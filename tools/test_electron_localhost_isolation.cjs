const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const webUrl = process.env.MAVAT_QA_WEB_URL || "http://127.0.0.1:18474";
const apiBaseUrl = new URL(webUrl).origin;
const webBasePath = new URL(webUrl).pathname.replace(/\/$/, "");
const debugPort = Number(process.env.MAVAT_QA_DEBUG_PORT || 19384);
const durationMs = Number(process.env.MAVAT_QA_DURATION_MS || 20_000);
const automationEngineEnabled = process.env.MAVAT_QA_AUTOMATION_ENGINE === "1";
const expectBrowserOs = process.env.MAVAT_QA_EXPECT_BROWSEROS === "1";
const openAutomationBrowser = process.env.MAVAT_QA_OPEN_AUTOMATION_BROWSER === "1";
const sidebarStress = process.env.MAVAT_QA_SIDEBAR_STRESS === "1";
const backgroundThrottling = process.env.MAVAT_QA_BACKGROUND_THROTTLING !== "0";
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mavat-electron-localhost-"));
const electronExe = path.join(root, "node_modules", "electron", "dist", "electron.exe");

async function waitForUrl(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw lastError || new Error(`${url} did not become ready`);
}

async function waitForRendererPage(browser, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = browser.contexts().flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith(webUrl));
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Electron renderer page was not exposed over CDP");
}

(async () => {
  await waitForUrl(webUrl);
  await waitForUrl(`${apiBaseUrl}/api/workflow`);

  const child = spawn(electronExe, ["."], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      MAVAT_EXTERNAL_LOCALHOST_URL: webUrl,
      MAVAT_ELECTRON_ISOLATE_LOCALHOST: "1",
      MAVAT_ELECTRON_ISOLATE_AUTOMATION_ENGINE: automationEngineEnabled ? "1" : "0",
      MAVAT_AUTOMATION_ENGINE_AUTOCONNECT: automationEngineEnabled ? "1" : "0",
      MAVAT_ELECTRON_BACKGROUND_THROTTLING: backgroundThrottling ? "1" : "0",
      MAVAT_ELECTRON_START_HIDDEN: "1",
      MAVAT_ELECTRON_DEBUG_PORT: String(debugPort),
      MAVAT_ELECTRON_USER_DATA_DIR: userDataDir,
      MAVAT_QA_ALLOW_MULTI_INSTANCE: "1",
      MAVAT_BROWSER_AUTOSTART: "0",
      MAVAT_SKIP_BROWSER_AUTOSTART: "1",
      MAVAT_ENABLE_CONTINUOUS_TRACE: "0",
    },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });

  let browser;
  try {
    await waitForUrl(`http://127.0.0.1:${debugPort}/json/version`);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    const page = await waitForRendererPage(browser);
    await page.waitForLoadState("domcontentloaded");
    assert.equal(new URL(page.url()).origin, new URL(webUrl).origin);
    assert.equal(await page.evaluate(() => typeof window.mavatDesktop), "object");

    const pageErrors = [];
    const consoleErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    await page.locator(`a[href="${webBasePath}/projects"]`).waitFor({ state: "attached" });
    await page.locator(`a[href="${webBasePath}/workflow"]`).waitFor({ state: "attached" });

    if (sidebarStress) {
      await page.getByRole("button", { name: "הפעלת הסתרה אוטומטית" }).click();
      const sidebar = page.locator('[data-sidebar="sidebar"]').first();
      await sidebar.waitFor({ state: "attached" });
      for (let index = 0; index < 100; index += 1) {
        await sidebar.dispatchEvent(index % 2 === 0 ? "mouseenter" : "mouseleave");
      }
    }

    let engineStatus = await page.evaluate(() => window.mavatDesktop.automationEngine.status());
    assert.equal(engineStatus.processRunning, automationEngineEnabled);
    if (!automationEngineEnabled) {
      engineStatus = await page.evaluate(() => window.mavatDesktop.automationEngine.connect());
      assert.equal(engineStatus.state, "connected");
      engineStatus = await page.evaluate(() => window.mavatDesktop.automationEngine.disconnect());
      assert.equal(engineStatus.state, "ready");
      await page.locator(`a[href="${webBasePath}/settings"]`).click();
      await page.waitForURL(`${webUrl}/settings`);
      await page.getByText("מנוע האוטומציה", { exact: true }).first().waitFor();
      await page.getByLabel("ניתוק אוטומטי לאחר חוסר פעילות (דקות)").waitFor();
    }
    if (automationEngineEnabled) {
      engineStatus = await page.evaluate(() => window.mavatDesktop.automationEngine.command("status"));
      assert.equal(engineStatus.ready, true);
      if (openAutomationBrowser) {
        engineStatus = await page.evaluate(() => window.mavatDesktop.automationEngine.command("open-browser", {
          startUrl: `${window.location.origin}/automation-test.html`,
        }));
        assert.equal(engineStatus.browserOpen, true);
      }
    }

    let browserStatus = null;
    if (expectBrowserOs) {
      browserStatus = await page.evaluate(async () => {
        const response = await fetch("/api/chrome/status");
        if (!response.ok) throw new Error(`browser status returned ${response.status}`);
        return response.json();
      });
      assert.equal(browserStatus.connected, true);
      assert.equal(browserStatus.provider, "browseros");
      assert.equal(browserStatus.cdp_port, 9101);
    }

    const startedAt = Date.now();
    let probes = 0;
    while (Date.now() - startedAt < durationMs) {
      const value = await Promise.race([
        page.evaluate(() => performance.now()),
        new Promise((_, reject) => setTimeout(() => reject(new Error("renderer probe timed out")), 2_000)),
      ]);
      assert.equal(typeof value, "number");
      probes += 1;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const logFile = path.join(userDataDir, "logs", "desktop.log");
    const log = fs.readFileSync(logFile, "utf8");
    assert.match(log, /isolated-localhost-ready/);
    assert.match(log, automationEngineEnabled ? /automation-engine-autoconnected/ : /automation-engine-lazy/);
    assert.doesNotMatch(log, /python-ready|vite-ready|renderer-probe-stalled|renderer-unresponsive/);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(consoleErrors, []);
    console.log(JSON.stringify({
      ok: true,
      probes,
      durationMs,
      url: page.url(),
      automationEngineEnabled,
      engineStatus,
      openAutomationBrowser,
      expectBrowserOs,
      browserStatus,
      sidebarStress,
      backgroundThrottling,
      stderr: stderr.trim(),
    }, null, 2));
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (child.exitCode === null) child.kill();
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
