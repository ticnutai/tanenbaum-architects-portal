const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const URL = process.env.MAVAT_FLOATING_RECORDING_TEST_URL || "http://127.0.0.1:18479/app/";
const ARTIFACT = path.join(ROOT, "artifacts", "floating-recording-control.png");

async function main() {
  fs.mkdirSync(path.dirname(ARTIFACT), { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "he-IL" });
  const errors = [];
  const calls = { start: 0, stop: 0 };
  let recordingState = "idle";

  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.route("**/api/recording/status", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        state: recordingState,
        message: recordingState === "recording" ? "מקליט עכשיו" : "ההקלטה כבויה",
        transport: "raw-cdp-websocket",
        background: true,
      }),
    });
  });
  await page.route("**/api/recording/start", async (route) => {
    calls.start += 1;
    recordingState = "recording";
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, message: "ההקלטה הופעלה" }),
    });
  });
  await page.route("**/api/recording/stop", async (route) => {
    calls.stop += 1;
    recordingState = "idle";
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, message: "ההקלטה נעצרה" }),
    });
  });
  await page.route("**/api/chrome/status", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ connected: true, display_name: "BrowserOS" }),
    });
  });
  await page.route("**/api/run/status", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ state: "idle" }),
    });
  });

  try {
    await page.goto(URL, { waitUntil: "networkidle" });
    const control = page.getByTestId("floating-recording-control");
    await control.waitFor();

    await page.getByRole("button", { name: "התחל הקלטה" }).click();
    await page.getByRole("button", { name: "עצור הקלטה" }).waitFor();
    await page.getByText("מקליט עכשיו", { exact: true }).waitFor();
    assert.equal(calls.start, 1, "the floating control must call start exactly once");

    await page.getByRole("button", { name: "עצור הקלטה" }).click();
    await page.getByRole("button", { name: "התחל הקלטה" }).waitFor();
    await page.getByText("מוכן להקלטה", { exact: true }).waitFor();
    assert.equal(calls.stop, 1, "the floating control must call stop exactly once");

    await page.screenshot({ path: ARTIFACT, fullPage: true });
    assert.deepEqual(errors, [], `UI errors: ${errors.join(" | ")}`);
    console.log(JSON.stringify({ ok: true, calls, screenshot: ARTIFACT }));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
