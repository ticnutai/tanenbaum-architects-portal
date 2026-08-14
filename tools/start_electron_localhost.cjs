const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const electronExe = path.join(root, "node_modules", "electron", "dist", "electron.exe");
const webUrl = process.env.MAVAT_LOCALHOST_URL || "http://127.0.0.1:18474";
const userDataDir = process.env.MAVAT_LOCALHOST_ELECTRON_DATA
  || path.join(process.env.LOCALAPPDATA || root, "MavatAutomation", "ElectronLocalhost");

const child = spawn(electronExe, ["."], {
  cwd: root,
  detached: true,
  stdio: "ignore",
  windowsHide: false,
  env: {
    ...process.env,
    MAVAT_EXTERNAL_LOCALHOST_URL: webUrl,
    MAVAT_ELECTRON_ISOLATE_LOCALHOST: "1",
    MAVAT_ELECTRON_ISOLATE_AUTOMATION_ENGINE:
      process.env.MAVAT_ELECTRON_ISOLATE_AUTOMATION_ENGINE || "0",
    MAVAT_ELECTRON_BACKGROUND_THROTTLING: "1",
    MAVAT_ELECTRON_USER_DATA_DIR: userDataDir,
    MAVAT_BROWSER_PROVIDER: process.env.MAVAT_BROWSER_PROVIDER || "auto",
    MAVAT_BROWSER_AUTOSTART: "0",
    MAVAT_SKIP_BROWSER_AUTOSTART: "1",
    MAVAT_ENABLE_CONTINUOUS_TRACE: "0",
  },
});

child.unref();
console.log(`Electron localhost started: ${webUrl}`);
console.log(`Electron data: ${userDataDir}`);
