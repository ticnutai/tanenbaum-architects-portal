const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const EXTENSION_PATH = path.join(ROOT, "browser-extension", ".output", "chrome-mv3");
const BACKEND = process.env.MAVAT_EXTENSION_TEST_URL || "http://127.0.0.1:18473";
const ARTIFACTS = path.join(ROOT, "artifacts", "extension-sidepanel");

async function jsonRequest(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const data = await response.json();
  if (!response.ok || data.ok === false)
    throw new Error(data.error || data.message || `HTTP ${response.status}`);
  return data;
}

async function main() {
  assert.ok(
    fs.existsSync(path.join(EXTENSION_PATH, "manifest.json")),
    "Build the extension before QA",
  );
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "mavat-extension-qa-"));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    viewport: { width: 420, height: 900 },
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  });
  const consoleErrors = [];
  try {
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 15_000 });
    const extensionId = new URL(worker.url()).host;
    assert.match(extensionId, /^[a-p]{32}$/);
    console.log(`EXTENSION_ID=${extensionId}`);

    const pairing = await jsonRequest(`${BACKEND}/api/extension/admin/pairing-code`, {
      method: "POST",
    });
    assert.match(pairing.pairing_code, /^\d{6}$/);

    const page = await context.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByLabel("קוד שמופיע בהגדרות התוכנה").fill(pairing.pairing_code);
    await page.getByRole("button", { name: "חיבור לתוכנה" }).click();
    await page.getByText("שלבים שהוקלטו").waitFor({ timeout: 10_000 });
    await page.getByText("מחובר למנוע ההקלטה").waitFor({ timeout: 10_000 });
    const liveStatus = await jsonRequest(`${BACKEND}/api/extension/admin/status`);
    assert.ok(liveStatus.paired_count >= 1, "paired extension was not reported");
    assert.ok(liveStatus.live_count >= 1, "live WebSocket connection was not reported");

    const count = page.locator(".steps-heading > span");
    const countText = await count.textContent();
    assert.match(countText || "", /^\d+$/);
    const initialCount = Number(countText);
    if (initialCount > 0) {
      const firstStep = page.locator(".step-card").first();
      await firstStep.getByRole("button", { name: /^פעולות עבור/ }).click();
      await firstStep.getByRole("button", { name: "עריכה" }).click();
      await firstStep.locator("input").fill("שלב בדיקת סיידבר");
      await firstStep.getByRole("button", { name: "שמור" }).click();
      await firstStep.getByText("שלב בדיקת סיידבר", { exact: true }).waitFor();

      await firstStep.getByRole("button", { name: /^פעולות עבור/ }).click();
      await firstStep.getByRole("button", { name: "שכפול" }).click();
      await page.waitForFunction(
        (expected) =>
          document.querySelector(".steps-heading > span")?.textContent === String(expected),
        initialCount + 1,
      );
      await page.getByRole("button", { name: /ביטול אחרון/ }).click();
      await page.waitForFunction(
        (expected) =>
          document.querySelector(".steps-heading > span")?.textContent === String(expected),
        initialCount,
      );

      const currentFirst = page.locator(".step-card").first();
      const wasPaused = await currentFirst.evaluate((element) =>
        element.classList.contains("step-paused"),
      );
      await currentFirst.getByRole("button", { name: /^פעולות עבור/ }).click();
      await currentFirst.getByRole("button", { name: wasPaused ? "הפעלה" : "השהיה" }).click();
      await page.waitForFunction(
        (paused) =>
          document.querySelector(".step-card")?.classList.contains("step-paused") === paused,
        !wasPaused,
      );
      await currentFirst.getByRole("button", { name: /^פעולות עבור/ }).click();
      await currentFirst.getByRole("button", { name: wasPaused ? "השהיה" : "הפעלה" }).click();
    }
    await page.getByRole("button", { name: "פתיחת העורך" }).click();
    await page.screenshot({ path: path.join(ARTIFACTS, "connected.png"), fullPage: true });

    assert.deepEqual(consoleErrors, [], `Side panel console errors: ${consoleErrors.join(" | ")}`);
    console.log(
      JSON.stringify({
        ok: true,
        extensionId,
        steps: Number(countText),
        screenshot: path.join(ARTIFACTS, "connected.png"),
      }),
    );
  } finally {
    await context.close();
    const tempRoot = path.resolve(os.tmpdir()) + path.sep;
    const resolvedProfile = path.resolve(profile);
    if (
      resolvedProfile.startsWith(tempRoot) &&
      path.basename(resolvedProfile).startsWith("mavat-extension-qa-")
    ) {
      fs.rmSync(resolvedProfile, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
