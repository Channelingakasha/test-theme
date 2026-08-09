import { app, BrowserWindow, dialog, net, protocol, shell } from 'electron'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { registerIpc } from './ipc'
import { ensureDir, rmrf } from './services/fsx'
import { imageCacheDir, stagingDir } from './services/store'

let mainWindow: BrowserWindow | null = null

/**
 * Surface a startup failure instead of exiting silently. A packaged app that
 * dies before its window appears looks to the user like nothing happened at
 * all, which is impossible to report or debug.
 */
function reportFatal(err: unknown): void {
  const message = err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err)
  console.error('PalMod failed to start:', message)
  try {
    dialog.showErrorBox('PalMod could not start', message.slice(0, 2000))
  } catch {
    /* dialog unavailable this early — the console output still has it */
  }
}

// A crash anywhere in the main process should say so rather than vanish.
process.on('uncaughtException', (err) => reportFatal(err))
process.on('unhandledRejection', (reason) => reportFatal(reason))

// Cached preview images are served over their own scheme so the renderer never
// needs file:// access (which the dev server origin can't use anyway).
protocol.registerSchemesAsPrivileged([
  { scheme: 'palimg', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

/**
 * Window icon. On Windows the executable's icon comes from build/icon.ico at
 * package time; this is what the taskbar and Linux window managers use.
 */
function appIcon(): string | undefined {
  const candidates = [
    path.join(process.resourcesPath ?? '', 'build', 'icon.png'),
    path.join(app.getAppPath(), 'build', 'icon.png'),
    path.join(__dirname, '../../build/icon.png')
  ]
  return candidates.find((p) => existsSync(p))
}

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
  const base: Electron.BrowserWindowConstructorOptions = {
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0d0f14',
    icon: appIcon(),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  }

  // The blended title bar is a Windows-only flourish. If this build of Windows
  // rejects the overlay options, fall back to a normal frame rather than
  // failing to open a window at all.
  try {
    mainWindow = new BrowserWindow(
      process.platform === 'win32'
        ? {
            ...base,
            titleBarStyle: 'hidden',
            titleBarOverlay: { color: '#0d0f14', symbolColor: '#8b93a7', height: 40 }
          }
        : base
    )
  } catch (err) {
    console.error('Custom title bar unavailable, using the standard frame:', err)
    mainWindow = new BrowserWindow(base)
  }

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Safety net: if the renderer never reports ready (a load failure, a stalled
  // first paint), show the window regardless rather than leaving the user
  // looking at nothing.
  const showFallback = setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show()
    }
  }, 4000)
  mainWindow.on('show', () => clearTimeout(showFallback))
  mainWindow.on('closed', () => clearTimeout(showFallback))

  mainWindow.webContents.on('did-fail-load', (_e, code, description, url) => {
    // -3 is ERR_ABORTED, which fires harmlessly on in-app navigation.
    if (code === -3) return
    reportFatal(new Error(`The app window failed to load (${code} ${description})\n${url}`))
  })

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    reportFatal(new Error(`The app window crashed: ${details.reason}`))
  })

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
    // Housekeeping must never stop the app opening. On Windows a leftover
    // staging file can be locked by antivirus or a previous run, and an
    // unhandled rejection here would leave the process alive with no window
    // and nothing on screen to explain why.
    try {
      await rmrf(stagingDir())
      await ensureDir(stagingDir())
      await ensureDir(imageCacheDir())
    } catch (err) {
      console.error('Startup cleanup failed, continuing anyway:', err)
    }

    try {
      registerImageProtocol()
      registerIpc(() => mainWindow)
      createWindow()
    } catch (err) {
      reportFatal(err)
      return
    }

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
