import { buildMenu } from './menu'
import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { Effect } from 'effect'

import type { WindowState } from '@shared/contract'
import { startRpcServer } from './rpc/handler'
import { runtime } from './runtime'
import { RecentsService } from './services/recents'
import { WindowStateService } from './services/window-state'

const isDev = !app.isPackaged

const DEFAULT_BOUNDS = { width: 1440, height: 900 } as const

/**
 * Window state is best-effort: a corrupt or missing database must never stop
 * the app from opening a window.
 */
async function loadWindowState(): Promise<WindowState | null> {
  try {
    return await runtime.runPromise(Effect.flatMap(WindowStateService, (s) => s.get))
  } catch (cause) {
    console.error('[main] could not read window state:', cause)
    return null
  }
}

function persistWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const bounds = win.isMaximized() ? win.getNormalBounds() : win.getBounds()
  const state: WindowState = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    maximized: win.isMaximized()
  }
  void runtime
    .runPromise(Effect.flatMap(WindowStateService, (s) => s.set(state)))
    .catch((cause: unknown) => console.error('[main] could not save window state:', cause))
}

function createWindow(restored: WindowState | null): BrowserWindow {
  const win = new BrowserWindow({
    width: restored?.width ?? DEFAULT_BOUNDS.width,
    height: restored?.height ?? DEFAULT_BOUNDS.height,
    ...(restored?.x != null && restored.y != null ? { x: restored.x, y: restored.y } : {}),
    minWidth: 960,
    minHeight: 620,
    show: false,
    backgroundColor: '#18181b',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true
    }
  })

  if (restored?.maximized) win.maximize()

  win.on('ready-to-show', () => win.show())

  /**
   * The toolbar insets itself past the macOS traffic lights, which hiddenInset
   * draws over the content — but in fullscreen there are no traffic lights, so the
   * inset becomes a gap. The renderer cannot detect window fullscreen (that is not
   * the same as HTML fullscreen), so main tells it.
   */
  const reportFullscreen = (): void =>
    win.webContents.send('menu-command', win.isFullScreen() ? 'fullscreen-on' : 'fullscreen-off')
  win.on('enter-full-screen', reportFullscreen)
  win.on('leave-full-screen', reportFullscreen)
  win.webContents.on('did-finish-load', reportFullscreen)

  // Debounced so dragging or resizing does not hammer sqlite.
  let saveTimer: NodeJS.Timeout | undefined
  const scheduleSave = (): void => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => persistWindowState(win), 400)
  }
  win.on('resize', scheduleSave)
  win.on('move', scheduleSave)
  win.on('close', () => {
    if (saveTimer) clearTimeout(saveTimer)
    persistWindowState(win)
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

void app.whenReady().then(async () => {
  startRpcServer()
  buildMenu()

  // Recent entries pointing at files that no longer exist are dropped once at
  // startup rather than filtered on every read.
  void runtime
    .runPromise(Effect.flatMap(RecentsService, (s) => s.pruneMissing))
    .catch((cause: unknown) => console.error('[main] recents prune failed:', cause))

  const restored = await loadWindowState()
  const win = createWindow(restored)

  if (process.env['BFLAYOUT_SELFTEST']) {
    const { runSelfTest } = await import('./selftest')
    runSelfTest(win)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(restored)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', (event) => {
  event.preventDefault()
  void runtime.dispose().finally(() => app.exit(0))
})
