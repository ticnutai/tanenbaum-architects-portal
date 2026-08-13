from __future__ import annotations

import json
import re
import threading
import time
from datetime import datetime
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit, urlunsplit


@dataclass(slots=True)
class RunCallbacks:
    log: Callable[[str], None]
    status: Callable[[int, str, str], None]
    manual: Callable[[str], None]
    finished: Callable[[str], None]
    step: Callable[[int, int, str, str], None] | None = None
    error: Callable[[dict[str, Any]], None] | None = None


class SafeFormat(dict):
    def __missing__(self, key: str) -> str:
        return "{" + key + "}"


def load_workflow(path: str | Path) -> dict[str, Any]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("steps"), list):
        raise ValueError("קובץ השלבים אינו תקין")
    return data


def save_workflow(path: str | Path, data: dict[str, Any]) -> None:
    Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


class WorkflowRunner:
    """Runs a constrained, auditable list of browser actions. No arbitrary code execution."""

    def __init__(
        self,
        workflow: dict[str, Any],
        records: list[dict[str, Any]],
        username: str,
        password: str,
        default_profile_id: str,
        secrets_by_profile: dict[str, str],
        browser_profile_dir: str,
        chrome_debug_port: int,
        callbacks: RunCallbacks,
        dry_run: bool = True,
        chrome_profile_directory: str = "Default",
        browser_provider: str = "chrome",
    ) -> None:
        self.workflow = workflow
        self.records = records or [{}]
        self.username = username
        self.password = password
        self.default_profile_id = default_profile_id
        self.secrets_by_profile = secrets_by_profile
        self.browser_profile_dir = browser_profile_dir
        self.chrome_debug_port = chrome_debug_port
        self.chrome_profile_directory = chrome_profile_directory
        self.browser_provider = browser_provider
        self.callbacks = callbacks
        self.dry_run = dry_run
        self.stop_event = threading.Event()
        self.continue_event = threading.Event()
        self.pause_event = threading.Event()

    def stop(self) -> None:
        self.stop_event.set()
        self.pause_event.clear()
        self.continue_event.set()

    def pause(self) -> None:
        self.pause_event.set()

    def resume(self) -> None:
        self.pause_event.clear()
        self.continue_event.set()

    def continue_after_manual(self) -> None:
        self.continue_event.set()

    def _wait_if_paused(self) -> None:
        while self.pause_event.is_set() and not self.stop_event.is_set():
            time.sleep(0.15)

    def _resolved(self, value: Any, row: dict[str, Any]) -> str:
        context = SafeFormat({**row, "username": self.username})
        return str(value or "").format_map(context)

    def _wait_manual(
        self,
        message: str,
        page: Any | None = None,
        resume_when: dict[str, Any] | None = None,
        timeout_seconds: int = 300,
    ) -> None:
        self.callbacks.manual(message)
        self.continue_event.clear()
        rule = resume_when or {}
        contains_any = [str(value).lower() for value in rule.get("url_contains_any", []) if value]
        not_contains = str(rule.get("url_not_contains") or "").lower()
        deadline = time.time() + max(10, timeout_seconds)
        while not self.stop_event.is_set():
            if self.continue_event.wait(0.25):
                return
            if page is not None and time.time() < deadline:
                try:
                    urls = [str(candidate.url or "") for candidate in page.context.pages]
                    matching = next(
                        (
                            url for url in urls
                            if (not not_contains or not_contains not in url.lower())
                            and (not contains_any or any(fragment in url.lower() for fragment in contains_any))
                        ),
                        "",
                    )
                    if matching:
                        self.callbacks.log(f"האימות המאובטח הושלם; ממשיך אוטומטית לפי הכתובת: {matching}")
                        return
                except Exception:
                    pass

    def _describe(self, step: dict[str, Any], row: dict[str, Any]) -> str:
        action = step.get("type", "noop")
        target = self._resolved(step.get("target", ""), row)
        value = "••••••" if action == "fill_secret" else self._resolved(step.get("value", ""), row)
        return f"{step.get('name', action)} | {action} | {target} {value}".strip()

    def run(self) -> None:
        if self.dry_run:
            self._run_dry()
            return
        self._run_browser()

    def _run_dry(self) -> None:
        self.callbacks.log("מצב בדיקה: לא נפתח דפדפן ולא נשלחים נתונים")
        for index, row in enumerate(self.records, start=1):
            if self.stop_event.is_set():
                self.callbacks.finished("נעצר")
                return
            for fallback_number, step in enumerate(self.workflow["steps"], start=1):
                if not step.get("enabled", True):
                    continue
                self._wait_if_paused()
                if self.stop_event.is_set():
                    self.callbacks.finished("נעצר")
                    return
                if step.get("scope", "per_record") == "once" and index > 1:
                    continue
                step_number = int(step.get("_original_step_number") or fallback_number)
                self.callbacks.log(f"שורה {index}, שלב {step_number}: {self._describe(step, row)}")
            self.callbacks.status(index, "בדיקה", "השלבים אומתו ללא שליחה")
        self.callbacks.finished("בדיקת השלבים הסתיימה")

    def _run_browser(self) -> None:
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            self.callbacks.finished("שגיאה: Playwright אינו מותקן")
            return

        try:
            with sync_playwright() as playwright:
                connected_browser = None
                owns_context = False
                try:
                    connected_browser = playwright.chromium.connect_over_cdp(
                        f"http://localhost:{self.chrome_debug_port}", timeout=3000
                    )
                    context = connected_browser.contexts[0]
                    provider_name = "BrowserOS" if self.browser_provider == "browseros" else "Chrome"
                    self.callbacks.log(f"מחובר לחלון {provider_name} הקיים של המערכת")
                except Exception:
                    if self.browser_provider == "browseros":
                        raise RuntimeError(
                            "חיבור BrowserOS נותק. פתח את BrowserOS או בחר Chrome בהגדרות ונסה שוב"
                        )
                    context = playwright.chromium.launch_persistent_context(
                        self.browser_profile_dir,
                        channel="chrome",
                        headless=False,
                        locale="he-IL",
                        viewport={"width": 1440, "height": 900},
                        args=[
                            f"--remote-debugging-port={self.chrome_debug_port}",
                            f"--profile-directory={self.chrome_profile_directory}",
                            "--no-first-run",
                            "--no-default-browser-check",
                            "--disable-session-crashed-bubble",
                            "--hide-crash-restore-bubble",
                        ],
                    )
                    owns_context = True
                    self.callbacks.log("נפתח Chrome עם הפרופיל הקבוע של המערכת")
                first_goto = next(
                    (
                        str(step.get("value") or step.get("target") or "")
                        for step in self.workflow["steps"]
                        if step.get("enabled", True) and step.get("type") == "goto"
                    ),
                    "",
                )
                first_recorded_page = next(
                    (
                        str(step.get("page_url") or "")
                        for step in self.workflow["steps"]
                        if step.get("enabled", True)
                        and str(step.get("page_url") or "").startswith(("http://", "https://"))
                    ),
                    "",
                )
                matching_pages = [
                    candidate for candidate in context.pages
                    if first_goto and candidate.url.rstrip("/") == first_goto.rstrip("/")
                ]
                if not matching_pages and first_recorded_page:
                    matching_pages = [
                        candidate for candidate in context.pages
                        if self._normalized_page_url(candidate.url) == self._normalized_page_url(first_recorded_page)
                    ]
                http_pages = [candidate for candidate in context.pages if candidate.url.startswith("http")]
                page = matching_pages[-1] if matching_pages else (http_pages[-1] if http_pages else context.new_page())
                self.callbacks.log(f"לשונית נבחרה להרצה: {page.url or 'לשונית חדשה'}")
                try:
                    for index, row in enumerate(self.records, start=1):
                        if self.stop_event.is_set():
                            break
                        self.callbacks.status(index, "בביצוע", "")
                        for fallback_number, step in enumerate(self.workflow["steps"], start=1):
                            step_number = int(step.get("_original_step_number") or fallback_number)
                            if self.stop_event.is_set():
                                break
                            self._wait_if_paused()
                            if self.stop_event.is_set():
                                break
                            if not step.get("enabled", True):
                                continue
                            if step.get("scope", "per_record") == "once" and index > 1:
                                continue
                            description = self._describe(step, row)
                            self.callbacks.log(f"▶ שורה {index}, שלב {step_number}: {description}")
                            if self.callbacks.step:
                                self.callbacks.step(index, step_number, str(step.get("name") or step.get("type")), "running")
                            try:
                                page = self._execute_step(page, step, row)
                            except Exception as exc:
                                folder = Path("screenshots") / "errors"
                                folder.mkdir(parents=True, exist_ok=True)
                                screenshot: Path | None = folder / f"error_{datetime.now().strftime('%Y%m%d_%H%M%S')}_step_{step_number}.png"
                                try:
                                    page.screenshot(path=str(screenshot), full_page=True)
                                except Exception:
                                    screenshot = None
                                details = {
                                    "row": index,
                                    "step": step_number,
                                    "step_name": str(step.get("name") or step.get("type")),
                                    "action": str(step.get("type") or ""),
                                    "target": str(step.get("target") or ""),
                                    "url": str(page.url or ""),
                                    "error": str(exc),
                                    "screenshot": str(screenshot.resolve()) if screenshot else "",
                                }
                                self.callbacks.log(
                                    f"❌ כשל בשורה {index}, שלב {step_number} ({details['step_name']}): {exc} | URL: {details['url']}"
                                )
                                if details["screenshot"]:
                                    self.callbacks.log(f"צילום הכשל נשמר: {details['screenshot']}")
                                if self.callbacks.step:
                                    self.callbacks.step(index, step_number, details["step_name"], "error")
                                if self.callbacks.error:
                                    self.callbacks.error(details)
                                raise RuntimeError(f"שלב {step_number} נכשל: {details['step_name']} — {exc}") from exc
                            self.callbacks.log(f"✓ שלב {step_number} הושלם: {step.get('name', step.get('type', ''))}")
                            if self.callbacks.step:
                                self.callbacks.step(index, step_number, str(step.get("name") or step.get("type")), "success")
                        if not self.stop_event.is_set():
                            self.callbacks.status(index, "הצלחה", "")
                finally:
                    if owns_context:
                        context.close()
            self.callbacks.finished("נעצר" if self.stop_event.is_set() else "ההרצה הסתיימה")
        except Exception as exc:  # browser errors are reported in the run log
            self.callbacks.log(f"שגיאה: {exc}")
            self.callbacks.finished("ההרצה נכשלה")

    @staticmethod
    def _action_scopes(page: Any, step: dict[str, Any]) -> list[Any]:
        expected_url = str(step.get("page_url") or "")
        frames = [frame for frame in page.frames if frame != page.main_frame]
        matching = [frame for frame in frames if expected_url and frame.url == expected_url]
        other = [frame for frame in frames if frame not in matching]
        return [*matching, page, *other]

    @staticmethod
    def _normalized_page_url(value: str) -> str:
        """Normalize a recorded URL without hiding a meaningful path or query change."""
        try:
            parsed = urlsplit(str(value or ""))
        except ValueError:
            return str(value or "").rstrip("/")
        if parsed.scheme not in {"http", "https"}:
            return str(value or "").rstrip("/")
        path = parsed.path.rstrip("/") or "/"
        return urlunsplit((parsed.scheme.lower(), parsed.netloc.lower(), path, parsed.query, ""))

    def _prepare_page_for_step(self, page: Any, step: dict[str, Any], timeout: int) -> Any:
        """Restore the page on which the action was recorded before locating its target."""
        expected_url = str(step.get("page_url") or "").strip()
        if not expected_url.startswith(("http://", "https://")):
            return page
        expected = self._normalized_page_url(expected_url)
        current = self._normalized_page_url(str(page.url or ""))
        main_frame = getattr(page, "main_frame", None)
        frame_urls = {
            self._normalized_page_url(str(frame.url or ""))
            for frame in getattr(page, "frames", [])
            if frame is not main_frame
        }
        if current == expected or expected in frame_urls:
            return page
        self.callbacks.log(f"ניווט מקדים לדף שבו הוקלט השלב: {expected_url}")
        page.goto(expected_url, wait_until="domcontentloaded", timeout=timeout)
        return page

    def _smart_action(
        self,
        page: Any,
        step: dict[str, Any],
        row: dict[str, Any],
        timeout: int,
        fill_value: str | None = None,
        select_value: str | None = None,
    ) -> Any:
        page = self._prepare_page_for_step(page, step, timeout)
        candidates = [step.get("locator") or {}, *(step.get("fallbacks") or [])]
        last_error: Exception | None = None
        for scope in self._action_scopes(page, step):
            for candidate in candidates:
                strategy = str(candidate.get("strategy") or "")
                candidate_value = self._resolved(candidate.get("value", ""), row)
                try:
                    if strategy == "position":
                        if scope is not page:
                            continue
                        self.callbacks.log("המזהים הסמנטיים לא נמצאו; נעשה שימוש בגיבוי מיקום")
                        viewport = page.viewport_size or page.evaluate("() => ({width: innerWidth, height: innerHeight})")
                        x = float(candidate.get("x_ratio", 0.5)) * float(viewport["width"])
                        y = float(candidate.get("y_ratio", 0.5)) * float(viewport["height"])
                        blocking_overlay = page.evaluate(
                            """({x, y}) => {
                                const element = document.elementFromPoint(x, y);
                                const overlay = element?.closest(
                                  '[role="dialog"], [aria-modal="true"], [class*="cookie" i], [id*="cookie" i], [class*="banner" i], [id*="banner" i], [class*="consent" i], [id*="consent" i]'
                                );
                                return overlay ? (overlay.innerText || overlay.getAttribute('aria-label') || 'חלון קופץ') : '';
                            }""",
                            {"x": x, "y": y},
                        )
                        if blocking_overlay and not step.get("optional"):
                            raise RuntimeError(
                                f"באנר או חלון קופץ מסתיר את יעד הלחיצה: {str(blocking_overlay)[:120]}"
                            )
                        page.mouse.click(x, y)
                        if fill_value is not None:
                            page.keyboard.insert_text(fill_value)
                        return page
                    if strategy == "role":
                        locator = scope.get_by_role(str(candidate.get("role") or "button"), name=candidate_value, exact=False)
                    elif strategy == "label":
                        locator = scope.get_by_label(candidate_value, exact=False)
                    elif strategy == "placeholder":
                        locator = scope.get_by_placeholder(candidate_value, exact=False)
                    elif strategy == "testid":
                        locator = scope.get_by_test_id(candidate_value)
                    elif strategy == "text":
                        locator = scope.get_by_text(candidate_value, exact=False)
                    elif strategy == "css":
                        locator = scope.locator(candidate_value)
                    else:
                        continue
                    locator.first.wait_for(state="visible", timeout=min(timeout, 5000))
                    if select_value is not None:
                        tag_name = locator.first.evaluate("element => element.tagName.toLowerCase()")
                        if tag_name == "select":
                            try:
                                locator.first.select_option(label=select_value, timeout=timeout)
                            except Exception:
                                locator.first.select_option(value=select_value, timeout=timeout)
                        else:
                            locator.first.click(timeout=timeout)
                            try:
                                locator.first.fill(select_value, timeout=timeout)
                            except Exception:
                                page.keyboard.insert_text(select_value)
                            option = scope.get_by_role("option", name=select_value, exact=False)
                            if option.count():
                                option.first.click(timeout=timeout)
                            else:
                                scope.get_by_text(select_value, exact=True).last.click(timeout=timeout)
                    elif fill_value is None:
                        pages_before = set(page.context.pages)
                        locator.first.click(timeout=timeout)
                        page.wait_for_timeout(600)
                        new_pages = [
                            candidate_page
                            for candidate_page in page.context.pages
                            if candidate_page not in pages_before and candidate_page.url.startswith("http")
                        ]
                        if new_pages:
                            page = new_pages[-1]
                            page.wait_for_load_state("domcontentloaded", timeout=timeout)
                    else:
                        locator.first.fill(fill_value, timeout=timeout)
                    return page
                except Exception as exc:
                    last_error = exc
        raise RuntimeError(f"לא נמצא רכיב לפי המזהים השמורים: {last_error or step.get('target', '')}")

    def _execute_step(self, page: Any, step: dict[str, Any], row: dict[str, Any]) -> Any:
        action = step.get("type", "noop")
        target = self._resolved(step.get("target", ""), row)
        value = self._resolved(step.get("value", ""), row)
        timeout = int(step.get("timeout_seconds", 30)) * 1000

        if action in {"fill_label", "fill_placeholder", "smart_fill", "select_option"} and re.search(r"\{TODO\}", value):
            raise RuntimeError(f"הערך '{value}' לא מופה לנתון אמיתי")

        if action == "noop":
            return page
        if action == "goto":
            destination = value or target
            if page.url.rstrip("/") != destination.rstrip("/"):
                page.goto(destination, wait_until="domcontentloaded", timeout=timeout)
            else:
                self.callbacks.log("הדף כבר פתוח בכתובת המבוקשת; הניווט דולג")
        elif action == "click_text":
            pages_before = set(page.context.pages)
            page.get_by_text(target, exact=False).first.click(timeout=timeout)
            page.wait_for_timeout(600)
            new_pages = [candidate for candidate in page.context.pages if candidate not in pages_before and candidate.url.startswith("http")]
            if new_pages:
                page = new_pages[-1]
                page.wait_for_load_state("domcontentloaded", timeout=timeout)
        elif action == "click_role":
            pages_before = set(page.context.pages)
            role = value or "button"
            page.get_by_role(role, name=target, exact=False).first.click(timeout=timeout)
            page.wait_for_timeout(600)
            new_pages = [candidate for candidate in page.context.pages if candidate not in pages_before and candidate.url.startswith("http")]
            if new_pages:
                page = new_pages[-1]
                page.wait_for_load_state("domcontentloaded", timeout=timeout)
        elif action == "fill_label":
            page.get_by_label(target, exact=False).first.fill(value, timeout=timeout)
        elif action == "fill_placeholder":
            page.get_by_placeholder(target, exact=False).first.fill(value, timeout=timeout)
        elif action == "select_option":
            if step.get("locator") or step.get("fallbacks"):
                return self._smart_action(page, step, row, timeout, select_value=value)
            control = page.get_by_label(target, exact=False).first
            tag_name = control.evaluate("element => element.tagName.toLowerCase()")
            if tag_name == "select":
                try:
                    control.select_option(label=value, timeout=timeout)
                except Exception:
                    control.select_option(value=value, timeout=timeout)
            else:
                control.click(timeout=timeout)
                try:
                    control.fill(value, timeout=timeout)
                except Exception:
                    page.keyboard.insert_text(value)
                option = page.get_by_role("option", name=value, exact=False)
                if option.count():
                    option.first.click(timeout=timeout)
                else:
                    page.get_by_text(value, exact=True).last.click(timeout=timeout)
        elif action == "fill_secret":
            profile_id = str(step.get("credential_profile_id") or self.default_profile_id)
            secret = self.secrets_by_profile.get(profile_id, "") or self.password
            if not secret:
                raise RuntimeError("לא נשמרה סיסמה לפרופיל המקושר לשלב")
            if step.get("locator") or step.get("fallbacks"):
                return self._smart_action(page, step, row, timeout, secret)
            page.get_by_label(target, exact=False).first.fill(secret, timeout=timeout)
        elif action in {"smart_click", "smart_fill"}:
            if action == "smart_fill" and not value:
                raise RuntimeError("לא הוגדר ערך למילוי החכם")
            try:
                return self._smart_action(page, step, row, timeout, value if action == "smart_fill" else None)
            except RuntimeError:
                if not step.get("optional"):
                    raise
                self.callbacks.log(f"הפעולה האופציונלית לא הופיעה ודולגה: {step.get('name', target)}")
                return page
        elif action == "wait_url":
            page.wait_for_url(re.compile(target or value), timeout=timeout)
        elif action == "wait_text":
            page.get_by_text(target, exact=False).first.wait_for(state="visible", timeout=timeout)
        elif action == "manual":
            resume_when = step.get("resume_when") if isinstance(step.get("resume_when"), dict) else {}
            auto_continue = bool(step.get("auto_continue")) or "login.gov.il" in str(step.get("page_url") or "")
            if auto_continue and not resume_when:
                resume_when = {
                    "url_not_contains": "login.gov.il",
                    "url_contains_any": ["plan.mavat.moin.gov.il", "mavat.moin.gov.il"],
                }
            manual_message = (
                "נדרש אישור בדיאלוג המאובטח של Chrome; לאחר בחירת הזהות האוטומציה תמשיך לבד"
                if auto_continue
                else (value or target or "השלם את הפעולה הידנית ולחץ המשך")
            )
            self._wait_manual(
                manual_message,
                page=page if auto_continue else None,
                resume_when=resume_when,
                timeout_seconds=max(10, int(step.get("timeout_seconds", 300))),
            )
        elif action == "screenshot":
            folder = Path("screenshots")
            folder.mkdir(exist_ok=True)
            filename = re.sub(r"[^\w.\-]+", "_", value or f"row_{row.get('_row_number', 0)}.png")
            page.screenshot(path=str(folder / filename), full_page=True)
        elif action == "delay":
            time.sleep(max(0.0, float(value or target or 1)))
        else:
            raise ValueError(f"סוג שלב לא נתמך: {action}")
        return page
