from __future__ import annotations

import json
import re
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


@dataclass(slots=True)
class RunCallbacks:
    log: Callable[[str], None]
    status: Callable[[int, str, str], None]
    manual: Callable[[str], None]
    finished: Callable[[str], None]


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
    ) -> None:
        self.workflow = workflow
        self.records = records or [{}]
        self.username = username
        self.password = password
        self.default_profile_id = default_profile_id
        self.secrets_by_profile = secrets_by_profile
        self.browser_profile_dir = browser_profile_dir
        self.chrome_debug_port = chrome_debug_port
        self.callbacks = callbacks
        self.dry_run = dry_run
        self.stop_event = threading.Event()
        self.continue_event = threading.Event()

    def stop(self) -> None:
        self.stop_event.set()
        self.continue_event.set()

    def continue_after_manual(self) -> None:
        self.continue_event.set()

    def _resolved(self, value: Any, row: dict[str, Any]) -> str:
        context = SafeFormat({**row, "username": self.username})
        return str(value or "").format_map(context)

    def _wait_manual(self, message: str) -> None:
        self.callbacks.manual(message)
        self.continue_event.clear()
        while not self.stop_event.is_set():
            if self.continue_event.wait(0.25):
                return

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
            for step in self.workflow["steps"]:
                if not step.get("enabled", True):
                    continue
                if step.get("scope", "per_record") == "once" and index > 1:
                    continue
                self.callbacks.log(f"שורה {index}: {self._describe(step, row)}")
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
                        f"http://127.0.0.1:{self.chrome_debug_port}", timeout=3000
                    )
                    context = connected_browser.contexts[0]
                    self.callbacks.log("מחובר לחלון Chrome הקיים של המערכת")
                except Exception:
                    context = playwright.chromium.launch_persistent_context(
                        self.browser_profile_dir,
                        channel="chrome",
                        headless=False,
                        locale="he-IL",
                        viewport={"width": 1440, "height": 900},
                        args=[f"--remote-debugging-port={self.chrome_debug_port}"],
                    )
                    owns_context = True
                    self.callbacks.log("נפתח Chrome עם הפרופיל הקבוע של המערכת")
                page = context.pages[0] if context.pages else context.new_page()
                try:
                    for index, row in enumerate(self.records, start=1):
                        if self.stop_event.is_set():
                            break
                        self.callbacks.status(index, "בביצוע", "")
                        for step in self.workflow["steps"]:
                            if self.stop_event.is_set():
                                break
                            if not step.get("enabled", True):
                                continue
                            if step.get("scope", "per_record") == "once" and index > 1:
                                continue
                            self.callbacks.log(f"שורה {index}: {self._describe(step, row)}")
                            self._execute_step(page, step, row)
                        if not self.stop_event.is_set():
                            self.callbacks.status(index, "הצלחה", "")
                finally:
                    if owns_context:
                        context.close()
            self.callbacks.finished("נעצר" if self.stop_event.is_set() else "ההרצה הסתיימה")
        except Exception as exc:  # browser errors are reported in the run log
            self.callbacks.log(f"שגיאה: {exc}")
            self.callbacks.finished("ההרצה נכשלה")

    def _execute_step(self, page: Any, step: dict[str, Any], row: dict[str, Any]) -> None:
        action = step.get("type", "noop")
        target = self._resolved(step.get("target", ""), row)
        value = self._resolved(step.get("value", ""), row)
        timeout = int(step.get("timeout_seconds", 30)) * 1000

        if action == "noop":
            return
        if action == "goto":
            page.goto(value or target, wait_until="domcontentloaded", timeout=timeout)
        elif action == "click_text":
            page.get_by_text(target, exact=False).first.click(timeout=timeout)
        elif action == "click_role":
            role = value or "button"
            page.get_by_role(role, name=target, exact=False).first.click(timeout=timeout)
        elif action == "fill_label":
            page.get_by_label(target, exact=False).first.fill(value, timeout=timeout)
        elif action == "fill_placeholder":
            page.get_by_placeholder(target, exact=False).first.fill(value, timeout=timeout)
        elif action == "fill_secret":
            profile_id = str(step.get("credential_profile_id") or self.default_profile_id)
            secret = self.secrets_by_profile.get(profile_id, "") or self.password
            if not secret:
                raise RuntimeError("לא נשמרה סיסמה לפרופיל המקושר לשלב")
            page.get_by_label(target, exact=False).first.fill(secret, timeout=timeout)
        elif action == "wait_url":
            page.wait_for_url(re.compile(target or value), timeout=timeout)
        elif action == "wait_text":
            page.get_by_text(target, exact=False).first.wait_for(state="visible", timeout=timeout)
        elif action == "manual":
            self._wait_manual(value or target or "השלם את הפעולה הידנית ולחץ המשך")
        elif action == "screenshot":
            folder = Path("screenshots")
            folder.mkdir(exist_ok=True)
            filename = re.sub(r"[^\w.\-]+", "_", value or f"row_{row.get('_row_number', 0)}.png")
            page.screenshot(path=str(folder / filename), full_page=True)
        elif action == "delay":
            time.sleep(max(0.0, float(value or target or 1)))
        else:
            raise ValueError(f"סוג שלב לא נתמך: {action}")
