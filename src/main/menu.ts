import { release } from 'node:os'
import {
  BrowserWindow,
  Menu,
  app,
  clipboard,
  dialog,
  shell,
  type MenuItemConstructorOptions
} from 'electron'

import { showHelp } from './help'

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
      ? ([
          {
            role: 'appMenu',
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              // ⌘, is where macOS puts preferences and where people look for them.
              item('Settings…', 'open-settings', 'CmdOrCtrl+,'),
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          }
        ] as MenuItemConstructorOptions[])
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
        // On macOS this lives in the app menu instead.
        ...(isMac ? [] : [item('Settings…', 'open-settings', 'CmdOrCtrl+,')]),
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
    { role: 'windowMenu' },
    {
      /*
       * `role: 'help'` rather than a plain label. On macOS that is what makes this
       * *the* Help menu — it gets the system search field that indexes the other
       * menus, and it is where the OS expects to find it. A menu merely called
       * "Help" gets neither.
       */
      role: 'help',
      submenu: [
        {
          label: 'BFLayout Documentation',
          click: () => showHelp('README.md')
        },
        {
          label: 'Modding: Projects, Deploy and Packaging',
          click: () => showHelp('README.md#modding')
        },
        { type: 'separator' },
        {
          label: 'Keyboard Shortcuts',
          click: () => showHelp('README.md#keyboard')
        },
        item('Show All Shortcuts…', 'show-shortcuts', 'CmdOrCtrl+/'),
        { type: 'separator' },
        {
          label: 'Using BFLayout with Claude Code (MCP)',
          click: () => showHelp('docs/mcp.md')
        },
        {
          label: 'Game Link: Jump to the Screen the Game Is Showing',
          click: () => showHelp('docs/game-link.md')
        },
        { type: 'separator' },
        {
          label: 'Reveal Application Data…',
          /*
           * Where the database, the dump index and the crash-recovery snapshots
           * live. It is the first thing anyone needs when something is wrong and
           * the last thing they can find, since macOS hides ~/Library.
           */
          click: () => void shell.openPath(app.getPath('userData'))
        },
        {
          label: 'Report a Problem…',
          click: () => void reportProblem()
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

const ISSUES_URL = 'https://github.com/KibbeWater/BFLayout/issues'

/**
 * Puts the details a bug report needs on the clipboard, then opens the issue list.
 *
 * The versions are the whole point. "It crashed opening a layout" is unactionable;
 * the same sentence with the app, Electron and OS versions under it is a bug
 * someone can start on. Asking a person to find those themselves is asking them
 * not to bother.
 *
 * It opens the issue *list* rather than a prefilled new issue: a duplicate is worth
 * finding first, and nothing here submits anything on anyone's behalf.
 */
async function reportProblem(): Promise<void> {
  const details = [
    `BFLayout ${app.getVersion()}`,
    `Electron ${process.versions['electron'] ?? 'unknown'} · Chromium ${process.versions['chrome'] ?? 'unknown'} · Node ${process.versions['node'] ?? 'unknown'}`,
    `${process.platform} ${process.arch} · ${release()}`,
    `Packaged: ${app.isPackaged ? 'yes' : 'no (running from source)'}`,
    '',
    'What I did:',
    'What I expected:',
    'What happened instead:'
  ].join('\n')

  clipboard.writeText(details)

  const answer = await dialog.showMessageBox({
    type: 'info',
    message: 'Details copied to the clipboard',
    detail: `${details}\n\nPaste this into the issue. Opening the issue list now — please check whether it has already been reported.`,
    buttons: ['Open Issues', 'Cancel'],
    defaultId: 0,
    cancelId: 1
  })

  if (answer.response === 0) await shell.openExternal(ISSUES_URL)
}
