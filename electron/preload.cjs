const { contextBridge, ipcRenderer } = require("electron");

// Keep preload deliberately passive. Earlier continuous diagnostics and global
// capture listeners made packaged Chromium spin shortly after first focus.

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
    status: () => ipcRenderer.invoke("automation-engine:status"),
    connect: () => ipcRenderer.invoke("automation-engine:connect"),
    disconnect: () => ipcRenderer.invoke("automation-engine:disconnect"),
    configure: (settings) => ipcRenderer.invoke("automation-engine:configure", settings),
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
