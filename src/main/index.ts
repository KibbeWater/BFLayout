import { buildMenu } from './menu'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { Effect } from 'effect'

import type { WindowState } from '@shared/contract'
import { startRpcServer } from './rpc/handler'
import { runtime } from './runtime'
import { RecentsService } from './services/recents'
import { WindowStateService } from './services/window-state'
import { getUnsavedCount, hasUnsavedWork } from './unsaved'

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

/**
 * Asks the user what to do about unsaved edits, and returns whether to proceed.
 *
 * "Save" is routed back to the renderer, which owns the documents and the save
 * pipeline; main waits for it to report the tabs clean rather than guessing when it
 * finished. If saving fails or stalls, the answer is *not* to proceed — losing the
 * work to a timeout would defeat the point of asking.
 */
async function resolveUnsaved(win: BrowserWindow): Promise<boolean> {
  const count = getUnsavedCount()
  const label = count === 1 ? 'One layout' : `${count} layouts`

  let choice: 'save' | 'discard' | 'cancel' = 'cancel'
  try {
    const result = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Save', 'Discard', 'Cancel'],
      defaultId: 2,
      cancelId: 2,
      noLink: true,
      message: 'Save your changes before closing?',
      detail: `${label} ${count === 1 ? 'has' : 'have'} unsaved edits. If you discard them, they are lost.`
    })
    choice = (['save', 'discard', 'cancel'] as const)[result.response] ?? 'cancel'
  } catch (cause) {
    // A dialog that will not open must not become a silent discard.
    console.error('[main] could not ask about unsaved changes:', cause)
    return false
  }

  if (choice === 'cancel') return false
  if (choice === 'discard') return true

  win.webContents.send('menu-command', 'save-all')
  const saved = await waitForClean()
  if (!saved) {
    console.error('[main] saving before close did not finish; keeping the window open')
  }
  return saved
}

/** Polls until the renderer reports every tab clean, or gives up. */
function waitForClean(timeoutMs = 15000): Promise<boolean> {
  const started = Date.now()
  return new Promise((resolve) => {
    const tick = (): void => {
      if (!hasUnsavedWork()) {
        resolve(true)
        return
      }
      if (Date.now() - started > timeoutMs) {
        resolve(false)
        return
      }
      setTimeout(tick, 100)
    }
    tick()
  })
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
  /*
   * And on request, because the three above are not enough on their own: `did-finish-load` can
   * beat React to mounting its listener, and a window that opens *already* fullscreen — which
   * macOS does when it restores a space — fires no transition. Without a way to ask, the renderer
   * kept the traffic-light inset with no traffic lights behind it.
   */
  ipcMain.on('ask-fullscreen', (event) => {
    if (event.sender === win.webContents) reportFullscreen()
  })

  /*
   * The appearance of *native* chrome.
   *
   * The renderer's `.dark` class only reaches the page; menus, scrollbars, native dialogs and the
   * window frame follow this. The theme setting existed and was applied to nothing at all — `dark`
   * was hardcoded in the HTML — so `light` and `system` did nothing while the UI reported them as
   * chosen.
   */
  ipcMain.on('set-theme-source', (event, theme: unknown) => {
    if (event.sender !== win.webContents) return
    if (theme === 'dark' || theme === 'light' || theme === 'system') {
      nativeTheme.themeSource = theme
    }
  })

  /*
   * Makes this behave like a document window, which on macOS is a specific set of behaviours rather
   * than a look: the title names the open file, the title bar carries its proxy icon, and the close
   * button shows a dot while there are unsaved changes. The app already tracked all three facts and
   * said none of them.
   */
  ipcMain.on('set-document-state', (event, state: unknown) => {
    if (event.sender !== win.webContents || typeof state !== 'object' || state === null) return
    const { title, path, edited } = state as {
      title?: unknown
      path?: unknown
      edited?: unknown
    }
    if (typeof title === 'string') win.setTitle(title)
    if (process.platform === 'darwin') {
      win.setDocumentEdited(edited === true)
      // An empty string clears it, which is what "no file open" should look like.
      win.setRepresentedFilename(typeof path === 'string' ? path : '')
    }
  })

  // Debounced so dragging or resizing does not hammer sqlite.
  let saveTimer: NodeJS.Timeout | undefined
  const scheduleSave = (): void => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => persistWindowState(win), 400)
  }
  win.on('resize', scheduleSave)
  win.on('move', scheduleSave)

  /**
   * Set once the user has answered the prompt for *this* window, so the re-issued
   * close is not intercepted again. Scoped per window rather than per process:
   * module-level, a window reopened through `activate` would inherit the flag and
   * skip the guard entirely.
   */
  let allowClose = false

  /**
   * Closing the window with unsaved edits asks first.
   *
   * `close` is synchronous — the only way to stop it is to preventDefault during
   * the event — so the answer has to already be here rather than fetched from the
   * renderer. That is what `unsaved.ts` is for. Once the user has decided, the
   * close is re-issued with `allowClose` set so this guard steps aside.
   *
   * Without this, Cmd+W discarded every unsaved layout silently, which for an
   * editor whose whole point is careful edits to game files was the worst bug in
   * the app.
   */
  win.on('close', (event) => {
    if (!allowClose && hasUnsavedWork()) {
      event.preventDefault()
      void resolveUnsaved(win).then((proceed) => {
        if (!proceed) return
        allowClose = true
        win.close()
      })
      return
    }

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
