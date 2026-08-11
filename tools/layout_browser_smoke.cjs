const path = require("path");
const { chromium } = require("playwright");

(async () => {
  const profileDir = path.join(__dirname, "..", ".runtime", "chrome", "layout-smoke");
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chrome",
    headless: false,
    locale: "he-IL",
    viewport: null,
    args: ["--start-maximized", "--lang=he-IL"],
  });
  const page = context.pages().at(-1) || await context.newPage();
  await page.goto("https://www.gov.il/he/service/mvat", { waitUntil: "domcontentloaded" });
  await new Promise((resolve) => setTimeout(resolve, 20000));
  await context.close();
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
