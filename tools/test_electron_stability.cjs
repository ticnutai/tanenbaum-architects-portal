const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const main = fs.readFileSync(path.join(root, "electron", "main.cjs"), "utf8");
const preload = fs.readFileSync(path.join(root, "electron", "preload.cjs"), "utf8");
const backend = fs.readFileSync(path.join(root, "web_app.py"), "utf8");

assert.doesNotMatch(
  backend,
  /if\s+"--no-browser"\s+not\s+in\s+sys\.argv/,
  "The backend must not open a personal browser by default.",
);
assert.match(
  backend,
  /if\s+"--open-browser"\s+in\s+sys\.argv/,
  "Opening a browser must remain an explicit developer opt-in.",
);

assert.doesNotMatch(
  main,
  /forcefullyCrashRenderer\s*\(/,
  "The desktop must never kill a renderer solely because a heartbeat was delayed.",
);
assert.doesNotMatch(
  main + preload,
  /renderer-heartbeat/,
  "The unreliable custom heartbeat watchdog must not be reintroduced.",
);
assert.match(
  main,
  /webContents\.on\("render-process-gone"/,
  "A genuine renderer-process failure must still be observed.",
);
assert.match(
  main,
  /renderer-reload-suppressed/,
  "Crash reloads must be rate limited to prevent recovery loops.",
);
assert.match(
  main,
  /rendererReloadHistory\.length >= 2/,
  "No more than two automatic renderer reloads per minute are allowed.",
);
assert.doesNotMatch(
  main,
  /appendFileSync\s*\(/,
  "High-frequency diagnostics must never block Electron's main loop with synchronous writes.",
);
assert.match(main, /renderer-probe-stalled/, "A stalled renderer must leave a diagnostic marker.");
assert.match(main, /contentTracing\.startRecording/, "A rolling Chromium trace must be available.");
assert.match(
  main,
  /MAVAT_ENABLE_CONTINUOUS_TRACE !== "1"/,
  "Continuous Chromium tracing must be opt-in because its ring buffer can cause renderer stalls.",
);
assert.match(main, /installApiDiagnostics/, "Slow local API requests must be measured.");
assert.match(preload, /renderer-diagnostics/, "The renderer must report lag and its last safe UI event.");
assert.match(
  main,
  /await window\.loadURL[\s\S]{0,500}startRuntimeDiagnostics\(window\)/,
  "Runtime probes must start only after the initial renderer document loaded.",
);
assert.match(
  main,
  /const BROWSER_AUTOSTART = process\.env\.MAVAT_BROWSER_AUTOSTART === "1"/,
  "Playwright browser attachment must be lazy by default.",
);
assert.match(
  main,
  /automationEventSubscribers\.has\(window\.webContents\.id\)/,
  "Browser events must only reach renderer routes that explicitly subscribed.",
);
assert.match(
  preload,
  /automation-engine:unsubscribe/,
  "Renderer routes must unsubscribe when leaving recorder/run screens.",
);

const worker = fs.readFileSync(path.join(root, "automation-engine", "worker.cjs"), "utf8");
assert.match(worker, /ACTIONABLE_CONSOLE_LEVELS/, "Browser console traffic must be filtered.");
assert.match(worker, /current\.count >= 10/, "Browser console traffic must be rate limited.");

console.log("Electron renderer stability checks: OK");
