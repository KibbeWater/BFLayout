# BFLayout

A cross-platform layout editor **and modding workbench** for Nintendo Switch BFLYT files and the archives they ship in — an alternative to the Windows-only Switch Toolbox.

## Status

Working today: open a `.szs`/`.sarc` archive, browse its contents, open a BFLYT layout, inspect and edit the pane tree on a texture-mapped WebGL2 canvas, and save back into the archive with byte-level fidelity for everything you did not touch.

It is also a tool for building a *mod* rather than editing files: point it at a
pristine dump and a mod folder, and the dump becomes read-only while every save
lands in the mod instead. See [Modding](#modding).

| Area | State |
| --- | --- |
| SARC archives (+ Yaz0 and ZSTD) | Read and write |
| BFLYT parse / edit / save | Working, with per-section byte preservation |
| Pane hierarchy, properties, canvas | Working |
| Materials (colours, blend, alpha compare, texture maps) | Editable |
| Window panes (nine-slice / pinwheel frames) | Working |
| Text panes | Drawn in the game's own typeface; glyph layout is still approximate |
| Other formats | Previewable read-only: fonts with glyph rendering, BNTX textures, BYML/`bgyml` trees, MSBT text, BFRES model structure, AAMP parameters, BWAV audio metadata, AINB logic |
| Undo / redo | Working — every edit, including property, material and visibility |
| Add / delete / duplicate pane, grid snapping | Working |
| Pane groups: list, add, edit, delete | Working — what animations bind through |
| Reorder and reparent panes (z-order) | Working — buttons and Alt+arrows |
| Align and distribute a multi-pane selection | Working |
| Filter the pane hierarchy by name or kind | Working |
| Zoom readout (click for 1:1) | Working |
| Canvas context menu (right click) | Working — right drag still pans |
| Keyboard editing (nudge, delete, duplicate, undo) | Working — see Keyboard |
| BYML documents | Read-only tree viewer (v1–7, both byte orders) |
| Session restore | Offers the previous session on launch |
| Crash recovery | Snapshots unsaved documents; offers them back on launch |
| BNTX textures | Decode and preview (BC1–BC5, BC7, all ASTC LDR block sizes, uncompressed; no BC6H) |
| BNTX containers: write and merge | Working — all 470 shipped containers rewrite byte for byte |
| BFLAN animation | Parse, play, scrub, inspect keyframes (no keyframe editing) |
| Canvas resize handles, rubber-band select, alignment guides | Working |
| Folder / romfs browsing | Working (tree or list, lazy per directory, windowed rows) |
| Materials list | Working (usage counts, shared-material warnings) |
| Show / hide panels, native menu bar | Working |
| prt1 external part resolution | Working (parts draw their referenced layout) |
| Texture export to PNG | Working |
| Texture import from PNG | Working **in place** — same size, uncompressed formats only (no BCn/ASTC encoder) |
| Archive entries: add, delete, rename, duplicate | Working |
| Name recovery for hash-only archives | Working, fed by the dump index |
| MSBT message tables | **Read and write**, with inline commands preserved; batch find/replace |
| Mod projects: read-only dump, copy-on-write saves | Working |
| Overlay browsing, per-file revert | Working |
| Pre-deploy check, structural diff vs the dump | Working |
| Deploy to Astris / Ryujinx mods folder | Working (install only — it never launches the game) |
| Mod package export / import, with a game-version gate | Working |
| Dump index: search names inside every file | Working (sqlite FTS5) |
| Reverse references — who uses this texture, part, pane | Working |
| Layouts as reviewable YAML, round-tripped | Working |
| Headless CLI | Working (`pnpm cli`) |
| MCP server for Claude Code | Working (`pnpm mcp`) — see [docs/mcp.md](docs/mcp.md) |
| Game link: jump to the screen the game is showing | Working, needs a Colony plugin — see [docs/game-link.md](docs/game-link.md) |
| BFFNT font rendering | Not needed for this title — it ships scalable fonts, which do decode (see Text panes) |

**Validated against real game files.** Every layout archive in a Tomodachi Life
romfs dump (Switch, v1.0.4) is parsed and rewritten byte for byte:

| | files | byte-exact |
| --- | --- | --- |
| SARC archives | 567 | 100% |
| BFLYT layouts | 544 | **100%** |
| BFLAN animations | 2187 | **100%** |
| BNTX containers | 74,571 textures decoded | 100% |
| BNTX rewrite | 470 containers, 3106 textures | **100%** |

Every file, byte for byte. See [Validating against real
files](#validating-against-real-files) for how to run it, and for the two format
details that measurement caught and reading would not have.

### A Mac app, not a web page in a window

Three things the app already knew and did not say, plus one setting that did nothing at all.

**The theme setting was stored and ignored.** `dark` was hardcoded on the `<html>` element, nothing
ever read the persisted value, and the welcome screen printed the chosen theme back as though it had
applied — so `light` and `system` did nothing. It is real now, in two halves, and the second is the
one that matters: the `.dark` class reaches the page, and `nativeTheme.themeSource` in main reaches
the *native* chrome — menus, traffic lights, scrollbars, native dialogs, the window frame. CSS alone
leaves a light app with dark system dialogs, which is exactly the seam that reads as unpolished.
`system` follows the OS live through `prefers-color-scheme`, which Chromium wires to the platform
appearance, so no reload and no polling.

**The window behaves like a document window**, which on macOS is a set of behaviours rather than a
look: the title names the open file, the title bar carries its proxy icon — draggable to another app,
right-clickable for the enclosing folder — and the close button shows the **dot** while there are
unsaved changes. Every Mac editor does the last one, and its absence registers as not-quite-native
without being obvious. All three facts were already tracked. The represented filename uses the
*archive* path for a layout inside one, because a proxy icon has to be something the Finder can
resolve.

**Shortcuts go through TanStack Hotkeys**, which replaced a hand-rolled `event.metaKey ||
event.ctrlKey` that was correct only by accident: it fired on **Ctrl+Z on macOS too**, where that is
not the shortcut. `Mod` resolves to Command on macOS and Control elsewhere, and the library's
`ignoreInputs` is the same focus guard that was hand-rolled next to it.

The arrow-key nudges deliberately stay in a raw keydown handler: they are continuous,
modifier-sensitive movement where Shift and Alt change what the key *means*, which is a handler's job
rather than a table of bindings.

### Keyboard

The full list is in the app: **Help → Show All Shortcuts…**, or ⌘/ from anywhere.
The Help menu also opens this file, the modding guide, the MCP and game-link docs,
and reveals the application data folder — which is where the database, the dump
index and the crash-recovery snapshots live, and which macOS otherwise hides.

| Keys | What |
| --- | --- |
| Cmd/Ctrl + A | Select every pane |
| Arrows | Nudge the selection by 1 |
| Shift + arrows | Nudge by 10 |
| Delete / Backspace | Delete the selection |
| ⌘D | Duplicate the selection beside itself |
| Alt + ↑ / ↓ | Bring forward / send backward among siblings |
| Alt + ← / → | Move out of the parent / into the pane above |
| Escape | Clear the selection |
| ⌘Z / ⌘⇧Z | Undo / redo |
| ⌘S / ⌘⇧S | Save / save as |
| ⌘O / ⌘⇧O | Open a file / open a folder |
| ⌘1–⌘4 | Toggle the sidebar, hierarchy, properties, timeline |
| ⌘0 | Canvas only |
| ⌘/ | Show every shortcut, on any screen |
| ⌘F | Fit the layout to the view |
| Alt while dragging | Suspend grid snapping and alignment guides |
| Two-finger scroll | Pan; pinch or ⌘-scroll zooms at the cursor |
| Click the same spot again | Select the pane *behind* the one you just got |
| Right click | Context menu; right *drag* still pans |

Nudge, delete and duplicate act on the whole selection as **one** undo entry, so a
twenty-pane drag is one press of ⌘Z rather than twenty.

Reordering matters more than it sounds: **draw order is tree order**, so moving a pane
later among its siblings is the only way to put it on top. Before this the only route
was delete-and-recreate, which lost every property the pane had.

Select-behind exists because painter's order makes the topmost pane the only hit, and
shipped layouts routinely end with a full-screen `bnd1` or `pan1` — which then
swallows every click. Clicking the same spot repeatedly walks down the stack and
wraps at the bottom.

## Modding

The editor opens a file, changes it, and writes it back. That is the wrong shape
for a mod, and the difference is not cosmetic: a mod is a *layer* over a pristine
dump, the emulator composes the two at load time, and the dump is the one copy of
the game's files anyone has. Editing it in place is how a modding session ends with
nothing to compare against and nothing to ship.

### A project makes the dump read-only

A project names two folders: the pristine romfs, and the folder the mod is being
built in. While one is active:

- the dump is **mounted read-only**, enforced at the single write funnel every save
  passes through rather than by convention at each call site;
- a save of a file that came out of the dump is **redirected** into the mod folder
  at the same relative path, and the open tab retargets itself at the copy — so the
  next save goes where the first one went, and a crash recovers into the mod rather
  than proposing to write the game;
- the file browser shows the **merged** tree, badged `mod` or `new`, and a
  `modified` row opens the mod's copy because that is what the game would load.

The redirect is invisible while it works, which is why the first save says so
plainly rather than reporting a normal save to a path nobody chose.

Reverting is deleting. A mod that ships a byte-identical file still shadows the
original, and goes on shadowing it after a game update changes the real one — so
the Mod panel calls that out as something to revert rather than leaving it looking
harmless.

### Opening one

**Open** on the project card browses the *dump*, with the mod layered over it —
badged `mod` and `new` where your files shadow or add to the game's. That is the
right place to work from: a mod is edited in the context of what it modifies, and
the alternative, browsing the mod folder alone, shows you only the files you have
already changed.

Creating a project, or picking one from the list, opens it for the same reason.
The mod on its own — every file it contains, and nothing else — is the **Mod**
tab in the sidebar, and its rows open the file they name.

### Check, diff, deploy, package

The **Mod** tab in the sidebar is the whole-mod view, because every other view in
the app is per-file and a mod is a set:

- **Check** reads every file the mod contains, decompresses it, identifies it by
  magic and parses it — *and opens its archives*, which is where the interesting
  problems live, since a layout mod is almost always a layout inside a `.szs`. It
  reports rather than refuses: a mod is entitled to ship a format this build cannot
  read, and the person who made it is better placed to judge than the checker is.
- **Diff** compares each file with the dump's copy and describes what changed —
  "3 panes moved, 1 material changed" — which is a review, a changelog, and the
  answer to what you did yesterday. A byte diff of a `.szs` is worthless because
  recompression moves everything.
- **Deploy** copies the layer into `mods/contents/<title id>/<mod>/romfs`, finding
  Astris and Ryujinx the same way Colony's `deploy.sh` does. It prunes files the
  mod no longer contains, and says which: a reverted file left behind in the
  deployed copy is still loaded by the game, which looks exactly like an edit that
  did not take.
- **Package** writes the standard `contents/<title id>/…` zip, so the result is the
  mod rather than a BFLayout format. The manifest records the game version, and
  importing someone else's package checks it **before** any bytes reach disk — a
  layout mod for the wrong build does not fail cleanly, it loads and the game
  misbehaves in ways nobody attributes to the mod.

Deploy stops at installing. Starting the game is a separate decision, and a tool
that launches an emulator because you pressed save is one people learn to be wary
of.

### A mod is usually more than assets

Two things follow from that, and both are easy to get wrong quietly.

**The mod's directory name has to be agreed, not derived.** A mod with a code half
installs into the same place as its asset half — Colony ships a `subsdk9` into
`contents/<title>/colony/exefs` and its romfs into `contents/<title>/colony/romfs`.
A deploy that named the directory after the *project* would install a second,
parallel mod that the loader's own deploy does not manage, and the two would drift
apart with nothing to say so. So the project carries a **mod folder name**, and the
form says what it is for.

The romfs folder is also treated the way Colony's deploy treats it: it is the
source of truth, mirrored with deletions, and `README.md` is not part of the mod —
a romfs overlay is a mirror of the game's tree, so anything in it is a file the
game gets handed.

**The resource size table is the hazard nothing else catches.** These titles ship a
table of how much memory each romfs resource needs, and the loader trusts it: make
a file bigger than its entry allows and the game does not fail politely, it fails
to load the resource or crashes, pointing nowhere near the file that grew. It is
the most common way a mod that is *more* than swapping same-sized assets goes
wrong.

BFLayout does not model that table and does not pretend to. What **Check** does is
notice the dangerous combination — a file whose expanded size differs from the
dump's, with no resource size table shipped alongside it — and say so. Sizes are
compared *decompressed*, because that is what the table records and because
comparing compressed bytes would fire on almost every re-save.

### Project settings

A project carries its own settings, each with a default that is right for the
common case — where it deploys and whether a deploy prunes, what counts as part of
the mod, the ZSTD level, which checks apply, and which folders the index reads.
Every one of them exists because a real project needed it to be different, and
they are reachable on **⌘,** along with the editor's own settings, which were
persisted and previously adjustable only by editing the database.

The index scope is the one worth setting deliberately. Indexing defaults to the
whole dump, which is correct and, for a romfs of 66,000 files across several
gigabytes, slow — every file is decompressed and parsed. A project that only ever
touches `Layout/` can name it and have the index take seconds.

### Finding things

Browsing a romfs answers "what files are there". Almost every question a modder
actually has is the other one — *where is the thing called this* — and the names
that matter live inside binary containers where neither a file browser nor `grep`
can reach them.

The **Search** tab indexes a dump once into sqlite: every pane name, material,
texture, font, part reference, animation target, BYML key and message, with FTS5
over the lot. Then it is instant, and the reverse direction — *what refers to
this* — is a click from any result. That one is what tells you whether an edit is
safe: a shared texture changed for one screen changes every screen that names it.

It also feeds name recovery. A hash-only archive can be read but not written, which
makes it read-only in practice — and the names are not lost, only absent: they are
written down in the files *around* it, which is exactly what the index collected.

### Layouts as text

`layout_to_text` (and `pnpm cli text`) writes the whole document as YAML that reads
back to the same bytes. A binary mod is a black box in version control — you can
see *that* a `.szs` changed and nothing about what. This is the thing Switch
Toolbox structurally cannot do, and it changes what a group of people can build
together rather than merely making one person faster.

Editor-only pane ids are left out, so exporting an unchanged layout twice produces
an identical file and a diff is about the change.

### Text

MSBT is writable. The reason it took a codec change rather than a save button is
that a message is not a string: it is text with inline commands threaded through
it — colour changes, button glyphs, variable substitutions — each carrying an
opaque payload. The editable form shows those as `{n:1.4}` placeholders, which are
*movable*, because moving a substitution to a different point in a sentence is most
of what translating is. Saving merges the edited string against the original's
commands; a placeholder the message never had is refused rather than invented,
since there would be no payload to write.

Batch find-and-replace across every table under a folder is available over RPC and
through the CLI and MCP server. Run it with `dryRun` first — it returns before and
after examples, because a pattern that matched more than intended across 3,406
files is not something a count can tell you.

### Textures

Importing a PNG writes the pixels **in place**: the container's offsets, its BRTI
blocks and the relocation table `nn::gfx` uses to fix up pointers at load are all
left exactly as they were. That is deliberate. Rebuilding a BNTX means reproducing
that relocation table, and getting it subtly wrong produces a file this app reads
back perfectly and the game refuses — the failure nobody would attribute to the
tool, and not something to attempt without a real dump to check against.

The cost is two refusals, both of which come back naming what to do instead: the
image must match the original's dimensions, and the format must be one there is an
encoder for. Compressing to BCn or ASTC well is a rate-distortion search rather
than a format conversion, so there is no encoder for those, and the honest answer
is to build the `.bntx` elsewhere and use Replace on the archive entry.

The forward Tegra swizzle that makes this work is pinned to the reverse one that
already decodes 74,571 real textures — `deswizzle(swizzle(x)) === x` for every
shape. It is the only leverage available without a GPU, and it is a good one: a
tiling function that disagrees with the hardware produces a texture that looks
perfect in this app and is shredded on screen.

### Working headless

`pnpm cli` is the same engine without a window — `info`, `list`, `tree`, `render`,
`set`, `text`, `apply`, `check`, `diff`, `search`. `check` exits non-zero, which is
what makes it a CI gate. This is the dividend the `shared` purity gate was built
for and which, until now, only the tests collected.

`pnpm mcp` exposes the same engine to Claude Code over MCP — 44 tools covering
archives (create, clone, add, rename and delete entries), layout structure (add,
delete, duplicate, rename, reparent, reorder, materials, user data), animations
(create, tracks, keyframes, length, looping) and a headless renderer that draws
a layout to a PNG using the editor's own transform code, so a preview cannot
disagree with the canvas about where a pane is. It decodes the **real textures**,
draws nine-slice window frames, and follows part panes into the layouts they
instantiate — on a real game screen that is the difference between three drawn
panes and forty-eight. Text is not drawn, and blend modes are not applied, so it is
a preview rather than a screenshot. `render_animation_frame` draws the layout **as
an animation leaves it at a given frame**, which is the difference between reading
curves and seeing them.

It is **project-aware**: it reads the same database the app writes, takes the
active mod project, and applies the same read-only dump and copy-on-write redirect
— so an agent editing a file from the dump produces a copy in the mod folder, and a
write into the dump is refused. Tool calls are served one at a time and writes are
atomic, because two concurrent edits to one archive otherwise lose one of them.

A whole screen can be authored without leaving it: `create_archive` makes the SARC
(compression follows the extension), `create_layout` and `create_animation` fill it,
and `clone_archive` copies a stock screen while renaming the layout and every sibling
animation together — the game resolves animations by the layout's name, so renaming
only the layout leaves a screen that loads and never animates, silently.

Panes carry behaviour that is not in their fields: `usd1` user data wires panes to
each other by name, and `AdjustToTextOn` makes a pane resize itself every frame to
fit the text panes it names. Duplicating one is therefore a trap — the copy keeps
pointing at the original's collaborator, and nothing about that is an error. So
`duplicate_pane` repoints references at the copy's own panes and warns about the
ones it cannot, `edit_pane_userdata` clears or repoints them, and `check` reports a
reference naming a pane the layout does not have. That last rule runs clean across
all 66,344 files of a shipped romfs, which took teaching it that references can name
several panes, can path into a part pane, and can be rooted at the embedding layout.

Entries are packed **by kind**: shaders and texture containers land on `0x1000`
boundaries, everything else on the usual `0x80`. The driver maps GPU resources
rather than reading them, so one that starts mid-page crashes inside the reader with
nothing naming the archive that caused it. `check` reports a misaligned one as an
error, which is the only cheap way to catch it.

Both are built alongside the main process, so a packaged app can serve MCP without
a source checkout or a Node installation. See [docs/mcp.md](docs/mcp.md).

Both read and write Yaz0 and ZSTD, so a dump that ships entirely as `.zs` — which
this game's does — is fully reachable from a script. An archive is re-compressed as
it arrived; writing a `.zs` back uncompressed produces a file the game will not load
and that still opens perfectly in the editor.

## Requirements

Node 22+, pnpm 10+.

## Getting started

```bash
pnpm install
pnpm db:generate     # generate sqlite migrations (committed under drizzle/)
pnpm dev             # launch the app
```

If Electron fails to start with `Error: Electron uninstall`, pnpm skipped its
postinstall and the binary was never downloaded. Fix it with:

```bash
node node_modules/electron/install.js
```

### Other commands

```bash
pnpm typecheck       # all four tsconfigs (see Architecture)
pnpm lint            # react-hooks/rules-of-hooks, and little else on purpose
pnpm test            # unit tests
pnpm build           # production bundle
pnpm package         # distributable via electron-builder
pnpm fixture:archive out.szs [yaz0|zstd|none]   # synthesize a test archive
pnpm validate:romfs /path/to/romfs              # re-encode every file and compare
pnpm validate:byml  /path/to/romfs              # parse every BYML document
pnpm validate:astc  /path/to/vectors            # compare ASTC against astcenc
pnpm diag:prt1 archive.szs Layout.bflyt         # which prt1 bytes the parser claims
pnpm diag:pai1 /path/to/romfs                   # pai1 entries by target byte
pnpm diag:bflan archive.szs Anim [section]      # one section, original beside rewritten

pnpm cli <command>   # headless tools; `pnpm cli help` lists them
pnpm mcp             # the MCP server, for Claude Code (docs/mcp.md)
```

`pnpm lint` carries one rule that matters. The same mistake shipped twice — a `useMemo`
placed below an early return, so a panel rendered fewer hooks than the previous pass and
React threw straight to the error boundary — and twice is the signature of a problem that
needs a tool rather than more attention. `exhaustive-deps` is a warning rather than an
error: several memos here deliberately key on a revision counter instead of the object they
derive from, because the object is fresh every render and depending on it would never hit,
and that is exactly the pattern the rule cannot tell from a bug.

## Architecture

```
src/
  shared/    platform-neutral: binary codecs, document model, RPC contract
  main/      Effect services, oRPC server, sqlite via drizzle
  preload/   MessagePort relay (~20 lines)
  renderer/  React + TanStack Router/Query, WebGL2 canvas, editor panels
```

### The `shared` purity gate

`src/shared` must run anywhere: no Node APIs, no DOM APIs. This is enforced by a
dedicated tsconfig with `"types": []` and no DOM lib:

```bash
pnpm typecheck:shared
```

If that fails, something in `shared/` grew a host dependency. This is why string
decoding is hand-written rather than using `TextDecoder`, and why ZSTD (a WASM
module needing host loading) lives in `main/` while Yaz0 is pure and lives in
`shared/`. The payoff is that every codec is unit-testable in plain vitest with
no Electron involved.

There are four tsconfigs because there are four genuinely different environments:
`shared` (neither Node nor DOM), `node` (main process, no DOM), `preload`
(Node + DOM — the one hybrid), and `web` (renderer).

### Who owns the document

The **renderer owns the working layout document**. Main parses a file once, hands
over the whole document, and from then on every edit — including a 60fps canvas
drag — is a local store mutation. Undo/redo lives next to the model.

Main keeps what the renderer cannot use: the original bytes of every section, in
a side table keyed by node id. On save the renderer ships the document back and
main re-marries it with those bytes.

This is what makes saves non-destructive. Each pane, material, user-data block
and unrecognised section carries a `dirty` flag; the writer replays original
bytes for anything clean and re-encodes only what changed. An untouched file
rewrites byte-for-byte, and a file containing sections this build does not
understand still saves without losing them. (Switch Toolbox rebuilds everything
on save, which is why its output differs byte-wise from the originals.)

### Typed errors end to end

A failure keeps its identity across the whole stack:

```
codec throws Data.TaggedError  →  Effect typed error channel
  →  exhaustive Match to an oRPC declared error code  →  renderer narrows it
```

The `Match.exhaustive` in `src/main/rpc/errors.ts` is the enforcement point: add
a member to `AppError` without mapping it and the build fails. On the renderer
side `src/renderer/lib/errors.ts` turns those codes into messages that name the
file, format and byte offset instead of saying "something went wrong".

Errors are never swallowed: query and mutation failures surface as toasts with a
retry, the MessagePort handshake has its own failure screen rather than a blank
window, a React error boundary catches render crashes, and unhandled rejections
are reported.

## Testing

```bash
pnpm test
```

Unit tests cover the binary reader/writer (including backpatching), Yaz0
round-trips, SARC round-trips and name recovery, the BFLYT codec (byte-exact
round-trip, partial re-encode, unknown-section preservation) and the pane
transform maths (origin codes, alpha inheritance, rotated hit-testing).

### Validating against real files

The unit tests are self-consistency tests: they prove the parser and writer agree
with each other, not that they agree with Nintendo. This does:

```bash
pnpm validate:romfs /path/to/romfs            # whole dump
pnpm validate:romfs /path/to/romfs --limit 60 # quick pass
```

It walks a dump, decompresses everything, and for each layout, animation and
archive parses it and **re-encodes it from the model with no preserved bytes**,
then compares byte for byte. That is the strict test: replaying original bytes
would prove nothing.

Running it against a real game found seven bugs the self-consistency tests could
not, and each is now covered by a unit test:

- **`utf16String` did not stop at the terminator.** Layouts reserve a text buffer
  larger than the string in it, so every such text pane had dozens of NUL
  characters appended to its text.
- **The two `txt1` length fields were backwards.** The first is the runtime
  capacity, not the stored length — one pane declares 1002 bytes of capacity for a
  12-byte string, and reading at that length runs off the end of the section.
- **`usd1` struct payloads were truncated to one byte.** The count field counts
  *items*, and a struct is one item however large it is.
- **BFLAN group names are 36 bytes, not 28.** Verified on files with 2, 6 and 7
  groups; the reference implementation has this wrong.
- **`pat1` can nest a whole `usd1` section inside itself.** Version 8 added a u32
  after the groups offset that points at it. It was being skipped as padding and
  written back as zero, so eight shipped animations lost the block and came back
  52 to 76 bytes short.
- **Unknown BFLAN sections kept only their signature and position**, not their
  bytes, so any section this build does not model was dropped on save.
- **`cnt1` sections were written last.** They sit near the *front* of the stream.
- **Pane flag bits past the two modelled ones were cleared** on save.
- **Padding bytes were zeroed** where shipped files put `0xff`.
- **A `txt1` capacity field was clamped up to the stored length.** Shipped files
  exist where the authored capacity is genuinely *smaller* than the string in it —
  one pane declares 34 bytes for a 50-byte string — so an unconditional `max`
  rewrote a field nobody had edited. It now only grows for a pane marked dirty.

What is left, and precisely why:

- **Four layouts**, and only these, whose `prt1` part panes carry data reached
  through offsets — each shows up as a short `prt1` and nothing else. The "keep the
  unmodelled tail" trick that fixed the other sections cannot be applied here
  without writing those blocks twice; `prt1` needs each property's
  `overrideSection`/`panelInfo` extent modelled properly.
That is the only remaining gap. The two animations that used to sit here —
`MiniGame_PictQuiz_00_Mosaic{Rough,Normal}` — now round-trip, and how they were
resolved is worth recording, because "two samples is not enough to infer the rule"
was the reason they had been left alone.

The rule was inferred from the *population* instead. `pnpm diag:pai1` counts pai1
entries by target byte across the whole dump: 6,831 target 0, 1,938 target 1, and
**exactly 2** target 2 — the same two files. A target-2 entry is a user-data
animation, its lone tag is `FLEU`, and `FLEU` likewise appears exactly twice. So the
shape had never round-tripped once, which also meant nothing could break by
modelling it.

It carries one more offset after its tag-offset array, pointing at a trailing block
that names the field it drives (`__CUS_Float_0`). Neither the offset nor the block
was read, which is exactly the 24 bytes both files came back short. The block's
bytes are replayed verbatim rather than re-encoded from the name: every instance in
the dump carries the same name, so a single sample cannot distinguish a fixed
16-byte slot from padding to 4, and replaying is exact under either rule.

Measuring first also turned up a bug that could not have been caught otherwise. The
writer pointed a target-2 tag offset *past* the leading word rather than at it, so
its own output could not be re-parsed — the reader took the signature for the
leading word and read every field of the tag four bytes late. Both affected files
were already failing, so no test could see it.

All of these still **save** correctly through the normal path, which replays
original bytes for anything untouched; only a full re-encode from the model
differs, which is what `validate:romfs` deliberately forces.

**ASTC and BC7 both decode**, which between them is every texture this game ships
bar two: **74,571 surfaces decode with zero errors**, up from 24,423 before the
ASTC decoder existed and 74,480 before BC7 joined it. The only format left
without a decoder is `BC6H`, which two textures use. One `.bntx` is rejected
outright — `MiiFaceMaskPos.bntx.zs` has a `"Gen "` platform header rather than
the NX one — which is reported rather than guessed at.

### End-to-end self-test

An automated pass over the real RPC surface, driven from the main process:

```bash
pnpm fixture:archive /tmp/MainMenu.szs yaz0
BFLAYOUT_SELFTEST=1 BFLAYOUT_SELFTEST_ARCHIVE=/tmp/MainMenu.szs pnpm dev
```

It exercises settings persistence, recent files, typed errors, archive open and
close, a full layout open → edit → save → reopen cycle, and the texture pipeline
end to end — then drives the real editor UI, confirms every referenced texture
reached the GPU, and exits non-zero if anything failed.

Two things about this suite are worth knowing before adding to it. **Text-field commits do
not depend on the window being frontmost**: Chromium suppresses focus and blur events for a
document without OS focus, so `element.blur()` alone silently did nothing when the terminal
had focus — five checks failed for reasons unrelated to what they tested, and passed whenever
the app window happened to be in front. They dispatch `focusout` explicitly now, which is
what React actually listens for. And **the renderer-side scripts are template literals**, so a
backtick anywhere inside one — including inside a comment — ends the literal early and the
build fails pointing at the comment rather than the quoting.

Several checks exist because the obvious version of the test passed while the
feature was broken. The context menu is pressed with a real `pointerdown` before
the click, since a bare `.click()` never triggered the dismiss listener that used
to close the menu before any item could fire. PNG export is verified by inflating
the file's own IDAT rather than by checking its signature, because
`nativeImage.createFromBitmap` wants *premultiplied* BGRA and a signature check
cannot tell a correct pixel from a washed-out one. And recovery is proved by
serializing the restored document, which is the step that fails when a recovered
tab has no main-process session behind it.

Add `BFLAYOUT_SELFTEST_SHOT=/tmp/shot.png` to also capture the window, which is
the only way to check what the GL canvas actually drew: the context runs without
`preserveDrawingBuffer`, so `toDataURL` and `readPixels` both come back blank.

### Text properties that were already rendered but not editable

Every field a text pane's rasteriser reads — alignment on both axes, top and bottom font
colour, italic tilt, the shadow flag and its offset and colours — was parsed, rendered and
re-encoded byte-exactly, and had no way to be set. You could position a label but not centre
it, and not colour it at all. They are in the panel now, and because the rasteriser already
consumed them they take effect on the canvas with no renderer work.

Two things are deliberate. The **flag bits are edited individually and masked**, never
assigned as a word: shipped files set bits past the three this build understands, and
clearing an unmodelled bit on save was a real bug once (see the list above) — the codec was
fixed and the UI must not reintroduce it. Same for the alignment byte, where the two axes
share one field. The end-to-end pass sets an unmodelled bit and a vertical alignment first,
then edits through the masks and asserts both survived, because "the bit I wanted is set" is
not the same claim as "the bits I did not touch are untouched".

`lineAlignment` is parsed but not offered, because the rasteriser does not use it — an
editor for a field with no visible effect is worse than its absence.

### Multi-selection actually does something

The app implements marquee select, shift-click, ancestor filtering and tree-order sorting
for multi-pane moves — and then the only panel that edits anything read
`selectedPaneIds[0]` and said so in a comment. Setting alpha across twelve panes was twelve
operations and twelve undo entries.

The properties panel now fans out. One field edit applies to the whole selection and lands
as a **single** composed undo entry, so Cmd+Z is symmetrical with what you did. Two
distinctions matter:

- **Kind-specific fields are scoped to matching panes.** A `pic1`'s vertex colours mean
  nothing on a `pan1`, and writing them there would build a document the writer cannot
  encode — so a mixed selection edits only panes sharing the active pane's kind, while the
  common fields (visible, size, alpha, transform) apply to everything selected.
- **Name does not fan out**, because it is identity rather than a property: two panes cannot
  share one, and `paneNameProblem` exists precisely to enforce that.

Descendants are deliberately *not* excluded the way they are for a move. Setting `visible`
on a parent and its child is a meaningful request; a move is the case where the parent
carries the child anyway.

A common field whose selected panes disagree says so: numbers and dropdowns show an amber
dot, checkboxes go indeterminate, and the alpha slider labels itself "differs". The value shown
is still the active pane's — blanking it
would throw away the one piece of information available — but a field quietly showing one
pane's number while eleven others hold something else invites an overwrite nobody intended.
The kind-specific fields below do not carry the marker yet; they apply only to panes sharing
the active pane's kind, which is a smaller set to be surprised by.

### Most of a romfs is not a layout

Everything that was not a layout used to be a dead end. The file tree and the archive browser
would classify a file and then refuse to open it — for formats this build reads perfectly well —
and a *font archive* was the worst case: it opened as an archive whose every entry did nothing,
which reads as the app being broken rather than a feature being absent.

There is now a **preview** for anything that is not a layout, with one entry point for a loose file
and an archive entry alike, chosen by sniffing the bytes rather than trusting an extension:

- **Fonts.** A `.bfarc` shows its `.bfcpx` fallback chains in order, flags any face a chain names
  that the archive does not hold, and renders **actual glyphs** for each face at an adjustable size.
- **Textures.** A `.bntx` enumerates its textures with dimensions, mip counts and format, marking
  any this build has no decoder for.
- **Data.** BYML and `bgyml` open in the existing tree viewer.
- **Message tables.** MSBT shows every string with its label, filterable.
- **Anything else** names itself — "BFRES is a model format this build does not read yet" — rather
  than saying "cannot open".

A classification bug is worth recording here, because it was hiding the most common thing in a
modern romfs. `bgyml` was not in the entry table, so it classified as `other`: **38,265 entries** in
one title's archives, more than every layout, animation and texture combined, presented as
unrecognised files — and all 1,763 loose ones parse with the BYML reader that already existed. The
scalable fonts the canvas draws real text with were unclassified for the same reason. A unit test
actively asserted the old behaviour; it now asserts the new one, with the reasoning.

### The formats added by measurement, and what each one cost

Four more parsers, each written against real bytes and each held to the same bar as the codecs
above — **every file in the dump, or a named and explained exception**:

| | files | parsed | note |
| --- | --- | --- | --- |
| MSBT (text) | 3,406 | **100%** | 333,671 messages, every one labelled |
| BFRES (models) | 2,284 | **100%** | 3,019 models, 5.56M vertices, no geometry decoded |
| AINB (logic) | 2,574 | **100%** | 62,749 nodes; connections not yet decoded |
| AAMP (parameters) | 26 | **100%** | counts agree with the header on all 26 |
| BWAV (audio) | 946 + 2,003 in `.bars` | **100%** | headers only; no audio decoding |

The interesting part is not the percentages, it is what only measurement could have told us.

**BFRES contradicted the reference implementation in four places.** Its group slot order changed in
v10 — the reference puts skeletal animation straight after models, real files insert two slots, so
reading the older layout finds *material* animation two slots early. `Model.TotalVertexCount` does
not exist in v10 at all; vertex counts are instead derived from `bufferSize == stride × vertexCount`,
which holds on all 4,455 vertex buffers. And the header's `blockOffset` is the string-pool offset
truncated to 16 bits, so it names the wrong place for the 192 files whose pool sits past 64 KiB.

**BWAV had no reference at all** — Switch-Toolbox contains the string once and then hands the file to
a reader that cannot parse it. Its sharpest finding: the sample counts at +0x08 and +0x0c are
different fields that are *identical in all 946 loose files*, so a parser built from loose files
never learns the difference. Inside a `.bars`, 946 prefetch stubs pin +0x0c at 14,336 samples while
+0x08 holds the real length — read the wrong one and every prefetched track shows as 0.3 seconds.

**AINB postdates the reference entirely.** Its strides were proved jointly rather than assumed:
`0x74 + commands × 0x18 + nodes × 0x3c` equals the declared offset in all 2,574 files, which only
lands if both strides are right. Parameter list lengths have no count stored anywhere — they are
span ÷ stride, with strides taken from the GCD of every span in the corpus. Value type order was
derived by cross-checking parameter names against the game's *own* node-definition BYML rather than
recalled, and the global parameter type order turned out to differ from the node one, which is
exactly the trap a remembered layout would have walked into.

**AAMP disagreed with the brief I wrote.** Only parameters use a 24-bit offset; lists and objects use
`u16 offset + u16 count`. It is decidable from the files — one object holds more than 255 parameters,
which a u8 count cannot express — and under the corrected reading all 26 files walk to exactly their
declared counts. AAMP also stores CRC32 hashes rather than names, and only 660 of 935 resolve: the
rest display as hex, never as invented text.

Every one of these degrades rather than guesses. Value types never seen in a real file are marked
inferred; unidentified header words are exposed raw rather than named; capped lists always report the
true total beside them; and BWAV says plainly that this build cannot decode audio instead of leaving
someone wondering why nothing plays.

### Message tables

MSBT holds every string a game shows — 3,406 files and 61 MB of text in one title. `pnpm
validate:msbt` parses **3,406 of 3,406**, yielding 333,671 messages, every one of them labelled.

The layout was worked out from a hex dump rather than documentation, and two decisions in it are
deliberate. Inline commands — colour changes, button glyphs, variable substitution — are encoded as
escape sequences rather than characters; decoding them as text gives garbage and dropping them hides
that a variable is being interpolated, so they become visible `{n:group.type}` placeholders and the
viewer dims them so the words still read as words. And sections the parser does not model are
skipped by their declared size, which is what lets `ATO1`, `ATR1` and `TSY1` cost nothing.

UTF-8 is hand-rolled because `shared` has no DOM — that purity gate is what lets these codecs run
unchanged in main, the renderer and tests — and malformed sequences become U+FFFD rather than
throwing, because a table is worth reading with one damaged string in it.

### Getting things out of an archive, and back in

Until recently nothing but a decoded texture could leave an archive. Layouts, animations,
texture containers and BYML were all readable *inside* the app and unreachable from outside it
— which is most of what someone using the tool this replaces does all day. Each entry row now
has **Extract** and **Replace**.

The bytes are exactly what the archive holds: compression in a `.szs` wraps the whole SARC,
not each entry, so what lands on disk is what the game's own loader would see, and re-importing
it changes nothing. The end-to-end pass asserts that round trip, because anything else would
mean the compression layer or the SARC writer is touching entries it should not.

Replacement is also the practical answer to importing a texture, which the roadmap lists as
not started. Doing it properly needs a BNTX writer, a BCn/ASTC **compressor** and a forward
Tegra swizzle — none of which exist here, and all of which are large. Swapping in a `.bntx`
built in another tool needs none of them.

Getting this right took a second pass, and the shape of the mistake is worth recording. The
first version created dirty archives in places the save UI could not reach: saving an archive
was only ever step two of saving a *layout tab*, so an archive with no openable layout — a
shared texture archive, the headline case for Replace — could be dirtied and then never written.
The archive's own close refusal, added just before, then blocked the only remaining exit, and
the quit prompt counted unsaved *tabs* only, so quitting discarded the import without a word.
Three separate changes, each defensible, compounding into a dead end.

So: the browser header has a **Save**, the quit count includes dirty archives, and importing
byte-identical bytes leaves the archive clean rather than demanding a save for a change that was
not one.

Three refusals are deliberate.

**Nothing** in an archive with unrecovered names can be replaced — not just the unnamed entries.
Writing a SARC needs every name, so one unnamed entry anywhere makes the whole archive
unwritable, and replacing a *named* entry in it would produce changes that could never be saved.
Refusing only the unnamed rows would have invited exactly the click that creates that trap.

Replacing the entry a **tab is currently editing** is refused too, and this one is the
interesting case: that tab holds its own copy of the layout, so its next save re-encodes *that*
over the bytes just imported. The import would appear to succeed, the user would keep working,
save, and find their imported file gone with nothing having reported a problem. The check lives
in the RPC router rather than in `ArchiveService`, because only `LayoutService` knows what is
open and it already depends on the archive service — the router is the one place that sees both.
Main-side on purpose: a renderer guard would be advisory, which is the lesson from the archive
Close button below.

And imported bytes are **reported, not validated** — refusing anything this build cannot parse
would block the legitimate case of a format it does not model, while accepting silently would
let someone leave an unreadable entry in an archive and find out much later. So the toast names
what arrived (`FLYT`, `BNTX`, `zstd`, `unrecognised`) and leaves the judgement where it belongs.

### Closing an archive is a button, not a heuristic

Nothing used to close an archive at all, so every one opened stayed open for the session. That
is worse than a leak: resolving a texture searches the layout's own archive and then **every
other open one** — a deliberate feature, since layouts routinely reference a shared texture
archive opened separately — so the list only grew, lookups got slower, and a stale archive
could keep answering with a same-named texture.

Reclaiming them automatically was implemented and then reverted, which is the part worth
recording. "Referenced" is not knowable from the inside: an archive opened *so that its
textures resolve* has no tab, is not the archive being browsed, and is not the loaded
animation — it looks exactly like an abandoned one. So a sweep silently un-textured panes, and
because the session snapshot is rebuilt from the list of open archives it also rewrote the
saved session to drop that archive for good. Restore would have quietly degraded its own
snapshot.

So it is an explicit **Close** in the archive browser, which refuses while any open tab holds a
layout from it — that tab's save writes its re-encoded entry back into this in-memory archive,
and save-as is not available for an archive-backed layout. A button cannot be wrong about
intent.

The unsaved-changes refusal lives in **main**, not in the button. A layout save writes its
re-encoded entry into the in-memory archive, so those changes exist nowhere else until the
archive itself is saved — dropping the session discards them. A guard in the renderer is
advisory: the disabled state is computed from cached query data, and a save whose second step
failed leaves that cache saying `dirty: false` while the archive genuinely is. The archive
lives in main, so the refusal does too, and the end-to-end pass makes one dirty on purpose to
check both directions — refused while dirty, closeable once saved.

### Where a keystroke goes

Three things that all looked fine and were not:

- **`Cmd+Z` while typing** used to undo the last *canvas* edit instead of the typing. The
  canvas key handler has always declined when focus is in a field, but the native menu
  forwards `Cmd+Z` as a command with no target at all, so it went straight to the document.
  Both now ask the same question (`lib/typing-target.ts`).

  Declining is only half of it, and the first attempt got this wrong. A menu accelerator
  consumes the keystroke before the page sees it — that is *why* the field never got its own
  undo — so simply not undoing the document left `Cmd+Z` doing nothing at all in a field:
  quieter than the original bug, still wrong, and the comment claiming "the browser's own
  undo takes the field" described something the code could not do. Undo cannot be a native
  `role` item the way cut/copy/paste are, because its meaning depends on focus, so the
  renderer asks main for `webContents.undo()` instead. The end-to-end pass asserts both
  halves: the document is untouched with the caret in a field, and exactly one entry is
  undone with focus on the canvas — which also rules out the accelerator and the keydown
  both firing.
- **`Cmd+O` did nothing on the welcome screen** — the one screen whose entire purpose is
  opening a file. The handler lived on the editor route, which is not mounted there. Open
  and open-folder now sit in the always-mounted shell beside `save-all`, which had already
  been moved for exactly this reason.
- **Grid and snap did not persist.** Both are settings fields and neither was read: the grid
  was component state so turning it off never stuck, and snapping was `useState(false)`
  while the persisted default is `true`, so it was off every launch no matter what.

### Losing work

Three separate things have to be true for edits to survive, and each is handled
differently:

- **A deliberate exit** — closing a tab, closing the window, quitting — prompts. Main
  cannot see the document store, so the renderer pushes its unsaved count over RPC and
  `BrowserWindow.on('close')` reads it synchronously, which it must: the only way to stop
  a close is to `preventDefault` during the event.
- **A dirty archive** counts toward the prompt as well as a dirty tab. An archive holds changes
  of its own — a layout save writes its re-encoded entry into it, and replacing an entry does the
  same — and both leave bytes that exist nowhere else. Counting tabs alone meant those were
  discarded on quit in silence while the archive's close refusal implied they were protected,
  which is worse than no guard at all.
- **A crash or a kill** is covered by recovery snapshots. On a debounced timer, any tab
  holding unsaved edits has its *document* written to sqlite — the document's own JSON,
  not encoded layout bytes, so the editing state comes back exactly, including a document
  the writer would currently refuse to encode.

  Rows are keyed by the file's **path** (plus the entry name, for a layout inside an
  archive), not by its document id. That distinction is the whole feature: document ids
  are minted per open and restart from `1` every launch, so keying persistent rows by them
  meant a crashed file's snapshot could be silently claimed — and then overwritten — by an
  unrelated file on the next run, and that a save could never find the row it was meant to
  discard.

  Restoring goes through a real `layout.open` on the file the key names, and only then
  swaps the recovered document in. Pushing the stored document straight into a tab looks
  like it works right up to the first save, which fails with *layout document not found*:
  without a main-process session there is nothing to save against, so the one thing
  recovery exists to do — getting the work back onto disk — is the one thing that does not
  happen.

  That reopen's preserved section bytes are then **thrown away**, which is the subtle
  half. They are keyed by node id, and node ids come from a counter global to the module
  that never resets, so they identify a node only within the process that minted them —
  and the recovered document's ids came from the process that crashed. Keeping both would
  let the writer replay one pane's bytes under a different pane, producing a valid file
  quietly carrying the wrong sections. A recovered document is always re-encoded whole
  from its model instead, which is exact: every layout and animation in the dump
  re-encodes byte for byte from the model alone. Byte preservation is an optimisation for
  untouched sections, and a recovered document has none — the bytes it came from are gone.

  A snapshot is decided per *file*, not per tab, because a file can have more than one tab
  on it — edit a layout, then click it again in the archive browser. Deciding per tab
  emitted a write and a discard for the same file in one pass, and whichever landed last
  won, so the dirty tab's edits ended up with no snapshot at all every single flush.

  A snapshot is discarded when a file that *was* dirty goes clean again, which is what a
  save looks like from the renderer. Not merely when a clean tab for it exists: after a
  crash the welcome screen offers both "Reopen" and "Recover", and clicking Reopen would
  otherwise have deleted the crash row four seconds later, before the user had declined
  it. The key also follows a save-as, and every tab resyncs its key from main when an
  archive is saved to a new path — a key left naming the old file meant recovery would
  restore the new edits into, and then overwrite, the very file the user had moved away
  from. `tests/autosave-plan.test.ts` holds that rule as a pure function, one test per
  failure it prevents.

  The welcome screen offers snapshots back rather than restoring automatically, and says
  so when the file has been written to since the snapshot was taken: silently reinstating
  an in-memory copy over a file someone changed elsewhere is its own way to lose work.
  Recovered tabs open **unsaved**, because their contents exist nowhere on disk — anything
  else and the close prompt stays quiet and the tab counts as replaceable, so opening the
  next layout throws the recovered work away. A successful save discards the snapshot,
  since the file on disk is then the better copy.
- **A save that half-succeeded** is why `markSaved` takes the revision the bytes were
  built from. Serializing and writing is asynchronous, so an edit landing in between is
  not on disk; clearing the flag anyway made it look saved and the tab-close guard then
  discarded it silently.

### Textures

BNTX containers are parsed and decoded in the main process, then handed to the
renderer as RGBA8 and uploaded to the GPU. Decoding lives in main so a large
texture cannot stall the UI thread, and decoded surfaces are held in an
LRU cache bounded by total bytes rather than entry count.

Which BNTX a layout's texture name refers to is a search, not a lookup: the
archive's `timg/` folder first, then the rest of that archive, then every other
open archive — because layouts routinely reference a shared texture archive
opened separately. A loose `.bflyt` searches the directory beside it. Names are
matched case-insensitively with `.bntx` optional, since layouts and containers
disagree about both.

Any decodable texture can be **exported as a PNG** from the Textures panel, which is
the only way to get one out: the files ship BNTX with Tegra swizzling and BCn or ASTC
compression that no image editor opens. Encoding goes through Electron's `nativeImage`
rather than a PNG library, since it is already present and this is the only place a
real image format is needed.

`BC1`–`BC5`, `BC7`, ASTC and the uncompressed formats decode. **`BC6H` does not** — it is
recognised and reported, and the pane draws a magenta checker rather than
plausible-but-wrong pixels.

#### BC7, verified against the GPU

BC7 packs a 4x4 block eight different ways, with a different bit layout, endpoint
precision, subset count and index width in each. A mistake in any one mode produces
plausible pixels rather than an obvious failure, which is why it went undecoded while
there was nothing to check against.

There is something to check against. `EXT_texture_compression_bptc` is available in this
Electron, so **the GPU decodes BC7 natively** — which makes hardware the reference, using
the game's own textures as input and needing no encoder. The self-test finds real BC7
textures in a dump, deswizzles them in main, then in the renderer decodes the same blocks
twice: once on the CPU, once by uploading them with `compressedTexImage2D`, rendering, and
reading the pixels back.

```bash
BFLAYOUT_SELFTEST_BC7=1 BFLAYOUT_SELFTEST_ROMFS=/path/to/romfs \
  BFLAYOUT_SELFTEST=1 pnpm dev
```

Result: **1,097,728 samples across 6 textures and 17,152 blocks, byte-exact, worst delta
zero**, covering seven of the eight modes (mode 7 does not appear in this game's art). The
check reports per-mode block counts, so a failure names the mode rather than the format.

It is behind its own flag because it needs a dump, and it earned its keep immediately: the
first run reported 25% matching with a worst delta of 249. That turned out to be **the
harness, not the decoder** — `readPixels` returns rows bottom-up and the shader was also
flipping `v`, so the comparison was against the texture's last row. Real pixels from the
wrong place, which is exactly what a broken decoder looks like.

The partition and fix-up tables were extracted mechanically from the reference
implementation Switch-Toolbox ships rather than retyped, since 192 rows of sixteen values
is where a transcription error would hide.

#### ASTC

All fourteen 2D block sizes decode, unorm and sRGB, in `formats/bntx/astc.ts`.
It is a port of the FasTC/Ryujinx decoder that Switch-Toolbox ships, rewritten
against measured behaviour rather than transliterated: block-level failures
return a reason instead of throwing, assertions that a corrupt block could
violate became real checks, and the working buffers are per-surface rather than
per-block.

It is checked against **Arm's astcenc**, the reference implementation, and the
bar is byte-exactness rather than a tolerance — ASTC decoding is specified in
exact integer arithmetic, so any difference is a defect. `pnpm validate:astc
<dir>` compares 180 vectors (ten block sizes × three quality presets × six kinds
of image content, 2.9 MB of pixels); all 180 match exactly. A small slice of
those vectors is committed in `tests/fixtures/astc-vectors.json` so the unit
tests carry real ground truth without needing the binary.

Two things that measurement caught and reading would not have:

- The 16-bit interpolated value converts to 8 bits by **truncation**, not by
  rounding. `round(v / 257)` is the arithmetically faithful conversion and it
  disagrees with the hardware on 6.5% of bytes, in both directions.
- The Ryujinx reference's own conversion (`255 * v / 65536 + 0.5`) is wrong the
  same way, so a faithful transliteration would have been subtly incorrect
  everywhere.

HDR is not implemented: endpoint modes 2, 3, 7, 11, 14 and 15 and HDR void
extents report as unsupported per block. These files are LDR.

One transport detail worth knowing: RGBA crosses the RPC boundary as a `Blob`,
not a `Uint8Array`. oRPC's serializer has no case for typed arrays and would
expand a 4 MB texture into a JSON object of numeric keys; `Blob` is the binary
type it transports natively. See `BinaryPayload` in `src/shared/contract`.

### Window panes and text

Window panes are cut into a content quad plus a frame ring by
`src/shared/formats/bflyt/window.ts`, which is pure and unit-tested. The frame
count is not a free choice and decides the cut:

- **8 frames** is a true nine-slice ring: four corners, then four stretched edges.
- **4 frames** is a *pinwheel* — each piece runs the full length of one side and
  stops before the next corner, so the four interlock rotationally. This surprises
  people who expect four corners; the tests assert the interlock by checking the
  pieces tile the ring exactly once.
- **1 frame** uses the pinwheel with one material; **2** is the horizontal kind.

Ring thickness comes from each frame texture's own dimensions, falling back to the
pane's `frameElem` fields — that order matters, because shipped layouts leave
`frameElem` at zero and let the art decide.

Text panes are drawn in **the game's own typeface**, which took finding out what that
even is. There are no BFFNT bitmap fonts in this title at all — a layout's `fnl1`
entry names a `.bfcpx` *font complex*, which names several obfuscated `.bfttf`/`.bfotf`
scalable faces living in a different archive (`Font/Font.Nin_NX_NVN.bfarc.zs`, beside
`Layout/` under the dump root). So implementing BFFNT would have been dead code, and
the useful work was elsewhere.

A `.bfttf` is an ordinary sfnt under eight bytes of header, XORed one big-endian u32 at
a time with a key chosen by its magic. The keys come from the reference implementation,
but they were **checked rather than trusted**, and the check is the reason to believe
them: for every one of the eleven faces in the archive, exactly one candidate key yields
both a valid sfnt signature and a declared length equal to the file length minus eight
— and the decoded bytes then have a sorted table directory of real tags (`CFF `, `cmap`,
`glyf`, `hmtx`, `GPOS`) all in bounds. Three independent invariants agreeing is not a
coincidence a wrong key could produce.

The complex's face order turns out to be a per-glyph fallback chain — specialised faces
first (gaiji, extended glyphs, digits), main typeface last — which is exactly the order
CSS resolves `font-family` in. So the chain is registered as `FontFace`s and handed to
the canvas verbatim, and the browser does the glyph-by-glyph fallback itself. Only the
descriptor's *name table* is modelled: the records ahead of it are readable but their
stride cannot be pinned down from seven samples, and the worst a future variation can
cost this way is a fallback face the canvas does without.

What is still approximate is the **glyph layout**, not the typeface: Canvas2D does its
own shaping and kerning, so character positions will not match the game exactly, and
per-character transforms are not modelled. Close enough to judge how a label looks; not
a pixel reference. A dump with no `Font` directory degrades to `sans-serif` silently,
because that is a normal thing for a dump to be. Rasters are cached per pane, keyed on
the resolved families as well as the content, so text drawn with the fallback is redrawn
once the real faces arrive rather than staying wrong.

The frame **UV mapping is an approximation**: a stretched axis maps 0 to
`length / frameSize`, so with clamped sampling the frame renders at natural size
and then extends its last row or column along the rest of the side. That matches
what Switch Toolbox's preview does and looks right for a rounded-corner frame, but
it is not derived from Nintendo's runtime and has not been checked against real
game output.

### Animation

BFLAN files are parsed by `src/shared/formats/bflan/`. The dock lists the
animations sitting next to the layout, plays them at their own 60fps frame units,
and shows every keyed track with its keyframes.

**Playback never mutates the layout document.** A frame is turned into a sparse
set of per-pane and per-material overrides, and the renderer resolves
`override ?? static`. Scrubbing is therefore free, closing the animation restores
the authored values exactly with nothing to undo, and an animation can never
corrupt what gets saved. The self-test asserts exactly this: scrubbing moves a
pane in world space while the document's own value stays put.

Tags handled: `FLPA` (transform), `FLVI` (visibility), `FLVC` (vertex colours and
pane alpha), `FLTS` (texture SRT), `FLMC` (material black/white), `FLTP` (texture
pattern). An unmodelled tag is skipped rather than guessed at — and because
writing replays the original bytes, it still round-trips.

v1 is playback and inspection. Keyframe *editing* is not implemented.

## Browsing a game dump

`Open folder…` points the editor at a romfs directory and browses it in place. A
dump is tens of thousands of files across a deep tree, so directories are listed
only when opened — that holds in both view modes, and an expanded tree costs
exactly the directories you expanded. The tree suits hunting down through
`Pack/Actor/…`; the flat list suits `Layout/`, where 544 siblings in an indented
tree are unreadable. The choice is a persisted setting.

Clicking a file **sniffs its magic** rather than trusting the extension, because in
a romfs the extension is a hint: `Foo.Nin_NX_NVN.blarc.zs` is a ZSTD-compressed
SARC. A layout archive with exactly one layout opens that layout straight onto the
canvas; with several, the archive browser presents the choice.

## Packaging

```bash
pnpm package
```

Two parts of `electron-builder.yml` are load-bearing rather than boilerplate:

- **`extraResources` ships `drizzle/`.** The database is created on first launch
  by running those migrations, so a build without them starts and then fails on
  the first query. `PathsLive` resolves them from `process.resourcesPath` when
  packaged and from the app path in development.
- **`asarUnpack` covers `better-sqlite3`.** It is a native module and cannot be
  loaded from inside an asar archive.

Verified by packaging with `--dir`, launching the result, and confirming it
creates `bflayout.db` in the user-data directory with all five tables — which
only happens if the migrations were found.

Nothing is code-signed or notarised: there are no credentials to do it with, and
a build that claims to be signed but is not is worse than one that does not
claim it. Expect Gatekeeper to complain on another machine.

## Format notes

Details worth knowing, gathered from the Switch Toolbox source:

- BFLYT is a flat stream of `signature` + `size` sections. The pane tree and the
  group tree are **independent**, each nested by zero-payload push/pop markers
  (`pas1`/`pae1` and `grs1`/`gre1`).
- The byte-order mark sits at offset 4, *before* the header size — so the first
  fields are read big-endian and the reader flips afterwards. SARC puts them the
  other way round.
- Version gates that matter: material field order changed at major 8, group name
  fields widened from 24 to 34 bytes at major 5, and the text pane
  per-character-transform pointer only exists past major 2.
- Material flags pack every array count and optional-block presence bit into one
  word, so the variable-length data after it can only be read once decoded.
- Archives may ship with **no name table**, addressed only by hash. Those
  entries are listed by hash and can be read but not replaced until a name is
  recovered (`archive.recoverNames`, implemented and self-tested, but with no button in the archive browser yet — the names
have to come from somewhere, and the layout texture lists that would feed it are not
wired up).
