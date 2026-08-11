from playwright.sync_api import sync_playwright

from mavat_app.recorder import RECORDER_SCRIPT


with sync_playwright() as playwright:
    browser = playwright.chromium.connect_over_cdp(
        "http://127.0.0.1:9223", timeout=5000
    )
    print("contexts", len(browser.contexts))
    for page in browser.contexts[0].pages:
        print("PAGE", page.title(), page.url)
        if not page.url.startswith("http"):
            continue
        try:
            page.evaluate(RECORDER_SCRIPT)
            installed = page.evaluate("() => !!window.__mavatRecorderInstalled")
            queue_length = page.evaluate(
                "() => (window.__mavatRecordedActions || []).length"
            )
            print(" installed=", installed, "queue=", queue_length)
        except Exception as exc:
            print(" ERROR", type(exc).__name__, str(exc)[:300])
