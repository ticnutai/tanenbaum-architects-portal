from __future__ import annotations

import threading
import time

from playwright.sync_api import sync_playwright

from mavat_app.recorder import BrowserRecorder


steps = []
logs = []
started = threading.Event()
finished = threading.Event()

recorder = BrowserRecorder(
    9223,
    on_log=logs.append,
    on_step=steps.append,
    on_started=lambda _text: started.set(),
    on_finished=lambda text: (logs.append(text), finished.set()),
)
worker = threading.Thread(target=recorder.run, daemon=True)
worker.start()
if not started.wait(8):
    raise RuntimeError("Recorder did not start: " + " | ".join(logs))

with sync_playwright() as playwright:
    browser = playwright.chromium.connect_over_cdp(
        "http://127.0.0.1:9223", timeout=5000
    )
    page = next(
        page
        for page in browser.contexts[0].pages
        if "gov.il" in page.url.lower() or "mavat.moin.gov.il" in page.url.lower()
    )
    page.evaluate(
        """() => window.__mavatRecordedActions.push({
          kind: 'click', role: 'button', name: 'בדיקת מקלט פנימית',
          url: location.href, at: Date.now()
        })"""
    )

deadline = time.time() + 8
while time.time() < deadline and not steps:
    time.sleep(0.1)
recorder.stop()
worker.join(5)

assert steps, "Recorder did not receive the synthetic click"
assert steps[0]["type"] == "click_role"
assert steps[0]["target"] == "בדיקת מקלט פנימית"
print("Live recorder test: OK")
