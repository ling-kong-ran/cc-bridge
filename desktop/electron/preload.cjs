const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ccBridgeDesktop', {
  platform: process.platform,
  openLogs: () => ipcRenderer.invoke('desktop:open-logs'),
})
