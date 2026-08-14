const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const executable = process.env.MAVAT_QA_EXECUTABLE;
const debugPort = Number(process.env.MAVAT_QA_DEBUG_PORT || 19418);
const profileMs = Number(process.env.MAVAT_QA_PROFILE_MS || 12000);
const outputDir = path.resolve(process.env.MAVAT_QA_OUTPUT_DIR || path.join(__dirname, "..", "artifacts", "electron-visible-profile"));
const userDataDir = process.env.MAVAT_QA_USER_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "mavat-visible-"));

function json(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    req.setTimeout(1000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

async function waitTarget() {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      const targets = await json(`http://127.0.0.1:${debugPort}/json/list`);
      const page = targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Electron target did not start");
}

async function main() {
  assert.ok(executable && fs.existsSync(executable), "MAVAT_QA_EXECUTABLE is required");
  fs.mkdirSync(outputDir, { recursive: true });
  const child = spawn(executable, [], {
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      MAVAT_ELECTRON_USER_DATA_DIR: userDataDir,
      MAVAT_DATA_DIR: process.env.MAVAT_QA_APP_DATA_DIR || path.join(userDataDir, "data"),
      MAVAT_ELECTRON_DEBUG_PORT: String(debugPort),
      MAVAT_PYTHON_PORT: "19473",
      MAVAT_ELECTRON_START_HIDDEN: "1",
      MAVAT_QA_ALLOW_MULTI_INSTANCE: "1",
      MAVAT_SKIP_BROWSER_AUTOSTART: "1",
      MAVAT_BROWSER_AUTOSTART: "0",
      MAVAT_ENABLE_CONTINUOUS_TRACE: "0",
    },
  });
  let socket;
  try {
    const target = await waitTarget();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    let sequence = 0;
    const pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result || {});
    });
    const call = (method, params = {}, timeout = 20000) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeout);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
    await call("Runtime.enable");
    await call("Profiler.enable");
    await call("Profiler.setSamplingInterval", { interval: 100 });
    await call("Profiler.start");
    await call("Runtime.evaluate", { expression: "window.mavatDesktop.showWindow()", awaitPromise: true });
    await new Promise((resolve) => setTimeout(resolve, profileMs));
    const { profile } = await call("Profiler.stop", {}, 30000);
    const samples = new Map();
    for (const nodeId of profile.samples || []) samples.set(nodeId, (samples.get(nodeId) || 0) + 1);
    const hottest = (profile.nodes || []).map((node) => ({
      functionName: node.callFrame?.functionName || "(anonymous)",
      url: node.callFrame?.url || "",
      line: (node.callFrame?.lineNumber ?? -1) + 1,
      hits: samples.get(node.id) || node.hitCount || 0,
    })).filter((item) => item.hits > 0).sort((a, b) => b.hits - a.hits).slice(0, 40);
    const targetPath = path.join(outputDir, "visible-cpu-profile.json");
    fs.writeFileSync(targetPath, JSON.stringify({ profileMs, hottest, profile }, null, 2));
    console.log(JSON.stringify({ targetPath, hottest: hottest.slice(0, 20) }, null, 2));
  } finally {
    socket?.close();
    if (child.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
