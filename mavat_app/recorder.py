from __future__ import annotations

import json
import threading
import time
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
    emit({kind: "click", role, name, ...descriptorFor(el), url: location.href, at: Date.now()});
  }, true);

  document.addEventListener("change", (event) => {
    const el = event.target;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return;
    const fieldType = (el.getAttribute("type") || el.tagName.toLowerCase()).toLowerCase();
    emit({
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
        target_fragments: tuple[str, ...] | None = None,
    ) -> None:
        self.debug_port = debug_port
        self.on_log = on_log
        self.on_step = on_step
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
            "type": "select_option",
            "scope": "once",
            "target": event.get("label", ""),
            "value": "{TODO}",
            "timeout_seconds": 30,
            "enabled": True,
            **common,
        }

    def run(self) -> None:
        workers: dict[str, tuple[threading.Thread, threading.Event]] = {}

        def relevant(target: dict[str, Any]) -> bool:
            url = str(target.get("url") or "").lower()
            return any(fragment in url for fragment in self.target_fragments)

        def observe(target: dict[str, Any], worker_stop: threading.Event) -> None:
            target_id = str(target.get("id") or "")
            contexts: set[int] = set()
            connection: CdpConnection | None = None
            binding_ready = False

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
                nonlocal binding_ready
                if event.method == "Runtime.executionContextCreated":
                    context_id = int((event.params.get("context") or {}).get("id") or 0)
                    if context_id:
                        contexts.add(context_id)
                        if binding_ready:
                            inject(context_id)
                    return
                if event.method == "Runtime.executionContextDestroyed":
                    contexts.discard(int(event.params.get("executionContextId") or 0))
                    return
                if event.method != "Runtime.bindingCalled":
                    return
                if event.params.get("name") != "__mavatRecordAction":
                    return
                try:
                    raw_event = json.loads(str(event.params.get("payload") or "{}"))
                    step = self._to_step(raw_event)
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
                targets = [target for target in page_targets(self.debug_port) if relevant(target)]
                active_ids = {str(target.get("id") or "") for target in targets}
                for target_id, (thread, worker_stop) in list(workers.items()):
                    if target_id not in active_ids or not thread.is_alive():
                        worker_stop.set()
                        workers.pop(target_id, None)
                for target in targets:
                    target_id = str(target.get("id") or "")
                    if not target_id or target_id in workers:
                        continue
                    worker_stop = threading.Event()
                    thread = threading.Thread(
                        target=observe, args=(target, worker_stop), daemon=True
                    )
                    workers[target_id] = (thread, worker_stop)
                    thread.start()
                if workers and not started:
                    started = True
                    self.on_started("מקליט עכשיו · Raw CDP ברקע")
                    self.on_log(
                        "הקלטת Raw CDP התחילה ברקע. ערכי שדות אינם נשמרים."
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
