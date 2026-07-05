const { app, BrowserWindow, ipcMain, shell } = require('electron')
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

let mainWindow = null
let backendProcess = null
let backendReady = null
let isQuitting = false

const APP_ROOT = app.isPackaged ? path.join(process.resourcesPath, 'cc-bridge') : path.resolve(__dirname, '..', '..')
const READY_TIMEOUT_MS = Number(process.env.CCB_DESKTOP_READY_TIMEOUT_MS || 120000)

function pagePath(name) {
  return path.join(__dirname, name)
}

function resolvePythonCommand() {
  if (process.env.CCB_DESKTOP_PYTHON) return process.env.CCB_DESKTOP_PYTHON
  if (process.platform === 'win32') return 'python'
  return 'python3'
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
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

function startBackend() {
  const token = crypto.randomBytes(32).toString('hex')
  const env = {
    ...process.env,
    CCB_DESKTOP: '1',
    CCB_DESKTOP_TOKEN: token,
    CCB_HOST: '127.0.0.1',
  }
  const args = ['-u', 'bootstrap.py', '--desktop']
  if (process.env.CCB_BOOTSTRAP_ASSUME_YES === '1') args.push('--yes')

  backendProcess = spawn(resolvePythonCommand(), args, {
    cwd: APP_ROOT,
    env,
    windowsHide: true,
  })

  backendProcess.stderr.on('data', chunk => process.stderr.write(chunk.toString()))
  backendProcess.on('exit', () => {
    backendProcess = null
    if (!isQuitting && mainWindow && !mainWindow.isDestroyed() && !backendReady) {
      mainWindow.loadFile(pagePath('backend-error.html'))
    }
  })

  waitForReady(backendProcess)
    .then(event => {
      backendReady = { ...event, token }
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(event.url)
    })
    .catch(error => {
      console.error(error)
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadFile(pagePath('backend-error.html'))
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
  await postShutdown()
  if (backendProcess && !backendProcess.killed) backendProcess.kill()
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    ipcMain.handle('desktop:open-logs', () => shell.openPath(path.join(os.homedir(), '.ccb')))
    createWindow()
    startBackend()
  })

  app.on('before-quit', event => {
    if (isQuitting) return
    isQuitting = true
    event.preventDefault()
    stopBackend().finally(() => app.exit(0))
  })

  app.on('window-all-closed', () => app.quit())
}
