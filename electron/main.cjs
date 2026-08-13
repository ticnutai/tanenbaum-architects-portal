const { app, BrowserWindow, clipboard, contentTracing, dialog, globalShortcut, ipcMain, Menu, screen, shell, utilityProcess } = require("electron");
const { spawn, execFile } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");

app.setName("Mavat Automation");
if (process.env.MAVAT_ELECTRON_USER_DATA_DIR) {
  app.setPath("userData", path.resolve(process.env.MAVAT_ELECTRON_USER_DATA_DIR));
}

// Keep a localhost-only DevTools endpoint available for end-to-end health
// checks. It never exposes the renderer outside this computer.
app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
app.commandLine.appendSwitch("remote-debugging-port", process.env.MAVAT_ELECTRON_DEBUG_PORT || "9333");

const ROOT = path.resolve(__dirname, "..");
const RESOURCE_ROOT = app.isPackaged ? process.resourcesPath : ROOT;
const PYTHON_ROOT = app.isPackaged ? path.join(RESOURCE_ROOT, "python-app") : ROOT;
const AUTOMATION_PROFILE = app.isPackaged
  ? path.join(app.getPath("userData"), "chrome", "mavat")
  : path.join(ROOT, ".runtime", "chrome", "mavat");
const preferredPythonPort = Number(process.env.MAVAT_PYTHON_PORT || 18473);
let pythonPort = preferredPythonPort;
let PYTHON_URL = `http://127.0.0.1:${pythonPort}`;
const WEB_URL = "http://127.0.0.1:18474";
const START_HIDDEN = process.env.MAVAT_ELECTRON_START_HIDDEN === "1";
// Attach Playwright lazily. An already-open browser can emit a very large CDP
// stream, so startup must remain responsive before recording or running.
const BROWSER_AUTOSTART = process.env.MAVAT_BROWSER_AUTOSTART === "1"
  && process.env.MAVAT_SKIP_BROWSER_AUTOSTART !== "1";
let pythonProcess = null;
let webProcess = null;
let mainWindow = null;
let automationProcess = null;
let windowLinkProcess = null;
let linkedWindows = false;
let activeAutomationProfile = AUTOMATION_PROFILE;
let automationSequence = 0;
const automationRequests = new Map();
const electronWindows = new Set();
const automationEventSubscribers = new Set();
let automationEventSummary = new Map();
let automationEventSummaryTimer = null;
let rendererReloadTimer = null;
let rendererReloadHistory = [];
let appIsQuitting = false;
let desktopLogStream = null;
let diagnosticsTimer = null;
let rendererProbePending = false;
let rendererProbeStartedAt = 0;
let rendererProbeLastOkAt = 0;
let rendererProbeLastReportedAt = 0;
let lastRendererPulse = null;
let tracingActive = false;
let traceStopPending = false;
const apiRequests = new Map();
let apiRequestSummary = new Map();

const MAX_DESKTOP_LOG_BYTES = 5 * 1024 * 1024;
const DIAGNOSTICS_INTERVAL_MS = 1000;
const RENDERER_STALL_MS = 3000;

function logPath() {
  const directory = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, "desktop.log");
}

function rotateDesktopLogIfNeeded() {
  const target = logPath();
  try {
    if (!fs.existsSync(target) || fs.statSync(target).size < MAX_DESKTOP_LOG_BYTES) return;
    const previous = `${target}.1`;
    if (fs.existsSync(previous)) fs.rmSync(previous, { force: true });
    fs.renameSync(target, previous);
  } catch {
    // Diagnostics must never prevent the application from starting.
  }
}

function ensureDesktopLogStream() {
  if (desktopLogStream) return desktopLogStream;
  rotateDesktopLogIfNeeded();
  desktopLogStream = fs.createWriteStream(logPath(), { flags: "a", encoding: "utf8" });
  desktopLogStream.on("error", () => {
    desktopLogStream = null;
  });
  return desktopLogStream;
}

function logLine(source, value) {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? "");
  ensureDesktopLogStream().write(`[${new Date().toISOString()}] [${source}] ${text.trim()}\n`);
}

function logProcessOutput(source, value) {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? "");
  const meaningful = text
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => !/127\.0\.0\.1 .*"GET \/api\/(?:recording\/status|run\/status|chrome\/status|chrome\/live) HTTP\/1\.1" (?:200|304) /.test(line));
  if (meaningful.length) logLine(source, meaningful.join("\n"));
}

function diagnosticsDirectory() {
  const directory = path.join(app.getPath("userData"), "diagnostics");
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function processMetricsSnapshot() {
  return app.getAppMetrics().map((metric) => ({
    pid: metric.pid,
    type: metric.type,
    cpu: Math.round((metric.cpu?.percentCPUUsage || 0) * 100) / 100,
    workingSetKb: metric.memory?.workingSetSize || 0,
  }));
}

async function startContinuousTrace() {
  // Chromium tracing can itself saturate a renderer after its in-memory ring
  // buffer fills on some Windows/Electron builds. Keep it as an explicit
  // diagnostic mode; the lightweight pulse/API/process telemetry stays on.
  if (process.env.MAVAT_ENABLE_CONTINUOUS_TRACE !== "1") return;
  if (tracingActive || traceStopPending || appIsQuitting) return;
  try {
    const categories = ["toplevel", "blink", "devtools.timeline", "v8"];
    if (process.env.MAVAT_DIAGNOSTICS_CPU_PROFILE === "1") {
      categories.push("disabled-by-default-v8.cpu_profiler");
    }
    await contentTracing.startRecording({
      record_mode: "record-continuously",
      included_categories: categories,
    });
    tracingActive = true;
    logLine("trace-started", "continuous renderer diagnostics");
  } catch (error) {
    logLine("trace-start-error", error.message || String(error));
  }
}

async function saveContinuousTrace(reason) {
  if (!tracingActive || traceStopPending) return;
  traceStopPending = true;
  tracingActive = false;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(diagnosticsDirectory(), `renderer-${reason}-${stamp}.json`);
  try {
    const saved = await contentTracing.stopRecording(target);
    logLine("trace-saved", saved || target);
  } catch (error) {
    logLine("trace-save-error", error.message || String(error));
  } finally {
    traceStopPending = false;
    setTimeout(() => void startContinuousTrace(), 1000);
  }
}

function installApiDiagnostics(window) {
  const requests = window.webContents.session.webRequest;
  requests.onBeforeRequest({ urls: ["http://127.0.0.1:*/*"] }, (details, callback) => {
    if (new URL(details.url).pathname.startsWith("/api/")) {
      apiRequests.set(details.id, { startedAt: Date.now(), url: details.url });
    }
    callback({});
  });
  requests.onCompleted({ urls: ["http://127.0.0.1:*/*"] }, (details) => {
    const request = apiRequests.get(details.id);
    if (!request) return;
    apiRequests.delete(details.id);
    const pathname = new URL(request.url).pathname;
    const durationMs = Date.now() - request.startedAt;
    const current = apiRequestSummary.get(pathname) || { count: 0, maxMs: 0, failures: 0 };
    current.count += 1;
    current.maxMs = Math.max(current.maxMs, durationMs);
    if (details.statusCode >= 400) current.failures += 1;
    apiRequestSummary.set(pathname, current);
    if (durationMs >= 2000 || details.statusCode >= 400) {
      logLine("api-slow", JSON.stringify({ pathname, durationMs, statusCode: details.statusCode }));
    }
  });
  requests.onErrorOccurred({ urls: ["http://127.0.0.1:*/*"] }, (details) => {
    const request = apiRequests.get(details.id);
    apiRequests.delete(details.id);
    if (request) logLine("api-error", JSON.stringify({ url: request.url, error: details.error }));
  });
}

function startRuntimeDiagnostics(window) {
  rendererProbeLastOkAt = Date.now();
  diagnosticsTimer = setInterval(() => {
    if (appIsQuitting || window.isDestroyed()) return;
    const now = Date.now();
    if (!rendererProbePending) {
      rendererProbePending = true;
      rendererProbeStartedAt = now;
      void window.webContents.executeJavaScript("performance.now()", true).then(() => {
        rendererProbePending = false;
        rendererProbeLastOkAt = Date.now();
      }).catch((error) => {
        rendererProbePending = false;
        logLine("renderer-probe-error", error.message || String(error));
      });
    } else if (
      now - rendererProbeStartedAt >= RENDERER_STALL_MS &&
      now - rendererProbeLastReportedAt >= 2000
    ) {
      rendererProbeLastReportedAt = now;
      logLine("renderer-probe-stalled", JSON.stringify({
        stalledForMs: now - rendererProbeStartedAt,
        lastProbeOkAgoMs: now - rendererProbeLastOkAt,
        lastPulse: lastRendererPulse,
        metrics: processMetricsSnapshot(),
        url: window.webContents.getURL(),
      }));
    }
    if (apiRequestSummary.size) {
      logLine("api-summary", JSON.stringify(Object.fromEntries(apiRequestSummary)));
      apiRequestSummary = new Map();
    }
  }, DIAGNOSTICS_INTERVAL_MS);
}

function scheduleRendererReload(window, details = {}) {
  if (appIsQuitting || window.isDestroyed() || rendererReloadTimer) return;

  const now = Date.now();
  rendererReloadHistory = rendererReloadHistory.filter((timestamp) => now - timestamp < 60000);
  if (rendererReloadHistory.length >= 2) {
    logLine("renderer-reload-suppressed", JSON.stringify({
      reason: details.reason || "unknown",
      attemptsLastMinute: rendererReloadHistory.length,
    }));
    return;
  }

  rendererReloadHistory.push(now);
  const recoveryUrl = window.webContents.getURL() || (app.isPackaged ? `${PYTHON_URL}/app/` : WEB_URL);
  logLine("renderer-reload-scheduled", JSON.stringify({ reason: details.reason || "unknown", recoveryUrl }));
  rendererReloadTimer = setTimeout(() => {
    rendererReloadTimer = null;
    if (appIsQuitting || window.isDestroyed()) return;
    void window.loadURL(recoveryUrl).catch((error) => {
      logLine("renderer-reload-error", error.message || String(error));
    });
  }, 750);
}

// Isolated packaged QA uses its own user-data/backend/debug ports and must not
// be redirected to a user's already-running desktop instance.
const hasSingleInstanceLock = process.env.MAVAT_QA_ALLOW_MULTI_INSTANCE === "1"
  || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

app.on("second-instance", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

function linkedWindowsSettingsPath() {
  return path.join(app.getPath("userData"), "linked-windows.json");
}

function loadLinkedWindowsSetting() {
  try { linkedWindows = Boolean(JSON.parse(fs.readFileSync(linkedWindowsSettingsPath(), "utf8")).enabled); }
  catch { linkedWindows = false; }
}

function saveLinkedWindowsSetting() {
  fs.writeFileSync(linkedWindowsSettingsPath(), JSON.stringify({ enabled: linkedWindows }, null, 2), "utf8");
}

function stopWindowLinking() {
  if (windowLinkProcess?.exitCode === null) windowLinkProcess.kill();
  windowLinkProcess = null;
}

function startWindowLinking(profileDir = activeAutomationProfile) {
  stopWindowLinking();
  activeAutomationProfile = profileDir || activeAutomationProfile;
  if (!linkedWindows || !mainWindow || mainWindow.isDestroyed()) return;
  const linkProcess = spawn("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    path.join(ROOT, "desktop", "link-windows.ps1"),
    "-ElectronPid", String(process.pid),
    "-ProfileDir", activeAutomationProfile,
  ], { cwd: ROOT, windowsHide: true, stdio: "ignore" });
  windowLinkProcess = linkProcess;
  linkProcess.once("exit", () => {
    if (windowLinkProcess === linkProcess) windowLinkProcess = null;
  });
}

function sendAutomationCommand(command, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!automationProcess) return reject(new Error("מנוע Playwright אינו מחובר"));
    const id = `engine-${++automationSequence}`;
    const timeout = setTimeout(() => {
      automationRequests.delete(id);
      reject(new Error("מנוע Playwright לא השיב בזמן"));
    }, 20000);
    automationRequests.set(id, { resolve, reject, timeout });
    automationProcess.postMessage({ id, command, payload });
  });
}

function startAutomationEngine() {
  if (automationProcess) return;
  automationProcess = utilityProcess.fork(path.join(ROOT, "automation-engine", "worker.cjs"), [], {
    serviceName: "Mavat Playwright Engine",
    stdio: "pipe",
    env: {
      ...process.env,
      MAVAT_AUTOMATION_PROFILE_DIR: AUTOMATION_PROFILE,
      MAVAT_CHROME_CDP_PORT: "9223",
      MAVAT_BROWSER_PROVIDER: process.env.MAVAT_BROWSER_PROVIDER || "auto",
    },
  });
  automationProcess.on("message", (message) => {
    if (message?.kind === "reply") {
      const pending = automationRequests.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      automationRequests.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error || "פעולת Playwright נכשלה"));
      return;
    }
    if (message?.kind === "event") {
      const eventType = String(message.type || "unknown");
      automationEventSummary.set(eventType, (automationEventSummary.get(eventType) || 0) + 1);
      for (const window of electronWindows) {
        if (!automationEventSubscribers.has(window.webContents.id)) continue;
        window.webContents.send("automation-engine:event", message);
      }
    }
  });
  automationProcess.stderr?.on("data", (chunk) => {
    logLine("playwright-error", chunk);
    for (const window of electronWindows) {
      if (!automationEventSubscribers.has(window.webContents.id)) continue;
      window.webContents.send("automation-engine:event", {
        kind: "event", type: "engine-error", at: new Date().toISOString(), error: chunk.toString(),
      });
    }
  });
  automationProcess.on("exit", () => {
    automationProcess = null;
    for (const pending of automationRequests.values()) {
      clearTimeout(pending.timeout); pending.reject(new Error("מנוע Playwright נסגר"));
    }
    automationRequests.clear();
  });
  if (!automationEventSummaryTimer) {
    automationEventSummaryTimer = setInterval(() => {
      if (!automationEventSummary.size) return;
      logLine("playwright-event-summary", JSON.stringify({
        subscribers: automationEventSubscribers.size,
        events: Object.fromEntries(automationEventSummary),
      }));
      automationEventSummary = new Map();
    }, 5000);
    automationEventSummaryTimer.unref?.();
  }
}

function dockAutomationWindows(profileDir) {
  return new Promise((resolve, reject) => {
    if (!mainWindow || mainWindow.isDestroyed()) return reject(new Error("חלון האפליקציה אינו זמין"));
    const display = screen.getDisplayMatching(mainWindow.getBounds());
    const area = display.workArea;
    execFile("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      path.join(ROOT, "desktop", "dock-windows.ps1"),
      "-ElectronPid", String(process.pid),
      "-ProfileDir", String(profileDir || path.join(ROOT, ".runtime", "chrome", "mavat")),
      "-WorkX", String(area.x), "-WorkY", String(area.y),
      "-WorkWidth", String(area.width), "-WorkHeight", String(area.height),
    ], { cwd: ROOT, windowsHide: true, encoding: "utf8", timeout: 15000 }, (error, stdout, stderr) => {
      if (error) return reject(new Error((stderr || stdout || error.message).trim()));
      try { resolve(JSON.parse(stdout.trim())); }
      catch { resolve({ ok: true }); }
    });
  });
}

async function openAndDockAutomationBrowser() {
  const result = await sendAutomationCommand("open-browser", {
    startUrl: "https://www.gov.il/he/service/mvat",
  });
  activeAutomationProfile = result.profileDir || activeAutomationProfile;
  if (result.provider === "browseros") {
    stopWindowLinking();
    result.layout = { ok: true, mode: "background-browseros" };
    return result;
  }
  try {
    result.layout = await dockAutomationWindows(activeAutomationProfile);
  } catch (error) {
    // Opening Chrome is the critical operation. A Windows layout failure must
    // never make the UI report that the browser itself failed to open.
    result.layout = { ok: false, error: error.message || String(error) };
  }
  startWindowLinking(activeAutomationProfile);
  return result;
}

function isReady(url) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolve(Boolean(response.statusCode && response.statusCode < 500));
    });
    request.setTimeout(700, () => { request.destroy(); resolve(false); });
    request.on("error", () => resolve(false));
  });
}

async function waitFor(url, processRef, label) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (await isReady(url)) return;
    if (processRef?.exitCode !== null && processRef?.exitCode !== undefined) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} לא הצליח לעלות`);
}

async function startServices() {
  logLine("startup", "reserve-python-port");
  // Do not reuse an orphaned backend from an older/unpacked build. When the
  // preferred port is occupied, this desktop instance receives a private port.
  pythonPort = await reserveFreePort(preferredPythonPort);
  PYTHON_URL = `http://127.0.0.1:${pythonPort}`;
  {
    const pythonExe = app.isPackaged
      ? path.join(RESOURCE_ROOT, "python-backend", "mavat-backend.exe")
      : path.join(ROOT, ".venv", "Scripts", "python.exe");
    const pythonArgs = app.isPackaged ? ["--no-browser"] : [path.join(PYTHON_ROOT, "web_app.py"), "--no-browser"];
    pythonProcess = spawn(pythonExe, pythonArgs, {
      cwd: PYTHON_ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        MAVAT_FRONTEND_DIR: app.isPackaged
          ? path.join(RESOURCE_ROOT, "frontend")
          : path.join(ROOT, "dist-electron"),
        MAVAT_BROWSER_PROFILE_DIR: AUTOMATION_PROFILE,
        MAVAT_CHROME_CDP_PORT: "9223",
        MAVAT_BROWSER_PROVIDER: process.env.MAVAT_BROWSER_PROVIDER || "auto",
        MAVAT_WEB_PORT: String(pythonPort),
        MAVAT_DATA_DIR: process.env.MAVAT_DATA_DIR
          || path.join(process.env.APPDATA || app.getPath("userData"), "MavatAutomation"),
        MAVAT_DESKTOP_LOG: logPath(),
      },
    });
    pythonProcess.stdout?.on("data", (chunk) => logProcessOutput("python", chunk));
    pythonProcess.stderr?.on("data", (chunk) => logProcessOutput("python-error", chunk));
    pythonProcess.on("exit", (code, signal) => logLine("python-exit", `code=${code} signal=${signal}`));
    await waitFor(`${PYTHON_URL}/api/workflow`, pythonProcess, "מנוע Python");
    logLine("startup", `python-ready ${PYTHON_URL}`);
  }
  if (!app.isPackaged && !(await isReady(WEB_URL))) {
    webProcess = spawn("node", [path.join(ROOT, "node_modules", "vite", "bin", "vite.js"), "dev"], {
      cwd: ROOT, windowsHide: true, stdio: "ignore",
    });
    await waitFor(WEB_URL, webProcess, "ממשק React");
    logLine("startup", `vite-ready ${WEB_URL}`);
  }
}

async function createWindow() {
  logLine("startup", JSON.stringify({ phase: "create-window", version: app.getVersion(), packaged: app.isPackaged }));
  loadLinkedWindowsSetting();
  await startServices();
  startAutomationEngine();
  Menu.setApplicationMenu(null);
  const window = new BrowserWindow({
    width: 1540, height: 980, minWidth: 560, minHeight: 620, show: false,
    title: "משרד טננבאום אדריכלות — מערכת מבא״ת", backgroundColor: "#f7f9fb",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"), contextIsolation: true,
      nodeIntegration: false, sandbox: true, zoomFactor: 0.9,
      backgroundThrottling: false,
    },
  });
  mainWindow = window;
  installApiDiagnostics(window);
  window.webContents.on("console-message", (_event, details) => {
    logLine(`renderer:${details.level}`, `${details.message} (${details.sourceId}:${details.lineNumber})`);
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    logLine("renderer-gone", JSON.stringify(details));
    void saveContinuousTrace(details.reason || "gone");
    if (details.reason !== "clean-exit") scheduleRendererReload(window, details);
  });
  window.webContents.on("did-fail-load", (_event, code, description, url) => logLine("load-error", `${code} ${description} ${url}`));
  window.on("unresponsive", () => logLine("renderer-unresponsive", JSON.stringify({
    url: window.webContents.getURL(),
    lastPulse: lastRendererPulse,
    metrics: processMetricsSnapshot(),
  })));
  window.on("responsive", () => logLine("renderer-responsive", window.webContents.getURL()));
  electronWindows.add(window);
  window.on("closed", () => {
    automationEventSubscribers.delete(window.webContents.id);
    electronWindows.delete(window);
    if (rendererReloadTimer) clearTimeout(rendererReloadTimer);
    rendererReloadTimer = null;
  });
  window.webContents.on("did-finish-load", () => {
    logLine("renderer-loaded", window.webContents.getURL());
  });
  window.webContents.on("before-input-event", (event, input) => {
    if (!input.control || !input.shift || input.type !== "keyDown") return;
    if (input.key.toLowerCase() === "b") {
      event.preventDefault();
      void openAndDockAutomationBrowser().catch((error) => {
        logLine("browser-open-error", error.message || String(error));
        window.webContents.send("automation-engine:event", {
          kind: "event", type: "background-browser-error",
          at: new Date().toISOString(), error: error.message || String(error),
        });
      });
    }
    if (input.key.toLowerCase() === "m") {
      event.preventDefault(); window.maximize(); window.focus();
    }
  });
  globalShortcut.unregister("CommandOrControl+Shift+B");
  globalShortcut.unregister("F9");
  const launchBrowserShortcut = () => {
    void openAndDockAutomationBrowser().catch((error) => {
      logLine("browser-open-error", error.message || String(error));
      if (!window.isDestroyed()) window.webContents.send("automation-engine:event", {
        kind: "event", type: "background-browser-error",
        at: new Date().toISOString(), error: error.message || String(error),
      });
    });
  };
  globalShortcut.register("CommandOrControl+Shift+B", launchBrowserShortcut);
  globalShortcut.register("F9", launchBrowserShortcut);
  window.once("ready-to-show", () => {
    if (!START_HIDDEN) window.show();
    // A linked setting must also take effect when Chrome was already open
    // before Electron started; previously it only started after open-browser.
    // The desktop application owns one persistent browser session. BrowserOS
    // stays in the background; the Chrome fallback is linked after it opens.
    if (BROWSER_AUTOSTART) {
      setTimeout(() => {
        void openAndDockAutomationBrowser().catch((error) => {
          window.webContents.send("automation-engine:event", {
            kind: "event", type: "background-browser-error",
            at: new Date().toISOString(), error: error.message || String(error),
          });
        });
      }, 300);
    }
  });
  await window.loadURL(app.isPackaged ? `${PYTHON_URL}/app/` : WEB_URL);
  // Probe only the fully loaded renderer. Starting executeJavaScript probes
  // while Chromium is still parsing the production bundle creates false
  // stall reports on slower machines and competes with first paint.
  startRuntimeDiagnostics(window);
  logLine("startup", "initial-url-loaded");
}

function reserveFreePort(preferredPort) {
  return new Promise((resolve, reject) => {
    const net = require("net");
    const ports = Array.from({ length: 21 }, (_, index) => preferredPort + index);
    const tryNext = (index) => {
      if (index >= ports.length) return reject(new Error("לא נמצא פורט מקומי פנוי בטווח השמור"));
      const server = net.createServer();
      server.unref();
      server.once("error", () => tryNext(index + 1));
      server.listen(ports[index], "127.0.0.1", () => {
        server.close(() => resolve(ports[index]));
      });
    };
    tryNext(0);
  });
}

ipcMain.handle("select-data-file", async () => {
  const result = await dialog.showOpenDialog({
    title: "בחירת קובץ נתוני לקוחות", properties: ["openFile"],
    filters: [{ name: "Excel, CSV או Word", extensions: ["xlsx", "csv", "tsv", "docx"] }],
  });
  return result.canceled ? "" : result.filePaths[0];
});
ipcMain.on("renderer-click", (event, payload = {}) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
  logLine("ui-click", JSON.stringify({
    at: Number(payload.at) || Date.now(),
    url: String(payload.url || "").slice(0, 800),
    tag: String(payload.tag || "").slice(0, 30),
    type: String(payload.type || "").slice(0, 40),
    text: String(payload.text || "").slice(0, 160),
    href: String(payload.href || "").slice(0, 500),
  }));
});
ipcMain.on("renderer-diagnostics", (event, payload = {}) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
  lastRendererPulse = {
    at: Number(payload.at) || Date.now(),
    lagMs: Number(payload.lagMs) || 0,
    visibility: String(payload.visibility || ""),
    route: String(payload.route || "").slice(0, 500),
    lastEvent: payload.lastEvent || null,
    longTask: payload.longTask || null,
  };
  if (lastRendererPulse.lagMs >= 250) logLine("renderer-lag", JSON.stringify(lastRendererPulse));
});
ipcMain.handle("copy-text", (_event, text) => { clipboard.writeText(text); return true; });
ipcMain.handle("desktop:show-window", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  return true;
});
function browserExtensionPath() {
  return app.isPackaged
    ? path.join(RESOURCE_ROOT, "browser-extension")
    : path.join(ROOT, "browser-extension", ".output", "chrome-mv3");
}
ipcMain.handle("extension:get-path", () => browserExtensionPath());
ipcMain.handle("extension:show-folder", () => {
  const target = browserExtensionPath();
  if (!fs.existsSync(target)) throw new Error("יש לבנות תחילה את תוסף BrowserOS");
  shell.showItemInFolder(path.join(target, "manifest.json"));
  return target;
});
ipcMain.handle("desktop:navigate-route", async (event, route) => {
  const normalized = String(route || "/");
  if (!/^\/[a-z0-9/_-]*$/i.test(normalized)) throw new Error("נתיב לא תקין");
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || window.isDestroyed() || window !== mainWindow) return false;
  const target = app.isPackaged
    ? `${PYTHON_URL}/app${normalized === "/" ? "/" : normalized}`
    : `${WEB_URL}${normalized}`;
  await window.loadURL(target);
  return true;
});
ipcMain.handle("automation-engine:command", async (_event, command, payload) => {
  const normalized = String(command || "");
  const result = await sendAutomationCommand(normalized, payload || {});
  if (normalized === "open-browser") {
    activeAutomationProfile = result.profileDir || activeAutomationProfile;
    if (result.provider === "browseros") {
      stopWindowLinking();
      result.layout = { ok: true, mode: "background-browseros" };
      return result;
    }
    try {
      result.layout = await dockAutomationWindows(activeAutomationProfile);
    } catch (error) {
      result.layout = { ok: false, error: error.message || String(error) };
    }
    startWindowLinking(activeAutomationProfile);
  }
  return result;
});
ipcMain.on("automation-engine:subscribe", (event) => {
  automationEventSubscribers.add(event.sender.id);
});
ipcMain.on("automation-engine:unsubscribe", (event) => {
  automationEventSubscribers.delete(event.sender.id);
});
ipcMain.handle("desktop-layout:split", async (_event, profileDir) =>
  dockAutomationWindows(String(profileDir || "")));
ipcMain.handle("desktop-layout:maximize", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  mainWindow.maximize(); mainWindow.focus(); return true;
});
ipcMain.handle("desktop-layout:get-linked", () => linkedWindows);
ipcMain.handle("desktop-layout:set-linked", (_event, enabled) => {
  linkedWindows = Boolean(enabled);
  saveLinkedWindowsSetting();
  if (linkedWindows) startWindowLinking(activeAutomationProfile);
  else stopWindowLinking();
  return linkedWindows;
});

if (hasSingleInstanceLock) {
  app.whenReady().then(async () => {
    if (process.env.MAVAT_ENABLE_CONTINUOUS_TRACE === "1") {
      await startContinuousTrace();
    } else {
      logLine("trace-disabled", "continuous tracing is opt-in; lightweight diagnostics remain active");
    }
    await createWindow();
  }).catch((error) => {
    dialog.showErrorBox("שגיאת הפעלה", error.message); app.quit();
  });
}
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => {
  appIsQuitting = true;
  if (rendererReloadTimer) clearTimeout(rendererReloadTimer);
  if (diagnosticsTimer) clearInterval(diagnosticsTimer);
  if (automationEventSummaryTimer) clearInterval(automationEventSummaryTimer);
  automationEventSummaryTimer = null;
  globalShortcut.unregisterAll();
  stopWindowLinking();
  if (webProcess?.exitCode === null) webProcess.kill();
  if (pythonProcess?.exitCode === null) pythonProcess.kill();
  if (automationProcess) automationProcess.kill();
  if (desktopLogStream) desktopLogStream.end();
});
