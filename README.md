# BFLayout

A cross-platform layout editor for Nintendo Switch BFLYT files and the archives they ship in — an alternative to the Windows-only Switch Toolbox.

## Status

Working today: open a `.szs`/`.sarc` archive, browse its contents, open a BFLYT layout, inspect and edit the pane tree on a texture-mapped WebGL2 canvas, and save back into the archive with byte-level fidelity for everything you did not touch.

| Area | State |
| --- | --- |
| SARC archives (+ Yaz0 and ZSTD) | Read and write |
| BFLYT parse / edit / save | Working, with per-section byte preservation |
| Pane hierarchy, properties, canvas | Working |
| Materials (colours, blend, alpha compare, texture maps) | Editable |
| Window panes (nine-slice / pinwheel frames) | Working |
| Text panes | Preview only — system font, not BFFNT |
| Undo / redo | Working — every edit, including property, material and visibility |
| Add / delete / duplicate pane, grid snapping | Working |
| Reorder and reparent panes (z-order) | Working — buttons and Alt+arrows |
| Align and distribute a multi-pane selection | Working |
| Filter the pane hierarchy by name or kind | Working |
| Zoom readout (click for 1:1) | Working |
| Keyboard editing (nudge, delete, duplicate, undo) | Working — see Keyboard |
| BYML documents | Read-only tree viewer (v1–7, both byte orders) |
| Session restore | Offers the previous session on launch |
| BNTX textures | Decode and preview (BC1–BC5, all ASTC LDR block sizes, uncompressed; no BC6H/BC7) |
| BFLAN animation | Parse, play, scrub, inspect keyframes (no keyframe editing) |
| Canvas resize handles, rubber-band select, alignment guides | Working |
| Folder / romfs browsing | Working (tree or list, lazy per directory, windowed rows) |
| Materials list | Working (usage counts, shared-material warnings) |
| Show / hide panels, native menu bar | Working |
| prt1 external part resolution | Working (parts draw their referenced layout) |
| Texture export to PNG | Working |
| Texture add / replace | Not started (textures are otherwise read-only) |
| BFFNT font rendering | Out of scope for v1 (see Text panes) |

**Validated against real game files.** Every layout archive in a Tomodachi Life
romfs dump (Switch, v1.0.4) is parsed and rewritten byte for byte:

| | files | byte-exact |
| --- | --- | --- |
| SARC archives | 567 | 100% |
| BFLYT layouts | 544 | 99.3% |
| BFLAN animations | 2187 | 99.9% |
| BNTX containers | 74,480 textures decoded | 100% |

See [Validating against real files](#validating-against-real-files) for how to run
this, and what the remaining 0.9% is.

### Keyboard

| Keys | What |
| --- | --- |
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
| ⌘F | Fit the layout to the view |
| Alt while dragging | Suspend grid snapping and alignment guides |
| Two-finger scroll | Pan; pinch or ⌘-scroll zooms at the cursor |
| Click the same spot again | Select the pane *behind* the one you just got |

Nudge, delete and duplicate act on the whole selection as **one** undo entry, so a
twenty-pane drag is one press of ⌘Z rather than twenty.

Reordering matters more than it sounds: **draw order is tree order**, so moving a pane
later among its siblings is the only way to put it on top. Before this the only route
was delete-and-recreate, which lost every property the pane had.

Select-behind exists because painter's order makes the topmost pane the only hit, and
shipped layouts routinely end with a full-screen `bnd1` or `pan1` — which then
swallows every click. Clicking the same spot repeatedly walks down the stack and
wraps at the bottom.

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
pnpm test            # unit tests
pnpm build           # production bundle
pnpm package         # distributable via electron-builder
pnpm fixture:archive out.szs [yaz0|zstd|none]   # synthesize a test archive
pnpm validate:romfs /path/to/romfs              # re-encode every file and compare
pnpm validate:byml  /path/to/romfs              # parse every BYML document
pnpm validate:astc  /path/to/vectors            # compare ASTC against astcenc
```

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
- **Two animations** (`MiniGame_PictQuiz_00_Mosaic{Rough,Normal}`) whose `pai1`
  entry declares `tagCount = 1` but carries **two** offset slots. The second points
  at a 20-byte block — a u32 followed by the name `__CUS_Float_0` — that runs to the
  end of the section, i.e. an animation targeting a user-data custom float. Two
  samples is not enough to infer the general rule, and guessing it risks the 2185
  animations that currently round-trip, so this is left modelled-as-unknown rather
  than approximated. `pnpm diag:bflan` is the tool for picking this up again.

All of these still **save** correctly through the normal path, which replays
original bytes for anything untouched; only a full re-encode from the model
differs, which is what `validate:romfs` deliberately forces.

**ASTC decodes**, which in this game is most textures: 74,480 surfaces decode
with zero errors, up from 24,423 before the decoder existed. The only formats
left without one are `BC7` (91 textures) and `BC6H` (2). One `.bntx` is rejected
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

Add `BFLAYOUT_SELFTEST_SHOT=/tmp/shot.png` to also capture the window, which is
the only way to check what the GL canvas actually drew: the context runs without
`preserveDrawingBuffer`, so `toDataURL` and `readPixels` both come back blank.

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

`BC1`–`BC5`, ASTC and the uncompressed formats decode. **`BC6H` and `BC7` do
not** — they are recognised and reported, and the pane draws a magenta checker
rather than plausible-but-wrong pixels. BC7 in particular needs two partition
tables and per-mode bit layouts reproduced exactly, and there were no test
vectors to validate an implementation against.

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

Text panes are rasterised with a **system font**, not the layout's BFFNT. You get
the right string at roughly the right size, colour, alignment and spacing —
enough to identify and position a label, not enough to judge how it will look.
Rasters are cached per pane and only redrawn when something affecting their pixels
changes.

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
  recovered (`archive.recoverNames`, fed from layout texture lists).
