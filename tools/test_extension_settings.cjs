const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const URL = process.env.MAVAT_SETTINGS_TEST_URL || "http://127.0.0.1:18473/app/settings";
const ARTIFACTS = path.join(ROOT, "artifacts", "extension-sidepanel");

async function main() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "he-IL" });
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(URL, { waitUntil: "networkidle" });
    const card = page.getByText("סיידבר הקלטה ב־BrowserOS", { exact: true });
    await card.waitFor();
    await page.getByRole("button", { name: "יצירת קוד חיבור" }).click();
    const code = page.locator("p.font-mono");
    await code.waitFor();
    assert.match((await code.textContent())?.trim() || "", /^\d{6}$/);
    await page.screenshot({ path: path.join(ARTIFACTS, "settings.png"), fullPage: true });
    assert.deepEqual(errors, [], `Settings console errors: ${errors.join(" | ")}`);
    console.log(JSON.stringify({ ok: true, screenshot: path.join(ARTIFACTS, "settings.png") }));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
