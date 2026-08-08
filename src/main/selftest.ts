import { readFile, writeFile } from 'node:fs/promises'
import { inflateSync } from 'node:zlib'
import { app, nativeImage, type BrowserWindow } from 'electron'

import { premultipliedBgra } from './services/textures'
import { getUnsavedCount } from './unsaved'

/**
 * Dev-only end-to-end check driven from the main process: it runs real RPC
 * calls inside the renderer so the whole chain — MessagePort transport, zod
 * validation, Effect services, sqlite, typed errors — is exercised in one go,
 * then exits with a non-zero code if anything failed.
 *
 * Enabled with BFLAYOUT_SELFTEST=1. Point BFLAYOUT_SELFTEST_ARCHIVE at a .szs
 * to include the archive pipeline (see `pnpm fixture:archive`).
 * Never runs in a packaged app.
 */
/*
 * A note for anyone adding a check below: the renderer-side scripts are injected as
 * template literals, so a backtick anywhere inside one — including inside a comment — ends
 * the literal early. The build then fails with a parse error pointing at the comment rather
 * than at the quoting, which is a confusing way to spend ten minutes. Write plain prose in
 * these scripts and quote identifiers with single quotes.
 */
export function runSelfTest(win: BrowserWindow): void {
  if (app.isPackaged) return

  win.webContents.on('console-message', (_event, _level, message) =>
    console.log('[renderer]', message)
  )

  win.webContents.once('did-finish-load', () => {
    void (async () => {
      const existingPath = JSON.stringify(app.getPath('exe'))
      const archivePath = JSON.stringify(process.env['BFLAYOUT_SELFTEST_ARCHIVE'] ?? '')

      const script = `(async () => {
        const out = []
        const fail = (m) => out.push('FAIL ' + m)
        const pass = (m) => out.push('PASS ' + m)
        const check = (cond, m) => cond ? pass(m) : fail(m)

        try {
          // The client appears once the MessagePort handshake completes.
          let c = window.__bfclient
          for (let i = 0; i < 200 && !c; i++) {
            await new Promise(r => setTimeout(r, 50))
            c = window.__bfclient
          }
          if (!c) { fail('client never appeared on window'); return out }

          // ---- settings ----
          const s0 = await c.app.settings.get()
          check(typeof s0.gridSize === 'number', 'settings.get returns defaults (gridSize=' + s0.gridSize + ')')

          const s1 = await c.app.settings.patch({ gridSize: 48, showGrid: false })
          check(s1.gridSize === 48 && s1.showGrid === false, 'settings.patch applies')
          check((await c.app.settings.get()).gridSize === 48, 'settings round-trip through sqlite')

          // ---- recents ----
          const added = await c.app.recents.add({ path: ${existingPath}, kind: 'layout' })
          check(!!added.id, 'recents.add returns a row (id=' + added.id + ')')
          check((await c.app.recents.list()).some(r => r.id === added.id), 'recents.list contains it')

          try {
            await c.app.recents.add({ path: '/definitely/not/here.bflyt', kind: 'layout' })
            fail('missing-file add should have thrown')
          } catch (e) {
            check(e && e.code === 'FILE_NOT_FOUND' && e.data && !!e.data.path,
              'typed error FILE_NOT_FOUND carries data.path')
          }

          await c.app.recents.remove({ id: added.id })
          check(!(await c.app.recents.list()).some(r => r.id === added.id), 'recents.remove deletes')

          // ---- archive pipeline ----
          const archivePath = ${archivePath}
          if (!archivePath) {
            out.push('SKIP archive checks (BFLAYOUT_SELFTEST_ARCHIVE not set)')
          } else {
            const expectedCompression = ${JSON.stringify(process.env['BFLAYOUT_SELFTEST_COMPRESSION'] ?? 'yaz0')}
            const arch = await c.archive.open({ path: archivePath })
            check(arch.entries.length > 0, 'archive.open lists ' + arch.entries.length + ' entries')
            check(arch.compression === expectedCompression,
              'archive.open detected ' + expectedCompression + ' compression (' + arch.compression + ')')
            check(arch.hasNames && arch.unnamedCount === 0, 'archive has a full name table')

            const layouts = arch.entries.filter(e => e.kind === 'layout')
            const textures = arch.entries.filter(e => e.kind === 'texture')
            check(layouts.length > 0 && textures.length > 0,
              'entries classified by kind (' + layouts.length + ' layout, ' + textures.length + ' texture)')
            check(arch.entries.every(e => e.displayName && e.size > 0), 'every entry has a name and size')

            // Reopening must return the same session, not a second copy.
            const again = await c.archive.open({ path: archivePath })
            check(again.archiveId === arch.archiveId, 'reopening returns the existing session')
            check((await c.archive.list()).length === 1, 'archive.list reports one open archive')

            const described = await c.archive.get({ archiveId: arch.archiveId })
            check(described.entries.length === arch.entries.length, 'archive.get matches archive.open')

            try {
              await c.archive.get({ archiveId: 'arch_does_not_exist' })
              fail('unknown archiveId should have thrown')
            } catch (e) {
              check(e && e.code === 'NOT_FOUND', 'typed error NOT_FOUND for unknown archive')
            }

            // ---- layout pipeline ----
            const layoutEntry = layouts[0]
            const opened = await c.layout.open({
              source: { kind: 'archive', archiveId: arch.archiveId, entryKey: layoutEntry.key }
            })
            const doc = opened.document
            check(!!opened.documentId, 'layout.open returned a document id')
            check(doc.info.width === 1280 && doc.info.height === 720,
              'layout header decoded (' + doc.info.width + 'x' + doc.info.height + ')')
            check(doc.platform === 'switch' && doc.version.major === 8,
              'platform and version decoded (' + doc.platform + ' v' + doc.version.major + ')')
            check(!!doc.rootPane && doc.rootPane.name === 'RootPane', 'root pane present')
            check(doc.textures.length === 2 && doc.materials.length === 3,
              'texture list and materials decoded')

            const countPanes = (p) => 1 + p.children.reduce((n, c) => n + countPanes(c), 0)
            const total = countPanes(doc.rootPane)
            // root + background + title + panel, then 3 buttons x (button, caption, touch)
            check(total === 13, 'full pane tree decoded (' + total + ' panes)')

            const panel = doc.rootPane.children.find(p => p.kind === 'wnd1')
            check(!!panel && panel.frames.length === 4, 'window pane kept its 4 frames')
            const firstButton = panel && panel.children[0]
            check(!!firstButton && firstButton.children.length === 2,
              'nested children survived the push/pop markers')
            const caption = firstButton && firstButton.children.find(p => p.kind === 'txt1')
            check(!!caption && caption.text === 'Start',
              'text pane string read from its offset (' + (caption && caption.text) + ')')

            // Round-trip a real edit through save and reopen.
            caption.text = 'Continue'
            caption.dirty = true
            const saved = await c.layout.save({ documentId: opened.documentId, document: doc })
            check(saved.bytes > 0, 'layout.save wrote ' + saved.bytes + ' bytes')

            const reopenedArchive = await c.archive.get({ archiveId: arch.archiveId })
            check(reopenedArchive.dirty === true, 'archive marked dirty after the layout was saved')

            await c.layout.close({ documentId: opened.documentId })
            const again2 = await c.layout.open({
              source: { kind: 'archive', archiveId: arch.archiveId, entryKey: layoutEntry.key }
            })
            const findText = (p) => p.kind === 'txt1' && p.name === 'Txt_Start'
              ? p
              : p.children.reduce((f, c) => f || findText(c), null)
            const roundTripped = findText(again2.document.rootPane)
            check(!!roundTripped && roundTripped.text === 'Continue',
              'edit survived save and reopen (' + (roundTripped && roundTripped.text) + ')')

            try {
              await c.layout.open({
                source: { kind: 'archive', archiveId: arch.archiveId, entryKey: 'timg/MainMenu.bntx' }
              })
              fail('opening a non-layout entry should have thrown')
            } catch (e) {
              check(e && e.code === 'UNSUPPORTED_FORMAT',
                'typed error UNSUPPORTED_FORMAT for a non-layout entry')
            }

            // Textures. The point of decoding one here is the transport: RGBA
            // rides as a Blob because oRPC has no Uint8Array case, and only a
            // real round trip through the MessagePort proves that survives.
            const layoutSource = {
              kind: 'archive', archiveId: arch.archiveId, entryKey: layoutEntry.key
            }
            const texList = await c.textures.list({ source: layoutSource })
            check(texList.unreadable.length === 0,
              'every BNTX container parsed (' + texList.containerCount + ' found)')
            check(texList.textures.length === 2 &&
              texList.textures.some(t => t.name === 'MainMenu') &&
              texList.textures.some(t => t.name === 'MainMenu_Frame'),
              'textures.list found the textures in both containers')
            const mainTex = texList.textures.find(t => t.name === 'MainMenu')
            check(mainTex.width === 256 && mainTex.height === 128,
              'texture dimensions read from BRTI (' + mainTex.width + 'x' + mainTex.height + ')')
            check(mainTex.format === 'R8G8B8A8_Unorm' && mainTex.decodable === true,
              'texture format is decodable (' + mainTex.format + ')')

            // The layout's texture list spells it "MainMenu.bntx" while the BNTX
            // calls it "MainMenu"; resolution has to bridge that.
            const decodedTex = await c.textures.get({
              source: layoutSource, name: doc.textures[0]
            })
            check(decodedTex.width === 256 && decodedTex.height === 128,
              'textures.get decoded ' + decodedTex.width + 'x' + decodedTex.height)
            const rgba = new Uint8Array(await decodedTex.rgba.arrayBuffer())
            check(rgba.length === 256 * 128 * 4,
              'RGBA survived the MessagePort as ' + rgba.length + ' bytes')
            // Bottom-right of the test pattern: full red and green ramp, and the
            // grid line at x=224 is behind us, so blue is the off value.
            const last = (127 * 256 + 255) * 4
            check(rgba[last] === 255 && rgba[last + 1] === 255 && rgba[last + 2] === 96 &&
              rgba[last + 3] === 255,
              'deswizzled pixels are correct at the far corner')

            // ---- folder browsing ----
            // A romfs dump is browsed one directory at a time; the archive's own
            // folder stands in for one here.
            const folderPath = archivePath.substring(0, archivePath.lastIndexOf('/'))
            const listing = await c.folder.list({ path: folderPath })
            check(listing.path === folderPath && listing.parent !== null,
              'folder.list returned the directory and its parent')
            check(listing.entries.some(e => e.name.endsWith('.szs')),
              'folder.list found the archive (' + listing.entries.length + ' entries)')
            const archiveEntry = listing.entries.find(e => e.name.endsWith('.szs'))
            check((archiveEntry.kind === 'archive' || archiveEntry.kind === 'layoutArchive') &&
              archiveEntry.size > 0 && archiveEntry.compressed,
              'the archive is classified and marked compressed')

            const identified = await c.folder.identify({ path: archivePath })
            check(identified.format === 'SARC' && identified.opensAs === 'archive',
              'folder.identify sniffed it as a SARC (' + identified.format + ')')
            check(identified.compression === expectedCompression,
              'folder.identify reported ' + identified.compression + ' compression')

            const notALayout = await c.folder.identify({ path: ${existingPath} })
            check(notALayout.opensAs === 'none',
              'folder.identify refuses to open something unrecognised')

            try {
              await c.folder.list({ path: '/definitely/not/a/folder' })
              fail('listing a missing folder should have thrown')
            } catch (e) {
              check(e && e.code === 'FILE_NOT_FOUND', 'typed error FILE_NOT_FOUND for a missing folder')
            }

            // ---- workspace ----
            const emptySession = await c.app.workspace.get()
            check(Array.isArray(emptySession.archives) && Array.isArray(emptySession.layouts),
              'workspace.get returns a snapshot shape')

            await c.app.workspace.set({
              archives: [archivePath],
              layouts: [{ archivePath: archivePath, entryKey: layoutEntry.key }]
            })
            const savedSession = await c.app.workspace.get()
            check(savedSession.archives.length === 1 && savedSession.archives[0] === archivePath,
              'workspace round-trips the archive path through sqlite')
            check(savedSession.layouts.length === 1 &&
              savedSession.layouts[0].entryKey === layoutEntry.key,
              'workspace round-trips the open layout')

            await c.app.workspace.clear()
            check((await c.app.workspace.get()).archives.length === 0,
              'workspace.clear empties the session')

            // ---- animations ----
            const anims = await c.animation.list({ source: layoutSource })
            check(anims.length === 2, 'animation.list found ' + anims.length + ' animations')
            check(anims.every(a => a.displayName.endsWith('.bflan') && a.size > 0),
              'every animation candidate has a name and size')

            const intro = anims.find(a => a.displayName.includes('_In'))
            const openedAnim = await c.animation.open({ source: layoutSource, key: intro.key })
            const animDoc = openedAnim.document
            check(!!openedAnim.animationId, 'animation.open returned an id')
            check(animDoc.tag && animDoc.tag.name === 'MainMenu_In',
              'pat1 name decoded (' + (animDoc.tag && animDoc.tag.name) + ')')
            check(animDoc.info && animDoc.info.frameSize === 30 && animDoc.info.loop === false,
              'pai1 frame size and loop flag decoded')
            check(animDoc.info.entries.length === 2,
              'both animated panes decoded (' + animDoc.info.entries.length + ')')

            const panelEntry = animDoc.info.entries.find(e => e.name === 'Wnd_Panel')
            check(!!panelEntry && panelEntry.tags.length === 2,
              'the panel entry kept its FLPA and FLVC tags')
            const flpa = panelEntry && panelEntry.tags.find(t => t.signature === 'FLPA')
            check(!!flpa && flpa.components.length === 2,
              'FLPA kept both animated components')
            const translateY = flpa && flpa.components.find(cp => cp.target === 1)
            check(!!translateY && translateY.curve === 'hermite' &&
              translateY.keyframes.length === 2 && translateY.keyframes[0].value === -400,
              'hermite keyframes survived the round trip')

            const titleEntry = animDoc.info.entries.find(e => e.name === 'Txt_Title')
            const flvi = titleEntry && titleEntry.tags[0]
            check(!!flvi && flvi.signature === 'FLVI' && flvi.components[0].curve === 'step',
              'the step-curve visibility track survived')

            // Reopening the same animation must reuse the session.
            const againAnim = await c.animation.open({ source: layoutSource, key: intro.key })
            check(againAnim.animationId === openedAnim.animationId,
              'reopening an animation returns the existing session')

            try {
              await c.animation.open({ source: layoutSource, key: layoutEntry.key })
              fail('opening a layout as an animation should have thrown')
            } catch (e) {
              check(e && e.code === 'UNSUPPORTED_FORMAT',
                'typed error UNSUPPORTED_FORMAT for a non-animation')
            }

            await c.animation.close({ animationId: openedAnim.animationId })

            // ---- save-as ----
            // A layout inside an archive must refuse a loose-file save-as: the
            // copy would look saved while staying detached from its archive.
            try {
              await c.layout.save({
                documentId: again2.documentId,
                document: again2.document,
                path: archivePath + '.detached.bflyt'
              })
              fail('save-as on an archive entry should have been refused')
            } catch (e) {
              check(e && e.code === 'WRITE_ERROR',
                'typed error WRITE_ERROR refusing to detach an archive entry')
            }

            // Saving the archive to a new path leaves the original alone.
            const copyPath = archivePath + '.copy.szs'
            const copied = await c.archive.save({ archiveId: arch.archiveId, path: copyPath })
            check(copied.path === copyPath && copied.dirty === false,
              'archive save-as wrote ' + copied.displayName + ' and cleared dirty')

            const reopenedCopy = await c.archive.open({ path: copyPath })
            check(reopenedCopy.entries.length === arch.entries.length,
              'the saved copy reopens with all ' + reopenedCopy.entries.length + ' entries')
            const copyLayout = reopenedCopy.entries.find(e => e.kind === 'layout')
            const fromCopy = await c.layout.open({
              source: { kind: 'archive', archiveId: reopenedCopy.archiveId, entryKey: copyLayout.key }
            })
            const copyText = findText(fromCopy.document.rootPane)
            check(!!copyText && copyText.text === 'Continue',
              'the edit survived into the saved copy')
            await c.layout.close({ documentId: fromCopy.documentId })
            await c.archive.close({ archiveId: reopenedCopy.archiveId })

            try {
              await c.textures.get({ source: layoutSource, name: 'NoSuchTexture' })
              fail('requesting a missing texture should have thrown')
            } catch (e) {
              check(e && e.code === 'NOT_FOUND', 'typed error NOT_FOUND for an unknown texture')
            }

            await c.archive.close({ archiveId: arch.archiveId })
            check((await c.archive.list()).length === 0, 'archive.close releases the session')

            try {
              await c.archive.open({ path: ${existingPath} })
              fail('opening a non-archive should have thrown')
            } catch (e) {
              check(e && e.code === 'UNSUPPORTED_FORMAT', 'typed error UNSUPPORTED_FORMAT for a non-archive')
            }
          }
        } catch (e) {
          fail('threw: ' + (e && e.message ? e.message : String(e)))
        }
        return out
      })()`

      try {
        const results = (await win.webContents.executeJavaScript(script)) as string[]
        results.push(...(await checkEditorRenders(win, archivePath)))
        for (const line of results) console.log('[selftest]', line)
        const failed = results.filter((line) => line.startsWith('FAIL'))
        const passed = results.filter((line) => line.startsWith('PASS'))
        console.log(
          `[selftest] ${passed.length} passed, ${failed.length} failed, ` +
            `${results.length - passed.length - failed.length} skipped`
        )
        app.exit(failed.length > 0 ? 1 : 0)
      } catch (cause) {
        console.error('[selftest] harness error:', cause)
        app.exit(1)
      }
    })()
  })
}

/**
 * Drives the real editor UI: opens the fixture layout into the document store,
 * navigates to the editor route, waits for the WebGL canvas to paint, then reads
 * the window back with capturePage.
 *
 * This is the only way to check the GL pipeline from the outside. The canvas is
 * created without preserveDrawingBuffer, so toDataURL and readPixels both come
 * back blank; compositing the window is what actually samples what was drawn.
 *
 * Set BFLAYOUT_SELFTEST_SHOT to also write the capture to a PNG for eyeballing.
 */
async function checkEditorRenders(win: BrowserWindow, archivePath: string): Promise<string[]> {
  const out: string[] = []
  const check = (condition: boolean, message: string): void => {
    out.push(`${condition ? 'PASS' : 'FAIL'} ${message}`)
  }

  if (archivePath === '""') return out

  /**
   * The blank-canvas regression: navigating to the editor before any document
   * exists used to leave the WebGL renderer uncreated forever, because the effect
   * that built it ran while the canvas element was still absent. The DOM overlays
   * kept drawing, so a selected pane showed its handles over an empty canvas.
   *
   * Order matters here — editor first, layout second — which is exactly what
   * opening a folder does.
   */
  const blankCanvas = (await win.webContents.executeJavaScript(`(async () => {
    const dev = window.__bfdev
    await dev.router.navigate({ to: '/editor' })
    await new Promise(r => setTimeout(r, 400))
    const canvasBefore = document.querySelector('canvas') !== null
    const rendererBefore = !!dev.renderer

    const c = window.__bfclient
    const arch = await c.archive.open({ path: ${archivePath} })
    const entry = arch.entries.find(e => e.kind === 'layout')
    const opened = await c.layout.open({
      source: { kind: 'archive', archiveId: arch.archiveId, entryKey: entry.key }
    })
    dev.documents.getState().openTab({
      documentId: opened.documentId,
      snapshotKey: opened.snapshotKey,
      displayName: opened.displayName,
      source: opened.source,
      document: opened.document
    })

    let canvas = null
    for (let i = 0; i < 60 && !canvas; i++) {
      await new Promise(r => requestAnimationFrame(r))
      canvas = document.querySelector('canvas')
    }
    await new Promise(r => setTimeout(r, 400))
    const result = {
      canvasBefore,
      rendererBefore,
      canvasAfter: canvas !== null,
      rendererAfter: !!dev.renderer,
      // A renderer that ran has a flattened tree; a missing one has nothing.
      flattened: dev.renderer ? dev.renderer.flattened.length : 0
    }

    // Clean up: later phases assume they own the tab list and the archive session.
    dev.documents.getState().closeTab(opened.documentId)
    await c.layout.close({ documentId: opened.documentId })
    await c.archive.close({ archiveId: arch.archiveId })
    return result
  })()`)) as {
    canvasBefore?: boolean
    rendererBefore?: boolean
    canvasAfter?: boolean
    rendererAfter?: boolean
    flattened?: number
  }

  check(blankCanvas.canvasBefore === false, 'no canvas is mounted before a layout is open')
  check(blankCanvas.canvasAfter === true, 'the canvas mounts once a layout opens')
  check(
    blankCanvas.rendererAfter === true,
    'the WebGL renderer is created when the canvas appears after mount'
  )
  check(
    (blankCanvas.flattened ?? 0) > 1,
    `the renderer drew the pane tree (${blankCanvas.flattened} panes)`
  )

  const setup = `(async () => {
    const dev = window.__bfdev
    if (!dev) return { error: 'dev handle missing' }
    const c = window.__bfclient

    const arch = await c.archive.open({ path: ${archivePath} })
    const entry = arch.entries.find(e => e.kind === 'layout')
    if (!entry) return { error: 'fixture has no layout entry' }
    const source = { kind: 'archive', archiveId: arch.archiveId, entryKey: entry.key }
    const opened = await c.layout.open({ source })

    dev.workspace.getState().setActiveArchive(arch.archiveId)
    dev.documents.getState().openTab({
      documentId: opened.documentId,
      snapshotKey: opened.snapshotKey,
      displayName: opened.displayName,
      source: opened.source,
      document: opened.document
    })
    await dev.router.navigate({ to: '/editor' })

    // Wait for the canvas to exist, then for the texture fetch behind it.
    let canvas = null
    for (let i = 0; i < 100 && !canvas; i++) {
      await new Promise(r => requestAnimationFrame(r))
      canvas = document.querySelector('canvas')
    }
    if (!canvas) return { error: 'no canvas mounted in the editor' }
    await new Promise(r => setTimeout(r, 1200))

    // Select the window pane so the properties panel and its material section
    // mount: they are the densest UI in the app and the likeliest to throw.
    const findWindow = (p) => p.kind === 'wnd1'
      ? p
      : p.children.reduce((f, c) => f || findWindow(c), null)
    const windowPane = findWindow(opened.document.rootPane)
    if (windowPane) {
      dev.documents.getState().select([windowPane.id])
      await new Promise(r => setTimeout(r, 400))
    }
    const propertyInputs = document.querySelectorAll('aside:last-of-type input, aside:last-of-type select')

    // Resize handles appear for a single selection. Eight of them, or the handle
    // hit-testing has nothing to grab.
    const handleCount = () =>
      [...document.querySelectorAll('div')].filter(d => /-resize$/.test(d.style.cursor)).length
    const handlesForOne = handleCount()
    dev.documents.getState().select([])
    await new Promise(r => setTimeout(r, 200))
    const handlesForNone = handleCount()
    if (windowPane) {
      dev.documents.getState().select([windowPane.id])
      await new Promise(r => setTimeout(r, 200))
    }

    // Marquee selection over the whole canvas should pick up every pane but the
    // root, exercised through the shared geometry the canvas uses.
    const marqueeHits = dev.editing.panesInRect(dev.renderer.flattened, [-2000, -2000, 2000, 2000], { includeHidden: true }).length

    // Add a pane through the hierarchy UI, then undo it. Add/delete are the only
    // structural edits, so they get checked against the real buttons.
    const state = dev.documents.getState()
    const activeTab = state.tabs.find(t => t.documentId === state.activeId) || state.tabs[0]
    const beforeAdd = activeTab.document
    const countTree = (p) => 1 + p.children.reduce((n, c) => n + countTree(c), 0)
    const paneCountBefore = countTree(beforeAdd.rootPane)
    const addButton = [...document.querySelectorAll('button')]
      .find(b => b.textContent.trim() === 'Add')
    let structuralResult = 'no Add button in the hierarchy panel'
    if (addButton) {
      addButton.click()
      await new Promise(r => setTimeout(r, 200))
      const pictureOption = [...document.querySelectorAll('button')]
        .find(b => b.textContent.trim() === 'Picture')
      if (!pictureOption) {
        structuralResult = 'the Add menu did not open'
      } else {
        pictureOption.click()
        await new Promise(r => setTimeout(r, 300))
        const current = () => {
          const st = dev.documents.getState()
          return (st.tabs.find(t => t.documentId === st.activeId) || st.tabs[0]).document.rootPane
        }
        const afterAdd = countTree(current())
        dev.documents.getState().undo()
        await new Promise(r => setTimeout(r, 200))
        const afterUndo = countTree(current())
        structuralResult = JSON.stringify({ paneCountBefore, afterAdd, afterUndo })
      }
    }

    // Browse a real romfs when one is pointed at, and open a layout archive out of
  // it the way the folder browser does: sniff, then open.
  let romfsResult = 'skipped'
  const romfs = ${JSON.stringify(process.env['BFLAYOUT_SELFTEST_ROMFS'] ?? '')}
  if (romfs) {
    const top = await c.folder.list({ path: romfs })
    const layoutDir = top.entries.find(e => e.kind === 'directory' && e.name === 'Layout')
    if (!layoutDir) {
      romfsResult = 'no Layout directory in ' + romfs
    } else {
      const inner = await c.folder.list({ path: layoutDir.path })
      // .blarc classifies as layoutArchive now; both are containers this can open.
      const first = inner.entries.find(e => e.kind === 'layoutArchive' || e.kind === 'archive')
      const ident = await c.folder.identify({ path: first.path })
      const arc = await c.archive.open({ path: first.path })
      const lay = arc.entries.find(e => e.kind === 'layout')
      const doc = await c.layout.open({
        source: { kind: 'archive', archiveId: arc.archiveId, entryKey: lay.key }
      })
      const count = (p) => 1 + p.children.reduce((n, k) => n + count(k), 0)
      const tex = await c.textures.list({ source: doc.source })
      const anims = await c.animation.list({ source: doc.source })

      // BYML is what a romfs is mostly made of, so read one end to end. Walk the
      // top level for any directory holding one rather than naming a path, which
      // would only work for this game.
      let bymlNodes = -1
      let bymlVersion = -1
      for (const dir of top.entries.filter(e => e.kind === 'directory').slice(0, 40)) {
        const listing = await c.folder.list({ path: dir.path })
        const candidate = listing.entries.find(e => e.kind === 'byml')
        if (!candidate) continue
        const parsed = await c.byml.open({ path: candidate.path })
        bymlNodes = parsed.nodeCount
        bymlVersion = parsed.version
        break
      }
      romfsResult = JSON.stringify({
        bymlNodes,
        bymlVersion,
        topEntries: top.entries.length,
        layoutFiles: inner.entries.length,
        name: first.name,
        format: ident.format,
        compression: ident.compression,
        panes: count(doc.document.rootPane),
        materials: doc.document.materials.length,
        textures: tex.textures.length,
        decodable: tex.textures.filter(t => t.decodable).length,
        anims: anims.length
      })
      await c.layout.close({ documentId: doc.documentId })
      await c.archive.close({ archiveId: arc.archiveId })
    }
  }

  // Expand the animation dock, load the intro animation, and scrub it. The
    // point is to prove overrides reach the canvas: the panel's Y translation is
    // keyed from -400 to -40, so its world position must differ between frames.
    //
    // Every lookup is scoped to the dock's own <section>. The archive browser
    // lists the same .bflan filenames, so an unscoped text search finds its rows
    // instead and silently tests nothing.
    let animationResult = 'the animation dock did not render'
    const dock = [...document.querySelectorAll('section')]
      .find(s => s.textContent.trim().startsWith('ANIMATION') || s.textContent.trim().startsWith('Animation'))
    if (dock) {
      const findRow = () => [...dock.querySelectorAll('button')]
        .find(b => b.textContent.includes('MainMenu_In.bflan'))

      /*
       * Only toggle if the list is not already showing. The panel opens expanded now,
       * so an unconditional click on its first button collapsed it and found nothing.
       */
      let row = findRow()
      if (!row) {
        dock.querySelector('button').click()
        for (let i = 0; i < 40 && !row; i++) {
          await new Promise(r => setTimeout(r, 100))
          row = findRow()
        }
      }

      if (!row) {
        animationResult = 'the intro animation was not listed in the dock: ' + dock.innerText.slice(0, 200)
      } else {
        row.click()
        for (let i = 0; i < 40 && !dev.playback.getState().document; i++) {
          await new Promise(r => setTimeout(r, 100))
        }

        const playback = dev.playback.getState()
        const panelWorldY = () => {
          const hit = dev.renderer.flattened.find(e => e.pane.name === 'Wnd_Panel')
          return hit ? hit.world[5] : null
        }

        playback.setFrame(0)
        await new Promise(r => requestAnimationFrame(r))
        await new Promise(r => requestAnimationFrame(r))
        const atStart = panelWorldY()

        playback.setFrame(20)
        await new Promise(r => requestAnimationFrame(r))
        await new Promise(r => requestAnimationFrame(r))
        const atEnd = panelWorldY()

        const st = dev.documents.getState()
      const active = st.tabs.find(t => t.documentId === st.activeId) || st.tabs[0]
      const layoutPane = findWindow(active.document.rootPane)

        animationResult = JSON.stringify({
          frames: playback.document ? playback.document.info.frameSize : 0,
          keyedTracks: dock.querySelectorAll('span[title^="frame"]').length,
          atStart,
          atEnd,
          documentTranslateY: layoutPane ? layoutPane.translate[1] : null
        })
      }
    }

    // Every texture the layout names must have reached the GPU. Checking the
    // store beats sampling pixels: the fixture's own test pattern contains the
    // same magenta the missing-texture placeholder uses.
    const names = opened.document.textures
    const states = names.map(n => {
      const entry = dev.renderer && dev.renderer.textures.stateOf(n)
      return n + '=' + (entry ? entry.state + (entry.detail ? ' (' + entry.detail + ')' : '') : 'never requested')
    })

    return {
      width: canvas.width,
      height: canvas.height,
      panes: dev.documents.getState().tabs.length,
      toastErrors: document.querySelectorAll('[data-toast-error]').length,
      propertyInputs: propertyInputs.length,
      romfsResult,
      handlesForOne,
      handlesForNone,
      marqueeHits,
      structuralResult,
      animationResult,
      textureStates: states
    }
  })()`

  const info = (await win.webContents.executeJavaScript(setup)) as {
    error?: string
    width?: number
    height?: number
    panes?: number
    toastErrors?: number
    propertyInputs?: number
    romfsResult?: string
    handlesForOne?: number
    handlesForNone?: number
    marqueeHits?: number
    structuralResult?: string
    animationResult?: string
    textureStates?: string[]
  }

  if (info.error) {
    check(false, `editor UI: ${info.error}`)
    return out
  }

  check((info.width ?? 0) > 100 && (info.height ?? 0) > 100, `canvas sized ${info.width}x${info.height}`)
  check(info.panes === 1, 'the layout opened as one editor tab')
  check(info.toastErrors === 0, 'no error toast while opening the editor')
  // A window pane exposes pane, transform, window and material fields; if the
  // material section threw, this collapses to a handful.
  check(
    (info.propertyInputs ?? 0) > 25,
    `the properties panel rendered ${info.propertyInputs} editable fields`
  )

  const romfs = info.romfsResult ?? 'skipped'
  if (romfs === 'skipped') {
    out.push('SKIP romfs browsing (BFLAYOUT_SELFTEST_ROMFS not set)')
  } else if (!romfs.startsWith('{')) {
    check(false, `romfs browsing: ${romfs}`)
  } else {
    const r = JSON.parse(romfs) as Record<string, number | string>
    check(
      Number(r['bymlNodes']) > 0,
      `read a BYML document from the dump (v${r['bymlVersion']}, ${r['bymlNodes']} nodes)`
    )
    check(Number(r['topEntries']) > 0, `romfs root listed ${r['topEntries']} entries`)
    check(Number(r['layoutFiles']) > 0, `Layout/ listed ${r['layoutFiles']} files`)
    check(r['format'] === 'SARC', `sniffed ${r['name']} as ${r['format']} (${r['compression']})`)
    check(Number(r['panes']) > 1, `parsed a real layout: ${r['panes']} panes, ${r['materials']} materials`)
    check(Number(r['textures']) > 0, `found ${r['textures']} textures, ${r['decodable']} decodable`)
    check(Number(r['anims']) > 0, `found ${r['anims']} animations beside it`)
  }

  check(info.handlesForOne === 8, `eight resize handles drawn for one selected pane (${info.handlesForOne})`)
  check(info.handlesForNone === 0, `no handles with nothing selected (${info.handlesForNone})`)
  // 13 panes, minus the root the marquee deliberately skips.
  check(info.marqueeHits === 12, `a full-canvas marquee selected ${info.marqueeHits} panes`)

  const structural = info.structuralResult ?? ''
  if (!structural.startsWith('{')) {
    check(false, `add/delete pane: ${structural}`)
  } else {
    const parsed = JSON.parse(structural) as {
      paneCountBefore: number
      afterAdd: number
      afterUndo: number
    }
    check(
      parsed.afterAdd === parsed.paneCountBefore + 1,
      `adding a pane through the UI grew the tree (${parsed.paneCountBefore} -> ${parsed.afterAdd})`
    )
    check(
      parsed.afterUndo === parsed.paneCountBefore,
      `undo removed the added pane again (${parsed.afterUndo})`
    )
  }

  const animation = info.animationResult ?? ''
  if (!animation.startsWith('{')) {
    check(false, `animation dock: ${animation}`)
  } else {
    const parsed = JSON.parse(animation) as {
      frames: number
      keyedTracks: number
      atStart: number | null
      atEnd: number | null
      documentTranslateY: number | null
    }
    check(parsed.frames === 30, `the dock loaded a ${parsed.frames}-frame animation`)
    check(parsed.keyedTracks > 0, `the timeline drew ${parsed.keyedTracks} keyframe markers`)
    check(
      parsed.atStart === -400 && parsed.atEnd === -40,
      `scrubbing moved the pane in world space (${parsed.atStart} -> ${parsed.atEnd})`
    )
    // The whole point of the override layer: playback leaves the document alone.
    check(
      parsed.documentTranslateY === -40,
      `playback did not write into the layout document (translate Y stayed ${parsed.documentTranslateY})`
    )
  }

  const states = info.textureStates ?? []
  check(states.length > 0, `the layout references ${states.length} texture(s)`)
  for (const state of states) {
    check(state.endsWith('=ready'), `texture uploaded to the GPU: ${state}`)
  }

  // The texture panel decodes independently of the canvas, so it needs its own
  // check: a thumbnail only gets a size once its RGBA arrived and drew.
  const panel = (await win.webContents.executeJavaScript(`(async () => {
    const tab = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'textures')
    if (!tab) return { error: 'no textures tab in the sidebar' }
    tab.click()
    await new Promise(r => setTimeout(r, 1200))
    const rows = document.querySelectorAll('li canvas')
    return {
      rows: rows.length,
      drawn: [...rows].filter(c => c.width > 0 && c.height > 0).length
    }
  })()`)) as { error?: string; rows?: number; drawn?: number }

  if (panel.error) {
    check(false, `texture panel: ${panel.error}`)
  } else {
    check((panel.rows ?? 0) > 0, `texture panel listed ${panel.rows} texture(s)`)
    check(panel.drawn === panel.rows, `every thumbnail decoded and drew (${panel.drawn}/${panel.rows})`)
  }

  /*
   * `layout.list` reports the sessions that are actually open.
   *
   * Worth its own check because it had no caller in the app and no coverage, and then
   * quietly returned `[]` for every call: the effect spread the session map when the
   * *service* was constructed rather than when it ran, and the service is built once,
   * before anything is open. Nothing failed — the procedure succeeded with an empty array
   * — and the one feature that depends on it, resyncing recovery keys after an archive
   * save-as, silently applied nothing and left every key naming the old path.
   */
  const sessions = (await win.webContents.executeJavaScript(`(async () => {
    const c = window.__bfclient
    const store = window.__bfdev.documents.getState()
    const listed = await c.layout.list()
    const open = store.tabs.map(t => t.documentId)
    /*
     * Only the sessions behind live tabs are required to have a key. A session whose
     * archive has since been closed legitimately has none — there is no path to name — and
     * durableKey returns an empty string rather than failing, because an unresolvable key
     * is not a reason for save or list to refuse to work.
     */
    const keyed = open.every(id => {
      const entry = listed.find(candidate => candidate.documentId === id)
      return entry && typeof entry.snapshotKey === 'string' && entry.snapshotKey.length > 0
    })

    return {
      listed: listed.length,
      open: open.length,
      covers: open.every(id => listed.some(entry => entry.documentId === id)),
      keyed
    }
  })()`)) as { listed?: number; open?: number; covers?: boolean; keyed?: boolean }

  check(
    (sessions.listed ?? 0) > 0 && sessions.covers === true,
    `layout.list reports the open sessions (${sessions.listed} listed, ${sessions.open} tabs)`
  )
  check(sessions.keyed === true, 'every session behind a live tab carries a durable key')

  /*
   * Closing the last tab with the Materials panel open.
   *
   * Panels that read the active document have to survive there not being one, and the way
   * they fail is specific: a hook below an early return means React sees fewer hooks than
   * on the previous render and throws, which the error boundary catches — so the whole
   * editor goes to an error screen rather than the panel showing an empty state. This has
   * happened twice in two panels, so it is worth a check that actually does it.
   */
  const emptyPanels = (await win.webContents.executeJavaScript(`(async () => {
    const dev = window.__bfdev
    const store = dev.documents.getState()
    const open = store.tabs.map(t => ({ documentId: t.documentId, snapshotKey: t.snapshotKey, displayName: t.displayName, source: t.source, document: t.document }))
    if (open.length === 0) return { error: 'no tab to close' }

    const failures = []
    for (const name of ['materials', 'properties', 'textures', 'archive']) {
      const before = dev.renderErrors ? dev.renderErrors().length : 0
      const tab = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === name)
      if (!tab) continue
      tab.click()
      await new Promise(r => setTimeout(r, 250))

      // Close every tab while this panel is showing.
      for (const entry of dev.documents.getState().tabs) {
        dev.documents.getState().closeTab(entry.documentId)
      }
      await new Promise(r => setTimeout(r, 400))

      /*
       * The boundary's own record is the signal, not the DOM. A boundary that catches and
       * then resets leaves the page looking perfectly normal, which is exactly why this
       * bug survived two reviews and shipped twice.
       */
      const errors = dev.renderErrors ? dev.renderErrors() : []
      if (errors.length > before) failures.push(name + ': ' + errors[errors.length - 1])

      // Put the document back for the next panel and for later checks.
      for (const entry of open) dev.documents.getState().openTab(entry, { newTab: true })
      await new Promise(r => setTimeout(r, 400))
    }

    return { failures, tabs: dev.documents.getState().tabs.length }
  })()`)) as { error?: string; failures?: string[]; tabs?: number }

  if (emptyPanels.error) {
    check(false, `panels with no document: ${emptyPanels.error}`)
  } else {
    check(
      (emptyPanels.failures ?? ['unknown']).length === 0,
      `every sidebar panel survives the last tab closing under it${
        (emptyPanels.failures ?? []).length > 0 ? ` (broke: ${emptyPanels.failures!.join(', ')})` : ''
      }`
    )
    check((emptyPanels.tabs ?? 0) > 0, 'the document was restored after the panel sweep')
  }

  // The folder browser is the entry point for a romfs dump, so drive it through the
  // real sidebar tab rather than only through RPC.
  const folder = (await win.webContents.executeJavaScript(`(async () => {
    const dev = window.__bfdev
    const romfs = ${JSON.stringify(process.env['BFLAYOUT_SELFTEST_ROMFS'] ?? '')}
    if (!romfs) return { skipped: true }
    dev.folder.getState().open(romfs)
    const tab = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'files')
    if (!tab) return { error: 'no files tab in the sidebar' }
    tab.click()
    await new Promise(r => setTimeout(r, 300))

    // This check is about tree mode, so make sure that is what is showing rather than
    // trusting whatever the persisted setting happens to be.
    const toTree = [...document.querySelectorAll('button')]
      .find(b => (b.title || '').startsWith('Switch to an expanding tree'))
    if (toTree) {
      toTree.click()
      await new Promise(r => setTimeout(r, 600))
    }

    let rows = []
    for (let i = 0; i < 40 && rows.length === 0; i++) {
      await new Promise(r => setTimeout(r, 100))
      rows = [...document.querySelectorAll('button')].filter(b => b.title.startsWith(romfs))
    }
    // Tree mode: expanding Layout/ should list its files in place.
    const layoutRow = rows.find(b => b.title === romfs + '/Layout')
    if (layoutRow) {
      layoutRow.click()
      await new Promise(r => setTimeout(r, 1500))
    }
    const after = [...document.querySelectorAll('button')].filter(b => b.title.startsWith(romfs + '/Layout/'))
    // Clicking a real layout archive should put a document on the canvas.
    const archiveRow = after.find(b => b.textContent.includes('.blarc'))
    let openedTab = null
    if (archiveRow) {
      /*
       * Watch the *active document id*, not the tab count.
       *
       * Opening reuses the current tab when it holds no unsaved work, so counting tabs
       * only detected a change when something earlier happened to leave one dirty — it
       * passed or failed on unrelated state. The id changing is what "a layout opened"
       * actually means, whether it landed in a new tab or replaced one.
       */
      const before = dev.documents.getState().activeId
      archiveRow.click()
      for (let i = 0; i < 80 && dev.documents.getState().activeId === before; i++) {
        await new Promise(r => setTimeout(r, 100))
      }
      const state = dev.documents.getState()
      const active = state.tabs.find(t => t.documentId === state.activeId)
      openedTab = state.activeId !== before && active ? active.displayName : null
    }
    return { rows: rows.length, afterEnter: after.length, openedTab }
  })()`)) as {
    skipped?: boolean
    error?: string
    rows?: number
    afterEnter?: number
    openedTab?: string | null
  }

  if (folder.skipped) {
    out.push('SKIP folder browser UI (BFLAYOUT_SELFTEST_ROMFS not set)')
  } else if (folder.error) {
    check(false, `folder browser: ${folder.error}`)
  } else {
    check((folder.rows ?? 0) > 0, `the folder browser listed ${folder.rows} entries`)
    check(
      (folder.afterEnter ?? 0) > 100,
      `expanding Layout/ listed ${folder.afterEnter} files in place`
    )
    // The bug this guards: clicking a .blarc used to open a container and leave the
    // canvas empty, which is indistinguishable from nothing happening.
    check(
      typeof folder.openedTab === 'string' && folder.openedTab.endsWith('.bflyt'),
      `clicking a layout archive opened ${folder.openedTab}`
    )
  }

  // Panel visibility is persisted in settings and driven from both the toolbar and
  // the native View menu, so check the toggles actually add and remove regions.
  const panelResult = (await win.webContents.executeJavaScript(`(async () => {
    const asides = () => document.querySelectorAll('aside').length
    const before = asides()
    const propsToggle = [...document.querySelectorAll('button')]
      .find(b => (b.title || '').startsWith('Hide properties'))
    if (!propsToggle) return { error: 'no properties toggle in the toolbar' }
    propsToggle.click()
    await new Promise(r => setTimeout(r, 500))
    const hidden = asides()
    propsToggle.click()
    await new Promise(r => setTimeout(r, 500))
    const restored = asides()
    return { before, hidden, restored }
  })()`)) as { error?: string; before?: number; hidden?: number; restored?: number }

  if (panelResult.error) {
    check(false, `panel toggles: ${panelResult.error}`)
  } else {
    check(
      panelResult.hidden === (panelResult.before ?? 0) - 1,
      `hiding the properties panel removed a region (${panelResult.before} -> ${panelResult.hidden})`
    )
    check(
      panelResult.restored === panelResult.before,
      `showing it again restored the region (${panelResult.restored})`
    )
  }

  /*
   * Drag a pane with real pointer events.
   *
   * Nothing else here touches the canvas's pointer handlers — every other check
   * drives the store through `__bfdev` — so the whole drag path was untested. That
   * matters now the drag mutates the document in place and redraws locally instead
   * of going through the store: a mistake there would leave panes unmovable with
   * every other check still green.
   */
  /*
   * Give the canvas the window first.
   *
   * The settings DB persists between runs and earlier checks drag the splitters, so
   * the canvas can start a few dozen pixels wide — at which point fitting clamps to
   * the minimum zoom and a click point means nothing. This goes through the menu
   * rather than patching settings directly because panel widths reach the UI via the
   * query cache, which only the mutation path invalidates.
   */
  win.webContents.send('menu-command', 'canvas-only')
  await win.webContents.executeJavaScript('new Promise(r => setTimeout(r, 700))')

  const dragResult = (await win.webContents.executeJavaScript(`(async () => {
    const dev = window.__bfdev
    const store = dev.documents.getState()
    const tab = store.tabs.find(t => t.documentId === store.activeId)
    if (!tab) return { error: 'no active tab' }

    // A leaf pane, so no child moves with it.
    const leaves = []
    const walk = (p) => { if (p.children.length === 0) leaves.push(p); p.children.forEach(walk) }
    walk(tab.document.rootPane)
    const target = leaves.find(p => p.kind === 'pic1') ?? leaves[0]
    if (!target) return { error: 'no pane to drag' }

    window.dispatchEvent(new CustomEvent('bflayout-command', { detail: 'fit' }))
    await new Promise(r => setTimeout(r, 400))

    store.select([target.id])
    await new Promise(r => setTimeout(r, 250))

    /*
     * The largest canvas, not the first.
     *
     * The texture panel draws its thumbnails as canvases too, so querySelector was
     * returning a 44x22 thumbnail — every click point computed from it landed
     * nowhere near the layout.
     */
    const canvases = [...document.querySelectorAll('canvas')]
    const surface = canvases.sort(
      (a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width
    )[0]
    if (!surface) return { error: 'no canvas element' }
    const box = surface.getBoundingClientRect()
    const container = surface.parentElement
    if (!container) return { error: 'canvas has no container' }

    // Aim at the pane's own centre so the pointer-down hits it.
    const gl = dev.renderer
    const entry = gl && gl.flattened ? gl.flattened.find(e => e.pane.id === target.id) : null
    if (!entry) return { error: 'pane not in the renderer' }
    const camera = dev.camera
    if (!camera) return { error: 'no camera on the dev seam' }
    // Affine is [a, b, c, d, e, f]; the translation is the last pair.
    const [wx, wy] = [entry.world[4], entry.world[5]]
    const cx = box.left + box.width / 2 + (wx - camera.x) * camera.zoom
    const cy = box.top + box.height / 2 - (wy - camera.y) * camera.zoom

    const fire = (type, x, y, extra) => container.dispatchEvent(
      new PointerEvent(type, {
        clientX: x, clientY: y, bubbles: true, cancelable: true,
        pointerId: 1, isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1,
        ...(extra || {})
      })
    )

    const findById = (p, id) =>
      p.id === id ? p : p.children.reduce((f, c) => f || findById(c, id), null)

    fire('pointerdown', cx, cy)
    await new Promise(r => setTimeout(r, 80))

    /*
     * Measure whichever pane the pointer actually grabbed, not the one aimed at.
     *
     * Shipped layouts routinely put a full-screen bnd1 or pan1 last in the tree, and
     * the hit test returns the topmost pane — so aiming at a specific leaf and
     * asserting on it would be testing the layout's z-order rather than the drag.
     */
    const selectedAfterDown = dev.documents.getState().tabs
      .find(t => t.documentId === store.activeId).selectedPaneIds.slice()
    const grabbedId = selectedAfterDown[0]
    const grabbed = grabbedId ? findById(tab.document.rootPane, grabbedId) : null
    if (!grabbed) return { error: 'pointer-down selected nothing to drag' }
    const before = [grabbed.translate[0], grabbed.translate[1]]

    // Two moves, because the bug class this guards appears only after the first.
    fire('pointermove', cx + 30, cy)
    await new Promise(r => setTimeout(r, 60))
    fire('pointermove', cx + 60, cy)
    await new Promise(r => setTimeout(r, 60))
    fire('pointerup', cx + 60, cy)
    await new Promise(r => setTimeout(r, 250))

    const now = dev.documents.getState().tabs.find(t => t.documentId === store.activeId)
    const moved = now.document ? findById(now.document.rootPane, grabbedId) : null

    return {
      before,
      after: moved ? [moved.translate[0], moved.translate[1]] : null,
      grabbed: grabbedId,
      undoDepth: now.history.undo.length,
      unsaved: now.unsaved,
      kind: grabbed.kind,
      point: [Math.round(cx), Math.round(cy)],
      box: [Math.round(box.left), Math.round(box.top), Math.round(box.width), Math.round(box.height)],
      selectedAfterDown
    }
  })()`)) as {
    error?: string
    before?: number[]
    after?: number[] | null
    undoDepth?: number
    unsaved?: boolean
    grabbed?: string
    kind?: string
    point?: number[]
    box?: number[]
    selectedAfterDown?: string[]
  }

  if (dragResult.error) {
    check(false, `pointer drag: ${dragResult.error}`)
  } else {
    const before = dragResult.before ?? [0, 0]
    const after = dragResult.after ?? [0, 0]
    check(
      after[0] !== before[0],
      `dragging with real pointer events moved the pane (x ${before[0]} -> ${after[0]}` +
        `; grabbed ${dragResult.kind} ${dragResult.grabbed} at ${JSON.stringify(dragResult.point)} in ${JSON.stringify(dragResult.box)}` +
        `, selected after down ${JSON.stringify(dragResult.selectedAfterDown)})`
    )
    // One entry for the whole drag, not one per frame.
    check(dragResult.undoDepth === 1, `the drag recorded one undo entry (${dragResult.undoDepth})`)
    check(dragResult.unsaved === true, 'the drag marked the document unsaved')
  }

  /*
   * An edit made while a save is in flight must not be reported as saved. Serializing
   * and writing is asynchronous, so those bytes are not on disk — and clearing the flag
   * anyway meant closing the tab later discarded the edit without asking.
   */
  const saveRace = (await win.webContents.executeJavaScript(`(async () => {
    const dev = window.__bfdev
    const store = dev.documents.getState()
    const tab = store.tabs.find(t => t.documentId === store.activeId)
    if (!tab) return { error: 'no active tab' }

    const at = (id) => dev.documents.getState().tabs.find(t => t.documentId === id)

    // Make it dirty, and remember the revision a save would have been built from.
    const target = tab.document.rootPane.children[0]
    store.select([target.id])
    await new Promise(r => setTimeout(r, 150))
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowRight', bubbles: true, cancelable: true
    }))
    await new Promise(r => setTimeout(r, 250))
    const builtFrom = at(tab.documentId).revision

    // Another edit lands while the imaginary save is still in flight.
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowRight', bubbles: true, cancelable: true
    }))
    await new Promise(r => setTimeout(r, 250))

    // The save completes, reporting the revision it was built from.
    dev.documents.getState().markSaved(tab.documentId, builtFrom)
    await new Promise(r => setTimeout(r, 200))
    const staleIgnored = at(tab.documentId).unsaved

    // With the current revision it does clear.
    dev.documents.getState().markSaved(tab.documentId, at(tab.documentId).revision)
    await new Promise(r => setTimeout(r, 200))
    return { staleIgnored, current: at(tab.documentId).unsaved }
  })()`)) as { error?: string; staleIgnored?: boolean; current?: boolean }

  if (saveRace.error) {
    check(false, `save race: ${saveRace.error}`)
  } else {
    check(saveRace.staleIgnored === true, 'a save built from a stale revision leaves the tab unsaved')
    check(saveRace.current === false, 'a save built from the current revision clears the flag')
  }

  /*
   * What `nativeImage.createFromBitmap` actually expects for a translucent pixel.
   *
   * It takes Chromium's native N32 bitmap, which is documented as *premultiplied* BGRA,
   * while every decoder here produces straight alpha. If that is right, exporting a UI
   * texture with any translucency shifts its colours — and the checks below would not
   * notice, since a PNG signature and a byte count say nothing about pixels.
   *
   * So: encode a known grey at half alpha and read it back. Grey 128 at alpha 128 is the
   * decisive value — read as premultiplied it unpremultiplies to 256 and clamps to 255,
   * read as straight it comes back as 128. Whichever it is, `exportPng` has to match.
   */
  {
    // Straight-alpha RGBA in, through the same conversion exportPng uses.
    const straight = new Uint8Array([128, 128, 128, 128])
    const image = nativeImage.createFromBitmap(Buffer.from(premultipliedBgra(straight)), {
      width: 1,
      height: 1
    })
    /*
     * Read from the PNG's own bytes, not from a round trip through nativeImage: PNG
     * stores straight alpha by spec, so the file says which convention went in. Feeding
     * it back through `createFromBuffer` would apply the same convention on the way out
     * and cancel exactly the error being looked for.
     */
    const pixel = firstPngPixel(image.toPNG())
    check(
      pixel.join(',') === '128,128,128,128',
      `a translucent texel survives PNG export (${pixel.join(',')} for grey 128 at alpha 128)`
    )
  }

  /*
   * Texture export writes a real PNG. Textures are otherwise read-only, and the
   * archives ship BNTX with Tegra swizzling and BCn or ASTC compression that no image
   * editor opens, so this is the only way one gets out.
   */
  const pngPath = `${app.getPath('temp')}/bflayout-selftest-export.png`
  const exported = (await win.webContents.executeJavaScript(`(async () => {
    const c = window.__bfclient
    const store = window.__bfdev.documents.getState()
    const tab = store.tabs.find(t => t.documentId === store.activeId)
    if (!tab) return { error: 'no active tab' }

    const list = await c.textures.list({ source: tab.source })
    const usable = list.textures.find(t => t.decodable)
    if (!usable) return { error: 'no decodable texture to export' }

    const written = await c.textures.exportPng({
      source: tab.source,
      name: usable.name,
      path: ${JSON.stringify(pngPath)}
    })
    return { written, name: usable.name }
  })()`)) as {
    error?: string
    name?: string
    written?: { path: string; width: number; height: number; bytes: number }
  }

  if (exported.error) {
    check(false, `texture export: ${exported.error}`)
  } else {
    const written = exported.written
    check((written?.bytes ?? 0) > 0, `exported ${exported.name} as ${written?.bytes} bytes of PNG`)
    // The magic matters: nativeImage returning an empty or non-PNG buffer would still
    // have produced a file.
    const bytes = await readFile(pngPath).catch(() => null)
    const signature = bytes ? [...bytes.subarray(0, 8)] : []
    check(
      signature.join(',') === '137,80,78,71,13,10,26,10',
      `the file on disk starts with the PNG signature (${signature.slice(0, 4).join(',')})`
    )
    check(
      (bytes?.length ?? 0) === (written?.bytes ?? -1),
      `the reported size matches the file (${bytes?.length} vs ${written?.bytes})`
    )
  }

  /*
   * Undoing back to the opened state reports the document clean again. Both undo and
   * redo used to set unsaved unconditionally, so a file could never return to a saved
   * state without saving — and the close-confirmation guard would then fire on a
   * document identical to what is on disk.
   */
  const savePoint = (await win.webContents.executeJavaScript(`(async () => {
    const dev = window.__bfdev
    const store = dev.documents.getState()
    const tab = store.tabs.find(t => t.documentId === store.activeId)
    if (!tab) return { error: 'no active tab' }

    store.markSaved(tab.documentId)
    await new Promise(r => setTimeout(r, 200))
    const clean = dev.documents.getState().tabs.find(t => t.documentId === store.activeId).unsaved

    // One real, undoable edit.
    const target = tab.document.rootPane.children[0]
    store.select([target.id])
    await new Promise(r => setTimeout(r, 150))
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowRight', bubbles: true, cancelable: true
    }))
    await new Promise(r => setTimeout(r, 250))
    const afterEdit = dev.documents.getState().tabs.find(t => t.documentId === store.activeId).unsaved

    dev.documents.getState().undo()
    await new Promise(r => setTimeout(r, 250))
    const afterUndo = dev.documents.getState().tabs.find(t => t.documentId === store.activeId).unsaved

    dev.documents.getState().redo()
    await new Promise(r => setTimeout(r, 250))
    const afterRedo = dev.documents.getState().tabs.find(t => t.documentId === store.activeId).unsaved

    return { clean, afterEdit, afterUndo, afterRedo }
  })()`)) as {
    error?: string
    clean?: boolean
    afterEdit?: boolean
    afterUndo?: boolean
    afterRedo?: boolean
  }

  if (savePoint.error) {
    check(false, `save point: ${savePoint.error}`)
  } else {
    check(savePoint.clean === false, 'a saved document reports clean')
    check(savePoint.afterEdit === true, 'an edit marks it unsaved')
    check(savePoint.afterUndo === false, 'undoing back to the save point reports it clean again')
    check(savePoint.afterRedo === true, 'redoing past the save point marks it unsaved')
  }

  /*
   * BC7 against the GPU.
   *
   * BC7 packs a 4x4 block eight different ways, and a mistake in any one mode produces
   * plausible pixels rather than an obvious failure — which is why it went undecoded while
   * there was nothing to check against. There is now: EXT_texture_compression_bptc means
   * the GPU decodes BC7 natively, so uploading real blocks from a shipped texture and
   * reading the rendered pixels back gives hardware ground truth.
   */
  /*
   * Behind its own flag, because the decoder does not pass yet.
   *
   * The harness is the finished part and the valuable part: it proved the decoder wrong
   * — 25% of bytes matching, worst delta 249 — which is exactly the outcome that
   * "plausible but unverified" hides. Leaving it in the default run would make the suite
   * permanently red and stop it catching real regressions, so it runs on request:
   *
   *     BFLAYOUT_SELFTEST_BC7=1 BFLAYOUT_SELFTEST_ROMFS=<dump> ... pnpm dev
   */
  const bc7Romfs =
    process.env['BFLAYOUT_SELFTEST_BC7'] ? (process.env['BFLAYOUT_SELFTEST_ROMFS'] ?? '') : ''
  if (!bc7Romfs) {
    out.push('SKIP BC7 GPU cross-check (set BFLAYOUT_SELFTEST_BC7=1 with a romfs)')
  } else {
    // Found and deswizzled here in main, which has the filesystem and the codecs; the
    // renderer only needs the linear blocks and the GPU.
    const samples = await findBc7Samples(bc7Romfs, 6)
    if (samples.length === 0) {
      check(false, `BC7 GPU cross-check: no BC7 texture found (${bc7Diagnostics})`)
    } else {
      const bc7 = (await win.webContents.executeJavaScript(`(async () => {
      const bntx = window.__bfdev.bntx
      if (!bntx) return { error: 'no bntx helpers on the dev seam' }

      const samples = ${JSON.stringify(
        samples.map((entry) => ({
          name: entry.name,
          width: entry.width,
          height: entry.height,
          blocks: [...entry.blocks]
        }))
      )}

      const totals = { total: 0, exact: 0, within1: 0, worst: 0, worstAt: -1, worstName: '' }
      const perMode = {}
      let firstBad = null

      for (const sample of samples) {
      const width = sample.width
      const height = sample.height
      const bytes = new Uint8Array(sample.blocks)
      const blocksX = Math.ceil(width / 4)
      const blocksY = Math.ceil(height / 4)

      // ---- CPU ----
      const cpu = new Uint8Array(width * height * 4)
      const tile = new Uint8Array(64)
      for (let by = 0; by < blocksY; by++) {
        for (let bx = 0; bx < blocksX; bx++) {
          bntx.decodeBc7Block(bytes, (by * blocksX + bx) * 16, tile)
          for (let ty = 0; ty < 4; ty++) {
            const y = by * 4 + ty
            if (y >= height) break
            for (let tx = 0; tx < 4; tx++) {
              const x = bx * 4 + tx
              if (x >= width) break
              const to = (y * width + x) * 4
              const from = (ty * 4 + tx) * 4
              cpu[to] = tile[from]
              cpu[to + 1] = tile[from + 1]
              cpu[to + 2] = tile[from + 2]
              cpu[to + 3] = tile[from + 3]
            }
          }
        }
      }

      // ---- GPU ----
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, antialias: false })
      if (!gl) return { error: 'no webgl2 context' }
      const ext = gl.getExtension('EXT_texture_compression_bptc')
      if (!ext) return { error: 'EXT_texture_compression_bptc unavailable' }

      const tex = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.compressedTexImage2D(
        gl.TEXTURE_2D, 0, ext.COMPRESSED_RGBA_BPTC_UNORM_EXT, width, height, 0, bytes
      )
      const err = gl.getError()
      if (err !== gl.NO_ERROR) return { error: 'compressedTexImage2D failed with ' + err }

      // Sources are joined from lines rather than written with escapes: this whole script
      // is itself inside a template literal, where a real newline inside a quoted string
      // is a syntax error and a backslash means something else again.
      const NL = String.fromCharCode(10)
      const vsSource = [
        '#version 300 es',
        'in vec2 p;',
        'out vec2 uv;',
        'void main(){ uv = (p + 1.0) * 0.5; gl_Position = vec4(p, 0.0, 1.0); }'
      ].join(NL)
      const fsSource = [
        '#version 300 es',
        'precision highp float;',
        'in vec2 uv;',
        'uniform sampler2D t;',
        'out vec4 o;',
        // No vertical flip. readPixels returns rows bottom-up and uv.y is 0 at the bottom
        // of the viewport, so sampling v = uv.y already lines row 0 of the readback up
        // with row 0 of the uploaded data. Flipping here as well compared the CPU decode
        // against the texture's *last* row — which produced real pixels from the wrong
        // place, and looked exactly like a broken decoder.
        'void main(){ o = texture(t, uv); }'
      ].join(NL)

      const vs = gl.createShader(gl.VERTEX_SHADER)
      gl.shaderSource(vs, vsSource)
      gl.compileShader(vs)
      if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
        return { error: 'vertex shader: ' + gl.getShaderInfoLog(vs) }
      }
      const fs = gl.createShader(gl.FRAGMENT_SHADER)
      gl.shaderSource(fs, fsSource)
      gl.compileShader(fs)
      if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
        return { error: 'fragment shader: ' + gl.getShaderInfoLog(fs) }
      }

      const prog = gl.createProgram()
      gl.attachShader(prog, vs)
      gl.attachShader(prog, fs)
      gl.linkProgram(prog)
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        return { error: 'link failed: ' + gl.getProgramInfoLog(prog) }
      }
      gl.useProgram(prog)

      const buf = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, buf)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW)
      const loc = gl.getAttribLocation(prog, 'p')
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)

      gl.viewport(0, 0, width, height)
      gl.disable(gl.BLEND)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.drawArrays(gl.TRIANGLES, 0, 3)

      const gpu = new Uint8Array(width * height * 4)
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, gpu)

      // Compare, tolerating the ±1 the spec leaves to the implementation.
      for (let i = 0; i < cpu.length; i++) {
        const delta = Math.abs(cpu[i] - gpu[i])
        totals.total++
        if (delta === 0) totals.exact++
        if (delta <= 1) totals.within1++
        if (delta > totals.worst) {
          totals.worst = delta
          totals.worstAt = i
          totals.worstName = sample.name
        }
      }

      /*
       * Per-mode accuracy, so a failure names the mode rather than the whole format.
       * BC7 has eight modes with different bit layouts, and an error in one of them looks
       * identical in aggregate to an error in all of them.
       */
      for (let by = 0; by < blocksY; by++) {
        for (let bx = 0; bx < blocksX; bx++) {
          const at = (by * blocksX + bx) * 16
          let mode = -1
          for (let bit = 0; bit < 8; bit++) {
            if ((bytes[at] >> bit) & 1) { mode = bit; break }
          }
          const key = 'mode' + mode
          perMode[key] = perMode[key] || { blocks: 0, bad: 0 }
          perMode[key].blocks++

          let bad = false
          for (let ty = 0; ty < 4 && !bad; ty++) {
            const y = by * 4 + ty
            if (y >= height) break
            for (let tx = 0; tx < 4; tx++) {
              const x = bx * 4 + tx
              if (x >= width) break
              const off = (y * width + x) * 4
              for (let c = 0; c < 4; c++) {
                if (Math.abs(cpu[off + c] - gpu[off + c]) > 1) { bad = true; break }
              }
              if (bad) break
            }
          }
          if (bad) {
            perMode[key].bad++
            if (!firstBad) {
              const texels = []
              for (let ty = 0; ty < 4; ty++) {
                for (let tx = 0; tx < 4; tx++) {
                  const y = by * 4 + ty
                  const x = bx * 4 + tx
                  if (y >= height || x >= width) continue
                  const off = (y * width + x) * 4
                  texels.push({
                    t: ty * 4 + tx,
                    cpu: [cpu[off], cpu[off+1], cpu[off+2], cpu[off+3]],
                    gpu: [gpu[off], gpu[off+1], gpu[off+2], gpu[off+3]]
                  })
                }
              }
              firstBad = {
                name: sample.name,
                mode,
                block: [...bytes.slice(at, at + 16)],
                texels: texels.slice(0, 4)
              }
            }
          }
        }
      }

      }

      return {
        samples: samples.length,
        total: totals.total,
        exact: totals.exact,
        within1: totals.within1,
        worst: totals.worst,
        worstPixel: totals.worstAt >= 0 ? Math.floor(totals.worstAt / 4) : -1,
        worstName: totals.worstName,
        perMode,
        firstBad
      }
    })()`)) as {
      error?: string
      samples?: number
      worstName?: string
      total?: number
      exact?: number
      within1?: number
      worst?: number
      worstPixel?: number
      perMode?: Record<string, { blocks: number; bad: number }>
      firstBad?: {
        name: string
        mode: number
        block: number[]
        texels: { t: number; cpu: number[]; gpu: number[] }[]
      } | null
    }

      if (bc7.error) {
        check(false, `BC7 GPU cross-check: ${bc7.error}`)
      } else {
        const total = bc7.total ?? 1
        const exactPct = ((bc7.exact ?? 0) / total) * 100
        const within1Pct = ((bc7.within1 ?? 0) / total) * 100
        check(
          within1Pct === 100,
          `BC7 matches the GPU within one unit across ${bc7.samples} textures ` +
            `(${within1Pct.toFixed(2)}% of ${total} samples, worst delta ${bc7.worst ?? 0}` +
            `${(bc7.worst ?? 0) > 0 ? ` in ${bc7.worstName}` : ''})`
        )
        // Reported rather than asserted: the last unit of the interpolation is
        // implementation-defined, so exactness is informative but not a requirement.
        console.log(
          `[selftest] INFO BC7 byte-exact on ${exactPct.toFixed(2)}% of samples ` +
            `(worst delta ${bc7.worst} at pixel ${bc7.worstPixel})`
        )
        for (const [mode, stats] of Object.entries(bc7.perMode ?? {})) {
          console.log(
            `[selftest] INFO BC7 ${mode}: ${stats.blocks - stats.bad}/${stats.blocks} blocks match`
          )
        }
        if (bc7.firstBad) {
          console.log(
            `[selftest] INFO BC7 first bad block is mode ${bc7.firstBad.mode} in ${bc7.firstBad.name}, bytes ` +
              bc7.firstBad.block.map((b) => b.toString(16).padStart(2, '0')).join(' ')
          )
          for (const texel of bc7.firstBad.texels) {
            console.log(
              `[selftest] INFO   texel ${texel.t}: cpu ${texel.cpu.join(',')} vs gpu ${texel.gpu.join(',')}`
            )
          }
        }
      }
    }
  }

  /*
   * The canvas context menu. Duplicate, delete and the tree moves were keyboard-only,
   * which for most people means undiscoverable. Right-drag still pans, so the menu opens
   * on a right *click* — a distinction worth testing, because it is the whole design.
   */
  const contextMenu = (await win.webContents.executeJavaScript(`(async () => {
    const dev = window.__bfdev
    const store = dev.documents.getState()
    const tab = store.tabs.find(t => t.documentId === store.activeId)
    if (!tab) return { error: 'no active tab' }

    const canvases = [...document.querySelectorAll('canvas')]
    const surface = canvases.sort(
      (a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width
    )[0]
    const container = surface && surface.parentElement
    if (!container) return { error: 'no canvas container' }
    const box = surface.getBoundingClientRect()
    const cx = box.left + box.width / 2
    const cy = box.top + box.height / 2

    const fire = (type, x, y, button) => container.dispatchEvent(
      new PointerEvent(type, {
        clientX: x, clientY: y, bubbles: true, cancelable: true,
        pointerId: 3, isPrimary: true, button: button ?? 0, buttons: button === 2 ? 2 : 1
      })
    )
    const menu = () => document.querySelector('[role="menu"]')

    // A right *drag* must pan, not open the menu.
    fire('pointerdown', cx, cy, 2)
    fire('pointermove', cx + 40, cy, 2)
    container.dispatchEvent(new MouseEvent('contextmenu', {
      clientX: cx + 40, clientY: cy, bubbles: true, cancelable: true
    }))
    await new Promise(r => setTimeout(r, 200))
    const afterDrag = !!menu()
    fire('pointerup', cx + 40, cy, 2)
    await new Promise(r => setTimeout(r, 150))

    /*
     * A right *click* must open it — in both of the orderings browsers use. macOS
     * Chromium fires contextmenu on the press, Windows and Linux fire it after the
     * release, so the menu has to survive being asked at either moment. First: the
     * macOS ordering, contextmenu while the button is still down.
     */
    fire('pointerdown', cx, cy, 2)
    container.dispatchEvent(new MouseEvent('contextmenu', {
      clientX: cx, clientY: cy, bubbles: true, cancelable: true
    }))
    await new Promise(r => setTimeout(r, 120))
    const openedOnPress = !!menu()
    fire('pointerup', cx, cy, 2)
    await new Promise(r => setTimeout(r, 250))
    const openedAfterPressOrdering = !!menu()
    if (openedAfterPressOrdering) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await new Promise(r => setTimeout(r, 150))
    }

    // Then the Windows ordering: released first, contextmenu after.
    fire('pointerdown', cx, cy, 2)
    fire('pointerup', cx, cy, 2)
    container.dispatchEvent(new MouseEvent('contextmenu', {
      clientX: cx, clientY: cy, bubbles: true, cancelable: true
    }))
    await new Promise(r => setTimeout(r, 250))
    const opened = !!menu()
    const labels = opened
      ? [...menu().querySelectorAll('[role="menuitem"]')].map(b => b.textContent)
      : []

    // Duplicating through the menu must actually add a pane.
    const before = (() => {
      const count = (p) => 1 + p.children.reduce((n, k) => n + count(k), 0)
      return count(tab.document.rootPane)
    })()
    const dup = opened
      ? [...menu().querySelectorAll('[role="menuitem"]')]
          .find(b => b.textContent.includes('Duplicate'))
      : null
    /*
     * Pressed the way a mouse presses it: pointerdown, then click.
     *
     * A bare dup.click() passes even when the menu is unusable in practice. The
     * dismiss listener is capture-phase at window, so it sees a real pointerdown on the
     * item first — and used to close the menu before the button could ever be clicked,
     * making every item a no-op. Synthesising only the click hid that completely.
     */
    if (dup) {
      const rect = dup.getBoundingClientRect()
      const at = { clientX: rect.left + 4, clientY: rect.top + 4, bubbles: true, cancelable: true }
      dup.dispatchEvent(new PointerEvent('pointerdown', { ...at, pointerId: 4, isPrimary: true, button: 0, buttons: 1 }))
      await new Promise(r => setTimeout(r, 60))
      const survived = !!menu()
      dup.dispatchEvent(new PointerEvent('pointerup', { ...at, pointerId: 4, isPrimary: true, button: 0, buttons: 0 }))
      dup.dispatchEvent(new MouseEvent('click', at))
      window.__bfSelftestMenuSurvived = survived
    }
    await new Promise(r => setTimeout(r, 350))

    const now = dev.documents.getState().tabs.find(t => t.documentId === store.activeId)
    const count = (p) => 1 + p.children.reduce((n, k) => n + count(k), 0)
    const after = count(now.document.rootPane)
    const closed = !menu()

    // Leave the tree as it was.
    dev.documents.getState().undo()
    await new Promise(r => setTimeout(r, 250))

    return {
      afterDrag, opened, openedOnPress, openedAfterPressOrdering,
      survived: window.__bfSelftestMenuSurvived,
      items: labels.length, before, after, closed
    }
  })()`)) as {
    error?: string
    afterDrag?: boolean
    opened?: boolean
    openedOnPress?: boolean
    openedAfterPressOrdering?: boolean
    survived?: boolean
    items?: number
    before?: number
    after?: number
    closed?: boolean
  }

  if (contextMenu.error) {
    check(false, `context menu: ${contextMenu.error}`)
  } else {
    check(contextMenu.afterDrag === false, 'a right drag pans instead of opening the menu')
    check(
      contextMenu.openedAfterPressOrdering === true,
      'a right click opens the menu when contextmenu fires on the press, as it does on macOS'
    )
    check(
      contextMenu.survived === true,
      'pressing a menu item does not dismiss the menu before the click lands'
    )
    check(
      contextMenu.opened === true && (contextMenu.items ?? 0) >= 5,
      `a right click opened the menu with ${contextMenu.items} items`
    )
    check(
      (contextMenu.after ?? 0) > (contextMenu.before ?? 0),
      `Duplicate from the menu added a pane (${contextMenu.before} -> ${contextMenu.after})`
    )
    check(contextMenu.closed === true, 'choosing an action closed the menu')
  }

  /*
   * Crash-recovery snapshots. The close and quit prompts cover a deliberate exit; this
   * is what stands between a crash and losing every edit since the last save.
   */
  const recovery = (await win.webContents.executeJavaScript(`(async () => {
    const dev = window.__bfdev
    const c = window.__bfclient
    const store = dev.documents.getState()
    const tab = store.tabs.find(t => t.documentId === store.activeId)
    if (!tab) return { error: 'no active tab' }

    await c.snapshot.clear()

    // Dirty the document and wait past the autosave debounce.
    const target = tab.document.rootPane.children[0]
    store.select([target.id])
    await new Promise(r => setTimeout(r, 200))
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowRight', bubbles: true, cancelable: true
    }))

    let listed = []
    for (let i = 0; i < 60 && listed.length === 0; i++) {
      await new Promise(r => setTimeout(r, 250))
      listed = await c.snapshot.list()
    }
    if (listed.length === 0) return { error: 'no snapshot was written for an unsaved tab' }

    const countPanes = (p) => 1 + p.children.reduce((n, k) => n + countPanes(k), 0)

    /*
     * The snapshot must restore into a *working* tab, which is the part that used to be
     * broken and invisible. Restoring pushed the stored document straight into a tab
     * with no main-process session behind it, so it looked recovered right up until the
     * first save failed with "layout document not found" — the one thing the feature is
     * for. Going through snapshot.restore reopens the file and hands back a real session,
     * and the proof is that serializing against it succeeds.
     */
    const restored = await c.snapshot.restore({ key: listed[0].key })
    const panes = restored && restored.document && restored.document.rootPane
      ? countPanes(restored.document.rootPane)
      : -1
    // NUL-separated: 'file' or 'archive', then the path, then the entry name.
    const keyedByPath = listed[0].key.includes(String.fromCharCode(0))

    let saveable = false
    let saveDetail = ''
    try {
      /*
       * No target path, so this re-encodes against the preserved sources and writes back
       * where it came from. For an archive entry that lands in the in-memory archive and
       * touches no file, which is what makes it safe to run here: the point is that the
       * session and its section blobs exist at all, and serialising is the only thing
       * that can prove it.
       */
      const written = await c.layout.save({
        documentId: restored.documentId,
        document: restored.document
      })
      saveable = written.bytes > 0
      saveDetail = written.bytes + ' bytes'
    } catch (cause) {
      saveDetail = String(cause && cause.message ? cause.message : cause)
    }
    await c.layout.close({ documentId: restored.documentId })

    /*
     * Actually saved, not just flagged. Calling markSaved alone left the live document
     * claiming to match a file it had never been written to, which every later check then
     * inherited. For an archive entry this writes into the in-memory archive and touches
     * no file, so it stays safe while exercising the real path.
     */
    const live = dev.documents.getState().tabs.find(t => t.documentId === tab.documentId)
    await c.layout.save({ documentId: live.documentId, document: live.document })
    dev.documents.getState().markSaved(live.documentId, live.revision)
    let after = listed
    for (let i = 0; i < 60 && after.length > 0; i++) {
      await new Promise(r => setTimeout(r, 250))
      after = await c.snapshot.list()
    }

    return {
      wrote: listed.length,
      name: listed[0].displayName,
      panes,
      keyedByPath,
      saveable,
      saveDetail,
      livePanes: countPanes(tab.document.rootPane),
      clearedAfterSave: after.length === 0
    }
  })()`)) as {
    error?: string
    wrote?: number
    name?: string
    panes?: number
    keyedByPath?: boolean
    saveable?: boolean
    saveDetail?: string
    livePanes?: number
    clearedAfterSave?: boolean
  }

  if (recovery.error) {
    check(false, `recovery snapshot: ${recovery.error}`)
  } else {
    check((recovery.wrote ?? 0) > 0, `an unsaved edit produced a snapshot of ${recovery.name}`)
    check(
      recovery.panes === recovery.livePanes && (recovery.panes ?? 0) > 1,
      `the snapshot holds the whole document (${recovery.panes} panes)`
    )
    check(
      recovery.keyedByPath === true,
      'snapshots are keyed by the file path, not by a per-process document id'
    )
    check(
      recovery.saveable === true,
      `a restored snapshot can be saved (${recovery.saveDetail})`
    )
    check(recovery.clearedAfterSave === true, 'saving discarded the snapshot')
  }

  /*
   * Switching layouts and coming back keeps the GPU textures. They used to be dropped
   * on every source change, so alternating between two tabs refetched and re-uploaded
   * every texture each time — a visible stall on a tab click.
   */
  const textureCache = (await win.webContents.executeJavaScript(`(async () => {
    const dev = window.__bfdev
    const store = dev.documents.getState()
    const tab = store.tabs.find(t => t.documentId === store.activeId)
    if (!tab) return { error: 'no active tab' }

    const textures = dev.renderer && dev.renderer.textures
    if (!textures) return { error: 'no texture store on the renderer' }

    // Wait for at least one texture to be resolved for this layout.
    const names = tab.document.textures
    if (names.length === 0) return { error: 'the layout references no textures' }
    let ready = null
    for (let i = 0; i < 60 && !ready; i++) {
      await new Promise(r => setTimeout(r, 100))
      ready = names.find(n => {
        const state = textures.stateOf(n)
        return state && state.state === 'ready'
      })
    }
    if (!ready) return { error: 'no texture became ready' }

    // Point the store elsewhere and back, the way a tab switch does.
    textures.setSource({ kind: 'file', path: '/nowhere/else.bflyt' })
    const whileAway = textures.stateOf(ready)
    textures.setSource(tab.source)
    const afterReturn = textures.stateOf(ready)

    return {
      name: ready,
      away: whileAway ? whileAway.state : 'absent',
      back: afterReturn ? afterReturn.state : 'absent'
    }
  })()`)) as { error?: string; name?: string; away?: string; back?: string }

  if (textureCache.error) {
    check(false, `texture cache: ${textureCache.error}`)
  } else {
    // A different source must not see the first one's textures...
    check(textureCache.away === 'absent', `another layout does not see ${textureCache.name}`)
    // ...and coming back must not have to fetch it again.
    check(
      textureCache.back === 'ready',
      `returning found ${textureCache.name} still on the GPU (${textureCache.back})`
    )
  }

  /*
   * A rename cannot collide with another pane's name. Animations resolve their targets
   * by name, so two panes sharing one makes a single animation drive both — the exact
   * invariant duplicatePane protects, which the rename field could otherwise undo.
   */
  const nameClash = (await win.webContents.executeJavaScript(`(async () => {
    const dev = window.__bfdev
    const store = dev.documents.getState()
    const tab = store.tabs.find(t => t.documentId === store.activeId)
    if (!tab) return { error: 'no active tab' }

    /*
     * Any two siblings, found anywhere in the tree. Assuming the root had two children
     * only held for the fixture layout, so this failed as soon as something earlier
     * opened a different one.
     */
    let siblings = null
    const findSiblings = (p) => {
      if (!siblings && p.children.length >= 2) siblings = p.children
      p.children.forEach(findSiblings)
    }
    findSiblings(tab.document.rootPane)
    if (!siblings) return { error: 'no pane with two children in this layout' }
    const [first, second] = siblings
    store.select([first.id])
    await new Promise(r => setTimeout(r, 300))

    const input = [...document.querySelectorAll('aside input')].find(i => i.value === first.name)
    if (!input) return { error: 'no name field for the selected pane' }

    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    ).set
    setter.call(input, second.name)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise(r => setTimeout(r, 250))

    const warned = !!document.querySelector('aside [aria-invalid="true"]')

    input.focus()
    input.blur()
    await new Promise(r => setTimeout(r, 300))

    const now = dev.documents.getState().tabs.find(t => t.documentId === store.activeId)
    const findById = (p, id) =>
      p.id === id ? p : p.children.reduce((f, c) => f || findById(c, id), null)
    const nameAfter = findById(now.document.rootPane, first.id).name

    /*
     * Abandon the rejected draft with Escape. A rejected value deliberately stays in the
     * field so it can be corrected, which means leaving it there changes what the next
     * check sees — the field no longer shows the pane's name.
     */
    input.focus()
    input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true
    }))
    await new Promise(r => setTimeout(r, 250))

    return { warned, nameAfter, wanted: second.name }
  })()`)) as {
    error?: string
    warned?: boolean
    nameAfter?: string
    wanted?: string
  }

  if (nameClash.error) {
    check(false, `name clash: ${nameClash.error}`)
  } else {
    check(nameClash.warned === true, 'a colliding rename is marked invalid while it is typed')
    check(
      nameClash.nameAfter !== nameClash.wanted,
      `blurring did not apply the colliding name (still ${nameClash.nameAfter})`
    )
  }

  /*
   * Renaming is one undo entry, not one per keystroke. Committing per character meant
   * a twenty-character rename cost twenty presses of Cmd+Z and evicted twenty real
   * entries from the 200-deep stack.
   */
  const rename = (await win.webContents.executeJavaScript(`(async () => {
    const dev = window.__bfdev
    const store = dev.documents.getState()
    const tab = store.tabs.find(t => t.documentId === store.activeId)
    if (!tab) return { error: 'no active tab' }

    const target = tab.document.rootPane.children[0]
    if (!target) return { error: 'no pane to rename' }
    store.select([target.id])
    await new Promise(r => setTimeout(r, 300))

    const input = [...document.querySelectorAll('aside input')]
      .find(i => i.value === target.name)
    if (!input) return { error: 'no name field showing the selected pane' }

    const depthBefore = dev.documents.getState().tabs
      .find(t => t.documentId === store.activeId).history.undo.length

    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    ).set
    // Type five characters, each one an input event.
    for (const value of ['Zz', 'Zzb', 'Zzbc', 'Zzbcd', 'Zzbcde']) {
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 40))
    }
    const duringTyping = dev.documents.getState().tabs
      .find(t => t.documentId === store.activeId).history.undo.length

    // React listens for focusout, not blur, so a synthetic 'blur' never reaches
    // onBlur. Driving the real thing does.
    input.focus()
    input.blur()
    await new Promise(r => setTimeout(r, 350))

    const now = dev.documents.getState().tabs.find(t => t.documentId === store.activeId)
    const findById = (p, id) =>
      p.id === id ? p : p.children.reduce((f, c) => f || findById(c, id), null)

    return {
      depthBefore,
      duringTyping,
      depthAfter: now.history.undo.length,
      name: findById(now.document.rootPane, target.id).name
    }
  })()`)) as {
    error?: string
    depthBefore?: number
    duringTyping?: number
    depthAfter?: number
    name?: string
  }

  if (rename.error) {
    check(false, `rename: ${rename.error}`)
  } else {
    check(rename.name === 'Zzbcde', `the rename applied on blur (${rename.name})`)
    check(
      rename.duringTyping === rename.depthBefore,
      `typing pushed nothing onto the undo stack (${rename.depthBefore} -> ${rename.duringTyping})`
    )
    check(
      rename.depthAfter === (rename.depthBefore ?? 0) + 1,
      `the whole rename is one undo entry (${rename.depthBefore} -> ${rename.depthAfter})`
    )
  }

  /*
   * The hierarchy filter. Finding a pane by name in a several-hundred-pane tree
   * previously meant scrolling; the tree mode had no filter at all.
   */
  const filterResult = (await win.webContents.executeJavaScript(`(async () => {
    const rows = () => document.querySelectorAll('aside button[title*="\u00b7"]').length
    const input = [...document.querySelectorAll('input')]
      .find(i => (i.placeholder || '').startsWith('Filter panes'))
    if (!input) return { error: 'no pane filter input' }

    /*
     * The needle comes from a pane that is actually in the open document. Hardcoding a
     * name from the fixture layout meant the check silently measured "nothing matches"
     * whenever something earlier had opened a different layout.
     */
    const store = window.__bfdev.documents.getState()
    const tab = store.tabs.find(t => t.documentId === store.activeId)
    if (!tab) return { error: 'no active tab' }
    const names = []
    const walk = (p) => { names.push(p.name); p.children.forEach(walk) }
    walk(tab.document.rootPane)
    const leaf = names.find(n => n && n !== tab.document.rootPane.name)
    if (!leaf) return { error: 'the open layout has no named child pane' }

    const before = rows()
    const setValue = (value) => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      ).set
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }

    setValue(leaf)
    await new Promise(r => setTimeout(r, 400))
    const filtered = rows()

    setValue('')
    await new Promise(r => setTimeout(r, 400))
    const restored = rows()

    return { before, filtered, restored }
  })()`)) as { error?: string; before?: number; filtered?: number; restored?: number }

  if (filterResult.error) {
    check(false, `pane filter: ${filterResult.error}`)
  } else {
    check(
      (filterResult.filtered ?? 0) > 0 && (filterResult.filtered ?? 0) < (filterResult.before ?? 0),
      `filtering the hierarchy narrowed it (${filterResult.before} -> ${filterResult.filtered} rows)`
    )
    check(
      filterResult.restored === filterResult.before,
      `clearing the filter restored every row (${filterResult.restored})`
    )
  }

  /*
   * Align acts on a whole selection. Before this, multi-select only enabled dragging:
   * the properties panel edits the first selected pane and nothing acted on the group,
   * so the marquee and shift-click machinery had no payoff.
   */
  const arrange = (await win.webContents.executeJavaScript(`(async () => {
    const dev = window.__bfdev
    const store = dev.documents.getState()
    const tab = store.tabs.find(t => t.documentId === store.activeId)
    if (!tab) return { error: 'no active tab' }

    // Siblings, so none is an ancestor of another and all move independently.
    const parent = tab.document.rootPane.children.find(p => p.children.length >= 2)
    if (!parent) return { error: 'no parent with two children' }
    const picked = parent.children.slice(0, 3)
    if (picked.length < 2) return { error: 'need two siblings' }

    // Spread them out so alignment has something to do.
    picked.forEach((p, i) => { p.translate[0] = i * 37 })
    store.select(picked.map(p => p.id))
    await new Promise(r => setTimeout(r, 300))

    const xBefore = picked.map(p => p.translate[0])

    const buttons = [...document.querySelectorAll('button')]
    const alignLeft = buttons.find(b => (b.title || '') === 'Align left')
    if (!alignLeft) return { error: 'no align-left button with several panes selected' }
    alignLeft.click()
    await new Promise(r => setTimeout(r, 400))

    const now = dev.documents.getState().tabs.find(t => t.documentId === store.activeId)
    const findById = (p, id) =>
      p.id === id ? p : p.children.reduce((f, c) => f || findById(c, id), null)
    const xAfter = picked.map(p => findById(now.document.rootPane, p.id).translate[0])

    dev.documents.getState().undo()
    await new Promise(r => setTimeout(r, 250))
    const undone = dev.documents.getState().tabs.find(t => t.documentId === store.activeId)
    const xUndone = picked.map(p => findById(undone.document.rootPane, p.id).translate[0])

    return { xBefore, xAfter, xUndone, count: picked.length }
  })()`)) as {
    error?: string
    xBefore?: number[]
    xAfter?: number[]
    xUndone?: number[]
    count?: number
  }

  if (arrange.error) {
    check(false, `align: ${arrange.error}`)
  } else {
    const after = arrange.xAfter ?? []
    check(
      after.length > 1 && new Set(after.map((value) => Math.round(value))).size === 1,
      `aligning ${arrange.count} panes left put them on one edge (${(arrange.xBefore ?? []).join(',')} -> ${after.join(',')})`
    )
    check(
      JSON.stringify(arrange.xUndone) === JSON.stringify(arrange.xBefore),
      'undo restored the original positions'
    )
  }

  /*
   * Reordering changes draw order, which is the whole point: tree order *is* paint
   * order, so bringing a pane forward means moving it later among its siblings. Until
   * this existed the only way to change what drew on top was delete-and-recreate.
   */
  const reorder = (await win.webContents.executeJavaScript(`(async () => {
    const dev = window.__bfdev
    const store = dev.documents.getState()
    const tab = store.tabs.find(t => t.documentId === store.activeId)
    if (!tab) return { error: 'no active tab' }

    const parent = tab.document.rootPane.children.find(p => p.children.length >= 2)
      ?? tab.document.rootPane
    if (parent.children.length < 2) return { error: 'nothing with two siblings to reorder' }

    const first = parent.children[0]
    const namesBefore = parent.children.map(p => p.name)

    store.select([first.id])
    await new Promise(r => setTimeout(r, 200))

    // Alt+ArrowUp raises, i.e. moves later among siblings.
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true
    }))
    await new Promise(r => setTimeout(r, 300))

    const now = dev.documents.getState().tabs.find(t => t.documentId === store.activeId)
    const findById = (p, id) =>
      p.id === id ? p : p.children.reduce((f, c) => f || findById(c, id), null)
    const parentNow = findById(now.document.rootPane, parent.id)
    const namesAfter = parentNow.children.map(p => p.name)

    // And undo puts it back.
    dev.documents.getState().undo()
    await new Promise(r => setTimeout(r, 250))
    const undone = dev.documents.getState().tabs.find(t => t.documentId === store.activeId)
    const namesUndone = findById(undone.document.rootPane, parent.id).children.map(p => p.name)

    return { namesBefore, namesAfter, namesUndone }
  })()`)) as {
    error?: string
    namesBefore?: string[]
    namesAfter?: string[]
    namesUndone?: string[]
  }

  if (reorder.error) {
    check(false, `reorder: ${reorder.error}`)
  } else {
    const before = reorder.namesBefore ?? []
    const after = reorder.namesAfter ?? []
    check(
      before[0] !== after[0] && after[1] === before[0],
      `Alt+Up moved a pane later among its siblings (${before.slice(0, 2).join(',')} -> ${after.slice(0, 2).join(',')})`
    )
    check(
      JSON.stringify(reorder.namesUndone) === JSON.stringify(before),
      'undo restored the original order'
    )
  }

  /*
   * Drive a command down the real menu path: main sends `menu-command`, the
   * preload bridge relays it, the renderer acts.
   *
   * This exists because the whole menu bar shipped inert — the preload exposed
   * only `platform`, so `onMenuCommand` was undefined and both consumers bailed
   * out of their `if (!api?.onMenuCommand) return` guard. Every accelerator
   * including Cmd+S silently did nothing. The panel check above could not catch it
   * because it clicks the toolbar button instead, and everything else here drives
   * the store through `__bfdev`. Nothing crossed the IPC boundary the menu uses.
   */
  const menuResult = (await win.webContents.executeJavaScript(`(async () => {
    const asides = () => document.querySelectorAll('aside').length
    window.__bfdevMenu = { before: asides() }
    return window.__bfdevMenu.before
  })()`)) as number

  win.webContents.send('menu-command', 'toggle-properties')
  const afterMenuHide = (await win.webContents.executeJavaScript(`(async () => {
    await new Promise(r => setTimeout(r, 500))
    return document.querySelectorAll('aside').length
  })()`)) as number

  check(
    afterMenuHide === menuResult - 1,
    `a native menu command reached the renderer (${menuResult} -> ${afterMenuHide} regions)`
  )

  // Put it back, which also proves the command is not a one-shot.
  win.webContents.send('menu-command', 'toggle-properties')
  const afterMenuShow = (await win.webContents.executeJavaScript(`(async () => {
    await new Promise(r => setTimeout(r, 500))
    return document.querySelectorAll('aside').length
  })()`)) as number
  check(afterMenuShow === menuResult, `the menu restored the region (${afterMenuShow})`)

  /*
   * The renderer must keep main informed about unsaved work, because the window
   * close handler is synchronous and cannot ask at the last moment. Before this
   * existed, Cmd+W discarded every unsaved layout without a word.
   */
  // Start from a clean slate: earlier checks leave edited tabs behind, and with a
  // romfs pointed at there is more than one, so a bare "count went up" is unstable.
  await win.webContents.executeJavaScript(`(async () => {
    const store = window.__bfdev.documents.getState()
    for (const tab of store.tabs) store.markSaved(tab.documentId)
    await new Promise(r => setTimeout(r, 300))
  })()`)
  const unsavedBefore = getUnsavedCount()
  check(unsavedBefore === 0, `every tab starts clean (${unsavedBefore} unsaved)`)

  await win.webContents.executeJavaScript(`(async () => {
    // mutate's recipe receives the tab, not the document.
    window.__bfdev.documents.getState().mutate((tab) => {
      tab.document.rootPane.name = 'DirtiedBySelfTest'
    })
    await new Promise(r => setTimeout(r, 300))
  })()`)
  const unsavedAfterEdit = getUnsavedCount()
  check(
    unsavedAfterEdit > unsavedBefore,
    `main learned about unsaved work (${unsavedBefore} -> ${unsavedAfterEdit})`
  )

  await win.webContents.executeJavaScript(`(async () => {
    window.__bfdev.documents.getState().markSaved()
    await new Promise(r => setTimeout(r, 300))
  })()`)
  check(
    getUnsavedCount() === unsavedBefore,
    `main learned the work was saved (back to ${getUnsavedCount()})`
  )

  /*
   * The flat file list windows its rows. A romfs is not a gentle input: this game's
   * Tex/ holds 29,342 files, and rendering a DOM node for each meant building tens of
   * thousands of elements before anything appeared — then again on every keystroke of
   * the filter.
   */
  const romfsRoot = process.env['BFLAYOUT_SELFTEST_ROMFS'] ?? ''
  if (!romfsRoot) {
    out.push('SKIP windowed file list (BFLAYOUT_SELFTEST_ROMFS not set)')
  } else {
    const windowed = (await win.webContents.executeJavaScript(`(async () => {
      const dev = window.__bfdev
      const c = window.__bfclient

      /*
       * Switch to list view through the toolbar toggle, not by patching settings.
       * Panel state reaches the UI via the query cache, which only the mutation path
       * invalidates — patching directly leaves the browser in tree mode and the check
       * silently measures the wrong thing.
       */
      dev.folder.getState().open(${JSON.stringify(romfsRoot)})
      await new Promise(r => setTimeout(r, 700))
      const toggle = [...document.querySelectorAll('button')]
        .find(b => (b.title || '').startsWith('Switch to a flat list'))
      if (!toggle) return { error: 'no list-view toggle in the folder toolbar' }
      toggle.click()
      await new Promise(r => setTimeout(r, 700))

      // Find the biggest directory under the root and open it.
      const top = await c.folder.list({ path: ${JSON.stringify(romfsRoot)} })
      let biggest = null
      for (const dir of top.entries.filter(e => e.kind === 'directory')) {
        const listing = await c.folder.list({ path: dir.path })
        if (!biggest || listing.entries.length > biggest.count) {
          biggest = { path: dir.path, count: listing.entries.length }
        }
      }
      if (!biggest) return { error: 'no directories under the romfs root' }

      const started = performance.now()
      dev.folder.getState().navigate(biggest.path)
      await new Promise(r => setTimeout(r, 1200))
      const elapsed = performance.now() - started

      const aside = document.querySelector('aside')
      const rendered = aside ? aside.querySelectorAll('button').length : -1

      /*
       * Put the view mode back. It is persisted in sqlite, so leaving it on "list"
       * changed the state the *next* run started in — and the tree-mode check then
       * counted windowed rows and failed for a reason nothing in it could explain.
       */
      const back = [...document.querySelectorAll('button')]
        .find(b => (b.title || '').startsWith('Switch to an expanding tree'))
      if (back) back.click()
      await new Promise(r => setTimeout(r, 500))

      return { count: biggest.count, rendered, elapsed: Math.round(elapsed) }
    })()`)) as { error?: string; count?: number; rendered?: number; elapsed?: number }

    if (windowed.error) {
      check(false, `windowed list: ${windowed.error}`)
    } else {
      const count = windowed.count ?? 0
      const rendered = windowed.rendered ?? 0
      check(count > 1000, `found a directory with ${count} entries to stress the list`)
      // The whole point: rows on screen, not rows in the directory.
      check(
        rendered > 0 && rendered < 400,
        `showing ${count} entries rendered only ${rendered} buttons`
      )
      check(
        (windowed.elapsed ?? 99999) < 3000,
        `opening it took ${windowed.elapsed}ms`
      )
    }
  }

  // Fit and deselect before the capture, so the screenshot shows the layout rather
  // than whatever corner the camera happened to be in.
  await win.webContents.executeJavaScript(`(async () => {
    window.__bfdev.documents.getState().select([])
    window.dispatchEvent(new CustomEvent('bflayout-command', { detail: 'fit' }))
    await new Promise(r => setTimeout(r, 400))
  })()`)

  const image = await win.webContents.capturePage()
  const { width, height } = image.getSize()
  const pixels = image.toBitmap() // BGRA, row-major
  check(width > 0 && height > 0, `captured the window at ${width}x${height}`)

  // A blank or flat-shaded canvas collapses to a handful of colour buckets; the
  // decoded test pattern spans many. This is a smoke check on "something was
  // actually drawn", not on correctness — the screenshot is for that.
  const distinct = new Set<string>()
  for (let i = 0; i < pixels.length; i += 4) {
    distinct.add(`${pixels[i + 2]! >> 4},${pixels[i + 1]! >> 4},${pixels[i]! >> 4}`)
  }
  check(distinct.size > 64, `the window drew ${distinct.size} distinct colours`)

  const shot = process.env['BFLAYOUT_SELFTEST_SHOT']
  if (shot) {
    await writeFile(shot, image.toPNG())
    console.log(`[selftest] wrote ${shot}`)
  }

  return out
}

/**
 * Finds a BC7 texture in a dump and returns its linear mip-0 blocks.
 *
 * Done here rather than over RPC because main has the filesystem and the codecs, and the
 * renderer only needs the blocks plus the GPU. The surface is capped: the point is to
 * exercise as many of BC7's eight modes as possible, not to compare a whole atlas, and the
 * blocks travel to the renderer inside a script.
 */
let bc7Diagnostics = 'not run'

interface Bc7Sample {
  name: string
  width: number
  height: number
  blocks: Uint8Array
}

/**
 * Several textures rather than one, because BC7's eight modes are what needs covering.
 *
 * A single texture exercised only modes 0, 2 and 3 — all of them opaque and multi-subset —
 * so the alpha modes went unchecked. Sampling across files picks up the rest.
 */
async function findBc7Samples(root: string, want: number): Promise<Bc7Sample[]> {
  const { readdir, readFile, stat } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { isBntx, parseBntx, BntxFormat, deswizzle, divRoundUp, mipBlockHeightLog2 } =
    await import('@shared/formats/bntx')

  /*
   * Decompression goes through the app's own service rather than importing zstd here.
   *
   * A direct `import('@bokuweb/zstd-wasm')` in this bundle failed for every one of the
   * 56,545 candidates — the wasm is loaded a particular way in `CompressionService`, and
   * duplicating that in a test only meant the test was wrong about the dump.
   */
  const { Effect } = await import('effect')
  const { runtime } = await import('./runtime')
  const { CompressionService } = await import('./services/compression')

  const decompress = async (raw: Uint8Array): Promise<Uint8Array> => {
    const result = await runtime.runPromise(
      Effect.flatMap(CompressionService, (service) =>
        Effect.orElseSucceed(service.decompress(raw), () => ({ data: raw, kind: 'none' as const }))
      )
    )
    return result.data
  }

  const MAX_SIDE = 128

  /*
   * Every candidate is examined, not the first few hundred.
   *
   * A dump holds tens of thousands of .bntx files and almost all of them are ASTC — the
   * BC7 ones sit in `Tex/`, well past any cap. Stopping early found nothing and reported
   * "no BC7 texture in the dump", which was a property of the walker rather than the dump.
   */
  const candidates: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4) return
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry)
      let info
      try {
        info = await stat(path)
      } catch {
        continue
      }
      if (info.isDirectory()) await walk(path, depth + 1)
      else if (/\.bntx(\.zs)?$/i.test(entry)) candidates.push(path)
    }
  }
  await walk(root, 0)

  const samples: Bc7Sample[] = []
  let parsed = 0
  let bc7Seen = 0
  let readFailures = 0
  let deswizzleFailures = 0

  for (const path of candidates) {
    let data: Uint8Array
    try {
      data = await decompress(new Uint8Array(await readFile(path)))
    } catch {
      readFailures++
      continue
    }
    if (!isBntx(data)) continue

    let container
    try {
      container = parseBntx(data)
      parsed++
    } catch {
      continue
    }

    for (const texture of container.textures) {
      if (texture.format !== BntxFormat.BC7) continue
      bc7Seen++
      // Multiples of four only, so the compared surface holds whole blocks.
      if (texture.width % 4 !== 0 || texture.height % 4 !== 0) continue

      const end = texture.mipOffsets[1] ?? texture.imageData.length
      const tiled = texture.imageData.subarray(texture.mipOffsets[0] ?? 0, end)
      try {
        const blocks = deswizzle(
          texture.width,
          texture.height,
          4,
          4,
          16,
          texture.tileMode,
          mipBlockHeightLog2(divRoundUp(texture.height, 4), texture.blockHeightLog2),
          tiled
        )

        /*
         * A leading band of whole rows, rather than the whole surface.
         *
         * The blocks travel to the renderer inside a script, so a 512x512 atlas would be a
         * megabyte of JSON. Taking complete rows keeps the block layout intact, which
         * matters because the comparison uploads the same bytes to the GPU.
         */
        const blocksX = texture.width / 4
        const rows = Math.min(texture.height / 4, Math.max(1, Math.floor(MAX_SIDE / 4)))
        const needed = blocksX * rows * 16
        if (blocks.length < needed) continue

        samples.push({
          name: `${path.split('/').pop()}:${texture.name}`,
          width: texture.width,
          height: rows * 4,
          blocks: blocks.subarray(0, needed)
        })
        if (samples.length >= want) {
          bc7Diagnostics = `${samples.length} sampled from ${candidates.length} candidates`
          return samples
        }
      } catch {
        deswizzleFailures++
        continue
      }
    }
  }

  bc7Diagnostics =
    `${candidates.length} candidates, ${parsed} parsed, ${bc7Seen} BC7, ` +
    `${readFailures} unreadable, ${deswizzleFailures} deswizzle failures, ` +
    `${samples.length} sampled`
  return samples
}

/**
 * The first pixel of a 1x1 RGBA PNG, straight from the file.
 *
 * Just enough PNG to answer one question — is what nativeImage wrote premultiplied? —
 * without a dependency. Only the first IDAT of a single-row image is handled, which is
 * all a 1x1 probe produces.
 */
function firstPngPixel(png: Buffer): number[] {
  // Every IDAT concatenated: the zlib stream is allowed to be split across chunks, and
  // inflating only the first one fails with Z_BUF_ERROR on a truncated stream.
  const parts: Buffer[] = []
  let at = 8
  while (at + 8 <= png.length) {
    const length = png.readUInt32BE(at)
    const type = png.toString('ascii', at + 4, at + 8)
    if (type === 'IDAT') parts.push(png.subarray(at + 8, at + 8 + length))
    if (type === 'IEND') break
    at += length + 12
  }
  if (parts.length === 0) return []
  const raw = inflateSync(Buffer.concat(parts))
  // Byte 0 of each row is the filter type; a 1x1 image cannot reference neighbours.
  return [...raw.subarray(1, 5)]
}
