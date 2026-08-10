from __future__ import annotations

import json
import sys
import urllib.request
from typing import Any


INSPECT_SCRIPT = r"""
({x, y, focused}) => {
  const raw = focused ? document.activeElement : document.elementFromPoint(x, y);
  if (!raw) return null;
  const el = raw.closest?.("button,a,input,textarea,select,[role],[contenteditable='true']") || raw;
  const clean = value => String(value || "").replace(/\s+/g, " ").trim().slice(0, 220);
  const text = clean(el.getAttribute("aria-label") || el.getAttribute("title") || el.innerText || el.textContent || el.value);
  let label = "";
  if (el.labels?.length) label = clean(Array.from(el.labels).map(item => item.innerText || item.textContent).join(" "));
  if (!label && el.id) label = clean(document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent);
  const placeholder = clean(el.getAttribute("placeholder"));
  const nativeRole = el.tagName === "A" ? "link" : el.tagName === "BUTTON" ? "button" :
    el.tagName === "SELECT" ? "combobox" : el.tagName === "TEXTAREA" ? "textbox" :
    el.tagName === "INPUT" ? (["button","submit","reset"].includes((el.type || "").toLowerCase()) ? "button" : "textbox") : "";
  const role = clean(el.getAttribute("role") || nativeRole);
  const escape = value => CSS.escape(String(value));
  const selectors = [];
  const add = (strategy, value, score, extra={}) => { if (value && !selectors.some(item => item.strategy === strategy && item.value === value)) selectors.push({strategy,value,score,...extra}); };
  if (label) add("label", label, 98);
  if (role && text) add("role", text, role === "button" || role === "link" ? 96 : 88, {role});
  if (placeholder) add("placeholder", placeholder, 92);
  const testId = clean(el.getAttribute("data-testid") || el.getAttribute("data-test-id") || el.getAttribute("data-qa"));
  if (testId) add("testid", testId, 94);
  if (el.id && !/\d{5,}/.test(el.id)) add("css", `#${escape(el.id)}`, 90);
  if (el.name && !/\d{5,}/.test(el.name)) add("css", `${el.tagName.toLowerCase()}[name="${escape(el.name)}"]`, 84);
  if (text) add("text", text, 78);
  const href = el instanceof HTMLAnchorElement ? el.href : "";
  const rect = el.getBoundingClientRect();
  const isSecret = el instanceof HTMLInputElement && el.type.toLowerCase() === "password";
  const isField = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || el.isContentEditable;
  const overlay = document.createElement("div");
  overlay.setAttribute("data-mavat-highlight", "true");
  Object.assign(overlay.style,{position:"fixed",zIndex:"2147483647",pointerEvents:"none",left:`${rect.left}px`,top:`${rect.top}px`,width:`${rect.width}px`,height:`${rect.height}px`,border:"3px solid #e0a82e",background:"rgba(224,168,46,.12)",boxShadow:"0 0 0 3px rgba(8,31,72,.45)",borderRadius:"5px"});
  document.querySelectorAll("[data-mavat-highlight]").forEach(node => node.remove());
  document.documentElement.appendChild(overlay); setTimeout(() => overlay.remove(), 1800);
  return {tag:el.tagName.toLowerCase(),role,text,label,placeholder,href,isSecret,isField,
    selectors:selectors.sort((a,b)=>b.score-a.score),confidence:selectors[0]?.score || 45,
    position:{
      xRatio:Math.max(0,Math.min(1,x/Math.max(1,innerWidth))),
      yRatio:Math.max(0,Math.min(1,y/Math.max(1,innerHeight)))
    },
    frameUrl:location.href};
}
"""


def target_catalog(port: int) -> list[dict[str, Any]]:
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=2) as response:
        return [item for item in json.load(response) if item.get("type") == "page"]


def main() -> None:
    port = int(sys.argv[1])
    requested_target = sys.argv[2] if len(sys.argv) > 2 else ""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{port}", timeout=5000)
        pages = [page for context in browser.contexts for page in context.pages if page.url.startswith("http")]
        catalog = target_catalog(port)
        requested = next((item for item in catalog if str(item.get("id")) == requested_target), None)
        page = next((item for item in pages if requested and item.url == requested.get("url")), None)
        if page is None:
            relevant = [item for item in pages if any(host in item.url for host in ("mavat", "gov.il", "iplan"))]
            page = relevant[-1] if relevant else (pages[-1] if pages else None)
        if page is None:
            raise RuntimeError("לא נמצאה לשונית אינטרנט פתוחה")
        session = page.context.new_cdp_session(page)

        for raw_line in sys.stdin:
            request = json.loads(raw_line)
            request_id = request.get("id")
            action = request.get("action")
            result: dict[str, Any] = {"id": request_id, "ok": True}
            try:
                metrics = session.send("Page.getLayoutMetrics")
                viewport = metrics.get("cssVisualViewport") or metrics.get("visualViewport") or {}
                width = float(viewport.get("clientWidth") or 1)
                height = float(viewport.get("clientHeight") or 1)
                x = max(0.0, min(1.0, float(request.get("x_ratio") or 0.5))) * width
                y = max(0.0, min(1.0, float(request.get("y_ratio") or 0.5))) * height
                detected = None
                if action in {"click", "double_click", "inspect"}:
                    detected = page.evaluate(INSPECT_SCRIPT, {"x": x, "y": y, "focused": False})
                elif action == "type_text":
                    detected = page.evaluate(INSPECT_SCRIPT, {"x": 0, "y": 0, "focused": True})
                if action in {"click", "double_click"}:
                    count = 2 if action == "double_click" else 1
                    session.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": count})
                    session.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": count})
                elif action == "scroll":
                    session.send("Input.dispatchMouseEvent", {"type": "mouseWheel", "x": x, "y": y, "deltaX": float(request.get("delta_x") or 0), "deltaY": float(request.get("delta_y") or 0)})
                elif action == "type_text":
                    session.send("Input.insertText", {"text": str(request.get("text") or "")})
                elif action == "key":
                    key = str(request.get("key") or "")
                    key_codes = {"Enter": 13, "Tab": 9, "Backspace": 8, "Escape": 27, "ArrowUp": 38, "ArrowDown": 40, "ArrowLeft": 37, "ArrowRight": 39}
                    code = key_codes.get(key, 0)
                    session.send("Input.dispatchKeyEvent", {"type": "keyDown", "key": key, "windowsVirtualKeyCode": code})
                    session.send("Input.dispatchKeyEvent", {"type": "keyUp", "key": key, "windowsVirtualKeyCode": code})
                elif action == "reload":
                    session.send("Page.reload", {"ignoreCache": False})
                elif action == "back":
                    page.go_back(wait_until="domcontentloaded", timeout=10000)
                elif action == "forward":
                    page.go_forward(wait_until="domcontentloaded", timeout=10000)
                elif action != "inspect":
                    raise ValueError(f"פעולת דפדפן לא נתמכת: {action}")
                result.update({"detected": detected, "url": page.url, "title": page.title()})
            except Exception as exc:
                result.update({"ok": False, "error": str(exc)})
            print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
