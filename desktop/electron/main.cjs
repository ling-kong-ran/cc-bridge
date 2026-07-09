const { app, BrowserWindow, Menu, ipcMain, shell, Notification } = require('electron')
const { autoUpdater } = require('electron-updater')
const { spawn, spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

let mainWindow = null
let backendProcess = null
let backendReady = null
let isQuitting = false
let isInstallingUpdate = false

const APP_ID = 'local.cc-bridge.desktop'
const APP_ROOT = app.isPackaged ? path.join(process.resourcesPath, 'cc-bridge') : path.resolve(__dirname, '..', '..')
const READY_TIMEOUT_MS = Number(process.env.CCB_DESKTOP_READY_TIMEOUT_MS || 120000)
const BACKGROUND_SERVER_ARG = '--background-server'
const START_AS_BACKGROUND_SERVER = process.argv.includes(BACKGROUND_SERVER_ARG)

function normalizedAppRoot() {
  return APP_ROOT.replace(/\\/g, '/')
}

function pagePath(name) {
  return path.join(__dirname, name)
}

function iconPath() {
  if (process.platform === 'win32') return path.resolve(__dirname, '..', 'assets', 'icon.ico')
  if (process.platform === 'darwin') return path.resolve(__dirname, '..', 'assets', 'icon.icns')
  return path.resolve(__dirname, '..', 'assets', 'icon.png')
}

if (process.platform === 'win32') {
  app.setAppUserModelId(APP_ID)
}

function runtimeManifestPath() {
  return path.join(APP_ROOT, 'runtime', 'manifest.json')
}

function readRuntimeManifest() {
  if (!app.isPackaged) return null
  try {
    const manifestPath = runtimeManifestPath()
    if (!fs.existsSync(manifestPath)) return null
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    console.error('读取内置运行时 manifest 失败', error)
    return null
  }
}

function runtimeRoot() {
  return path.join(APP_ROOT, 'runtime')
}

function isWindowsAppExecutionAlias(filePath) {
  return String(filePath || '').replace(/\\/g, '/').toLowerCase().includes('/microsoft/windowsapps/')
}

function isUsableFile(filePath) {
  try {
    return Boolean(filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile())
  } catch {
    return false
  }
}

function pythonVersion(command) {
  try {
    const result = spawnSync(command, ['-c', 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000,
    })
    const text = (result.stdout || '').trim()
    const match = text.match(/^(\d+)\.(\d+)$/)
    if (!match) return null
    return { major: Number(match[1]), minor: Number(match[2]) }
  } catch {
    return null
  }
}

function isSupportedPython(command) {
  if (process.platform === 'win32' && isWindowsAppExecutionAlias(command)) return false
  const version = pythonVersion(command)
  return Boolean(version && (version.major > 3 || (version.major === 3 && version.minor >= 10)))
}

function resolvePythonFromLauncher() {
  if (process.platform !== 'win32') return ''
  try {
    const result = spawnSync('py', ['-3', '-c', 'import sys; print(sys.executable)'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000,
    })
    const candidate = (result.stdout || '').trim()
    if (isUsableFile(candidate) && isSupportedPython(candidate)) return candidate
  } catch {}
  return ''
}

function resolvePythonFromCommonDirs() {
  if (process.platform !== 'win32') return ''
  const bases = [
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python'),
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Python') : '',
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Python') : '',
  ].filter(Boolean)
  const candidates = []
  for (const base of bases) {
    try {
      for (const name of fs.readdirSync(base)) {
        const python = path.join(base, name, 'python.exe')
        if (isUsableFile(python)) {
          const version = pythonVersion(python)
          if (version && (version.major > 3 || (version.major === 3 && version.minor >= 10))) {
            candidates.push({ python, version })
          }
        }
      }
    } catch {}
  }
  candidates.sort((a, b) => (b.version.major - a.version.major) || (b.version.minor - a.version.minor))
  return candidates[0]?.python || ''
}

function resolvePythonCommand() {
  if (process.env.CCB_DESKTOP_PYTHON && isSupportedPython(process.env.CCB_DESKTOP_PYTHON)) return process.env.CCB_DESKTOP_PYTHON
  if (process.platform === 'win32') {
    const launcherPython = resolvePythonFromLauncher()
    if (launcherPython) return launcherPython
    const installedPython = resolvePythonFromCommonDirs()
    if (installedPython) return installedPython
    if (isSupportedPython('python')) return 'python'
    if (isSupportedPython('python3')) return 'python3'
    return 'python'
  }
  return isSupportedPython('python3') ? 'python3' : 'python'
}

function configureLoginStartup() {
  if (!app.isPackaged) return
  app.setLoginItemSettings({
    openAtLogin: true,
    openAsHidden: true,
    args: [BACKGROUND_SERVER_ARG],
  })
}

function createWindow() {
  Menu.setApplicationMenu(null)

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    frame: false,
    backgroundColor: '#14181f',
    hasShadow: true,
    titleBarStyle: 'hidden',
    icon: iconPath(),
    autoHideMenuBar: true,
    menuBarVisible: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.loadFile(pagePath('loading.html'))
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    let finished = false

    const timer = setTimeout(() => {
      done()
      reject(new Error(`等待后端启动超时 (${READY_TIMEOUT_MS}ms)`))
    }, READY_TIMEOUT_MS)

    function done() {
      if (finished) return
      finished = true
      clearTimeout(timer)
      child.stdout.off('data', onData)
      child.off('exit', onExit)
      child.off('error', onError)
    }

    function onData(chunk) {
      const text = chunk.toString()
      process.stdout.write(text)
      buffer += text
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line.startsWith('{')) continue
        try {
          const event = JSON.parse(line)
          if (event.type === 'server_ready' && event.url) {
            done()
            resolve(event)
            return
          }
        } catch {}
      }
    }

    function onExit(code, signal) {
      done()
      reject(new Error(`后端在就绪前退出：${signal || code}`))
    }

    function onError(error) {
      done()
      reject(error)
    }

    child.stdout.on('data', onData)
    child.on('exit', onExit)
    child.on('error', onError)
  })
}

function requestJson(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, res => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { raw += chunk })
      res.on('end', () => {
        try {
          const data = raw ? JSON.parse(raw) : {}
          resolve({ statusCode: res.statusCode || 0, data })
        } catch (error) {
          reject(error)
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy(new Error('请求后端超时'))
    })
    if (body) req.end(body)
    else req.end()
  })
}

function checkExistingBackend(port, requireAppRootMatch = true) {
  return requestJson({
    hostname: '127.0.0.1',
    port,
    path: '/api/health',
    method: 'GET',
    timeout: 800,
  }).then(result => {
    if (result.statusCode !== 200 || result.data?.app !== 'cc-bridge') return null
    if (requireAppRootMatch && result.data?.app_root && result.data.app_root !== normalizedAppRoot()) return null
    return {
      type: 'server_ready',
      host: '127.0.0.1',
      port,
      url: `http://127.0.0.1:${port}`,
      desktop: true,
      reused: true,
      token: result.data?.shutdown_token || '',
    }
  }).catch(() => null)
}

async function findExistingBackend(requireAppRootMatch = true) {
  const startPort = Number(process.env.CCB_PORT || 17878)
  const checks = []
  for (let port = startPort; port < startPort + 50; port += 1) checks.push(checkExistingBackend(port, requireAppRootMatch))
  const results = await Promise.all(checks)
  return results.find(Boolean) || null
}

async function waitForExistingBackend(timeoutMs = READY_TIMEOUT_MS) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const existing = await findExistingBackend(false)
    if (existing) return existing
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return null
}

function spawnBackend() {
  const token = crypto.randomBytes(32).toString('hex')
  const env = {
    ...process.env,
    CCB_DESKTOP: '1',
    CCB_DESKTOP_TOKEN: token,
    CCB_HOST: '127.0.0.1',
    CCB_BUNDLED_RUNTIME_ROOT: runtimeRoot(),
    CCB_BUNDLED_MANIFEST: runtimeManifestPath(),
  }
  const args = ['-u', 'bootstrap.py', '--desktop']
  if (process.env.CCB_BOOTSTRAP_ASSUME_YES === '1') args.push('--yes')

  backendProcess = spawn(resolvePythonCommand(), args, {
    cwd: APP_ROOT,
    env,
    windowsHide: true,
    detached: app.isPackaged && !START_AS_BACKGROUND_SERVER,
  })

  backendProcess.stderr.on('data', chunk => process.stderr.write(chunk.toString()))
  backendProcess.on('exit', () => {
    backendProcess = null
    if (!isQuitting && mainWindow && !mainWindow.isDestroyed() && !backendReady) {
      mainWindow.loadFile(pagePath('backend-error.html'))
    }
  })
  if (app.isPackaged) backendProcess.unref()

  return { child: backendProcess, token }
}

function openBackend(event, token = '') {
  if (!event || backendReady) return
  backendReady = { ...event, token: event.token || token }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(event.url)
  }
}

async function startBackend() {
  const existing = await findExistingBackend(false)
  if (existing) {
    openBackend(existing)
    return
  }

  const { child, token } = spawnBackend()
  waitForReady(child)
    .then(event => openBackend(event, token))
    .catch(error => console.error('stdout ready 检测失败', error))

  waitForExistingBackend()
    .then(event => {
      if (event) openBackend(event, token)
      else if (!backendReady) throw new Error(`等待后端启动超时 (${READY_TIMEOUT_MS}ms)`)
    })
    .catch(error => {
      console.error(error)
      if (mainWindow && !mainWindow.isDestroyed() && !backendReady) mainWindow.loadFile(pagePath('backend-error.html'))
    })
}

function postShutdown() {
  return new Promise(resolve => {
    if (!backendReady) return resolve(false)
    const body = JSON.stringify({ token: backendReady.token })
    const req = http.request(
      {
        hostname: backendReady.host || '127.0.0.1',
        port: backendReady.port,
        path: '/api/shutdown',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 1000,
      },
      res => {
        res.resume()
        res.on('end', () => resolve(true))
      }
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.end(body)
  })
}

async function stopBackend() {
  if (backendReady?.reused && !isInstallingUpdate) return
  await postShutdown()
  if (backendProcess && !backendProcess.killed) backendProcess.kill()
}

function normalizeReleaseNotes(notes) {
  if (Array.isArray(notes)) return notes.map(item => item?.note || item).filter(Boolean).join('\n')
  return notes || ''
}

function configureAutoUpdater() {
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('error', error => console.error('自动更新检查失败', error))
  autoUpdater.checkForUpdatesAndNotify()
}

async function checkDesktopUpdate() {
  if (!app.isPackaged) return { ok: false, error: 'not_packaged' }
  try {
    const result = await autoUpdater.checkForUpdates()
    const info = result?.updateInfo || {}
    return {
      ok: true,
      has_update: info.version && info.version !== app.getVersion(),
      local: app.getVersion(),
      remote: info.version || '',
      release_name: info.releaseName || '',
      commits: normalizeReleaseNotes(info.releaseNotes),
      error: null,
    }
  } catch (error) {
    console.error('自动更新检查失败', error)
    return { ok: false, error: error?.message || String(error) }
  }
}

async function installDesktopUpdate() {
  if (!app.isPackaged) return { ok: false, error: 'not_packaged' }
  try {
    const result = await autoUpdater.checkForUpdates()
    const downloadPromise = result?.downloadPromise || autoUpdater.downloadUpdate()
    await downloadPromise
    autoUpdater.autoInstallOnAppQuit = false
    isInstallingUpdate = true
    await stopBackend()
    autoUpdater.quitAndInstall(false, true)
    return { ok: true, error: null }
  } catch (error) {
    console.error('自动更新下载失败', error)
    return { ok: false, error: error?.message || String(error) }
  }
}

function showDesktopNotification(_event, payload = {}) {
  if (!Notification.isSupported()) return false

  const notification = new Notification({
    title: String(payload.title || app.getName()),
    body: String(payload.body || ''),
    icon: iconPath(),
    silent: false,
  })
  notification.on('click', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
  notification.show()
  return true
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    if (backendReady?.url) mainWindow.loadURL(backendReady.url)
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function registerIpcHandlers() {
  ipcMain.handle('desktop:open-logs', () => shell.openPath(path.join(os.homedir(), '.ccb')))
  ipcMain.handle('desktop:minimize-window', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize()
  })
  ipcMain.handle('desktop:close-window', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close()
  })
  ipcMain.handle('desktop:get-version', () => app.getVersion())
  ipcMain.handle('desktop:check-update', checkDesktopUpdate)
  ipcMain.handle('desktop:install-update', installDesktopUpdate)
  ipcMain.handle('desktop:notify', showDesktopNotification)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv = []) => {
    if (START_AS_BACKGROUND_SERVER && argv.includes(BACKGROUND_SERVER_ARG)) return
    showMainWindow()
  })

  app.whenReady().then(() => {
    configureLoginStartup()
    registerIpcHandlers()
    if (!START_AS_BACKGROUND_SERVER) createWindow()
    startBackend()
    configureAutoUpdater()
  })

  app.on('before-quit', event => {
    if (isQuitting) return
    isQuitting = true
    if (!isInstallingUpdate) {
      app.exit(0)
      return
    }
    event.preventDefault()
    stopBackend().finally(() => app.exit(0))
  })

  app.on('window-all-closed', () => {
    if (!START_AS_BACKGROUND_SERVER) app.quit()
  })
}
