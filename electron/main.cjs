const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu } = require("electron");
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PYTHON_URL = "http://127.0.0.1:18473";
const WEB_URL = "http://127.0.0.1:18474";
let pythonProcess = null;
let webProcess = null;

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
  for (let attempt = 0; attempt < 90; attempt += 1) {
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
  await startServices();
  Menu.setApplicationMenu(null);
  const window = new BrowserWindow({
    width: 1540, height: 980, minWidth: 1050, minHeight: 720, show: false,
    title: "משרד טננבאום אדריכלות — מערכת מבא״ת", backgroundColor: "#f7f9fb",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"), contextIsolation: true,
      nodeIntegration: false, sandbox: true,
    },
  });
  window.once("ready-to-show", () => window.show());
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

app.whenReady().then(createWindow).catch((error) => {
  dialog.showErrorBox("שגיאת הפעלה", error.message); app.quit();
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => {
  if (webProcess?.exitCode === null) webProcess.kill();
  if (pythonProcess?.exitCode === null) pythonProcess.kill();
});
