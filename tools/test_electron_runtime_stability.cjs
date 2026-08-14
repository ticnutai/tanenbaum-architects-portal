const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const executable = process.env.MAVAT_QA_EXECUTABLE
  || path.join(root, "release", "win-unpacked", "Mavat Automation.exe");
const debugPort = Number(process.env.MAVAT_QA_DEBUG_PORT || 19333);
const durationMs = Number(process.env.MAVAT_QA_DURATION_MS || 120_000);
const isolatedUserDataDir = !process.env.MAVAT_QA_USER_DATA_DIR;
const userDataDir = process.env.MAVAT_QA_USER_DATA_DIR
  || fs.mkdtempSync(path.join(os.tmpdir(), "mavat-electron-qa-"));
const appDataDir = process.env.MAVAT_QA_APP_DATA_DIR || path.join(userDataDir, "data");
const logFile = path.join(userDataDir, "logs", "desktop.log");
const initialLogSize = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.setTimeout(1000, () => request.destroy(new Error(`timeout: ${url}`)));
    request.on("error", reject);
  });
}

async function waitForTarget() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${debugPort}/json/list`);
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // Electron and the embedded backend are still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Electron DevTools target did not become ready");
}

function connectCdp(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  return {
    ready,
    call(method, params = {}, timeoutMs = 3000) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { socket.close(); },
  };
}

function stopProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 10_000,
    });
  } else {
    child.kill("SIGTERM");
  }
}

async function waitForUi(cdp) {
  const deadline = Date.now() + 60_000;
  let lastValue = null;
  while (Date.now() < deadline) {
    try {
      const result = await cdp.call("Runtime.evaluate", {
        expression: "({ href: location.href, ready: document.readyState, buttons: document.querySelectorAll('button').length, version: document.querySelector('[data-testid=app-version]')?.textContent?.trim() || '' })",
        returnByValue: true,
      });
      lastValue = result.result.value;
      if (
        lastValue.ready === "complete" &&
        lastValue.buttons > 0 &&
        /^גרסה\s+\d+\.\d+\.\d+$/.test(lastValue.version) &&
        /\/app\/?/.test(lastValue.href)
      ) {
        return lastValue;
      }
    } catch {
      // The first document may still be replaced by the packaged application.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Packaged UI did not become ready: ${JSON.stringify(lastValue)}`);
}

async function evaluate(cdp, expression, timeoutMs = 3000) {
  const result = await cdp.call("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, timeoutMs);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result.value;
}

async function waitForHref(cdp, suffix, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let href = "";
  while (Date.now() < deadline) {
    try {
      href = await evaluate(cdp, "location.href");
      if (new URL(href).pathname.endsWith(suffix)) return href;
    } catch {
      // A failed evaluation is useful evidence only if the route never settles.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Electron did not navigate to ${suffix}; last URL: ${href}`);
}

async function clickSidebarRoute(cdp, suffix) {
  const clicked = await evaluate(cdp, `(() => {
    const link = [...document.querySelectorAll('a[href]')].find((item) => new URL(item.href).pathname.endsWith(${JSON.stringify("__SUFFIX__")}));
    if (!link) return false;
    link.click();
    return true;
  })()`.replace('"__SUFFIX__"', JSON.stringify(suffix)));
  assert.equal(clicked, true, `Missing sidebar link for ${suffix}`);
  return waitForHref(cdp, suffix);
}

async function clickButtonByText(cdp, text) {
  const clicked = await evaluate(cdp, `(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === ${JSON.stringify("__TEXT__")});
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`.replace('"__TEXT__"', JSON.stringify(text)));
  assert.equal(clicked, true, `Missing enabled button: ${text}`);
}

async function waitForEngineState(cdp, expectedRunning, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let status = null;
  while (Date.now() < deadline) {
    try {
      status = await evaluate(cdp, "window.mavatDesktop.automationEngine.status()");
      if (status.processRunning === expectedRunning) return status;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Automation engine did not reach processRunning=${expectedRunning}: ${JSON.stringify(status)}`);
}

async function main() {
  assert.ok(fs.existsSync(executable), `Packaged executable is missing: ${executable}`);
  let qaPassed = false;
  const child = spawn(executable, [], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      MAVAT_ELECTRON_USER_DATA_DIR: userDataDir,
      MAVAT_DATA_DIR: appDataDir,
      MAVAT_ELECTRON_DEBUG_PORT: String(debugPort),
      MAVAT_PYTHON_PORT: "19473",
      MAVAT_ELECTRON_START_HIDDEN: process.env.MAVAT_QA_START_HIDDEN || "1",
      MAVAT_QA_ALLOW_MULTI_INSTANCE: "1",
      MAVAT_SKIP_BROWSER_AUTOSTART: process.env.MAVAT_QA_SKIP_BROWSER_AUTOSTART || "1",
      MAVAT_BROWSER_AUTOSTART: process.env.MAVAT_QA_BROWSER_AUTOSTART || "0",
      MAVAT_DIAGNOSTICS_CPU_PROFILE: "0",
      MAVAT_ENABLE_CONTINUOUS_TRACE: "0",
    },
  });
  let stderr = "";
  child.stdout.on("data", (chunk) => process.stdout.write(`[electron] ${chunk}`));
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
    process.stderr.write(`[electron-error] ${chunk}`);
  });
  child.once("exit", (code, signal) => {
    if (!qaPassed) process.stderr.write(`[electron-exit] code=${code} signal=${signal}\n`);
  });

  let cdp;
  try {
    const target = await waitForTarget();
    cdp = connectCdp(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.call("Runtime.enable");
    const initialUi = await waitForUi(cdp);
    const documentTimeOrigin = await evaluate(cdp, "performance.timeOrigin");
    const routeSequence = (process.env.MAVAT_QA_ROUTE_SEQUENCE || "logs,settings")
      .split(",")
      .map((route) => `/${route.trim().replace(/^\/+/, "")}`)
      .filter((route) => route.length > 1);
    for (const route of routeSequence) await clickSidebarRoute(cdp, route);
    const settingsState = await evaluate(cdp, `({
      href: location.href,
      heading: document.querySelector('h1')?.textContent?.trim() || '',
      timeOrigin: performance.timeOrigin,
      controls: document.querySelectorAll('button,input,select').length,
    })`);
    if (routeSequence.at(-1) === "/settings") {
      assert.match(settingsState.heading, /הגדרות/, "Settings heading did not render after navigation");
      assert.ok(settingsState.controls > 0, "Settings lost its interactive controls");
    }
    assert.equal(
      settingsState.timeOrigin,
      documentTimeOrigin,
      "Logs to Settings replaced the Electron document instead of using SPA navigation",
    );
    let engineLifecycle = null;
    if (process.env.MAVAT_QA_AUTOMATION_ENGINE === "1") {
      await clickButtonByText(cdp, "חיבור עכשיו");
      const connected = await waitForEngineState(cdp, true);
      assert.equal(connected.processRunning, true, "Automation worker did not start");
      assert.equal(connected.state, "connected", "Automation worker did not become connected");
      const workerStatus = await evaluate(cdp, "window.mavatDesktop.automationEngine.command('status')", 15_000);
      assert.equal(workerStatus.ready, true, "Automation worker did not answer a real command");
      engineLifecycle = { connected, workerStatus };
    }
    const startedAt = Date.now();
    let probes = 0;
    let maxProbeMs = 0;
    while (Date.now() - startedAt < durationMs) {
      const before = Date.now();
      const result = await cdp.call("Runtime.evaluate", {
        expression: "({ now: performance.now(), ready: document.readyState, buttons: document.querySelectorAll('button').length })",
        returnByValue: true,
      });
      const elapsed = Date.now() - before;
      maxProbeMs = Math.max(maxProbeMs, elapsed);
      assert.equal(result.result.value.ready, "complete");
      assert.ok(result.result.value.buttons > 0, "The packaged UI lost its controls");
      probes += 1;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const fullLog = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
    // A real-data run may reuse a diagnostic log containing an old, already
    // fixed stall. Validate only bytes written by this QA launch.
    const log = fullLog.length >= initialLogSize ? fullLog.slice(initialLogSize) : fullLog;
    assert.doesNotMatch(log, /renderer-(?:probe-stalled|unresponsive|gone)/, log.slice(-4000));
    assert.doesNotMatch(log, /\[(?:python-exit|load-error)\]/, log.slice(-4000));
    assert.ok(probes >= Math.floor(durationMs / 700), `Too few renderer probes: ${probes}`);
    assert.ok(maxProbeMs < 1500, `Renderer probe latency was ${maxProbeMs}ms`);
    if (engineLifecycle) {
      await clickButtonByText(cdp, "ניתוק עכשיו");
      const disconnected = await waitForEngineState(cdp, false);
      assert.equal(disconnected.processRunning, false, "Automation worker did not stop cleanly");
      assert.equal(disconnected.state, "ready", "Automation worker did not return to lazy-ready state");
      engineLifecycle.disconnected = disconnected;
    }
    if (process.env.MAVAT_QA_GRACEFUL_CLOSE === "1") {
      // A successful window.close() destroys the DevTools target before CDP can
      // always acknowledge Runtime.evaluate. The process exit is authoritative.
      void cdp.call("Runtime.evaluate", { expression: "window.close()" }).catch(() => undefined);
      const exit = await Promise.race([
        new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Graceful Electron close timed out")), 10_000)),
      ]);
      assert.equal(exit.code, 0, `Electron exited abnormally: ${JSON.stringify(exit)}`);
      assert.doesNotMatch(stderr, /Object has been destroyed|Uncaught Exception/, stderr);
    }
    console.log(JSON.stringify({ ok: true, durationMs, probes, maxProbeMs, initialUi, settingsState, engineLifecycle, logFile }));
    qaPassed = true;
  } finally {
    cdp?.close();
    stopProcessTree(child);
    if (qaPassed && isolatedUserDataDir) {
      try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch {}
    } else {
      process.stderr.write(`[qa-artifacts] ${userDataDir}\n`);
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
