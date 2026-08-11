const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const PROFILE_DIR = process.env.MAVAT_AUTOMATION_PROFILE_DIR || path.join(ROOT, ".runtime", "chrome", "mavat");
const ARTIFACTS_DIR = path.join(ROOT, "run_logs", "playwright");
const CDP_PORT = Number(process.env.MAVAT_CHROME_CDP_PORT || 9223);
// Chrome מפרסם את WebSocket של DevTools תחת localhost. שימוש באותה כתובת
// מונע socket hang up בגרסאות Chrome חדשות שבהן IPv4/IPv6 נפתרים בנפרד.
const CDP_URL = `http://localhost:${CDP_PORT}`;

let browser = null;
let context = null;
let activePage = null;
let chromeProcess = null;
let profileSetupProcess = null;
let runController = null;
let manualResolver = null;

function send(message) {
  if (process.send) process.send(message);
  else process.stdout.write(`${JSON.stringify(message)}\n`);
}

function event(type, payload = {}) {
  send({ kind: "event", type, at: new Date().toISOString(), ...payload });
}

function reply(id, ok, result = {}, error = "") {
  send({ kind: "reply", id, ok, result, error });
}

function engineStatus() {
  return {
    ready: true,
    browserOpen: Boolean(context),
    profilePreparing: Boolean(profileSetupProcess),
    running: Boolean(runController),
    page: activePage ? { title: "", url: activePage.url() } : null,
    profileDir: PROFILE_DIR,
    mode: "google-chrome-cdp",
  };
}

async function publishStatus() {
  const status = engineStatus();
  if (activePage) {
    try { status.page.title = await activePage.title(); } catch { /* navigation in progress */ }
  }
  event("status", { status });
  return status;
}

function findChrome() {
  const candidates = [
    process.env.MAVAT_CHROME_PATH,
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
    process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
  ].filter(Boolean);
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) throw new Error("Google Chrome לא נמצא במחשב. יש להתקין Chrome או להגדיר MAVAT_CHROME_PATH");
  return executable;
}

async function waitForCdp(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${CDP_URL}/json/version`);
      if (response.ok) return;
    } catch { /* Chrome עדיין עולה */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Chrome נפתח אך ממשק החיבור המקומי לא היה זמין בזמן");
}

async function launchAndConnectChrome() {
  if (profileSetupProcess) {
    throw new Error("חלון הכנת הפרופיל עדיין פתוח. יש להשלים את הכניסה, לסגור את Chrome ואז לפתוח את דפדפן האוטומציה");
  }
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const executable = findChrome();
  chromeProcess = spawn(executable, [
    `--remote-debugging-port=${CDP_PORT}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${PROFILE_DIR}`,
    "--start-maximized",
    "--lang=he-IL",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ], { detached: false, windowsHide: false, stdio: "ignore" });
  chromeProcess.once("exit", () => {
    chromeProcess = null;
  });
  await waitForCdp();
  browser = await chromium.connectOverCDP(CDP_URL);
  browser.on("disconnected", () => {
    browser = null;
    context = null;
    activePage = null;
    event("browser-closed");
    void publishStatus();
  });
  context = browser.contexts()[0];
  if (!context) throw new Error("Chrome נפתח אך לא נמצא בו פרופיל פעיל");
}

async function prepareChromeProfile() {
  if (browser) await browser.close();
  if (profileSetupProcess) throw new Error("חלון הכנת הפרופיל כבר פתוח");
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  profileSetupProcess = spawn(findChrome(), [
    `--user-data-dir=${PROFILE_DIR}`,
    "--start-maximized",
    "--lang=he-IL",
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    "https://accounts.google.com/",
  ], { detached: false, windowsHide: false, stdio: "ignore" });
  profileSetupProcess.once("exit", () => {
    profileSetupProcess = null;
    event("profile-setup-closed");
    void publishStatus();
  });
  event("profile-setup-opened", { profileDir: PROFILE_DIR });
  await publishStatus();
}

function attachPage(page) {
  activePage = page;
  page.on("console", (message) => event("console", {
    level: message.type(), text: message.text(), url: page.url(),
  }));
  page.on("pageerror", (error) => event("console", {
    level: "pageerror", text: error.message, url: page.url(),
  }));
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) event("navigation", { url: frame.url() });
  });
  void publishStatus();
}

async function ensureBrowser(startUrl = "") {
  if (!context) {
    await launchAndConnectChrome();
    context.on("page", attachPage);
    const existing = context.pages();
    attachPage(existing.at(-1) || await context.newPage());
    event("browser-opened", { profileDir: PROFILE_DIR, mode: "google-chrome-cdp" });
  }
  if (startUrl && activePage && activePage.url() !== startUrl) {
    await activePage.goto(startUrl, { waitUntil: "domcontentloaded" });
  }
  await publishStatus();
  return activePage;
}

function resolveTemplate(value, record) {
  return String(value ?? "").replace(/\{([^{}]+)\}/g, (match, key) => {
    if (key === "username") return String(record.username ?? "");
    return Object.prototype.hasOwnProperty.call(record, key) ? String(record[key] ?? "") : match;
  });
}

function locatorFrom(page, candidate, record) {
  const value = resolveTemplate(candidate.value, record);
  switch (candidate.strategy) {
    case "role": return page.getByRole(candidate.role || "button", { name: value, exact: false });
    case "label": return page.getByLabel(value, { exact: false });
    case "placeholder": return page.getByPlaceholder(value, { exact: false });
    case "testid": return page.getByTestId(value);
    case "text": return page.getByText(value, { exact: false });
    case "css": return page.locator(value);
    default: return null;
  }
}

async function smartAction(page, step, record, fillValue) {
  const candidates = [step.locator, ...(step.fallbacks || [])].filter(Boolean);
  let lastError = null;
  for (const candidate of candidates) {
    try {
      if (candidate.strategy === "position") {
        const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        await page.mouse.click((candidate.x_ratio || 0.5) * viewport.width, (candidate.y_ratio || 0.5) * viewport.height);
        if (fillValue !== undefined) await page.keyboard.insertText(fillValue);
        return;
      }
      const locator = locatorFrom(page, candidate, record);
      if (!locator) continue;
      if (await locator.count() !== 1) throw new Error(`המזהה מצא ${await locator.count()} רכיבים במקום רכיב אחד`);
      if (fillValue === undefined) await locator.click();
      else await locator.fill(fillValue);
      return;
    } catch (error) { lastError = error; }
  }
  throw new Error(`לא נמצא רכיב יציב: ${lastError?.message || step.target || step.name}`);
}

async function verifyPostcondition(page, step, record) {
  const expected = step.postcondition || {};
  if (expected.url) await page.waitForURL(new RegExp(resolveTemplate(expected.url, record)));
  if (expected.text) await page.getByText(resolveTemplate(expected.text, record), { exact: false }).waitFor({ state: "visible" });
}

async function executeStep(page, step, record, signal) {
  if (signal.aborted) throw new Error("ההרצה נעצרה");
  const action = step.type;
  const target = resolveTemplate(step.target, record);
  const value = resolveTemplate(step.value, record);
  const timeout = Math.max(1000, Number(step.timeout_seconds || 30) * 1000);
  page.setDefaultTimeout(timeout);
  page.setDefaultNavigationTimeout(timeout);

  if (action === "goto") await page.goto(value || target, { waitUntil: "domcontentloaded" });
  else if (action === "click_role") await page.getByRole(value || "button", { name: target, exact: false }).click();
  else if (action === "click_text") await page.getByText(target, { exact: false }).click();
  else if (action === "fill_label") await page.getByLabel(target, { exact: false }).fill(value);
  else if (action === "fill_placeholder") await page.getByPlaceholder(target, { exact: false }).fill(value);
  else if (action === "smart_click") await smartAction(page, step, record, undefined);
  else if (action === "smart_fill") await smartAction(page, step, record, value);
  else if (action === "select_option") {
    const control = page.getByLabel(target, { exact: false }).first();
    const tagName = await control.evaluate((element) => element.tagName.toLowerCase());
    if (tagName === "select") {
      try { await control.selectOption({ label: value }); }
      catch { await control.selectOption({ value }); }
    } else {
      await control.click();
      try { await control.fill(value); }
      catch { await page.keyboard.insertText(value); }
      const option = page.getByRole("option", { name: value, exact: false });
      if (await option.count()) await option.first().click();
      else await page.getByText(value, { exact: true }).last().click();
    }
  }
  else if (action === "check") await page.getByLabel(target, { exact: false }).check();
  else if (action === "wait_text") await page.getByText(target, { exact: false }).waitFor({ state: "visible" });
  else if (action === "wait_url") await page.waitForURL(new RegExp(target || value));
  else if (action === "delay") await page.waitForTimeout(Number(value || target || 1) * 1000);
  else if (action === "screenshot") await page.screenshot({ path: path.join(ARTIFACTS_DIR, value || `step-${Date.now()}.png`), fullPage: true });
  else if (action === "manual") {
    event("manual-required", { message: value || target || "נדרשת פעולה ידנית" });
    await new Promise((resolve) => { manualResolver = resolve; });
    manualResolver = null;
  } else if (action === "noop") return;
  else if (action === "fill_secret") throw new Error("סיסמה נדרשת דרך כספת Windows; היא אינה מתקבלת מתוך נתוני האוטומציה");
  else throw new Error(`סוג פעולה אינו נתמך במנוע החדש: ${action}`);
  await verifyPostcondition(page, step, record);
}

async function runWorkflow(command) {
  if (runController) throw new Error("כבר קיימת הרצה פעילה");
  const workflow = command.workflow;
  if (!workflow || !Array.isArray(workflow.steps)) throw new Error("מבנה האוטומציה אינו תקין");
  const records = Array.isArray(command.records) && command.records.length ? command.records : [{}];
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const page = await ensureBrowser(command.startUrl || "");
  runController = new AbortController();
  event("run-started", { workflow: workflow.name, records: records.length });
  await publishStatus();
  try {
    for (let rowIndex = 0; rowIndex < records.length; rowIndex += 1) {
      const record = records[rowIndex];
      for (let stepIndex = 0; stepIndex < workflow.steps.length; stepIndex += 1) {
        const step = workflow.steps[stepIndex];
        if (step.enabled === false || (step.scope === "once" && rowIndex > 0)) continue;
        event("step-started", { row: rowIndex + 1, step: stepIndex + 1, name: step.name, action: step.type });
        try {
          await executeStep(page, step, record, runController.signal);
          event("step-completed", { row: rowIndex + 1, step: stepIndex + 1, name: step.name, url: page.url() });
        } catch (error) {
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          const screenshot = path.join(ARTIFACTS_DIR, `${stamp}-step-${stepIndex + 1}.png`);
          try { await page.screenshot({ path: screenshot, fullPage: true }); } catch { /* best effort */ }
          event("step-failed", { row: rowIndex + 1, step: stepIndex + 1, name: step.name, action: step.type, url: page.url(), error: error.message, screenshot });
          throw error;
        }
      }
    }
    event("run-completed", { workflow: workflow.name });
  } finally {
    runController = null;
    await publishStatus();
  }
}

async function handle(message) {
  const { id, command, payload = {} } = message;
  try {
    if (command === "status") return reply(id, true, await publishStatus());
    if (command === "open-browser") {
      await ensureBrowser(payload.startUrl || "https://www.gov.il/he/service/mvat");
      return reply(id, true, await publishStatus());
    }
    if (command === "prepare-profile") {
      await prepareChromeProfile();
      return reply(id, true, await publishStatus());
    }
    if (command === "close-browser") {
      if (browser) await browser.close();
      return reply(id, true, engineStatus());
    }
    if (command === "continue") {
      if (!manualResolver) throw new Error("אין שלב ידני שממתין להמשך");
      manualResolver();
      return reply(id, true, { continued: true });
    }
    if (command === "stop") {
      if (runController) runController.abort();
      if (manualResolver) manualResolver();
      return reply(id, true, { stopped: true });
    }
    if (command === "run") {
      void runWorkflow(payload).catch((error) => event("run-failed", { error: error.message }));
      return reply(id, true, { accepted: true });
    }
    throw new Error(`פקודה לא מוכרת: ${command}`);
  } catch (error) {
    reply(id, false, {}, error.message || String(error));
  }
}

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  try { void handle(JSON.parse(line)); }
  catch (error) { event("protocol-error", { error: error.message }); }
});
process.on("message", (message) => { void handle(message); });

process.on("SIGTERM", async () => {
  try {
    if (browser) await browser.close();
    if (chromeProcess && !chromeProcess.killed) chromeProcess.kill();
    if (profileSetupProcess && !profileSetupProcess.killed) profileSetupProcess.kill();
  } finally { process.exit(0); }
});

event("ready", { status: engineStatus() });
