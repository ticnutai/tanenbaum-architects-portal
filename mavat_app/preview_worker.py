from __future__ import annotations

import base64
import json
import os
import sys
import time
import urllib.request
from typing import Any


def targets(port: int) -> list[dict[str, Any]]:
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=2) as response:
        return [item for item in json.load(response) if item.get("type") == "page"]


def emit(frame: bytes = b"", **metadata: Any) -> None:
    output = sys.stdout.buffer
    output.write((json.dumps({"length": len(frame), **metadata}, ensure_ascii=False) + "\n").encode("utf-8"))
    if frame:
        output.write(frame)
        output.write(b"\n")
    output.flush()


def main() -> None:
    port = int(sys.argv[1])
    requested_target = sys.argv[2] if len(sys.argv) > 2 else ""
    once = "--once" in sys.argv
    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{port}", timeout=5000)
        pages = [page for context in browser.contexts for page in context.pages if page.url.startswith("http")]
        catalog = targets(port)
        requested = next((item for item in catalog if str(item.get("id")) == requested_target), None)
        page = next((item for item in pages if requested and item.url == requested.get("url")), None)
        if page is None:
            relevant = [item for item in pages if any(host in item.url for host in ("mavat", "gov.il", "iplan"))]
            page = relevant[-1] if relevant else (pages[-1] if pages else None)
        if page is None:
            emit(error="לא נמצאה לשונית אינטרנט פתוחה")
            return
        selected_target = next((item for item in catalog if item.get("url") == page.url), {})
        target_id = str(selected_target.get("id") or requested_target)
        session = page.context.new_cdp_session(page)
        if once:
            try:
                capture = session.send("Page.captureScreenshot", {
                    "format": "jpeg", "quality": 68,
                    "fromSurface": True, "captureBeyondViewport": False,
                })
                frame = base64.b64decode(capture["data"])
                emit(frame, target_id=target_id, url=page.url, title=page.title(), error="")
                os._exit(0)
            except Exception as exc:
                emit(error=str(exc)[:500], target_id=target_id, url=page.url)
                return

        def on_frame(event: dict[str, Any]) -> None:
            try:
                frame = base64.b64decode(event["data"])
                emit(frame, target_id=target_id, url=page.url, title=page.title(), error="")
                session.send("Page.screencastFrameAck", {"sessionId": event["sessionId"]})
            except Exception as exc:
                emit(error=str(exc)[:500], target_id=target_id, url=page.url)

        session.on("Page.screencastFrame", on_frame)
        session.send("Page.startScreencast", {
            "format": "jpeg", "quality": 65, "maxWidth": 1440, "maxHeight": 900, "everyNthFrame": 1,
        })
        while browser.is_connected():
            page.wait_for_timeout(1000)


if __name__ == "__main__":
    main()
