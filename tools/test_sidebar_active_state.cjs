const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const baseUrl = process.env.MAVAT_QA_URL || "http://127.0.0.1:18474";
const cases = [
  ["/", "לוח בקרה"],
  ["/workflow", "שלבי עבודה"],
  ["/logs", "יומן ריצה"],
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "he-IL" });
    for (const [route, expected] of cases) {
      await page.goto(`${baseUrl}${route}`, { waitUntil: "networkidle" });
      const state = await page.locator("[data-sidebar=menu-button]").evaluateAll((buttons) => ({
        activeButtons: buttons.filter((button) => button.dataset.active === "true").map((button) => button.textContent.trim()),
      }));
      assert.deepEqual(state.activeButtons, [expected], `${route}: expected one active sidebar button`);
    }
    console.log(`Sidebar active state: ${cases.length}/${cases.length} routes passed`);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
