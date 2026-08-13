from __future__ import annotations

import json
import re
import threading
import time
from urllib.parse import urlparse
from typing import Any, Callable

import websocket

from mavat_app.cdp import CdpConnection, CdpEvent, page_targets


RECORDER_SCRIPT = r"""
(() => {
  if (window.__mavatRecorderInstalled) return;
  window.__mavatRecorderInstalled = true;

  const emit = payload => {
    try { window.__mavatRecordAction(JSON.stringify(payload)); }
    catch (_) { /* binding is restored on the next execution context */ }
  };

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
    return (el.getAttribute("placeholder") || el.getAttribute("name") || id || "").trim();
  };

  const visibleName = (el) => (
    el.getAttribute("aria-label") ||
    el.getAttribute("title") ||
    el.getAttribute("alt") ||
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
    const overlay = Boolean(el.closest(
      '[role="dialog"], [aria-modal="true"], [class*="cookie" i], [id*="cookie" i], [class*="banner" i], [id*="banner" i], [class*="consent" i], [id*="consent" i]'
    ));
    return {text,label,placeholder,role,overlay,selectors:selectors.sort((a,b)=>b.score-a.score),
      position:{x_ratio:(rect.left+rect.width/2)/innerWidth,y_ratio:(rect.top+rect.height/2)/innerHeight}};
  };

  const fieldTimers = new WeakMap();
  const fieldPayload = (el) => {
    const fieldType = (el.getAttribute("type") || el.tagName.toLowerCase()).toLowerCase();
    const secret = fieldType === "password";
    const isSelect = el instanceof HTMLSelectElement;
    const selected = isSelect && el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
    return {
      kind: isSelect ? "select" : (fieldType === "checkbox" || fieldType === "radio" ? "toggle" : "fill"),
      label: labelFor(el),
      secret,
      value: secret ? "" : (selected ? (selected.text || selected.value) : (el.value || "")),
      secret_value: secret ? (el.value || "") : "",
      checked: "checked" in el ? Boolean(el.checked) : undefined,
      ...descriptorFor(el),
      url: location.href,
      at: Date.now()
    };
  };
  const emitField = (el) => {
    const timer = fieldTimers.get(el);
    if (timer) clearTimeout(timer);
    fieldTimers.delete(el);
    emit(fieldPayload(el));
  };
  const scheduleField = (el) => {
    const previous = fieldTimers.get(el);
    if (previous) clearTimeout(previous);
    fieldTimers.set(el, setTimeout(() => emitField(el), 450));
  };

  document.addEventListener("click", (event) => {
    const el = event.target.closest(
      "button, a, [role='button'], [role='menuitem'], [role='tab'], input[type='button'], input[type='submit'], input[type='image'], [onclick], [tabindex]"
    );
    if (!el) return;
    const role = el.getAttribute("role") || (el.tagName === "A" ? "link" : "button");
    const name = visibleName(el) || labelFor(el) || "רכיב ללא תווית";
    if (!name) return;
    emit({kind: "click", role, name, ...descriptorFor(el), url: location.href, at: Date.now()});
  }, true);

  document.addEventListener("input", (event) => {
    const el = event.target;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
    scheduleField(el);
  }, true);

  document.addEventListener("change", (event) => {
    const el = event.target;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return;
    emitField(el);
  }, true);

  document.addEventListener("blur", (event) => {
    const el = event.target;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
    if (fieldTimers.has(el) || (el.getAttribute("type") || "").toLowerCase() === "password") emitField(el);
  }, true);

  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    form.querySelectorAll("input, textarea, select").forEach((el) => {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        if (el.value || ("checked" in el && el.checked)) emitField(el);
      }
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
        target_fragments: tuple[str, ...] | None = None,
        on_secret: Callable[[dict[str, Any], str], None] | None = None,
        on_target: Callable[[str, str, str], None] | None = None,
    ) -> None:
        self.debug_port = debug_port
        self.on_log = on_log
        self.on_step = on_step
        self.on_secret = on_secret
        self.on_target = on_target
        self.on_started = on_started
        self.on_finished = on_finished
        self.target_fragments = target_fragments or (
            "gov.il",
            "mavat.moin.gov.il",
            "login.gov.il",
        )
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
            name = str(event.get("name") or "")
            optional_overlay = bool(event.get("overlay")) and bool(re.search(
                r"(?:עוגי|קבל(?:ו)? הכל|אני מסכים|הבנתי|לא תודה|סגור|cookie|accept all|allow all|agree|got it|no thanks|dismiss|close)",
                name,
                flags=re.IGNORECASE,
            ))
            return {
                "name": f"לחיצה: {name}",
                "type": "smart_click",
                "scope": "once",
                "target": event.get("name", ""),
                "value": "",
                "timeout_seconds": 30,
                "enabled": True,
                "optional": optional_overlay,
                **common,
            }
        if kind == "fill":
            secret = bool(event.get("secret"))
            return {
                "name": "הזנת סיסמה" if secret else f"מילוי שדה: {event.get('label', '')}",
                "type": "fill_secret" if secret else "smart_fill",
                "scope": "once",
                "target": event.get("label", ""),
                "value": "" if secret else str(event.get("value") or ""),
                "timeout_seconds": 30,
                "enabled": True,
                **common,
            }
        if kind == "toggle":
            return {
                "name": f"שינוי אפשרות: {event.get('label', '')}",
                "type": "smart_click",
                "scope": "once",
                "target": event.get("label", ""),
                "value": "",
                "timeout_seconds": 30,
                "enabled": True,
                **common,
            }
        return {
            "name": f"בחירה בשדה: {event.get('label', '')}",
            "type": "select_option",
            "scope": "once",
            "target": event.get("label", ""),
            "value": str(event.get("value") or ""),
            "timeout_seconds": 30,
            "enabled": True,
            **common,
        }

    def run(self) -> None:
        workers: dict[str, tuple[threading.Thread, threading.Event]] = {}
        known_targets: set[str] = set()

        def relevant(target: dict[str, Any]) -> bool:
            url = str(target.get("url") or "").lower()
            return any(fragment in url for fragment in self.target_fragments)

        def observe(
            target: dict[str, Any], worker_stop: threading.Event, opened_during_recording: bool
        ) -> None:
            target_id = str(target.get("id") or "")
            contexts: set[int] = set()
            connection: CdpConnection | None = None
            binding_ready = False
            current_main_url = str(target.get("url") or "")

            def announce_target(url: str = "", title: str = "") -> None:
                if self.on_target:
                    self.on_target(target_id, url or current_main_url, title or str(target.get("title") or ""))

            def navigation_step(url: str, title: str = "") -> dict[str, Any]:
                parsed = urlparse(url)
                page_name = title.strip() or parsed.netloc or url
                return {
                    "name": f"מעבר לדף: {page_name}"[:180],
                    "type": "goto",
                    "scope": "once",
                    "target": "",
                    "value": url,
                    "page_url": url,
                    "timeout_seconds": 30,
                    "enabled": True,
                    "confidence": 100,
                    "_target_id": target_id,
                }

            def inject(context_id: int) -> None:
                if not connection or connection.closed:
                    return
                try:
                    connection.request(
                        "Runtime.evaluate",
                        {
                            "expression": RECORDER_SCRIPT,
                            "contextId": context_id,
                            "returnByValue": False,
                        },
                    )
                except Exception:
                    contexts.discard(context_id)

            def handle(event: CdpEvent) -> None:
                nonlocal binding_ready, current_main_url
                if event.method == "Runtime.executionContextCreated":
                    context = event.params.get("context") or {}
                    if not bool((context.get("auxData") or {}).get("isDefault")):
                        return
                    context_id = int(context.get("id") or 0)
                    if context_id:
                        contexts.add(context_id)
                        if binding_ready:
                            inject(context_id)
                    return
                if event.method == "Runtime.executionContextDestroyed":
                    contexts.discard(int(event.params.get("executionContextId") or 0))
                    return
                if event.method == "Page.frameNavigated":
                    frame = event.params.get("frame") or {}
                    if frame.get("parentId"):
                        return
                    url = str(frame.get("url") or "")
                    if not url.startswith(("http://", "https://")):
                        return
                    previous_url = current_main_url
                    changed = url != current_main_url
                    current_main_url = url
                    announce_target(url)
                    if changed and relevant({"url": url}):
                        if "login.gov.il" in previous_url.lower() and "mavat" in url.lower():
                            self.on_step({
                                "name": "אימות מאובטח והמשך אוטומטי למבא״ת",
                                "type": "manual",
                                "scope": "once",
                                "target": "השלם סיסמה, Passkey או אימות ממשלתי מאובטח",
                                "value": "השלם את האימות המאובטח בדפדפן; האוטומציה תמשיך לבד לאחר הצלחת הכניסה",
                                "page_url": previous_url,
                                "timeout_seconds": 300,
                                "enabled": True,
                                "auto_continue": True,
                                "resume_when": {
                                    "url_not_contains": "login.gov.il",
                                    "url_contains_any": [
                                        "plan.mavat.moin.gov.il",
                                        "mavat.moin.gov.il",
                                    ],
                                },
                                "confidence": 100,
                                "_target_id": target_id,
                            })
                        self.on_step(navigation_step(url))
                    return
                if event.method != "Runtime.bindingCalled":
                    return
                if event.params.get("name") != "__mavatRecordAction":
                    return
                try:
                    raw_event = json.loads(str(event.params.get("payload") or "{}"))
                    step = self._to_step(raw_event)
                    step["_target_id"] = target_id
                    secret_value = str(raw_event.get("secret_value") or "")
                    if bool(raw_event.get("secret")) and secret_value and self.on_secret:
                        self.on_secret(step, secret_value)
                    else:
                        self.on_step(step)
                except Exception as exc:
                    self.on_log(f"אירוע CDP לא נקלט: {exc}")

            try:
                connection = CdpConnection(str(target["webSocketDebuggerUrl"]), on_event=handle)
                connection.request("Runtime.enable")
                connection.request("Page.enable")
                connection.request("Runtime.addBinding", {"name": "__mavatRecordAction"})
                connection.request(
                    "Page.addScriptToEvaluateOnNewDocument", {"source": RECORDER_SCRIPT}
                )
                binding_ready = True
                for context_id in list(contexts):
                    inject(context_id)
                announce_target()
                if opened_during_recording and current_main_url.startswith(("http://", "https://")):
                    self.on_step(navigation_step(current_main_url, str(target.get("title") or "")))
                self.on_log(
                    f"צופה Raw CDP מחובר ברקע: {target.get('title') or target.get('url')}"
                )
                while not self.stop_event.is_set() and not worker_stop.is_set():
                    try:
                        connection.pump_once()
                    except websocket.WebSocketTimeoutException:
                        continue
            except Exception as exc:
                if not self.stop_event.is_set() and not worker_stop.is_set():
                    self.on_log(f"חיבור Raw CDP ללשונית נותק: {exc}")
            finally:
                if connection:
                    connection.close()

        try:
            deadline = time.time() + 6
            started = False
            while not self.stop_event.is_set():
                all_targets = page_targets(self.debug_port)
                available_ids = {str(target.get("id") or "") for target in all_targets}
                for target_id, (thread, worker_stop) in list(workers.items()):
                    if target_id not in available_ids or not thread.is_alive():
                        worker_stop.set()
                        workers.pop(target_id, None)
                targets = [target for target in all_targets if relevant(target)]
                for target in targets:
                    target_id = str(target.get("id") or "")
                    if not target_id or target_id in workers:
                        continue
                    opened_during_recording = started and target_id not in known_targets
                    known_targets.add(target_id)
                    worker_stop = threading.Event()
                    thread = threading.Thread(
                        target=observe,
                        args=(target, worker_stop, opened_during_recording),
                        daemon=True,
                    )
                    workers[target_id] = (thread, worker_stop)
                    thread.start()
                if workers and not started:
                    started = True
                    self.on_started("מקליט עכשיו · Raw CDP ברקע")
                    self.on_log(
                        "הקלטת Raw CDP התחילה ברקע. ערכים רגילים נשמרים בשלבים; סיסמאות נשלחות רק לכספת Windows."
                    )
                if not started and time.time() > deadline:
                    raise RuntimeError(
                        "לא נמצא דף gov.il / login.gov.il / מבא״ת פתוח ב-Chrome"
                    )
                time.sleep(0.45)
            self.on_finished("הקלטת Raw CDP ברקע נעצרה ונשמרה")
        except Exception as exc:
            self.on_finished(f"ההקלטה נכשלה: {exc}")
        finally:
            for thread, worker_stop in workers.values():
                worker_stop.set()
