from __future__ import annotations

import json
import threading
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable

import websocket


def page_targets(port: int) -> list[dict[str, Any]]:
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=2) as response:
        return [
            item
            for item in json.load(response)
            if item.get("type") == "page" and item.get("webSocketDebuggerUrl")
        ]


def select_page_target(port: int, requested_target: str = "") -> dict[str, Any] | None:
    targets = page_targets(port)
    if requested_target:
        selected = next(
            (item for item in targets if str(item.get("id")) == requested_target), None
        )
        if selected:
            return selected
    http_targets = [item for item in targets if str(item.get("url") or "").startswith("http")]
    relevant = [
        item
        for item in http_targets
        if any(host in str(item.get("url") or "").lower() for host in ("mavat", "gov.il", "iplan"))
    ]
    return (relevant or http_targets or targets)[-1] if (relevant or http_targets or targets) else None


@dataclass(slots=True)
class CdpEvent:
    method: str
    params: dict[str, Any]


class CdpConnection:
    """Small synchronous raw-CDP WebSocket client with no Playwright side effects."""

    def __init__(
        self,
        websocket_url: str,
        on_event: Callable[[CdpEvent], None] | None = None,
        timeout: float = 0.7,
    ) -> None:
        self.websocket_url = websocket_url
        self.on_event = on_event
        self.socket = websocket.create_connection(
            websocket_url,
            timeout=timeout,
            suppress_origin=True,
            enable_multithread=True,
        )
        self._next_id = 0
        self._send_lock = threading.Lock()
        self.closed = False

    def close(self) -> None:
        self.closed = True
        try:
            self.socket.close()
        except Exception:
            pass

    def _dispatch(self, message: dict[str, Any]) -> None:
        method = str(message.get("method") or "")
        if method and self.on_event:
            self.on_event(CdpEvent(method, dict(message.get("params") or {})))

    def send(self, method: str, params: dict[str, Any] | None = None) -> int:
        with self._send_lock:
            self._next_id += 1
            command_id = self._next_id
            self.socket.send(json.dumps({"id": command_id, "method": method, "params": params or {}}))
            return command_id

    def request(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        command_id = self.send(method, params)
        while not self.closed:
            message = self.receive()
            if message.get("id") != command_id:
                self._dispatch(message)
                continue
            if message.get("error"):
                raise RuntimeError(str(message["error"].get("message") or message["error"]))
            return dict(message.get("result") or {})
        raise RuntimeError("חיבור CDP נסגר")

    def receive(self) -> dict[str, Any]:
        raw = self.socket.recv()
        if not raw:
            raise ConnectionError("חיבור CDP נסגר")
        return dict(json.loads(raw))

    def pump_once(self) -> None:
        self._dispatch(self.receive())
