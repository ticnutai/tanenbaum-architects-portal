const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mavatDesktop", {
  selectDataFile: () => ipcRenderer.invoke("select-data-file"),
  copyText: (text) => ipcRenderer.invoke("copy-text", String(text || "")),
  platform: process.platform,
});
