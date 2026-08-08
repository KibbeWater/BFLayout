import { BrowserWindow, Menu, app, type MenuItemConstructorOptions } from 'electron'

/**
 * The application menu.
 *
 * Every item here is a shortcut to something the UI already exposes — the menu
 * exists because it is where people look for window management, and because it is
 * the only place macOS puts a menu bar at all. Commands are forwarded to the
 * renderer, which owns the state; main deliberately keeps no opinion about which
 * panels are open.
 */
export function buildMenu(): void {
  const send = (command: string): void => {
    const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    target?.webContents.send('menu-command', command)
  }

  const item = (
    label: string,
    command: string,
    accelerator?: string
  ): MenuItemConstructorOptions => ({
    label,
    ...(accelerator ? { accelerator } : {}),
    click: () => send(command)
  })

  const isMac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([{ role: 'appMenu' }] as MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        item('Open File…', 'open-file', 'CmdOrCtrl+O'),
        item('Open Folder…', 'open-folder', 'CmdOrCtrl+Shift+O'),
        { type: 'separator' },
        item('Save', 'save', 'CmdOrCtrl+S'),
        item('Save As…', 'save-as', 'CmdOrCtrl+Shift+S'),
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        item('Undo', 'undo', 'CmdOrCtrl+Z'),
        item('Redo', 'redo', 'CmdOrCtrl+Shift+Z'),
        { type: 'separator' },
        // Text fields need the real clipboard roles, not forwarded commands.
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        item('Files, Archive & Textures', 'toggle-sidebar', 'CmdOrCtrl+1'),
        item('Hierarchy', 'toggle-hierarchy', 'CmdOrCtrl+2'),
        item('Properties', 'toggle-properties', 'CmdOrCtrl+3'),
        item('Animation Timeline', 'toggle-timeline', 'CmdOrCtrl+4'),
        { type: 'separator' },
        item('Show All Panels', 'show-all-panels'),
        item('Canvas Only', 'canvas-only', 'CmdOrCtrl+0'),
        { type: 'separator' },
        item('Fit Layout to View', 'fit', 'CmdOrCtrl+F'),
        item('Toggle Grid', 'toggle-grid'),
        item('Toggle Textures', 'toggle-textures'),
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  void app
}
