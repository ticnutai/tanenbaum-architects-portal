const { contextBridge, ipcRenderer } = require("electron");

// Send a real heartbeat from the renderer event loop. Probing a sandboxed
// renderer with webContents.executeJavaScript is unreliable and can mistake a
// healthy page for a frozen one.
const sendRendererHeartbeat = () => {
  ipcRenderer.send("renderer-heartbeat", {
    at: Date.now(),
    url: globalThis.location?.href || "",
  });
};
sendRendererHeartbeat();
setInterval(sendRendererHeartbeat, 2000);

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
      ipcRenderer.on("automation-engine:event", handler);
      return () => ipcRenderer.removeListener("automation-engine:event", handler);
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
