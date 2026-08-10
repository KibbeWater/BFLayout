import { useCallback, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  ArrowRight,
  FolderOpen,
  Loader2,
  Package,
  Plus,
  Rocket,
  Settings2,
  X
} from 'lucide-react'

import { getClient, getOrpc } from '@renderer/lib/orpc'
import { reportError, reportSuccess } from '@renderer/lib/toast'
import { ProjectSettings } from '@renderer/components/project-settings'
import { useFolder } from '@renderer/editor/store/folder'
import type { ModProject } from '@shared/contract'

/**
 * The mod project card.
 *
 * A project is what separates modding from file editing: it names the pristine
 * dump — which becomes read-only for as long as the project is active — and the
 * folder the mod is being built in, which is where every save of a dump file
 * lands instead. That redirect is invisible while it is working, so this card
 * exists to make the arrangement legible: which dump, which mod folder, and how
 * many files the mod currently replaces.
 */

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** A labelled folder field that fills itself from the native picker. */
function FolderField(props: {
  label: string
  hint: string
  /** What the native picker says it is asking for. Two identical dialogs in a row
   * is how the second answer ends up in the first field. */
  dialogTitle: string
  value: string
  onChange: (value: string) => void
}): ReactNode {
  const [picking, setPicking] = useState(false)

  const pick = (): void => {
    setPicking(true)
    void (async () => {
      try {
        const chosen = await getClient().dialog.openFolder({
          title: props.dialogTitle,
          buttonLabel: 'Choose'
        })
        if (!chosen.canceled && chosen.path) props.onChange(chosen.path)
      } catch (cause) {
        reportError(cause)
      } finally {
        setPicking(false)
      }
    })()
  }

  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {props.label}
      </span>
      <span className="flex items-center gap-2">
        <input
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
          placeholder={props.hint}
          spellCheck={false}
          className="min-w-0 flex-1 rounded border bg-background px-2 py-1 font-mono text-xs"
        />
        <button
          type="button"
          onClick={pick}
          disabled={picking}
          className="flex shrink-0 items-center gap-1 rounded border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
        >
          {picking ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <FolderOpen className="size-3" />
          )}
          Choose…
        </button>
      </span>
    </label>
  )
}

/**
 * Opens a project: browse its dump, with the mod layered over it.
 *
 * Activating a project only records which one it is — the redirect and the
 * read-only guard are process-wide state, not a screen. That left the obvious
 * next step missing: a project was active and nothing had opened, with no way in
 * but knowing to press "Open folder…" and re-pick a path the project already
 * knows.
 *
 * The dump is what gets opened rather than the mod folder, and that is the point
 * of the overlay: you browse the whole game and see your own files badged inside
 * it, because a mod is edited in the context of what it modifies. The mod on its
 * own is in the Mod tab.
 */
function useOpenProject(): (project: ModProject) => void {
  const navigate = useNavigate()
  const openFolder = useFolder((state) => state.open)

  return useCallback(
    (project: ModProject) => {
      openFolder(project.dumpPath)
      void navigate({ to: '/editor' })
    },
    [navigate, openFolder]
  )
}

function NewProjectForm(props: { onDone: () => void; onCancel: () => void }): ReactNode {
  const orpc = getOrpc()
  const queryClient = useQueryClient()
  const openProject = useOpenProject()
  const [name, setName] = useState('')
  const [dumpPath, setDumpPath] = useState('')
  const [modPath, setModPath] = useState('')
  const [titleId, setTitleId] = useState('')
  const [modName, setModName] = useState('')
  const [gameVersion, setGameVersion] = useState('')

  const create = useMutation(
    orpc.project.create.mutationOptions({
      onSuccess: async (project) => {
        /*
         * Created and then activated, rather than created active. Activating is
         * what mounts the dump read-only process-wide, and doing it as its own
         * step means a half-written project can never leave the app in a state
         * where saving is refused for a project the user never finished making.
         */
        try {
          await getClient().project.setActive({ id: project.id })
        } catch (cause) {
          reportError(cause)
        }
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.project.list.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.project.active.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.project.status.key() })
        ])
        reportSuccess(
          'Mod project ready',
          `${project.name} is active. ${project.dumpPath} is now read-only, and edits will be saved into ${project.modPath}.`
        )
        props.onDone()
        // Straight into the files. Creating a project and being left on the
        // welcome screen is the step where it stops being obvious what to do.
        openProject(project)
      }
    })
  )

  const ready = name.trim() !== '' && dumpPath.trim() !== '' && modPath.trim() !== ''

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        if (!ready) return
        create.mutate({
          name: name.trim(),
          dumpPath: dumpPath.trim(),
          modPath: modPath.trim(),
          titleId: titleId.trim(),
          modName: modName.trim(),
          gameVersion: gameVersion.trim()
        })
      }}
      className="flex w-full flex-col gap-3 rounded-lg border bg-card/60 p-4"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium">New mod project</h3>
        <button
          type="button"
          onClick={props.onCancel}
          className="rounded p-1 hover:bg-accent"
          aria-label="Cancel"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Name
        </span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Bigger buttons"
          className="rounded border bg-background px-2 py-1 text-xs"
        />
      </label>

      <FolderField
        label="Pristine dump"
        hint="Pick the extracted romfs folder"
        dialogTitle="Choose the pristine romfs dump"
        value={dumpPath}
        onChange={setDumpPath}
      />
      <FolderField
        label="Mod folder"
        hint="Where your edits are collected"
        dialogTitle="Choose the folder your mod is built in"
        value={modPath}
        onChange={setModPath}
      />
      <p className="-mt-1 text-[11px] text-muted-foreground/70">
        The dump becomes read-only. Saving a file from it writes a copy into the mod
        folder instead, which is created if it does not exist.
      </p>

      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Title ID
          </span>
          <input
            value={titleId}
            onChange={(event) => setTitleId(event.target.value)}
            placeholder="e.g. 0100…2000"
            spellCheck={false}
            className="rounded border bg-background px-2 py-1 font-mono text-xs"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Game version
          </span>
          <input
            value={gameVersion}
            onChange={(event) => setGameVersion(event.target.value)}
            placeholder="e.g. 1.0.0"
            spellCheck={false}
            className="rounded border bg-background px-2 py-1 font-mono text-xs"
          />
        </label>
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Mod folder name
        </span>
        <input
          value={modName}
          onChange={(event) => setModName(event.target.value)}
          placeholder={
            name.trim() === ''
              ? 'derived from the name'
              : `derived: ${name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-')}`
          }
          spellCheck={false}
          className="rounded border bg-background px-2 py-1 font-mono text-xs"
        />
      </label>
      {/*
        The field that is easy to leave alone and expensive to get wrong. A mod that
        is more than asset replacement has a code half installing into the same
        directory, and a derived name would deploy a second, parallel mod that the
        loader's own deploy does not manage.
      */}
      <p className="-mt-1 text-[11px] text-muted-foreground/70">
        Where a deploy installs, under{' '}
        <span className="font-mono">mods/contents/&lt;title id&gt;/</span>. If this mod
        also ships a loader or plugin, set this to the name that half already uses —
        Colony uses <span className="font-mono">colony</span> — so both halves land in
        one mod rather than two.
      </p>

      {/*
        Both fields are optional, and both have consequences that would otherwise
        only surface much later — at the Deploy button, or at an import that should
        have been refused. Saying so here is the difference between an informed
        choice and a dead end found an hour in.
      */}
      <p className="text-[11px] text-muted-foreground/70">
        The title ID places a deploy and names the folder inside a release zip. The
        version is recorded so a mod built against a different build can be refused
        on import rather than crashing the game.
        {titleId.trim() === '' ? (
          <span className="mt-1 block text-amber-500">
            Without a title ID you can edit and diff, but Deploy and Package will not
            work — a romfs mod is found by title. You can add it later.
          </span>
        ) : null}
      </p>

      <button
        type="submit"
        disabled={!ready || create.isPending}
        className="flex items-center justify-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
      >
        {create.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
        Create and activate
      </button>
    </form>
  )
}

export function ProjectCard(): ReactNode {
  const orpc = getOrpc()
  const queryClient = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState(false)

  const projects = useQuery(orpc.project.list.queryOptions())
  const status = useQuery(orpc.project.status.queryOptions())
  const openProject = useOpenProject()

  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.project.list.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.project.active.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.project.status.key() })
    ])
  }

  const setActive = useMutation(
    orpc.project.setActive.mutationOptions({
      onSuccess: async (project) => {
        await refresh()
        reportSuccess(
          project ? 'Mod project active' : 'Mod project closed',
          project
            ? `${project.dumpPath} is read-only; edits save into ${project.modPath}.`
            : 'The dump is writable again, and saves go back where files were opened from.'
        )
        // Choosing a project from the list is someone saying "work on this one",
        // so it opens rather than only being recorded.
        if (project) openProject(project)
      }
    })
  )

  if (creating) {
    return (
      <div className="w-full max-w-xl">
        <NewProjectForm onDone={() => setCreating(false)} onCancel={() => setCreating(false)} />
      </div>
    )
  }

  const active = status.data?.project ?? null
  const all = projects.data ?? []

  if (!active) {
    return (
      <div className="flex w-full max-w-xl items-center gap-3 rounded-lg border border-dashed bg-card/30 p-3">
        <Package className="size-4 shrink-0 text-muted-foreground" />
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">No mod project</span> — saves go
          straight back to the files you opened. A project makes the dump read-only and
          collects your edits in a mod folder.
        </p>
        {all.length > 0 ? (
          <select
            value=""
            onChange={(event) => setActive.mutate({ id: Number(event.target.value) })}
            className="rounded border bg-background px-2 py-1 text-xs"
            aria-label="Activate an existing mod project"
          >
            <option value="" disabled>
              Open…
            </option>
            {all.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        ) : null}
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="flex shrink-0 items-center gap-1.5 rounded border px-2 py-1 text-xs hover:bg-accent"
        >
          <Plus className="size-3.5" />
          New
        </button>
      </div>
    )
  }

  if (editing) {
    return (
      <div className="w-full max-w-xl">
        <ProjectSettings project={active} onClose={() => setEditing(false)} />
      </div>
    )
  }

  const files = status.data?.files ?? []
  const added = files.filter((file) => !file.replacesPristine).length

  return (
    <div className="flex w-full max-w-xl flex-col gap-2 rounded-lg border bg-card/60 p-3">
      <div className="flex items-center gap-3">
        <Package className="size-4 shrink-0 text-primary" />
        <p className="min-w-0 flex-1 truncate text-xs">
          <span className="font-medium">{active.name}</span>
          <span className="text-muted-foreground">
            {' — '}
            {files.length === 0
              ? 'no files yet'
              : `${files.length} file${files.length === 1 ? '' : 's'}, ${formatBytes(status.data?.totalBytes ?? 0)}`}
            {added > 0 ? ` (${added} added)` : ''}
          </span>
        </p>
        {all.length > 1 ? (
          <select
            value={active.id}
            onChange={(event) => setActive.mutate({ id: Number(event.target.value) })}
            className="rounded border bg-background px-2 py-1 text-xs"
            aria-label="Switch mod project"
          >
            {all.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        ) : null}
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="rounded p-1 hover:bg-accent"
          title="Project settings"
          aria-label="Project settings"
        >
          <Settings2 className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded p-1 hover:bg-accent"
          title="New mod project"
          aria-label="New mod project"
        >
          <Plus className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setActive.mutate({ id: null })}
          disabled={setActive.isPending}
          className="rounded p-1 hover:bg-accent disabled:opacity-50"
          title="Close this project and make the dump writable again"
          aria-label="Close this mod project"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
        <dt>dump</dt>
        <dd className="truncate" title={active.dumpPath}>
          {active.dumpPath} <span className="text-muted-foreground/60">(read-only)</span>
        </dd>
        <dt>mod</dt>
        <dd className="truncate" title={active.modPath}>
          {active.modPath}
        </dd>
      </dl>
      {/*
        The primary action, and the one that was missing: a project that is active
        but has nothing open is a state with no obvious next step. It leads rather
        than sits beside Deploy, because opening is what you do first and every
        time, while deploying is what you do occasionally.
      */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => openProject(active)}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
        >
          <ArrowRight className="size-3.5" />
          Open {active.name}
        </button>
        <span className="min-w-0 truncate text-[11px] text-muted-foreground/70">
          Browse the dump with your mod layered over it
        </span>
      </div>
      <DeployButton disabled={files.length === 0} titleId={active.titleId} />
    </div>
  )
}

/**
 * Installs the mod layer where the emulator will load it.
 *
 * Deliberately stops there. Starting the game is a separate decision, and a tool
 * that launches an emulator because you pressed save is one people learn to be
 * wary of.
 */
function DeployButton({
  disabled,
  titleId
}: {
  disabled: boolean
  titleId: string
}): ReactNode {
  const orpc = getOrpc()
  const [busy, setBusy] = useState(false)
  const targets = useQuery(orpc.deploy.targets.queryOptions())

  const present = (targets.data ?? []).filter((target) => target.exists)
  const noTitle = titleId.trim() === ''

  const blocked = noTitle
    ? 'This project has no title ID, and a mod is found by title. Add one first.'
    : disabled
      ? 'Nothing to deploy yet — edit and save a file from the dump.'
      : present.length === 0
        ? `No emulator data directory found. Looked in: ${(targets.data ?? []).map((target) => target.dataDir).join(', ')}`
        : null

  const deploy = (): void => {
    setBusy(true)
    void (async () => {
      try {
        const result = await getClient().deploy.run({})
        reportSuccess(
          'Deployed',
          `${result.copied} file${result.copied === 1 ? '' : 's'} installed to ${result.target}.` +
            (result.removed.length > 0
              ? ` ${result.removed.length} stale file${result.removed.length === 1 ? '' : 's'} removed: ${result.removed.slice(0, 3).join(', ')}${result.removed.length > 3 ? '…' : ''}.`
              : '') +
            ' Restart the game to load it.'
        )
      } catch (cause) {
        reportError(cause, { retry: deploy })
      } finally {
        setBusy(false)
      }
    })()
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={deploy}
        disabled={busy || blocked !== null}
        className="flex items-center gap-1.5 rounded border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
        title={blocked ?? `Install into ${present[0]?.label ?? 'the emulator'}'s mods folder`}
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Rocket className="size-3.5" />}
        Deploy
      </button>
      <span className="min-w-0 truncate text-[11px] text-muted-foreground/70">
        {blocked ?? `→ ${present[0]?.label}`}
      </span>
    </div>
  )
}
