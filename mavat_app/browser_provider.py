from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


BROWSEROS_CONFIG = (
    Path(os.environ.get("LOCALAPPDATA", ""))
    / "BrowserOS"
    / "User Data"
    / ".browseros"
    / "config.json"
)


@dataclass(slots=True)
class BrowserEndpoint:
    provider: str
    display_name: str
    connected: bool
    cdp_port: int
    browser: str = ""
    pages: list[dict[str, str]] | None = None
    mcp_url: str = ""
    error: str = ""

    def to_dict(self) -> dict[str, Any]:
        result = asdict(self)
        result["pages"] = list(self.pages or [])
        return result


def _read_json(url: str, timeout: float = 1.0) -> Any:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.load(response)


def _probe_cdp(provider: str, display_name: str, port: int, mcp_url: str = "") -> BrowserEndpoint:
    try:
        version = _read_json(f"http://127.0.0.1:{port}/json/version")
        targets = _read_json(f"http://127.0.0.1:{port}/json/list")
        pages = [
            {
                "id": str(item.get("id") or ""),
                "title": str(item.get("title") or ""),
                "url": str(item.get("url") or ""),
            }
            for item in targets
            if item.get("type") == "page"
            and str(item.get("url") or "").startswith(("http://", "https://"))
        ]
        return BrowserEndpoint(
            provider=provider,
            display_name=display_name,
            connected=True,
            cdp_port=port,
            browser=str(version.get("Browser") or display_name),
            pages=pages,
            mcp_url=mcp_url,
        )
    except (OSError, urllib.error.URLError, json.JSONDecodeError, ValueError) as exc:
        return BrowserEndpoint(
            provider=provider,
            display_name=display_name,
            connected=False,
            cdp_port=port,
            pages=[],
            mcp_url=mcp_url,
            error=str(exc),
        )


def browseros_connection_settings(
    config_path: Path | None = None,
    configured_cdp_port: int = 0,
    configured_mcp_url: str = "",
) -> tuple[int, str]:
    cdp_port = int(configured_cdp_port or 0)
    mcp_url = str(configured_mcp_url or "").strip()
    path = Path(config_path or BROWSEROS_CONFIG)
    if path.is_file():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            ports = data.get("ports") if isinstance(data, dict) else {}
            if isinstance(ports, dict):
                cdp_port = cdp_port or int(ports.get("cdp") or 0)
                proxy_port = int(ports.get("proxy") or 0)
                server_port = int(ports.get("server") or 0)
                if not mcp_url and (proxy_port or server_port):
                    # BrowserOS exposes the agent-facing MCP URL through its
                    # proxy port (the same URL shown in Connected agents).
                    # Older releases only exposed the internal server port.
                    mcp_url = f"http://127.0.0.1:{proxy_port or server_port}/mcp"
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            pass
    return cdp_port or 9101, mcp_url or "http://127.0.0.1:9001/mcp"


def _browseros_mcp_healthy(mcp_url: str) -> bool:
    health_url = mcp_url.rsplit("/", 1)[0] + "/health"
    try:
        data = _read_json(health_url)
        return bool(data.get("status") == "ok" and data.get("cdpConnected"))
    except (OSError, urllib.error.URLError, json.JSONDecodeError, AttributeError):
        return False


def discover_browser_endpoints(
    chrome_port: int = 9223,
    browseros_cdp_port: int = 0,
    browseros_mcp_url: str = "",
    browseros_config_path: Path | None = None,
) -> list[BrowserEndpoint]:
    browseros_port, mcp_url = browseros_connection_settings(
        browseros_config_path, browseros_cdp_port, browseros_mcp_url
    )
    browseros = _probe_cdp("browseros", "BrowserOS", browseros_port, mcp_url)
    if browseros.connected and not _browseros_mcp_healthy(mcp_url):
        browseros.connected = False
        browseros.error = "שרת BrowserOS MCP אינו בריא"
    chrome = _probe_cdp("chrome", "Google Chrome", int(chrome_port))
    return [browseros, chrome]


def _unprobed_endpoint(
    provider: str,
    display_name: str,
    port: int,
    *,
    mcp_url: str = "",
) -> BrowserEndpoint:
    """Represent an inactive fallback without opening another browser connection."""
    return BrowserEndpoint(
        provider=provider,
        display_name=display_name,
        connected=False,
        cdp_port=port,
        pages=[],
        mcp_url=mcp_url,
        error="לא נבדק — ספק הגלישה הפעיל מחובר",
    )


def _probe_browseros(port: int, mcp_url: str) -> BrowserEndpoint:
    endpoint = _probe_cdp("browseros", "BrowserOS", port, mcp_url)
    if endpoint.connected and not _browseros_mcp_healthy(mcp_url):
        endpoint.connected = False
        endpoint.error = "שרת BrowserOS MCP אינו בריא"
    return endpoint


def select_browser_endpoint(
    preferred: str = "auto",
    chrome_port: int = 9223,
    browseros_cdp_port: int = 0,
    browseros_mcp_url: str = "",
    browseros_config_path: Path | None = None,
) -> tuple[BrowserEndpoint, list[BrowserEndpoint]]:
    requested = str(preferred or "auto").strip().lower()
    browseros_port, mcp_url = browseros_connection_settings(
        browseros_config_path, browseros_cdp_port, browseros_mcp_url
    )
    chrome_port = int(chrome_port)

    # Probe exactly one provider during normal operation. The fallback is only
    # touched after the preferred provider is unavailable, so status polling
    # cannot create parallel CDP/MCP traffic or a misleading dual connection.
    if requested == "chrome":
        chrome = _probe_cdp("chrome", "Google Chrome", chrome_port)
        if chrome.connected:
            browseros = _unprobed_endpoint(
                "browseros", "BrowserOS", browseros_port, mcp_url=mcp_url
            )
            return chrome, [browseros, chrome]
        browseros = _probe_browseros(browseros_port, mcp_url)
        return (browseros if browseros.connected else chrome), [browseros, chrome]

    # BrowserOS is intentionally preferred in auto mode: its MCP and CDP
    # endpoints are owned by the browser and survive application restarts.
    browseros = _probe_browseros(browseros_port, mcp_url)
    if browseros.connected:
        chrome = _unprobed_endpoint("chrome", "Google Chrome", chrome_port)
        return browseros, [browseros, chrome]
    chrome = _probe_cdp("chrome", "Google Chrome", chrome_port)
    return (chrome if chrome.connected else browseros), [browseros, chrome]


def browseros_mcp_call(mcp_url: str, tool: str, arguments: dict[str, Any]) -> dict[str, Any]:
    payload = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": tool, "arguments": arguments},
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        mcp_url,
        data=payload,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        },
    )
    with urllib.request.urlopen(request, timeout=8) as response:
        data = json.load(response)
    if data.get("error"):
        raise RuntimeError(str(data["error"].get("message") or data["error"]))
    result = data.get("result") or {}
    if result.get("isError"):
        content = result.get("content") or []
        message = next((str(item.get("text")) for item in content if item.get("text")), "")
        raise RuntimeError(message or "פעולת BrowserOS MCP נכשלה")
    return result


def open_browseros_page(
    endpoint: BrowserEndpoint,
    url: str,
    *,
    background: bool = True,
    hidden: bool = False,
) -> None:
    if endpoint.provider != "browseros" or not endpoint.mcp_url:
        raise ValueError("החיבור הפעיל אינו BrowserOS MCP")
    browseros_mcp_call(
        endpoint.mcp_url,
        "tabs",
        {"action": "new", "url": url, "background": background, "hidden": hidden},
    )
