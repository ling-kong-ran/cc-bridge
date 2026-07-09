const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ccBridgeDesktop', {
  platform: process.platform,
  openLogs: () => ipcRenderer.invoke('desktop:open-logs'),
  minimizeWindow: () => ipcRenderer.invoke('desktop:minimize-window'),
  closeWindow: () => ipcRenderer.invoke('desktop:close-window'),
  getVersion: () => ipcRenderer.invoke('desktop:get-version'),
  checkUpdate: () => ipcRenderer.invoke('desktop:check-update'),
  installUpdate: () => ipcRenderer.invoke('desktop:install-update'),
  notify: (payload) => ipcRenderer.invoke('desktop:notify', payload),
  getBootstrapLogPath: () => ipcRenderer.invoke('desktop:get-bootstrap-log-path'),
  onBootstrapProgress: (callback) => {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('desktop:bootstrap-progress', listener)
    return () => ipcRenderer.removeListener('desktop:bootstrap-progress', listener)
  },
})
