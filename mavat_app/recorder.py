from __future__ import annotations

import threading
import time
from typing import Any, Callable


RECORDER_SCRIPT = r"""
(() => {
  if (window.__mavatRecorderInstalled) return;
  window.__mavatRecorderInstalled = true;
  window.__mavatRecordedActions = [];

  const labelFor = (el) => {
    if (!el) return "";
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    if (el.labels && el.labels.length) {
      const text = Array.from(el.labels).map(x => x.innerText || x.textContent || "").join(" ").trim();
      if (text) return text;
    }
    const id = el.id;
    if (id) {
      const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (label) return (label.innerText || label.textContent || "").trim();
    }
    return (el.getAttribute("placeholder") || el.getAttribute("name") || id || "שדה ללא תווית").trim();
  };

  const visibleName = (el) => (
    el.getAttribute("aria-label") ||
    el.getAttribute("title") ||
    el.innerText ||
    el.textContent ||
    (el.tagName === "INPUT" ? el.value : "") ||
    ""
  ).replace(/\s+/g, " ").trim().slice(0, 180);

  const descriptorFor = (el) => {
    const text = visibleName(el);
    const label = labelFor(el);
    const placeholder = (el.getAttribute("placeholder") || "").trim();
    const nativeRole = el.tagName === "A" ? "link" : el.tagName === "BUTTON" ? "button" :
      el.tagName === "SELECT" ? "combobox" : (el.tagName === "INPUT" || el.tagName === "TEXTAREA") ? "textbox" : "";
    const role = el.getAttribute("role") || nativeRole;
    const selectors = [];
    const add = (strategy, value, score, extra={}) => { if (value && !selectors.some(item => item.strategy === strategy && item.value === value)) selectors.push({strategy,value,score,...extra}); };
    if (label) add("label", label, 98);
    if (role && text) add("role", text, role === "button" || role === "link" ? 96 : 88, {role});
    if (placeholder) add("placeholder", placeholder, 92);
    const testId = el.getAttribute("data-testid") || el.getAttribute("data-test-id") || el.getAttribute("data-qa");
    if (testId) add("testid", testId, 94);
    if (el.id && !/\d{5,}/.test(el.id)) add("css", `#${CSS.escape(el.id)}`, 90);
    if (el.name && !/\d{5,}/.test(el.name)) add("css", `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`, 84);
    if (text) add("text", text, 78);
    const rect = el.getBoundingClientRect();
    return {text,label,placeholder,role,selectors:selectors.sort((a,b)=>b.score-a.score),
      position:{x_ratio:(rect.left+rect.width/2)/innerWidth,y_ratio:(rect.top+rect.height/2)/innerHeight}};
  };

  document.addEventListener("click", (event) => {
    const el = event.target.closest("button, a, [role='button'], input[type='button'], input[type='submit']");
    if (!el) return;
    const role = el.getAttribute("role") || (el.tagName === "A" ? "link" : "button");
    const name = visibleName(el);
    if (!name) return;
    window.__mavatRecordedActions.push({kind: "click", role, name, ...descriptorFor(el), url: location.href, at: Date.now()});
  }, true);

  document.addEventListener("change", (event) => {
    const el = event.target;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return;
    const fieldType = (el.getAttribute("type") || el.tagName.toLowerCase()).toLowerCase();
    window.__mavatRecordedActions.push({
      kind: el instanceof HTMLSelectElement ? "select" : "fill",
      label: labelFor(el),
      secret: fieldType === "password",
      ...descriptorFor(el),
      url: location.href,
      at: Date.now()
    });
  }, true);
})();
"""


class BrowserRecorder:
    """Records future visible browser actions without recording entered values."""

    def __init__(
        self,
        debug_port: int,
        on_log: Callable[[str], None],
        on_step: Callable[[dict[str, Any]], None],
        on_started: Callable[[str], None],
        on_finished: Callable[[str], None],
    ) -> None:
        self.debug_port = debug_port
        self.on_log = on_log
        self.on_step = on_step
        self.on_started = on_started
        self.on_finished = on_finished
        self.stop_event = threading.Event()

    def stop(self) -> None:
        self.stop_event.set()

    @staticmethod
    def _to_step(event: dict[str, Any]) -> dict[str, Any]:
        kind = event.get("kind")
        selectors = list(event.get("selectors") or [])
        preferred = selectors[0] if selectors else {"strategy": "position", "score": 45}
        position = event.get("position") or {}
        fallbacks = selectors[1:] + [{
            "strategy": "position", "x_ratio": position.get("x_ratio", 0.5),
            "y_ratio": position.get("y_ratio", 0.5), "score": 40,
        }]
        common = {
            "locator": preferred, "fallbacks": fallbacks, "page_url": event.get("url", ""),
            "position": position, "confidence": int(preferred.get("score") or 45),
        }
        if kind == "click":
            return {
                "name": f"לחיצה: {event.get('name', '')}",
                "type": "smart_click",
                "scope": "once",
                "target": event.get("name", ""),
                "value": "",
                "timeout_seconds": 30,
                "enabled": True,
                **common,
            }
        if kind == "fill":
            secret = bool(event.get("secret"))
            return {
                "name": "הזנת סיסמה" if secret else f"מילוי שדה: {event.get('label', '')}",
                "type": "fill_secret" if secret else "smart_fill",
                "scope": "once",
                "target": event.get("label", ""),
                "value": "" if secret else "{TODO}",
                "timeout_seconds": 30,
                "enabled": True,
                **common,
            }
        return {
            "name": f"בחירה בשדה: {event.get('label', '')}",
            "type": "manual",
            "scope": "once",
            "target": event.get("label", ""),
            "value": "בחר את הערך המתאים; יש לערוך שלב זה לאחר המיפוי",
            "timeout_seconds": 30,
            "enabled": True,
        }

    def run(self) -> None:
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            self.on_finished("Playwright אינו מותקן")
            return

        seen_frames: set[int] = set()
        target_fragments = ("gov.il", "mavat.moin.gov.il", "login.gov.il")
        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.connect_over_cdp(
                    f"http://127.0.0.1:{self.debug_port}", timeout=5000
                )
                if not browser.contexts:
                    raise RuntimeError("לא נמצא חלון Chrome פעיל")
                context = browser.contexts[0]
                context.add_init_script(RECORDER_SCRIPT)
                attached_count = 0
                for page in list(context.pages):
                    if not any(fragment in page.url.lower() for fragment in target_fragments):
                        continue
                    for frame in page.frames:
                        try:
                            frame.evaluate(RECORDER_SCRIPT)
                            seen_frames.add(id(frame))
                            attached_count += 1
                        except Exception:
                            continue
                if attached_count == 0:
                    raise RuntimeError("לא נמצא דף gov.il / login.gov.il / מבא״ת פתוח ב-Chrome")
                self.on_started("מקליט עכשיו")
                self.on_log("הקלטת פעולות התחילה. ערכי שדות אינם נשמרים.")

                while not self.stop_event.is_set():
                    for page in list(context.pages):
                        if not any(fragment in page.url.lower() for fragment in target_fragments):
                            continue
                        for frame in page.frames:
                            frame_key = id(frame)
                            if frame_key not in seen_frames:
                                try:
                                    frame.evaluate(RECORDER_SCRIPT)
                                    self.on_log(f"מחובר למסגרת בדף: {page.title()} | {page.url}")
                                    seen_frames.add(frame_key)
                                except Exception:
                                    continue
                            try:
                                installed = frame.evaluate(
                                    "() => !!window.__mavatRecorderInstalled"
                                )
                                if not installed:
                                    frame.evaluate(RECORDER_SCRIPT)
                                events = frame.evaluate(
                                    "() => (window.__mavatRecordedActions || []).splice(0)"
                                )
                            except Exception:
                                seen_frames.discard(frame_key)
                                continue
                            for event in events or []:
                                step = self._to_step(event)
                                self.on_step(step)
                                self.on_log(f"נקלט שלב: {step['name']}")
                    time.sleep(0.35)
                self.on_finished("הקלטת הפעולות נעצרה ונשמרה")
        except Exception as exc:
            self.on_finished(f"ההקלטה נכשלה: {exc}")
