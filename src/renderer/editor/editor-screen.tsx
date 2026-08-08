import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { useEffect, useState, type CSSProperties } from 'react'
import {
  ArrowLeft,
  FolderOpen,
  ListTree,
  Loader2,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Redo2,
  Save,
  SaveAll,
  Undo2,
  X
} from 'lucide-react'

import type { PanelKey } from '@shared/contract'
import { usePanels } from '@renderer/lib/use-panels'
import { IS_MAC, useFullscreen } from '@renderer/lib/use-fullscreen'
import { Splitter } from '@renderer/components/splitter'

/** Controls inside a drag region need this or they cannot be clicked. */
const NO_DRAG = { WebkitAppRegion: 'no-drag' } as CSSProperties

import { getClient } from '@renderer/lib/orpc'
import { useOpenFile } from '@renderer/lib/use-open-file'
import { useSave } from '@renderer/lib/use-save'
import { useSessionSnapshot } from '@renderer/lib/use-session'
import { useActiveTab, useDocuments } from '@renderer/editor/store/document'
import { useFolder } from '@renderer/editor/store/folder'
import { useWorkspace } from '@renderer/editor/store/workspace'
import { ArchiveBrowser } from './panels/archive-browser'
import { HierarchyPanel } from './panels/hierarchy'
import { PropertiesPanel } from './panels/properties'
import { FolderBrowser } from './panels/folder-browser'
import { MaterialsPanel } from './panels/materials'
import { TexturePanel } from './panels/textures'
import { TimelinePanel } from './panels/timeline'
import { LayoutCanvas } from './canvas/layout-canvas'

export function EditorScreen(): ReactNode {
  // Records which files are open so the welcome screen can offer them back.
  useSessionSnapshot()
  const panels = usePanels()
  useMenuCommands()

  const leftVisible = panels.showSidebar || panels.showHierarchy

  /**
   * Sizes are mirrored locally so a drag is smooth: the committed value goes to
   * sqlite on release, and previewing through a settings round trip would make the
   * divider lag the pointer.
   */
  const [sidebar, setSidebar] = useState(panels.sidebarWidth)
  const [properties, setProperties] = useState(panels.propertiesWidth)
  const [timeline, setTimeline] = useState(panels.timelineHeight)

  // Adopt persisted sizes once settings arrive, and after an external change.
  useEffect(() => setSidebar(panels.sidebarWidth), [panels.sidebarWidth])
  useEffect(() => setProperties(panels.propertiesWidth), [panels.propertiesWidth])
  useEffect(() => setTimeline(panels.timelineHeight), [panels.timelineHeight])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorToolbar />
      <DocumentTabs />
      <div className="flex min-h-0 flex-1">
        {leftVisible ? (
          <>
            <aside
              className="flex min-w-0 flex-col bg-card/40"
              style={{ width: sidebar }}
            >
              {panels.showSidebar ? <BrowserPane /> : null}
              {panels.showHierarchy ? (
                <>
                  <PanelHeader title="Hierarchy" />
                  <div className="flex min-h-0 flex-[4] flex-col">
                    <HierarchyPanel />
                  </div>
                </>
              ) : null}
            </aside>
            <Splitter
              orientation="vertical"
              label="left"
              size={sidebar}
              min={180}
              max={720}
              onPreview={setSidebar}
              onCommit={(value) => {
                setSidebar(value)
                panels.setSize('sidebarWidth', value)
              }}
            />
          </>
        ) : null}

        <div className="flex min-w-0 flex-1 flex-col">
          <LayoutCanvas />
          {panels.showTimeline ? (
            <>
              <Splitter
                orientation="horizontal"
                label="top"
                size={timeline}
                min={90}
                max={700}
                onPreview={setTimeline}
                onCommit={(value) => {
                  setTimeline(value)
                  panels.setSize('timelineHeight', value)
                }}
              />
              <div className="flex min-h-0 shrink-0 flex-col" style={{ height: timeline }}>
                <TimelinePanel />
              </div>
            </>
          ) : null}
        </div>

        {panels.showProperties ? (
          <>
            <Splitter
              orientation="vertical"
              label="right"
              size={properties}
              min={220}
              max={720}
              onPreview={setProperties}
              onCommit={(value) => {
                setProperties(value)
                panels.setSize('propertiesWidth', value)
              }}
            />
            <aside
              className="flex min-w-0 flex-col bg-card/40"
              style={{ width: properties }}
            >
              <PanelHeader title="Properties" />
              <PropertiesPanel />
            </aside>
          </>
        ) : null}
      </div>
    </div>
  )
}

/**
 * Routes native menu commands to the things they name.
 *
 * The menu is a second front end onto the same actions, so it dispatches rather
 * than reimplementing: panel toggles go through the same settings the toolbar
 * writes, and canvas commands are re-broadcast as keyboard events the canvas
 * already listens for.
 */
function useMenuCommands(): void {
  const panels = usePanels()
  const { openViaDialog, openFolderViaDialog } = useOpenFile()
  const { save, saveAs } = useSave()
  const undo = useDocuments((state) => state.undo)
  const redo = useDocuments((state) => state.redo)

  useEffect(() => {
    const api = window.bflayout
    if (!api?.onMenuCommand) return

    return api.onMenuCommand((command) => {
      switch (command) {
        case 'open-file':
          openViaDialog()
          break
        case 'open-folder':
          openFolderViaDialog()
          break
        case 'save':
          save()
          break
        case 'save-as':
          saveAs()
          break
        case 'undo':
          undo()
          break
        case 'redo':
          redo()
          break
        case 'toggle-sidebar':
          panels.toggle('showSidebar')
          break
        case 'toggle-hierarchy':
          panels.toggle('showHierarchy')
          break
        case 'toggle-properties':
          panels.toggle('showProperties')
          break
        case 'toggle-timeline':
          panels.toggle('showTimeline')
          break
        case 'show-all-panels':
          for (const key of PANEL_KEYS) panels.set(key, true)
          break
        case 'canvas-only':
          for (const key of PANEL_KEYS) panels.set(key, false)
          break
        default:
          // Canvas commands live in the canvas; it listens for these already.
          window.dispatchEvent(new CustomEvent('bflayout-command', { detail: command }))
          break
      }
    })
  }, [panels, openViaDialog, openFolderViaDialog, save, saveAs, undo, redo])
}

const PANEL_KEYS: readonly PanelKey[] = [
  'showSidebar',
  'showHierarchy',
  'showProperties',
  'showTimeline'
]

/** Toolbar toggles, so the panels are discoverable without opening a menu. */
function PanelToggles(): ReactNode {
  const panels = usePanels()

  const entries: { key: PanelKey; icon: ReactNode; label: string }[] = [
    { key: 'showSidebar', icon: <PanelLeft className="size-3.5" />, label: 'Files, archive and textures' },
    { key: 'showHierarchy', icon: <ListTree className="size-3.5" />, label: 'Hierarchy' },
    { key: 'showProperties', icon: <PanelRight className="size-3.5" />, label: 'Properties' },
    { key: 'showTimeline', icon: <PanelBottom className="size-3.5" />, label: 'Animation timeline' }
  ]

  return (
    <>
      {entries.map((entry) => (
        <button
          key={entry.key}
          type="button"
          style={NO_DRAG}
          onClick={() => panels.toggle(entry.key)}
          title={`${panels[entry.key] ? 'Hide' : 'Show'} ${entry.label.toLowerCase()}`}
          aria-pressed={panels[entry.key]}
          className={`rounded px-1.5 py-1 hover:bg-accent ${
            panels[entry.key] ? 'text-foreground' : 'text-muted-foreground/40'
          }`}
        >
          {entry.icon}
        </button>
      ))}
    </>
  )
}

/**
 * Archive contents and textures share one pane. They compete for the same
 * vertical space and are rarely needed at the same moment, and tabs keep the
 * hierarchy tree — which is needed constantly — from being squeezed.
 */
function BrowserPane(): ReactNode {
  // The active tab lives in the store so opening an archive from the file browser
  // can bring the Archive tab forward; see FolderStore.tab.
  const tab = useFolder((state) => state.tab)
  const setTab = useFolder((state) => state.setTab)

  return (
    <>
      <div className="flex shrink-0 items-stretch border-b">
        {(['files', 'archive', 'textures', 'materials'] as const).map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setTab(name)}
            className={`px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-wide ${
              tab === name
                ? 'border-b-2 border-primary text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {name}
          </button>
        ))}
      </div>
      <div className="flex min-h-0 flex-[3] flex-col border-b">
        {tab === 'files' ? (
          <FolderBrowser />
        ) : tab === 'archive' ? (
          <ArchiveBrowser />
        ) : tab === 'textures' ? (
          <TexturePanel />
        ) : (
          <MaterialsPanel />
        )}
      </div>
    </>
  )
}

function EditorToolbar(): ReactNode {
  const { openViaDialog, busy } = useOpenFile()
  const archiveId = useWorkspace((state) => state.activeArchiveId)
  const tab = useActiveTab()
  const { save, saveAs, saving, canSave } = useSave()
  const fullscreen = useFullscreen()

  return (
    /**
     * The window uses hiddenInset on macOS, which draws the traffic lights over the
     * top-left of the content — directly on top of the first toolbar button. The
     * inset keeps clear of them, and the header doubles as a drag region since there
     * is no title bar left to grab.
     */
    <header
      className={`flex items-center gap-2 border-b py-1.5 pr-2 ${
        IS_MAC && !fullscreen ? 'pl-[84px]' : 'pl-2'
      }`}
      style={{ WebkitAppRegion: 'drag' } as CSSProperties}
    >
      <Link
        to="/"
        className="flex items-center gap-1 rounded px-2 py-1 hover:bg-accent"
        style={NO_DRAG}
      >
        <ArrowLeft className="size-3.5" />
        <span className="text-xs">Home</span>
      </Link>
      <div className="mx-1 h-4 w-px bg-border" />
      <button
        type="button"
        style={NO_DRAG}
        onClick={openViaDialog}
        disabled={busy}
        className="flex items-center gap-1.5 rounded px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <FolderOpen className="size-3.5" />}
        Open
      </button>
      <div className="mx-1 h-4 w-px bg-border" />
      <UndoRedoButtons />
      <div className="mx-1 h-4 w-px bg-border" />
      <button
        type="button"
        style={NO_DRAG}
        onClick={save}
        disabled={!canSave || saving}
        title={canSave ? 'Save the layout and its archive' : 'Open a layout first'}
        className="flex items-center gap-1.5 rounded px-2 py-1 text-xs hover:bg-accent disabled:opacity-40"
      >
        {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
        Save
        {tab?.unsaved ? <span className="size-1.5 rounded-full bg-primary" /> : null}
      </button>
      <button
        type="button"
        style={NO_DRAG}
        onClick={saveAs}
        disabled={!canSave || saving}
        title={
          tab?.source.kind === 'archive'
            ? 'Write the whole archive to a new file'
            : 'Write this layout to a new file'
        }
        className="flex items-center gap-1.5 rounded px-2 py-1 text-xs hover:bg-accent disabled:opacity-40"
      >
        <SaveAll className="size-3.5" />
        Save as…
      </button>
      <div className="mx-1 h-4 w-px bg-border" />
      <PanelToggles />
      <div className="ml-auto text-[11px] text-muted-foreground">
        {archiveId ? null : 'No archive open'}
      </div>
    </header>
  )
}

function UndoRedoButtons(): ReactNode {
  const tab = useActiveTab()
  const undo = useDocuments((state) => state.undo)
  const redo = useDocuments((state) => state.redo)

  const nextUndo = tab?.history.undo[tab.history.undo.length - 1]
  const nextRedo = tab?.history.redo[tab.history.redo.length - 1]

  return (
    <>
      <button
        type="button"
        style={NO_DRAG}
        onClick={undo}
        disabled={!nextUndo}
        title={nextUndo ? `Undo ${nextUndo.label}` : 'Nothing to undo'}
        className="rounded px-1.5 py-1 hover:bg-accent disabled:opacity-30"
      >
        <Undo2 className="size-3.5" />
      </button>
      <button
        type="button"
        style={NO_DRAG}
        onClick={redo}
        disabled={!nextRedo}
        title={nextRedo ? `Redo ${nextRedo.label}` : 'Nothing to redo'}
        className="rounded px-1.5 py-1 hover:bg-accent disabled:opacity-30"
      >
        <Redo2 className="size-3.5" />
      </button>
    </>
  )
}

function DocumentTabs(): ReactNode {
  const tabs = useDocuments((state) => state.tabs)
  const activeId = useDocuments((state) => state.activeId)
  const setActive = useDocuments((state) => state.setActive)
  const closeTab = useDocuments((state) => state.closeTab)

  if (tabs.length === 0) return null

  return (
    <div className="flex items-stretch gap-px overflow-x-auto border-b bg-card/20">
      {tabs.map((tab) => (
        <div
          key={tab.documentId}
          className={`group flex items-center gap-1.5 border-r px-3 py-1.5 ${
            tab.documentId === activeId ? 'bg-card' : 'hover:bg-accent/50'
          }`}
        >
          <button type="button" onClick={() => setActive(tab.documentId)} className="text-xs">
            {tab.displayName}
            {tab.unsaved ? ' •' : ''}
          </button>
          <button
            type="button"
            onClick={() => {
              closeTab(tab.documentId)
              void getClient()
                .layout.close({ documentId: tab.documentId })
                .catch((cause: unknown) =>
                  console.warn('[bflayout] could not release document:', cause)
                )
            }}
            className="rounded p-0.5 opacity-0 hover:bg-accent group-hover:opacity-100"
            aria-label={`Close ${tab.displayName}`}
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  )
}

function PanelHeader({ title }: { title: string }): ReactNode {
  return (
    <header className="shrink-0 border-b px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      {title}
    </header>
  )
}
