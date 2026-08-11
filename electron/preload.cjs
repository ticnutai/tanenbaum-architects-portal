const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mavatDesktop", {
  selectDataFile: () => ipcRenderer.invoke("select-data-file"),
  copyText: (text) => ipcRenderer.invoke("copy-text", String(text || "")),
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
