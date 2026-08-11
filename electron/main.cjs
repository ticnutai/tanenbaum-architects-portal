const { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, screen } = require("electron");
const { spawn, fork, execFile } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PYTHON_URL = "http://127.0.0.1:18473";
const WEB_URL = "http://127.0.0.1:18474";
let pythonProcess = null;
let webProcess = null;
let mainWindow = null;
let automationProcess = null;
let windowLinkProcess = null;
let linkedWindows = false;
let activeAutomationProfile = path.join(ROOT, ".runtime", "chrome", "mavat");
let automationSequence = 0;
const automationRequests = new Map();
const electronWindows = new Set();

const hasSingleInstanceLock = app.requestSingleInstanceLock();
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
    if (!automationProcess?.connected) return reject(new Error("מנוע Playwright אינו מחובר"));
    const id = `engine-${++automationSequence}`;
    const timeout = setTimeout(() => {
      automationRequests.delete(id);
      reject(new Error("מנוע Playwright לא השיב בזמן"));
    }, 20000);
    automationRequests.set(id, { resolve, reject, timeout });
    automationProcess.send({ id, command, payload });
  });
}

function startAutomationEngine() {
  if (automationProcess?.connected) return;
  automationProcess = fork(path.join(ROOT, "automation-engine", "worker.cjs"), [], {
    cwd: ROOT, silent: true, windowsHide: true,
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
      for (const window of electronWindows) window.webContents.send("automation-engine:event", message);
    }
  });
  automationProcess.stderr?.on("data", (chunk) => {
    for (const window of electronWindows) window.webContents.send("automation-engine:event", {
      kind: "event", type: "engine-error", at: new Date().toISOString(), error: chunk.toString(),
    });
  });
  automationProcess.on("exit", () => {
    automationProcess = null;
    for (const pending of automationRequests.values()) {
      clearTimeout(pending.timeout); pending.reject(new Error("מנוע Playwright נסגר"));
    }
    automationRequests.clear();
  });
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
  result.layout = await dockAutomationWindows(result.profileDir);
  activeAutomationProfile = result.profileDir || activeAutomationProfile;
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
  if (!(await isReady(`${PYTHON_URL}/api/workflow`))) {
    pythonProcess = spawn(path.join(ROOT, ".venv", "Scripts", "python.exe"), [path.join(ROOT, "web_app.py"), "--no-browser"], {
      cwd: ROOT, windowsHide: true, stdio: "ignore",
    });
    await waitFor(`${PYTHON_URL}/api/workflow`, pythonProcess, "מנוע Python");
  }
  if (!(await isReady(WEB_URL))) {
    webProcess = spawn("node", [path.join(ROOT, "node_modules", "vite", "bin", "vite.js"), "dev"], {
      cwd: ROOT, windowsHide: true, stdio: "ignore",
    });
    await waitFor(WEB_URL, webProcess, "ממשק React");
  }
}

async function createWindow() {
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
    },
  });
  mainWindow = window;
  electronWindows.add(window);
  window.on("closed", () => electronWindows.delete(window));
  window.webContents.on("before-input-event", (event, input) => {
    if (!input.control || !input.shift || input.type !== "keyDown") return;
    if (input.key.toLowerCase() === "b") {
      event.preventDefault();
      void openAndDockAutomationBrowser().catch((error) => dialog.showErrorBox("פתיחת דפדפן", error.message));
    }
    if (input.key.toLowerCase() === "m") {
      event.preventDefault(); window.maximize(); window.focus();
    }
  });
  globalShortcut.unregister("CommandOrControl+Shift+B");
  globalShortcut.unregister("F9");
  const launchBrowserShortcut = () => {
    void openAndDockAutomationBrowser().catch((error) => dialog.showErrorBox("פתיחת דפדפן", error.message));
  };
  globalShortcut.register("CommandOrControl+Shift+B", launchBrowserShortcut);
  globalShortcut.register("F9", launchBrowserShortcut);
  window.once("ready-to-show", () => {
    window.show();
    // A linked setting must also take effect when Chrome was already open
    // before Electron started; previously it only started after open-browser.
    startWindowLinking(activeAutomationProfile);
  });
  await window.loadURL(WEB_URL);
}

ipcMain.handle("select-data-file", async () => {
  const result = await dialog.showOpenDialog({
    title: "בחירת קובץ נתוני לקוחות", properties: ["openFile"],
    filters: [{ name: "Excel, CSV או Word", extensions: ["xlsx", "csv", "tsv", "docx"] }],
  });
  return result.canceled ? "" : result.filePaths[0];
});
ipcMain.handle("copy-text", (_event, text) => { clipboard.writeText(text); return true; });
ipcMain.handle("automation-engine:command", async (_event, command, payload) => {
  const normalized = String(command || "");
  const result = await sendAutomationCommand(normalized, payload || {});
  if (normalized === "open-browser") {
    result.layout = await dockAutomationWindows(result.profileDir);
    activeAutomationProfile = result.profileDir || activeAutomationProfile;
    startWindowLinking(activeAutomationProfile);
  }
  return result;
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
  app.whenReady().then(createWindow).catch((error) => {
    dialog.showErrorBox("שגיאת הפעלה", error.message); app.quit();
  });
}
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => {
  globalShortcut.unregisterAll();
  stopWindowLinking();
  if (webProcess?.exitCode === null) webProcess.kill();
  if (pythonProcess?.exitCode === null) pythonProcess.kill();
  if (automationProcess?.connected) automationProcess.kill();
});
