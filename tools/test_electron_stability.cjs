const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const main = fs.readFileSync(path.join(root, "electron", "main.cjs"), "utf8");
const preload = fs.readFileSync(path.join(root, "electron", "preload.cjs"), "utf8");
const backend = fs.readFileSync(path.join(root, "web_app.py"), "utf8");
const localhostLauncher = fs.readFileSync(path.join(root, "tools", "start_electron_localhost.cjs"), "utf8");

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
assert.doesNotMatch(
  main,
  /webContents\.executeJavaScript\("performance\.now\(\)"/,
  "Runtime health checks must not inject recurring JavaScript into the renderer.",
);
assert.match(main, /contentTracing\.startRecording/, "A rolling Chromium trace must be available.");
assert.match(
  main,
  /MAVAT_ENABLE_CONTINUOUS_TRACE !== "1"/,
  "Continuous Chromium tracing must be opt-in because its ring buffer can cause renderer stalls.",
);
assert.match(main, /installApiDiagnostics/, "Slow local API requests must be measured.");
assert.doesNotMatch(preload, /PerformanceObserver/, "Preload must not profile the renderer continuously.");
assert.doesNotMatch(preload, /setInterval\s*\(/, "Preload must not run a recurring IPC heartbeat.");
assert.doesNotMatch(
  preload,
  /addEventListener\([^\n]*true\)/,
  "Preload must not install global capture listeners over every UI interaction.",
);
assert.match(
  main,
  /await window\.loadURL[\s\S]{0,500}startRuntimeDiagnostics\(window\)/,
  "Passive runtime diagnostics must start only after the initial renderer document loaded.",
);
assert.match(
  main,
  /const BROWSER_AUTOSTART = process\.env\.MAVAT_BROWSER_AUTOSTART === "1"/,
  "Playwright browser attachment must be lazy by default.",
);
assert.match(
  main,
  /if \(process\.env\.MAVAT_ELECTRON_DEBUG_PORT\)/,
  "Electron CDP must only be enabled explicitly for diagnostics.",
);
assert.doesNotMatch(
  main,
  /MAVAT_ELECTRON_DEBUG_PORT \|\| "9333"/,
  "Normal desktop launches must not expose an idle Electron debugging endpoint.",
);
assert.match(
  main,
  /ISOLATED_LOCALHOST_MODE[\s\S]{0,180}await waitFor\(WEB_URL, null/,
  "Electron isolation mode must reuse an already-running localhost UI.",
);
assert.match(
  main,
  /if \(!automationProcess\) startAutomationEngine\(\)/,
  "The Playwright worker must start lazily on the first automation command.",
);
assert.match(main, /settings\.auto_connect/, "Automation engine startup must be configurable.");
assert.match(main, /idle-timeout/, "An idle engine must be disconnected automatically.");
assert.match(main, /automation-engine:disconnect/, "Manual engine disconnection must be exposed.");
assert.match(preload, /automation-engine:status/, "The UI must be able to read engine lifecycle status.");
assert.doesNotMatch(
  main,
  /if \(!ISOLATED_LOCALHOST_MODE \|\| ISOLATED_AUTOMATION_ENGINE\)/,
  "Normal Electron startup must not eagerly launch the Playwright worker.",
);
assert.match(localhostLauncher, /MAVAT_ELECTRON_ISOLATE_LOCALHOST: "1"/);
assert.match(
  localhostLauncher,
  /MAVAT_ELECTRON_ISOLATE_AUTOMATION_ENGINE:[\s\S]{0,100}process\.env\.MAVAT_ELECTRON_ISOLATE_AUTOMATION_ENGINE \|\| "0"/,
  "Localhost isolation must not eagerly start the automation worker by default.",
);
assert.match(localhostLauncher, /MAVAT_BROWSER_AUTOSTART: "0"/);
const sidebar = fs.readFileSync(path.join(root, "src", "components", "app-sidebar.tsx"), "utf8");
assert.doesNotMatch(
  sidebar,
  /Tooltip(Provider|Trigger|Content)?/,
  "The navigation sidebar must not include the Radix tooltip path that spun the production renderer.",
);
assert.doesNotMatch(
  sidebar,
  /navigateRoute/,
  "Sidebar links must use one SPA navigation path; a full Electron document reload can wedge the renderer.",
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
assert.match(main, /const webContentsId = window\.webContents\.id/, "Window cleanup must capture the webContents id before destruction.");
assert.doesNotMatch(main, /window\.on\("closed",[\s\S]{0,180}window\.webContents\.id/, "Closed handlers must not access destroyed webContents.");

const worker = fs.readFileSync(path.join(root, "automation-engine", "worker.cjs"), "utf8");
assert.match(worker, /ACTIONABLE_CONSOLE_LEVELS/, "Browser console traffic must be filtered.");
assert.match(worker, /current\.count >= 10/, "Browser console traffic must be rate limited.");

const rootRoute = fs.readFileSync(path.join(root, "src", "routes", "__root.tsx"), "utf8");
const settingsRoute = fs.readFileSync(path.join(root, "src", "routes", "settings.tsx"), "utf8");
assert.doesNotMatch(
  settingsRoute,
  /components\/ui\/switch/,
  "Settings must use its simple native toggle instead of the packaged Radix switch path.",
);
assert.doesNotMatch(
  settingsRoute,
  /role=["']switch["']/,
  "Settings must not recreate the renderer-spinning custom switch accessibility tree.",
);
assert.doesNotMatch(
  settingsRoute,
  /setInterval\s*\([^)]*(?:automationEngine|desktop\.status|refresh)/,
  "Opening Settings must not start a recurring Electron IPC status loop.",
);
assert.doesNotMatch(
  rootRoute,
  /pathname\s*===\s*["']\/logs["'][\s\S]{0,350}navigateRoute/,
  "Leaving the logs route must not replace the Electron document through loadURL.",
);
const reactSources = rootRoute + sidebar;
assert.equal((rootRoute.match(/<AppSidebar\b/g) || []).length, 1, "Electron must render exactly one navigation sidebar.");
assert.equal((rootRoute.match(/<SidebarProvider\b/g) || []).length, 1, "Electron must have exactly one sidebar provider.");
assert.doesNotMatch(reactSources, /<\s*(iframe|webview)\b/i, "Electron must not reintroduce an embedded target browser.");
assert.doesNotMatch(main, /\b(BrowserView|WebContentsView)\b/, "Electron must not create a second embedded browser surface.");

console.log("Electron renderer stability checks: OK");
