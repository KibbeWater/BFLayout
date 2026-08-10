import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FolderOpen, Loader2, RotateCcw, X } from 'lucide-react'

import type { ModProject, ModProjectSettings } from '@shared/contract'
import { defaultProjectSettings } from '@shared/contract'
import { getClient, getOrpc } from '@renderer/lib/orpc'
import { reportError, reportSuccess } from '@renderer/lib/toast'

/**
 * Editing a project, and the quirks of the one it is for.
 *
 * Everything here has a default that is right for the common case, so a project
 * that never opens this is configured correctly. Each setting exists because some
 * real project needed it to be different — which is why each one says what it is
 * for rather than only what it is called.
 *
 * It doubles as the edit form: until now a project's paths and title were fixed
 * at creation, so a typo meant making a new one.
 */

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}): ReactNode {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
      {hint ? <span className="text-[11px] text-muted-foreground/70">{hint}</span> : null}
    </label>
  )
}

function Toggle({
  label,
  hint,
  value,
  onChange
}: {
  label: string
  hint: string
  value: boolean
  onChange: (value: boolean) => void
}): ReactNode {
  return (
    <label className="flex items-start gap-2">
      <input
        type="checkbox"
        checked={value}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5"
      />
      <span className="min-w-0 flex-1">
        <span className="block text-xs">{label}</span>
        <span className="block text-[11px] text-muted-foreground/70">{hint}</span>
      </span>
    </label>
  )
}

export function ProjectSettings({
  project,
  onClose
}: {
  project: ModProject
  onClose: () => void
}): ReactNode {
  const orpc = getOrpc()
  const queryClient = useQueryClient()

  const [name, setName] = useState(project.name)
  const [dumpPath, setDumpPath] = useState(project.dumpPath)
  const [modPath, setModPath] = useState(project.modPath)
  const [titleId, setTitleId] = useState(project.titleId)
  const [modName, setModName] = useState(project.modName)
  const [gameVersion, setGameVersion] = useState(project.gameVersion)
  const [settings, setSettings] = useState<ModProjectSettings>(project.settings)

  const targets = useQuery(orpc.deploy.targets.queryOptions())
  const detected = (targets.data ?? []).find((target) => target.exists)

  const set = <K extends keyof ModProjectSettings>(
    key: K,
    value: ModProjectSettings[K]
  ): void => setSettings({ ...settings, [key]: value })

  const save = useMutation(
    orpc.project.update.mutationOptions({
      onSuccess: async (updated) => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.project.list.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.project.active.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.project.status.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.folder.list.key() })
        ])
        reportSuccess('Project saved', `${updated.name} updated.`)
        onClose()
      }
    })
  )

  const pickFolder = (title: string, apply: (path: string) => void): void => {
    void (async () => {
      try {
        const chosen = await getClient().dialog.openFolder({ title, buttonLabel: 'Choose' })
        if (!chosen.canceled && chosen.path) apply(chosen.path)
      } catch (cause) {
        reportError(cause)
      }
    })()
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        save.mutate({
          id: project.id,
          patch: {
            name: name.trim(),
            dumpPath: dumpPath.trim(),
            modPath: modPath.trim(),
            titleId: titleId.trim(),
            modName: modName.trim(),
            gameVersion: gameVersion.trim(),
            settings
          }
        })
      }}
      className="flex w-full flex-col gap-4 rounded-lg border bg-card/60 p-4"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium">{project.name} — settings</h3>
        <button type="button" onClick={onClose} className="rounded p-1 hover:bg-accent" aria-label="Close">
          <X className="size-3.5" />
        </button>
      </div>

      <section className="flex flex-col gap-3">
        <Field label="Name">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="rounded border bg-background px-2 py-1 text-xs"
          />
        </Field>

        <Field label="Pristine dump" hint="Read-only while this project is open.">
          <span className="flex items-center gap-2">
            <input
              value={dumpPath}
              onChange={(event) => setDumpPath(event.target.value)}
              spellCheck={false}
              className="min-w-0 flex-1 rounded border bg-background px-2 py-1 font-mono text-xs"
            />
            <button
              type="button"
              onClick={() => pickFolder('Choose the pristine romfs dump', setDumpPath)}
              className="flex shrink-0 items-center gap-1 rounded border px-2 py-1 text-xs hover:bg-accent"
            >
              <FolderOpen className="size-3" />
            </button>
          </span>
        </Field>

        <Field label="Mod folder" hint="Where every edit is collected.">
          <span className="flex items-center gap-2">
            <input
              value={modPath}
              onChange={(event) => setModPath(event.target.value)}
              spellCheck={false}
              className="min-w-0 flex-1 rounded border bg-background px-2 py-1 font-mono text-xs"
            />
            <button
              type="button"
              onClick={() => pickFolder('Choose the folder your mod is built in', setModPath)}
              className="flex shrink-0 items-center gap-1 rounded border px-2 py-1 text-xs hover:bg-accent"
            >
              <FolderOpen className="size-3" />
            </button>
          </span>
        </Field>

        <div className="grid grid-cols-3 gap-3">
          <Field label="Title ID">
            <input
              value={titleId}
              onChange={(event) => setTitleId(event.target.value)}
              spellCheck={false}
              className="rounded border bg-background px-2 py-1 font-mono text-xs"
            />
          </Field>
          <Field label="Mod folder name">
            <input
              value={modName}
              onChange={(event) => setModName(event.target.value)}
              placeholder="derived"
              spellCheck={false}
              className="rounded border bg-background px-2 py-1 font-mono text-xs"
            />
          </Field>
          <Field label="Game version">
            <input
              value={gameVersion}
              onChange={(event) => setGameVersion(event.target.value)}
              spellCheck={false}
              className="rounded border bg-background px-2 py-1 font-mono text-xs"
            />
          </Field>
        </div>
        <p className="-mt-1 text-[11px] text-muted-foreground/70">
          If this mod also ships a loader or plugin, set the folder name to the one that
          half already uses so both land in one mod rather than two.
        </p>
      </section>

      <section className="flex flex-col gap-3 border-t pt-3">
        <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Deploy
        </h4>

        <Field
          label="Emulator data folder"
          hint={
            detected
              ? `Leave blank to use ${detected.label} at ${detected.dataDir}`
              : 'Leave blank to auto-detect Astris and Ryujinx'
          }
        >
          <span className="flex items-center gap-2">
            <input
              value={settings.emulatorDataDir ?? ''}
              onChange={(event) => set('emulatorDataDir', event.target.value.trim() || null)}
              placeholder="auto-detect"
              spellCheck={false}
              className="min-w-0 flex-1 rounded border bg-background px-2 py-1 font-mono text-xs"
            />
            <button
              type="button"
              onClick={() =>
                pickFolder("Choose the emulator's data folder", (path) =>
                  set('emulatorDataDir', path)
                )
              }
              className="flex shrink-0 items-center gap-1 rounded border px-2 py-1 text-xs hover:bg-accent"
            >
              <FolderOpen className="size-3" />
            </button>
          </span>
        </Field>

        <Toggle
          label="Remove deployed files the mod no longer contains"
          hint="A reverted file left behind is still loaded by the game, which looks exactly like an edit that did not take. Turn off only if something else manages the same folder."
          value={settings.deployPrune}
          onChange={(value) => set('deployPrune', value)}
        />
      </section>

      <section className="flex flex-col gap-3 border-t pt-3">
        <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Files
        </h4>

        <Field
          label="Not part of the mod"
          hint="Comma-separated names, matched anywhere in the tree. These stay in your folder but are never deployed, packaged or checked."
        >
          <input
            value={settings.excludedFiles.join(', ')}
            onChange={(event) =>
              set(
                'excludedFiles',
                event.target.value
                  .split(',')
                  .map((name) => name.trim())
                  .filter((name) => name !== '')
              )
            }
            spellCheck={false}
            className="rounded border bg-background px-2 py-1 font-mono text-xs"
          />
        </Field>

        <Field
          label="ZSTD level"
          hint="Used when this app compresses. A file always goes back with the compression it arrived with, so this only affects how small it ends up. 17 is what these files ship at."
        >
          <input
            type="number"
            min={1}
            max={22}
            value={settings.zstdLevel}
            onChange={(event) => set('zstdLevel', Number(event.target.value))}
            className="w-32 rounded border bg-background px-2 py-1 font-mono text-xs"
          />
        </Field>
      </section>

      <section className="flex flex-col gap-3 border-t pt-3">
        <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Checks
        </h4>

        <Toggle
          label="Warn when a file changed size and no resource size table ships with it"
          hint="These titles record how much memory each resource needs; a file larger than its entry allows fails to load, usually as a crash pointing nowhere near it. Turn off if you patch the table another way."
          value={settings.checkResourceSizeTable}
          onChange={(value) => set('checkResourceSizeTable', value)}
        />
        <Toggle
          label="Warn when a file's name differs from a real one only by .zs or .szs"
          hint="The game asks for an exact path, so such a file is never loaded — it usually means a decompressed copy was saved under the wrong name."
          value={settings.checkCompressionSuffix}
          onChange={(value) => set('checkCompressionSuffix', value)}
        />
      </section>

      <section className="flex flex-col gap-3 border-t pt-3">
        <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Search index
        </h4>
        <Field
          label="Folders to index"
          hint="Comma-separated, relative to the dump. Blank indexes all of it — a project that only touches Layout/ can say so and have it take seconds instead of minutes."
        >
          <input
            value={settings.indexFolders.join(', ')}
            onChange={(event) =>
              set(
                'indexFolders',
                event.target.value
                  .split(',')
                  .map((folder) => folder.trim())
                  .filter((folder) => folder !== '')
              )
            }
            placeholder="all of it"
            spellCheck={false}
            className="rounded border bg-background px-2 py-1 font-mono text-xs"
          />
        </Field>
      </section>

      <div className="flex items-center gap-2 border-t pt-3">
        <button
          type="submit"
          disabled={save.isPending}
          className="flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {save.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
          Save
        </button>
        <button
          type="button"
          onClick={() => setSettings(defaultProjectSettings())}
          className="flex items-center gap-1.5 rounded border px-2 py-1 text-xs hover:bg-accent"
          title="Put every setting back to its default; paths and title are untouched"
        >
          <RotateCcw className="size-3" />
          Reset settings
        </button>
      </div>
    </form>
  )
}
