from __future__ import annotations

import base64
import json
import sys
import threading
from typing import Any

import websocket

from mavat_app.cdp import CdpConnection, CdpEvent, page_targets, select_page_target


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
    target = select_page_target(port, requested_target)
    if not target:
        emit(error="לא נמצאה לשונית אינטרנט פתוחה")
        return
    target_id = str(target.get("id") or requested_target)
    url = str(target.get("url") or "")
    title = str(target.get("title") or "")
    launch_url = url
    connection: CdpConnection | None = None

    screencast_options = {
        "format": "jpeg",
        "quality": 65,
        "maxWidth": 1440,
        "maxHeight": 900,
        "everyNthFrame": 1,
    }

    def on_event(event: CdpEvent) -> None:
        if event.method != "Page.screencastFrame" or not connection:
            return
        try:
            frame = base64.b64decode(str(event.params["data"]))
            emit(frame, target_id=target_id, url=url, title=title, error="")
            connection.send(
                "Page.screencastFrameAck", {"sessionId": event.params["sessionId"]}
            )
        except Exception as exc:
            emit(error=str(exc)[:500], target_id=target_id, url=url)

    try:
        connection = CdpConnection(str(target["webSocketDebuggerUrl"]), on_event=on_event)
        connection.request("Page.enable")
        if once:
            capture = connection.request(
                "Page.captureScreenshot",
                {
                    "format": "jpeg",
                    "quality": 68,
                    "fromSurface": True,
                    "captureBeyondViewport": False,
                },
            )
            emit(
                base64.b64decode(str(capture["data"])),
                target_id=target_id,
                url=url,
                title=title,
                error="",
            )
            return
        capture = connection.request(
            "Page.captureScreenshot",
            {
                "format": "jpeg",
                "quality": 65,
                "fromSurface": True,
                "captureBeyondViewport": False,
            },
        )
        emit(
            base64.b64decode(str(capture["data"])),
            target_id=target_id,
            url=url,
            title=title,
            error="",
        )
        connection.request("Page.startScreencast", screencast_options)

        def close_after_navigation() -> None:
            while connection and not connection.closed:
                try:
                    current = next(
                        (item for item in page_targets(port) if str(item.get("id")) == target_id),
                        None,
                    )
                    if not current or str(current.get("url") or "") != launch_url:
                        connection.close()
                        return
                except Exception:
                    pass
                threading.Event().wait(0.5)

        threading.Thread(target=close_after_navigation, daemon=True).start()
        while True:
            try:
                connection.pump_once()
            except websocket.WebSocketTimeoutException:
                continue
    except Exception as exc:
        emit(error=str(exc)[:500], target_id=target_id, url=url)
    finally:
        if connection:
            connection.close()


if __name__ == "__main__":
    main()
