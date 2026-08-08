import { BrowserWindow, dialog } from 'electron'
import { Effect } from 'effect'

import { IoError } from '@main/errors'

const LAYOUT_EXTENSIONS = ['bflyt', 'bclyt', 'brlyt']
const ANIM_EXTENSIONS = ['bflan', 'bclan', 'brlan']
const ARCHIVE_EXTENSIONS = ['szs', 'sarc', 'arc', 'lyarc', 'pack', 'zs']

export type OpenPurpose = 'layout' | 'archive' | 'any'

function filtersFor(purpose: OpenPurpose): Electron.FileFilter[] {
  const layout = { name: 'Layouts', extensions: LAYOUT_EXTENSIONS }
  const archive = { name: 'Archives', extensions: ARCHIVE_EXTENSIONS }
  const all = { name: 'All files', extensions: ['*'] }

  switch (purpose) {
    case 'layout':
      return [layout, all]
    case 'archive':
      return [archive, all]
    default:
      return [
        {
          name: 'Layouts and archives',
          extensions: [...LAYOUT_EXTENSIONS, ...ANIM_EXTENSIONS, ...ARCHIVE_EXTENSIONS]
        },
        layout,
        archive,
        all
      ]
  }
}

export class DialogService extends Effect.Service<DialogService>()('DialogService', {
  sync: () => {
    const openFiles = (options: { purpose: OpenPurpose; multiple?: boolean }) =>
      Effect.tryPromise({
        try: async () => {
          const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
          const properties: Array<'openFile' | 'multiSelections'> = ['openFile']
          if (options.multiple) properties.push('multiSelections')

          const result = parent
            ? await dialog.showOpenDialog(parent, {
                properties,
                filters: filtersFor(options.purpose)
              })
            : await dialog.showOpenDialog({
                properties,
                filters: filtersFor(options.purpose)
              })

          return { canceled: result.canceled, paths: result.filePaths }
        },
        catch: (cause) =>
          new IoError({
            detail: `could not open the file dialog: ${
              cause instanceof Error ? cause.message : String(cause)
            }`
          })
      })

    /**
     * Picks a directory — a dumped romfs, typically. No filters: the point is to
     * browse whatever is in there, including formats this build does not know.
     */
    const openFolder = Effect.tryPromise({
      try: async () => {
        const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
        const options = {
          properties: ['openDirectory' as const],
          title: 'Open a folder'
        }
        const result = parent
          ? await dialog.showOpenDialog(parent, options)
          : await dialog.showOpenDialog(options)
        return { canceled: result.canceled, path: result.filePaths[0] ?? null }
      },
      catch: (cause) =>
        new IoError({
          detail: `could not open the folder dialog: ${
            cause instanceof Error ? cause.message : String(cause)
          }`
        })
    })

    const saveFileAs = (options: { defaultName?: string; purpose: OpenPurpose }) =>
      Effect.tryPromise({
        try: async () => {
          const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
          const config: Electron.SaveDialogOptions = {
            filters: filtersFor(options.purpose),
            ...(options.defaultName ? { defaultPath: options.defaultName } : {})
          }
          const result = parent
            ? await dialog.showSaveDialog(parent, config)
            : await dialog.showSaveDialog(config)

          return { canceled: result.canceled, path: result.filePath ?? null }
        },
        catch: (cause) =>
          new IoError({
            detail: `could not open the save dialog: ${
              cause instanceof Error ? cause.message : String(cause)
            }`
          })
      })

    /**
     * Confirms before unsaved edits are thrown away.
     *
     * Cancel is both the default and the escape action, so a stray Return or Escape
     * keeps the work rather than losing it. "Discard" is flagged destructive, which
     * macOS renders in red.
     */
    const confirmDiscard = (options: { name: string; scope: 'tab' | 'window' }) =>
      Effect.tryPromise({
        try: async () => {
          const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
          const config: Electron.MessageBoxOptions = {
            type: 'warning',
            buttons: ['Save', 'Discard', 'Cancel'],
            defaultId: 2,
            cancelId: 2,
            noLink: true,
            message:
              options.scope === 'tab'
                ? `Save your changes to ${options.name}?`
                : `Save your changes before closing?`,
            detail:
              options.scope === 'tab'
                ? 'If you discard them, your edits to this layout are lost.'
                : `${options.name} has unsaved edits. If you discard them, they are lost.`
          }

          const result = parent
            ? await dialog.showMessageBox(parent, config)
            : await dialog.showMessageBox(config)

          const choice = (['save', 'discard', 'cancel'] as const)[result.response] ?? 'cancel'
          return { choice }
        },
        catch: (cause) =>
          new IoError({
            detail: `could not ask about unsaved changes: ${
              cause instanceof Error ? cause.message : String(cause)
            }`
          })
      })

    return { openFiles, openFolder, saveFileAs, confirmDiscard } as const
  }
}) {}
