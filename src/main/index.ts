import { app, BrowserWindow, net, protocol, shell } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerIpc } from './ipc'
import { ensureDir, rmrf } from './services/fsx'
import { imageCacheDir, stagingDir } from './services/store'

let mainWindow: BrowserWindow | null = null

// Cached preview images are served over their own scheme so the renderer never
// needs file:// access (which the dev server origin can't use anyway).
protocol.registerSchemesAsPrivileged([
  { scheme: 'palimg', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

function registerImageProtocol(): void {
  protocol.handle('palimg', async (request) => {
    // Only ever serve a bare filename out of the image cache.
    const name = path.basename(decodeURIComponent(new URL(request.url).pathname))
    if (!name || name === '.' || name === '..') return new Response('Not found', { status: 404 })
    const file = path.join(imageCacheDir(), name)
    try {
      return await net.fetch(pathToFileURL(file).toString())
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0d0f14',
    titleBarStyle: process.platform === 'win32' ? 'hidden' : 'default',
    titleBarOverlay:
      process.platform === 'win32' ? { color: '#0d0f14', symbolColor: '#8b93a7', height: 40 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // External links open in the user's browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

// Single instance: a second launch focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(async () => {
    // Staging is scratch space; clear anything left by a previous run.
    await rmrf(stagingDir())
    await ensureDir(stagingDir())
    await ensureDir(imageCacheDir())

    registerImageProtocol()
    registerIpc(() => mainWindow)
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    void rmrf(stagingDir())
  })
}
