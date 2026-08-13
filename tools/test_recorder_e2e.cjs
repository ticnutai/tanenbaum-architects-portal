const { chromium } = require("playwright");

const API = "http://127.0.0.1:18473";
const CDP = "http://127.0.0.1:9223";
const FIXTURE = "http://127.0.0.1:18999/gov.il-recorder-e2e.html";

async function json(url, init) {
  const response = await fetch(url, init);
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error || data.message || `${response.status}`);
  return data;
}

async function waitForRecording(expected, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await json(`${API}/api/recording/status`);
    if (status.state === expected) return status;
    if (status.state === "error") throw new Error(status.message);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`recording did not reach ${expected}`);
}

(async () => {
  const browser = await chromium.connectOverCDP(CDP);
  const context = browser.contexts()[0];
  const page = context.pages().at(-1) || (await context.newPage());
  await page.goto(FIXTURE, { waitUntil: "domcontentloaded" });

  const before = await json(`${API}/api/workflow`);
  const beforeCount = before.workflow.steps.length;
  await json(`${API}/api/recording/start`, { method: "POST" });
  await waitForRecording("recording");

  await page.getByLabel("שם לקוח").fill("לקוח בדיקת E2E");
  await page.getByLabel("ועדה").selectOption({ label: "שדות דן" });
  await page.getByRole("button", { name: "שמירת בדיקה" }).click();
  await page.waitForTimeout(1200);

  await json(`${API}/api/recording/stop`, { method: "POST" });
  await waitForRecording("idle");
  const after = await json(`${API}/api/workflow`);
  const added = after.workflow.steps.slice(beforeCount);
  const expectedTypes = ["smart_fill", "select_option", "smart_click"];
  if (added.length !== 3) throw new Error(`expected 3 saved steps, got ${added.length}`);
  if (expectedTypes.some((type) => added.filter((step) => step.type === type).length !== 1)) {
    throw new Error(`unexpected step sequence: ${added.map((step) => step.type).join(", ")}`);
  }
  console.log(JSON.stringify({ beforeCount, afterCount: after.workflow.steps.length, added }, null, 2));
  process.exit(0);
})().catch(async (error) => {
  try { await json(`${API}/api/recording/stop`, { method: "POST" }); } catch {}
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
