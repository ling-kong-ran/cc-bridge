const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ccBridgeDesktop', {
  platform: process.platform,
  openLogs: () => ipcRenderer.invoke('desktop:open-logs'),
  closeWindow: () => ipcRenderer.invoke('desktop:close-window'),
  checkUpdate: () => ipcRenderer.invoke('desktop:check-update'),
  installUpdate: () => ipcRenderer.invoke('desktop:install-update'),
})
