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

import { useOpenFile } from '@renderer/lib/use-open-file'
import { useSave } from '@renderer/lib/use-save'
import { isTypingFocused } from '@renderer/lib/typing-target'
import { useUnsavedGuard } from '@renderer/lib/use-unsaved-guard'
import { useSessionSnapshot } from '@renderer/lib/use-session'
import { useActiveTab, useDocuments } from '@renderer/editor/store/document'
import { useFolder } from '@renderer/editor/store/folder'
import { useWorkspace } from '@renderer/editor/store/workspace'
import { ArchiveBrowser } from './panels/archive-browser'
import { HierarchyPanel } from './panels/hierarchy'
import { PropertiesPanel } from './panels/properties'
import { BymlViewer } from './panels/byml-viewer'
import { PreviewPanel } from './panels/preview'
import { FolderBrowser } from './panels/folder-browser'
import { AgentPanel } from './panels/agent-panel'
import { ModPanel } from './panels/mod-panel'
import { SearchPanel } from './panels/search-panel'
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
          <MainView />
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
  // `save-all`, `open-file` and `open-folder` are handled in AppShell, which is mounted on
  // every route; handling them here as well produced two dialogs for one Cmd+O.
  const { save, saveAs } = useSave()
  const undo = useDocuments((state) => state.undo)
  const redo = useDocuments((state) => state.redo)

  useEffect(() => {
    const api = window.bflayout
    if (!api?.onMenuCommand) return

    return api.onMenuCommand((command) => {
      switch (command) {
        /*
         * `open-file` and `open-folder` are handled by the shell, not here.
         *
         * The preload registers listeners with `ipcRenderer.on`, which is multi-listener, so
         * with both mounted one Cmd+O produced two `dialog.openFiles` calls and two native
         * dialogs — pick a file, it opens, and a second dialog appears unprompted. Nothing
         * dedupes them: `openViaDialog` sets a busy flag it never checks, and the main-side
         * dialog opens unconditionally. The shell is the right owner because it is mounted on
         * every route, including the welcome screen where Cmd+O matters most.
         */
        case 'save':
          save()
          break
        case 'save-as':
          saveAs()
          break
        /*
         * Undo and redo are the two commands that mean something different depending on
         * where the caret is. A menu accelerator carries no target, so the focused element
         * is the only thing that says whether Cmd+Z belongs to the text field the user is
         * typing in or to the document — and sending it to the document while they type
         * silently reverted the last canvas edit instead of their typing.
         *
         * The browser's own undo handles the field, so declining here is all that is
         * needed; the cut/copy/paste items already use native roles for the same reason.
         */
        /*
         * Undo and redo mean different things depending on where the caret is, and a menu
         * accelerator carries no target — so the focused element decides. With focus in a
         * text field the *field* is undone, through main, because the accelerator swallowed
         * the keystroke before the page could handle it natively; anything else undoes the
         * document. Declining without the fallback made Cmd+Z do nothing at all in a field,
         * which is quieter than the original bug but still wrong.
         */
        case 'undo':
          if (isTypingFocused()) window.bflayout?.editUndo?.()
          else undo()
          break
        case 'redo':
          if (isTypingFocused()) window.bflayout?.editRedo?.()
          else redo()
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
  }, [panels, save, saveAs, undo, redo])
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
/**
 * The canvas, or a BYML document when one is open.
 *
 * They share the space rather than sitting side by side because they answer the
 * same question — "what am I looking at" — and a romfs holds far more
 * configuration data than layouts.
 */
function MainView(): ReactNode {
  const bymlPath = useFolder((state) => state.bymlPath)
  const previewing = useFolder((state) => state.previewing)
  const closePreview = useFolder((state) => state.closePreview)
  const closeByml = useFolder((state) => state.closeByml)
  if (previewing) return <PreviewPanel source={previewing} onClose={closePreview} />
  if (!bymlPath) return <LayoutCanvas />

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
          BYML document
        </span>
        <button
          type="button"
          onClick={closeByml}
          className="ml-auto rounded border px-2 py-0.5 text-[11px] hover:bg-accent"
        >
          Back to the canvas
        </button>
      </div>
      <BymlViewer path={bymlPath} />
    </div>
  )
}

function BrowserPane(): ReactNode {
  // The active tab lives in the store so opening an archive from the file browser
  // can bring the Archive tab forward; see FolderStore.tab.
  const tab = useFolder((state) => state.tab)
  const setTab = useFolder((state) => state.setTab)

  return (
    <>
      {/*
        Scrollable, because the row grew past the sidebar.
        
        Six tabs at the default 288px do not fit, and a plain flex row does not say
        so — it clips the last one against the edge, which is indistinguishable from
        the tab not existing. `mod` was the one that disappeared, which is exactly
        the tab someone goes looking for when they cannot find their mod.
        
        `shrink-0` on each button stops flex from squeezing them into illegibility
        instead; the row scrolls, and the active tab is scrolled into view.
      */}
      <div className="flex shrink-0 items-stretch overflow-x-auto border-b [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {(
          ['files', 'archive', 'search', 'textures', 'materials', 'mod', 'agent'] as const
        ).map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setTab(name)}
            ref={(node) => {
              if (node && tab === name) node.scrollIntoView({ block: 'nearest', inline: 'nearest' })
            }}
            className={`shrink-0 whitespace-nowrap px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide ${
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
        ) : tab === 'search' ? (
          <SearchPanel />
        ) : tab === 'textures' ? (
          <TexturePanel />
        ) : tab === 'mod' ? (
          <ModPanel />
        ) : tab === 'agent' ? (
          <AgentPanel />
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
  const { saveDocument } = useSave()
  // Closing goes through the guard, which asks before discarding unsaved edits and
  // releases the document in main once the tab is really gone.
  const { closeTabSafely } = useUnsavedGuard(saveDocument)

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
            onClick={() => void closeTabSafely(tab.documentId)}
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
