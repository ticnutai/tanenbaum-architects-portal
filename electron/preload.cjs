const { contextBridge, ipcRenderer } = require("electron");

let lastDiagnosticTick = performance.now();
let lastUserEvent = null;
let lastLongTask = null;

for (const eventName of ["pointerdown", "keydown", "wheel", "focus", "blur", "visibilitychange"]) {
  globalThis.addEventListener(eventName, (event) => {
    const target = event.target;
    lastUserEvent = {
      type: eventName,
      at: Date.now(),
      tag: String(target?.tagName || "").toLowerCase().slice(0, 30),
      label: String(target?.getAttribute?.("aria-label") || target?.getAttribute?.("title") || "").slice(0, 120),
    };
  }, true);
}

try {
  const observer = new PerformanceObserver((list) => {
    const entry = list.getEntries().at(-1);
    if (entry) lastLongTask = { at: Date.now(), durationMs: Math.round(entry.duration) };
  });
  observer.observe({ type: "longtask", buffered: true });
} catch {
  // Long Task API availability varies between Chromium contexts.
}

setInterval(() => {
  const now = performance.now();
  const lagMs = Math.max(0, Math.round(now - lastDiagnosticTick - 500));
  lastDiagnosticTick = now;
  ipcRenderer.send("renderer-diagnostics", {
    at: Date.now(),
    lagMs,
    visibility: globalThis.document?.visibilityState || "",
    route: globalThis.location?.href || "",
    lastEvent: lastUserEvent,
    longTask: lastLongTask,
  });
}, 500);

// Record only control metadata, never form values or keystrokes. This leaves a
// useful last-action trail when a renderer hangs during a real user session.
globalThis.addEventListener("click", (event) => {
  const element = event.target?.closest?.("button, a, [role='button'], input, select, textarea");
  if (!element) return;
  ipcRenderer.send("renderer-click", {
    at: Date.now(),
    url: globalThis.location?.href || "",
    tag: String(element.tagName || "").toLowerCase(),
    type: String(element.getAttribute?.("type") || ""),
    text: String(
      element.getAttribute?.("aria-label") ||
      element.getAttribute?.("title") ||
      element.innerText ||
      element.getAttribute?.("placeholder") ||
      "",
    ).replace(/\s+/g, " ").trim().slice(0, 160),
    href: String(element.getAttribute?.("href") || "").slice(0, 500),
  });
}, true);

contextBridge.exposeInMainWorld("mavatDesktop", {
  selectDataFile: () => ipcRenderer.invoke("select-data-file"),
  copyText: (text) => ipcRenderer.invoke("copy-text", String(text || "")),
  navigateRoute: (route) => ipcRenderer.invoke("desktop:navigate-route", String(route || "/")),
  showWindow: () => ipcRenderer.invoke("desktop:show-window"),
  extension: {
    getPath: () => ipcRenderer.invoke("extension:get-path"),
    showFolder: () => ipcRenderer.invoke("extension:show-folder"),
  },
  automationEngine: {
    command: (command, payload = {}) => ipcRenderer.invoke("automation-engine:command", command, payload),
    onEvent: (listener) => {
      const handler = (_event, message) => listener(message);
      ipcRenderer.send("automation-engine:subscribe");
      ipcRenderer.on("automation-engine:event", handler);
      return () => {
        ipcRenderer.removeListener("automation-engine:event", handler);
        if (ipcRenderer.listenerCount("automation-engine:event") === 0) {
          ipcRenderer.send("automation-engine:unsubscribe");
        }
      };
    },
  },
  layout: {
    split: (profileDir = "") => ipcRenderer.invoke("desktop-layout:split", profileDir),
    maximize: () => ipcRenderer.invoke("desktop-layout:maximize"),
    getLinked: () => ipcRenderer.invoke("desktop-layout:get-linked"),
    setLinked: (enabled) => ipcRenderer.invoke("desktop-layout:set-linked", Boolean(enabled)),
  },
  platform: process.platform,
});
