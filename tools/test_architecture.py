from __future__ import annotations

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def main() -> None:
    source_files = list((ROOT / "src").rglob("*.tsx")) + list((ROOT / "src").rglob("*.ts"))
    rendered_source = "\n".join(path.read_text(encoding="utf-8") for path in source_files)
    assert not re.search(r"<\s*(iframe|webview)\b", rendered_source, re.IGNORECASE), (
        "React must not embed the target site through iframe/webview"
    )

    project_runtime = "\n".join(
        read(relative)
        for relative in (
            "electron/main.cjs",
            "automation-engine/worker.cjs",
            "web_app.py",
            "mavat_app/config.py",
            "mavat_app/workflow.py",
            "desktop/dock-windows.ps1",
            "desktop/link-windows.ps1",
        )
    )
    assert "9222" not in project_runtime, "The retired CDP port 9222 returned"
    assert 'path.join(ROOT, ".runtime", "chrome", "mavat")' in read(
        "automation-engine/worker.cjs"
    )
    dock_script = read("desktop/dock-windows.ps1")
    assert '$_.Name -eq "chrome.exe"' in dock_script
    assert '$_.Name -in @("chrome.exe", "chromium.exe")' not in dock_script
    assert 'channel="chrome"' in read("mavat_app/workflow.py")
    assert '"google-chrome-cdp"' in read("automation-engine/worker.cjs")
    assert '"browseros-mcp-cdp"' in read("automation-engine/worker.cjs")
    assert 'MAVAT_BROWSER_PROVIDER' in read("electron/main.cjs")
    assert "select_browser_endpoint" in read("web_app.py")
    assert "requestSingleInstanceLock" in read("electron/main.cjs")
    assert "window.show();\n    // A linked setting must also take effect" in read("electron/main.cjs")
    recorder = read("mavat_app/recorder.py")
    preview = read("mavat_app/preview_worker.py")
    assert "from mavat_app.cdp import" in recorder
    assert "from mavat_app.cdp import" in preview
    assert "sync_playwright" not in recorder
    assert "sync_playwright" not in preview
    assert "Windows Credential Manager" in read("web_app.py")
    assert "on_secret" in recorder
    assert 'event.method == "Page.frameNavigated"' in recorder
    assert '"recording-target"' in read("web_app.py")
    assert "_action_scopes" in read("mavat_app/workflow.py")
    assert '@sock.route("/ws/events")' in read("web_app.py")
    assert "/ws/events" in read("src/routes/recorder.tsx")
    assert "raw-cdp-websocket" in read("src/routes/recorder.tsx")
    recorder_route = read("src/routes/recorder.tsx")
    assert 'mavatApi("/api/chrome/open"' in recorder_route
    assert "window.mavatDesktop.automationEngine.command" not in recorder_route
    assert "await ensureChrome();" in recorder_route
    assert "scheduleReconnect" in read("automation-engine/worker.cjs")
    assert "openAndDockAutomationBrowser().catch" in read("electron/main.cjs")
    engine_test = read("tools/test_automation_engine.cjs")
    assert 'MAVAT_CHROME_CDP_PORT: "19223"' in engine_test
    sidebar = read("src/routes/__root.tsx") + read("src/components/app-sidebar.tsx")
    assert "mavat.sidebar.autoHide" in sidebar
    assert "הצמד את סרגל הצד" in sidebar
    assert "overlay={autoHide}" in sidebar

    extension_config = read("browser-extension/wxt.config.ts")
    assert '"sidePanel"' in extension_config
    assert '"storage"' in extension_config
    assert '"http://127.0.0.1/*"' in extension_config
    assert '"debugger"' not in extension_config
    assert '"nativeMessaging"' not in extension_config
    assert '"<all_urls>"' not in extension_config
    assert '@sock.route("/ws/extension")' in read("web_app.py")
    assert "ExtensionBridge" in read("web_app.py")
    assert "sync_playwright" not in read("browser-extension/entrypoints/sidepanel/api.ts")

    print("Architecture regression checks: OK")


if __name__ == "__main__":
    main()
