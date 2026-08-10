import { useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FilePlus2,
  Info,
  Loader2,
  Package,
  GitCompare,
  PackageOpen,
  Rocket,
  ShieldCheck,
  Undo2,
  XCircle
} from 'lucide-react'

import type { CheckNoteView, ModCheckedFile } from '@shared/contract'
import { getClient, getOrpc } from '@renderer/lib/orpc'
import { reportError, reportSuccess } from '@renderer/lib/toast'
import { useOpenFile } from '@renderer/lib/use-open-file'

/**
 * Everything about the mod as a whole, in one place.
 *
 * The rest of the app edits one file at a time, which is the right shape for
 * editing and the wrong one for shipping: a mod is the *set* of files, and the
 * questions that matter — what does it contain, is any of it broken, where does
 * it install — have no answer in a per-file view. This panel is that answer.
 */

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function NoteIcon({ level }: { level: CheckNoteView['level'] }): ReactNode {
  if (level === 'error') return <XCircle className="mt-0.5 size-3 shrink-0 text-destructive" />
  if (level === 'warning')
    return <AlertTriangle className="mt-0.5 size-3 shrink-0 text-amber-500" />
  return <Info className="mt-0.5 size-3 shrink-0 text-muted-foreground/60" />
}

function CheckedFileRow({ file }: { file: ModCheckedFile }): ReactNode {
  const worst = file.notes.some((found) => found.level === 'error')
    ? 'error'
    : file.notes.some((found) => found.level === 'warning')
      ? 'warning'
      : 'ok'
  const [open, setOpen] = useState(worst !== 'ok')

  return (
    <li className="border-b last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-xs hover:bg-accent/40"
      >
        {open ? (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        )}
        {worst === 'error' ? (
          <XCircle className="size-3.5 shrink-0 text-destructive" />
        ) : worst === 'warning' ? (
          <AlertTriangle className="size-3.5 shrink-0 text-amber-500" />
        ) : (
          <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={file.relativePath}>
          {file.relativePath}
        </span>
        {!file.replacesPristine ? (
          <span
            className="shrink-0 rounded bg-emerald-500/20 px-1 text-[9px] uppercase text-emerald-500"
            title="The dump has no file at this path"
          >
            new
          </span>
        ) : null}
        <span className="shrink-0 text-[10px] uppercase text-muted-foreground/60">
          {file.format}
        </span>
      </button>
      {open && file.notes.length > 0 ? (
        <ul className="space-y-1 px-2 pb-2 pl-7">
          {file.notes.map((found, index) => (
            <li key={index} className="flex gap-1.5 text-[11px] text-muted-foreground">
              <NoteIcon level={found.level} />
              <span className="min-w-0">{found.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  )
}

export function ModPanel(): ReactNode {
  const orpc = getOrpc()
  const queryClient = useQueryClient()
  const status = useQuery(orpc.project.status.queryOptions())
  const targets = useQuery(orpc.deploy.targets.queryOptions())
  const { openPath } = useOpenFile()

  const [checking, setChecking] = useState(false)
  const [deploying, setDeploying] = useState(false)
  const [diffing, setDiffing] = useState(false)
  const [packaging, setPackaging] = useState(false)
  /** Which report the body shows. Only one at a time — they answer different questions. */
  const [view, setView] = useState<'files' | 'check' | 'diff'>('files')
  const [diff, setDiff] = useState<Awaited<
    ReturnType<ReturnType<typeof getClient>['modDiff']['run']>
  > | null>(null)
  const [report, setReport] = useState<Awaited<
    ReturnType<ReturnType<typeof getClient>['modCheck']['run']>
  > | null>(null)

  const project = status.data?.project ?? null
  const files = status.data?.files ?? []

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: orpc.project.status.key() })
  }

  const check = (): void => {
    setChecking(true)
    void (async () => {
      try {
        const result = await getClient().modCheck.run()
        setReport(result)
        setView('check')
        reportSuccess(
          result.errors > 0
            ? `${result.errors} problem${result.errors === 1 ? '' : 's'} found`
            : result.warnings > 0
              ? `${result.warnings} warning${result.warnings === 1 ? '' : 's'}`
              : 'Everything checks out',
          result.errors > 0
            ? 'Files listed below will very likely not load in the game.'
            : `${result.files.length} file${result.files.length === 1 ? '' : 's'} read and parsed.`
        )
      } catch (cause) {
        reportError(cause, { retry: check })
      } finally {
        setChecking(false)
      }
    })()
  }

  /**
   * What the mod changes, structurally.
   *
   * The file list says which files were touched; this says what was done to them.
   * It is the same view a reviewer wants and the same one a release note is made
   * of, which is why it is worth computing rather than remembering.
   */
  const showDiff = (): void => {
    setDiffing(true)
    void (async () => {
      try {
        const result = await getClient().modDiff.run()
        setDiff(result)
        setView('diff')
        reportSuccess(
          result.totalChanges === 0 ? 'Nothing structural to report' : 'Compared with the dump',
          result.totalChanges === 0
            ? `${result.files.length} file${result.files.length === 1 ? '' : 's'} differ, but none in a way BFLayout can describe — textures and unmodelled formats compare as bytes.`
            : `${result.totalChanges} change${result.totalChanges === 1 ? '' : 's'} across ${result.files.length} file${result.files.length === 1 ? '' : 's'}.`
        )
      } catch (cause) {
        reportError(cause, { retry: showDiff })
      } finally {
        setDiffing(false)
      }
    })()
  }

  /**
   * Writes the mod out as an installable zip.
   *
   * The shape is the standard `contents/<title id>/romfs/…`, so the result is the
   * mod rather than a BFLayout format — someone who has never heard of this editor
   * can drop it into their emulator's mods folder.
   */
  const exportPackage = (): void => {
    setPackaging(true)
    void (async () => {
      const client = getClient()
      try {
        const version = window.prompt('Version for this release.', '1.0.0')
        if (version === null) return
        const author = window.prompt('Author, for the manifest. Leave blank to skip.', '') ?? ''

        const chosen = await client.dialog.saveFileAs({
          purpose: 'any',
          defaultName: `${project?.name.replace(/\s+/g, '-').toLowerCase() ?? 'mod'}-${version}.zip`
        })
        if (chosen.canceled || !chosen.path) return

        const result = await client.package.export({
          path: chosen.path,
          version,
          author
        })
        reportSuccess(
          'Packaged',
          `${result.fileCount} file${result.fileCount === 1 ? '' : 's'} written to ${result.path} (${formatBytes(result.bytes)}), built for game version ${result.gameVersion || 'unrecorded'}.`
        )
      } catch (cause) {
        reportError(cause, { retry: exportPackage })
      } finally {
        setPackaging(false)
      }
    })()
  }

  /**
   * Reads a package, says what is wrong with it, and only then offers to install.
   *
   * The version check has to happen before any bytes reach disk. A layout mod for
   * the wrong game build does not fail cleanly — it loads, and the game misbehaves
   * in ways nobody attributes to the mod.
   */
  const importPackage = (): void => {
    setPackaging(true)
    void (async () => {
      const client = getClient()
      try {
        const chosen = await client.dialog.openFiles({ purpose: 'any' })
        if (chosen.canceled || chosen.paths.length === 0) return
        const path = chosen.paths[0]!

        const info = await client.package.inspect({ path })
        const summary = [
          info.name ? `${info.name}${info.version ? ` ${info.version}` : ''}` : 'Unnamed package',
          info.author ? `by ${info.author}` : null,
          `${info.files.length} file${info.files.length === 1 ? '' : 's'}`,
          info.gameVersion ? `for game version ${info.gameVersion}` : null
        ]
          .filter(Boolean)
          .join(' · ')

        const question = [
          summary,
          '',
          ...(info.warnings.length > 0 ? [...info.warnings, ''] : []),
          'Install it into your mod folder?'
        ].join('\n')

        if (!window.confirm(question)) return

        const result = await client.package.import({ path, overwrite: false })
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.project.status.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.folder.list.key() })
        ])
        reportSuccess(
          'Imported',
          `${result.imported.length} file${result.imported.length === 1 ? '' : 's'} added.` +
            (result.skipped.length > 0
              ? ` ${result.skipped.length} left alone because your mod already has them.`
              : '')
        )
      } catch (cause) {
        reportError(cause, { retry: importPackage })
      } finally {
        setPackaging(false)
      }
    })()
  }

  const deploy = (): void => {
    setDeploying(true)
    void (async () => {
      try {
        const result = await getClient().deploy.run({})
        reportSuccess(
          'Deployed',
          `${result.copied} file${result.copied === 1 ? '' : 's'} installed to ${result.target}.` +
            (result.removed.length > 0
              ? ` ${result.removed.length} stale file${result.removed.length === 1 ? '' : 's'} removed.`
              : '') +
            ' Restart the game to load it.'
        )
      } catch (cause) {
        reportError(cause, { retry: deploy })
      } finally {
        setDeploying(false)
      }
    })()
  }

  const revert = (relativePath: string): void => {
    if (
      !window.confirm(
        `Remove ${relativePath} from your mod?\n\nIf the dump has a file at that path, the game's original applies again.`
      )
    ) {
      return
    }
    void (async () => {
      try {
        await getClient().project.revert({ relativePath })
        refresh()
        void queryClient.invalidateQueries({ queryKey: orpc.folder.list.key() })
        reportSuccess('Reverted', `${relativePath} is no longer part of your mod.`)
      } catch (cause) {
        reportError(cause, { retry: () => revert(relativePath) })
      }
    })()
  }

  if (status.isPending) {
    return (
      <p className="flex items-center gap-2 p-3 text-xs text-muted-foreground/60">
        <Loader2 className="size-3 animate-spin" />
        Loading…
      </p>
    )
  }

  if (!project) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
        <Package className="size-5 text-muted-foreground/50" />
        <p className="text-xs text-muted-foreground/70">
          No mod project is open, so saves go straight back to the files you opened.
        </p>
        <p className="text-[11px] text-muted-foreground/50">
          Set one up from the welcome screen: it makes the dump read-only and collects
          every edit in a mod folder.
        </p>
      </div>
    )
  }

  const present = (targets.data ?? []).filter((target) => target.exists)
  const deployBlocked =
    project.titleId.trim() === ''
      ? 'This project has no title ID; a romfs mod is found by title.'
      : files.length === 0
        ? 'Nothing to deploy yet.'
        : present.length === 0
          ? 'No emulator data directory found.'
          : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-2 border-b p-2">
        <div className="flex items-center gap-1.5">
          <Package className="size-3.5 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{project.name}</span>
          <span className="shrink-0 text-[10px] text-muted-foreground/70">
            {files.length} file{files.length === 1 ? '' : 's'} ·{' '}
            {formatBytes(status.data?.totalBytes ?? 0)}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={check}
            disabled={checking || files.length === 0}
            className="flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-50"
            title="Read and parse every file in the mod, and everything inside its archives"
          >
            {checking ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <ShieldCheck className="size-3" />
            )}
            Check
          </button>
          <button
            type="button"
            onClick={showDiff}
            disabled={diffing || files.length === 0}
            className="flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-50"
            title="Compare every file with the dump's copy and say what changed"
          >
            {diffing ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <GitCompare className="size-3" />
            )}
            Diff
          </button>
          <button
            type="button"
            onClick={deploy}
            disabled={deploying || deployBlocked !== null}
            className="flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-50"
            title={deployBlocked ?? `Install into ${present[0]?.label}'s mods folder`}
          >
            {deploying ? <Loader2 className="size-3 animate-spin" /> : <Rocket className="size-3" />}
            Deploy
          </button>
          <button
            type="button"
            onClick={exportPackage}
            disabled={packaging || files.length === 0}
            className="flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-50"
            title="Write an installable zip in the standard contents/<title id>/romfs shape"
          >
            {packaging ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <PackageOpen className="size-3" />
            )}
            Package
          </button>
          <button
            type="button"
            onClick={importPackage}
            disabled={packaging}
            className="rounded border px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-50"
            title="Read someone else's mod package, check what it targets, and install it"
          >
            Import
          </button>
          {view !== 'files' ? (
            <button
              type="button"
              onClick={() => setView('files')}
              className="ml-auto text-[10px] text-primary hover:underline"
            >
              back to files
            </button>
          ) : report ? (
            <span className="ml-auto text-[10px] text-muted-foreground/70">
              {report.errors > 0
                ? `${report.errors} error${report.errors === 1 ? '' : 's'}`
                : report.warnings > 0
                  ? `${report.warnings} warning${report.warnings === 1 ? '' : 's'}`
                  : 'all clear'}
            </span>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {view === 'check' && report && report.notes.length > 0 ? (
          <ul className="border-b bg-amber-500/5 p-2">
            {report.notes.map((note, index) => (
              <li key={index} className="flex gap-1.5 text-[11px] text-muted-foreground">
                <NoteIcon level={note.level} />
                <span className="min-w-0">{note.message}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {view === 'diff' && diff ? (
          <ul>
            {diff.files.map((file) => (
              <li key={file.relativePath} className="border-b p-2 last:border-b-0">
                <p className="flex items-center gap-1.5">
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-[11px]"
                    title={file.relativePath}
                  >
                    {file.relativePath}
                  </span>
                  {file.isNew ? (
                    <span className="shrink-0 rounded bg-emerald-500/20 px-1 text-[9px] uppercase text-emerald-500">
                      new
                    </span>
                  ) : null}
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">{file.summary}</p>
                {file.changes.length > 0 ? (
                  <ul className="mt-1 space-y-0.5">
                    {file.changes.map((change, index) => (
                      <li key={index} className="text-[11px] text-muted-foreground/80">
                        <span className="font-medium text-foreground">{change.target}</span>{' '}
                        {change.detail}
                      </li>
                    ))}
                  </ul>
                ) : file.entries.length > 0 ? (
                  <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground/60">
                    {file.entries.join(', ')}
                  </p>
                ) : null}
              </li>
            ))}
            {diff.files.length === 0 ? (
              <li className="p-4 text-center text-[11px] text-muted-foreground/60">
                Your mod matches the dump exactly.
              </li>
            ) : null}
          </ul>
        ) : view === 'check' && report ? (
          <ul>
            {report.files.map((file) => (
              <CheckedFileRow key={file.relativePath} file={file} />
            ))}
          </ul>
        ) : files.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-4 text-center">
            <FilePlus2 className="size-5 text-muted-foreground/40" />
            <p className="text-[11px] text-muted-foreground/60">
              Your mod is empty. Open a file from the dump, edit it and save — the copy
              lands here, and the dump stays untouched.
            </p>
          </div>
        ) : (
          <ul>
            {files.map((file) => (
              <li
                key={file.relativePath}
                className="group flex items-center gap-1.5 border-b last:border-b-0"
              >
                {/*
                  The list of what a mod contains is also the shortest route into
                  it — these are the files you are actually working on, and having
                  to find them again in the browser is the long way round.
                */}
                <button
                  type="button"
                  onClick={() =>
                    void openPath(`${project.modPath}/${file.relativePath}`, 'auto')
                  }
                  className="min-w-0 flex-1 truncate px-2 py-1.5 text-left font-mono text-[11px] hover:bg-accent/40"
                  title={`Open ${file.relativePath}`}
                >
                  {file.relativePath}
                </button>
                {!file.replacesPristine ? (
                  <span
                    className="shrink-0 rounded bg-emerald-500/20 px-1 text-[9px] uppercase text-emerald-500"
                    title="The dump has no file at this path"
                  >
                    new
                  </span>
                ) : null}
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">
                  {formatBytes(file.size)}
                </span>
                <button
                  type="button"
                  onClick={() => revert(file.relativePath)}
                  className="mr-2 shrink-0 rounded p-0.5 opacity-0 hover:bg-accent focus-visible:opacity-100 group-hover:opacity-100"
                  title="Remove from the mod"
                  aria-label={`Remove ${file.relativePath} from the mod`}
                >
                  <Undo2 className="size-3 text-muted-foreground/70" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
