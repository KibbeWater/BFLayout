# MCP server

BFLayout ships an MCP server so Claude Code can read, edit and *look at* layouts
and animations directly.

Most of modding this game is reading. Which of 544 layouts draws a screen; what
does this pane tree actually do; what does this animation move, and to where. All
of it is work an assistant is good at, and all of it was locked inside a GUI.

## Two servers

There are two, and they expose exactly the same tools — the definitions are shared,
so they cannot drift. The difference is what each can *see*.

**The in-app server** is the one to prefer while you are working. BFLayout hosts it
(sidebar → **Agent** → Start), and because it runs inside the editor it knows what
is open: a tool call that names no file means the layout on screen. Every call it
serves is listed in that panel as it happens, so an agent editing your mod is
something you watch rather than infer.

**The stdio server** is the one Claude Code launches itself. It works whether or not
the app is running, which makes it the right choice for scripts and CI, but it can
only read the mod project out of the app's database — it cannot know which file you
are looking at, so every call needs a path.

## Registering it

**The in-app server** — start it from the Agent panel, then use its Copy config
button, which gives you:

```json
{
  "mcpServers": {
    "bflayout-app": { "type": "http", "url": "http://127.0.0.1:47601" }
  }
}
```

It is loopback-only and off until you start it. These tools write files, so it does
not listen by default.

**From a source checkout** — no build step, uses `tsx`:

```json
{
  "mcpServers": {
    "bflayout": {
      "command": "pnpm",
      "args": ["--dir", "/path/to/BFLayout", "mcp"]
    }
  }
}
```

**From an installed app.** The CLI and MCP server are built alongside the main
process and ship inside the app, so no repo and no Node installation is needed —
Electron's own Node runs them:

```json
{
  "mcpServers": {
    "bflayout": {
      "command": "/Applications/BFLayout.app/Contents/MacOS/BFLayout",
      "args": ["/Applications/BFLayout.app/Contents/Resources/app.asar/out/main/mcp/server.js"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

`ELECTRON_RUN_AS_NODE` is what stops the binary opening a window and makes it
behave as a Node runtime. It also matters for a subtler reason: `better-sqlite3`
is a native module built against Electron's ABI, and running the server this way
is what lets it read the app's project database.

Then `/mcp` in Claude Code should list the server with 44 tools.

## It knows about your mod project

This is the part worth understanding before you let it write anything.

The server reads the same database the app writes, takes whichever mod project is
**active**, and installs it into the same read-only guard and copy-on-write
redirect the app's own saves go through. So with a project open:

- editing a file that came out of the pristine dump writes a **copy into your mod
  folder** and leaves the dump untouched, exactly as the app does;
- a write that would land in the dump is **refused**, including one you asked for
  explicitly with `output_path`;
- every edit tool says so in its result when a write was redirected.

Call `current_context` to see which project is in force. With no project active
there is no layer and no guard — writes go straight to the files you name, which
is the right behaviour for working on loose files and the wrong one to assume
while pointed at a dump.

## Tools

### Finding things

| Tool | What it is for |
| --- | --- |
| `current_context` | What is open: project, browsed folder, archives, layout tabs — **call this first** |
| `identify_file` | What a file really is, by magic. Extensions in a romfs are a hint |
| `list_archive` | Entries in a SARC/SZS, each with its real format |
| `search_dump` | Find a name *inside* the files of a whole dump |
| `check_file` | Parse everything and report what would stop the game loading it |

### Archives

| Tool | What it is for |
| --- | --- |
| `create_archive` | A new empty SARC; compression follows the extension |
| `clone_archive` | Copy a whole archive, optionally renaming a stem throughout |
| `add_entry` | Put a file from disk into an archive |
| `rename_entry` | Rename an entry, rehashing it so the game still finds it |
| `delete_entry` | Remove an entry |

### Layouts

| Tool | What it is for |
| --- | --- |
| `create_layout` | A new empty layout, loose or as an archive entry |
| `duplicate_layout` | Copy a whole layout to a new entry or file |
| `copy_panes` | Copy panes **between** layouts, bringing materials, textures and fonts |
| `read_layout` | The pane tree: names, kinds, positions, sizes, text, part references |
| `render_layout` | A PNG of the layout, plus every pane's rectangle |
| `edit_pane` | translate, size, scale, rotate, alpha, visible, text |
| `add_pane` | Add a pan1/pic1/txt1/wnd1/bnd1/prt1 under a named parent |
| `delete_pane` | Remove a pane and its subtree |
| `duplicate_pane` | Copy a subtree beside itself, renaming every pane in it |
| `list_groups` | The layout's pane groups — what animations bind through |
| `add_group` | Add a group holding named panes |
| `edit_group` | Change which panes a group holds |
| `delete_group` | Remove a group |
| `read_pane_userdata` | The behavioural key/value bag on a pane, and what it points at |
| `edit_pane_userdata` | Set or remove those entries |
| `rename_pane` | Rename, with the caveat that references break |
| `reparent_pane` | Move under a different parent |
| `reorder_pane` | Move among siblings — which is z-order |
| `edit_material` | Colours and which textures a material samples |
| `add_material` | Add a material, or a texture to the layout's list |
| `diff_layouts` | What changed between two layouts, structurally |
| `layout_to_text` | The whole layout as reviewable YAML |
| `apply_layout_text` | Write that YAML back into the binary |

### Animations

| Tool | What it is for |
| --- | --- |
| `create_animation` | A new empty BFLAN, loose or as an archive entry |
| `copy_animation` | Copy a BFLAN into another archive, retarget it, report what it will not find |
| `list_animations` | Every BFLAN in an archive, with length, loop and track count |
| `read_animation` | Every animated channel, flattened into named tracks |
| `render_animation_frame` | The layout **as the animation leaves it at frame N** |
| `edit_animation` | Length, loop, name, frame range |
| `add_animation_track` | Animate something not yet animated |
| `remove_animation_track` | Stop animating a channel |
| `set_keyframes` | Replace a whole curve |
| `put_keyframe` | Set one key, replacing any at that frame |
| `remove_keyframe` | Remove one key |

## Building a layout out of an existing one

A pane refers to its material by **index**, and a material refers to its textures by
index. So pasting a pane into another layout without remapping leaves it pointing at
whatever sits at that index in the destination — which is not an error anywhere. It
draws, with the wrong texture, and nothing says so.

`copy_panes` carries the subtree, the materials those panes draw with, the textures
those materials sample and the fonts the text uses, remapping every index. **Across
archives it also copies the texture containers**, because a layout that merely
*names* a texture its archive does not hold still parses, still loads, and draws
untextured:

```
create_layout  path=Menu.szs  entry=blyt/MyMenu.bflyt  name=MyMenu
copy_panes     from_path=Menu.szs  from_entry=blyt/MainMenu.bflyt
               panes=["Wnd_Panel"]  path=Menu.szs  entry=blyt/MyMenu.bflyt
→ copied Wnd_Panel; materials: T_Label, P_Base, W_Frame;
  textures: MainMenu.bntx, MainMenu_Frame.bntx; fonts: Common.bffnt
```

Deduplication differs by kind, deliberately. A **texture** name is a file name, so
two layouts naming the same one mean the same image and it is reused. A **material**
name is local, so one that matches by name but differs in content is imported under
its own name and you are told — reusing the destination's would change how the copy
draws for a reason nobody would find.

Textures are **merged into the container the destination already has**, not added
beside it. That distinction is the whole of it: nn::ui2d opens
`timg/__Combined.bntx` by that exact path and never enumerates an archive, so a
second container is simply never read — the copied panes' textures stay unresolved
and the game dies dereferencing null inside `nn::ui2d::ResourceTextureInfo` while
building the layout. It previews perfectly the entire time, because the previewer
searches every container.

Merging means writing a BNTX, which means reproducing its radix tree and relocation
table. Both are verified the only way worth trusting: every one of the 470
containers in a shipped romfs parses and rewrites **byte for byte**. Pixel data is
carried across still tiled and still in its original format, so a merge is a repack
— there is no BCn or ASTC compressor involved and no quality to lose.

A texture the destination already has under the same name is left alone rather than
replaced: that art is what its other layouts are drawing with. Pass
`carry_textures: false` when the textures live in a shared archive the game loads
anyway.

To start from an existing screen wholesale, `duplicate_layout` copies it to a new
entry in the same archive, to a loose `.bflyt`, or **into a different archive** —
giving both `to_path` and `to_entry` brings the textures across too. It can rename
the layout internally at the same time.

## User data, and why duplicating is a trap

Some of a pane's behaviour is not in its fields. It is in `usd1`, a key/value bag
the runtime reads to wire panes to each other by **name**:

```
read_pane_userdata  pane=W_Base_00
→ AdjustToTextOn      "T_Text_00\nT_Big_00\nT_Small_00"   (all present)
  AdjustToTextMinSize 440
  AdjustToTextMargin  100
```

`AdjustToTextOn` means *resize yourself, every frame, to fit these text panes*. A
pane carrying it looks like any other pane, which makes it the sharpest edge in the
format: duplicate one and the copy keeps the original's value, so it sits there
sizing itself to a pane that belongs to something else. Nothing about that is an
error. It parses, it deploys, it renders in the editor, and it goes wrong at run
time.

So `duplicate_pane` repoints references at the copy's own panes when those were
copied too, and **says so when it cannot**:

```
duplicate_pane  pane=W_Base_00
→ W_Base_00 duplicated as W_Base_00_copy; 3 reference(s) still point outside the copy
  warnings: W_Base_00_copy.AdjustToTextOn still points at T_Text_00, T_Big_00, T_Small_00
```

Which is a warning rather than a refusal, because pointing outside is sometimes the
intent — several panes naming one shared capture target is normal. When it is not
the intent, `edit_pane_userdata` is the fix: `remove: ["AdjustToTextOn"]` stops the
copy resizing itself at all, or `set` repoints it at a pane it owns.

`check_file` reports a reference naming a pane the layout does not have. Three
things it deliberately does **not** report, each of which cost a false positive
before it was understood:

- A value naming **several** panes, newline-separated. Shipped layouts do this.
- `L_Key_00/T_KeyTxt_00` — a path into a part pane, whose far half is another file.
- `/N_Capture_00` — rooted at whichever layout embeds this one, so unresolvable here.

Editing user data re-encodes the whole section rather than replaying its original
bytes, so a `struct` entry — an opaque payload whose stored count does not describe
its length — can be removed but not created or overwritten.

## Building a screen from nothing

A screen is an archive, a layout inside it, and the animations the game plays on it.
All three can be made here, so a custom screen never needs a detour through another
tool:

```
create_archive    path=romfs/Layout/My_Screen.Nin_NX_NVN.blarc.zs
create_layout     path=…blarc.zs  entry=blyt/My_Screen.bflyt  name=My_Screen
create_animation  path=…blarc.zs  entry=anim/My_Screen_In.bflan  name=In  frame_size=20
```

Compression is taken from the extension — `.zs` means ZSTD at the project's level,
`.szs` means Yaz0, anything else is stored plain — so an archive round-trips into the
romfs the way the rest of the dump is packed.

More often the shortcut is `clone_archive`, because a stock screen already has the
shader, the texture container and the animation set that make it load:

```
clone_archive  from_path=…/Common_Text_00.Nin_NX_NVN.blarc.zs
               to_path=…/Common_CantTouch_00.Nin_NX_NVN.blarc.zs
               rename_from=Common_Text_00  rename_to=Common_CantTouch_00
→ 9 entries, 5 renamed
```

The rename matters more than it looks. The game resolves a layout's animations **by
the layout's name**, so `blyt/X.bflyt` is played by `anim/X_In.bflan`,
`anim/X_Loop.bflan` and the rest. Renaming the layout alone leaves a screen that
loads and never animates, with nothing reporting a problem. `clone_archive` renames
every entry whose name contains the stem *and* rewrites the layout's own internal
name, so the three places that have to agree do. `rename_entry` is there for the
one-off case, and rehashes the entry — SARC looks entries up by the hash of the name,
so relabelling without rehashing strands the file inside its own archive.

## How entries are packed

Entries are aligned by kind. Shaders (`.bnsh`) and texture containers (`.bntx`) are
placed on `0x1000` boundaries; everything else gets the ordinary `0x80` floor.

This is not a preference. The driver *maps* GPU resources rather than reading them,
so a container that starts mid-page crashes inside the reader — a null dereference
with nothing in it that mentions the archive, the entry or the packing. An archive
packed entirely at `0x80` looks completely correct until it runs.

Anything BFLayout writes is aligned this way, including entries added to an archive
that had no GPU resources to inherit an alignment from. `check_file` reports a
misaligned one as an **error**, with the offset it landed at, so an archive built
elsewhere can be diagnosed before it reaches the game.

## Copying an animation into another archive

`copy_panes` remaps material and texture indices because a pane pointing at the
wrong index still draws — with the wrong texture, and nothing says so. A BFLAN has
no such index. It binds to panes and materials **by name**, so there is nothing to
remap, and the failure it has instead is quieter still: a track naming a pane the
destination does not have loads perfectly and animates nothing.

Nothing can catch that downstream. It is indistinguishable from an animation that
has not been triggered yet. So `copy_animation` reports every target it cannot
resolve, and `rename` points them at the destination's own names:

```
copy_animation  from_path=Button_MainMenu_00.blarc.zs
                from_entry=anim/Button_MainMenu_00_Select.bflan
                to_path=Balloon_RoomName_00.blarc.zs
                to_entry=anim/Balloon_RoomName_00_Select.bflan
→ 8 tracks
  missing panes:     P_Select_00, P_Select_01
  missing materials: P_Emphasis_00, P_Emphasis_01
  missing groups:    G_Btn_00

copy_animation  … rename={"P_Select_00": "W_BaseSh_00", "P_Emphasis_00": "T_Text_00", …}
→ missing panes: (none)   missing materials: (none)
```

## Groups are not optional

Groups look like an organisational nicety and are nothing of the sort. **2183 of
the 2187 animations in a shipped romfs bind to a group**, and that binding is what
decides which panes the animation applies to. Bound to a group the layout does not
have, an animation loads, keeps every one of its tracks, resolves every target, and
moves nothing.

That is worse than a broken animation, because it reads as a broken *shader* — the
file is correct, the panes are correct, and nothing anywhere reports a problem.

So `copy_animation` reports a missing group like any other unresolved target, and
`create_groups: true` builds it from the panes the animation actually drives:

```
copy_animation  … to_entry=anim/Wave_Test_00_Loop.bflan
→ missingPanes:  N_All_00
  missingGroups: G_All_00
  warning: the pat1 binds to G_All_00, which this layout has no group for …
           Pass create_groups: true to build it from the panes this animation
           drives, rename it onto a group the layout already has, or make it
           yourself with add_group.

copy_animation  … rename={"N_All_00": "P_Fluid_01"}  create_groups=true
→ createdGroups: G_All_00 (P_Fluid_01)
  missingGroups: (none)
```

It is opt-in because it rewrites the destination **layout**, not just the animation
entry. It refuses to build a group out of targets that do not resolve — a group
listing panes that are not there is the same silent nothing one level down — and it
puts only pane targets in, never materials.

`list_groups`, `add_group`, `edit_group` and `delete_group` do the same work
directly, and `read_layout` now lists groups alongside materials, because a layout
with none cannot be animated by a stock animation at all.

Two other things it checks. The entry name has to start with the destination
layout's name — the game resolves a layout's animations by that name, so
`anim/Wave_Loop.bflan` beside `blyt/Screen.bflyt` is loaded by nobody. And an FLTP
pattern table names textures that must exist in the destination archive's
container; those are merged across like any others, and any it cannot supply are
listed.

The one thing that genuinely is an index needs no remapping: FLTP keyframe values
index the animation's **own** texture table, which is inside the BFLAN and travels
with it.

## Reading an animation

A BFLAN nests three levels deep — entry (the pane or material), tag (the kind of
property), component (the channel) — and none of that is how anyone thinks about
it. `read_animation` flattens it into tracks and names the properties:

```json
{
  "entry": "Wnd_Panel", "target": "pane",
  "tag": "FLPA", "tagName": "Transform",
  "targetByte": 1, "targetName": "Translate Y",
  "curve": "hermite",
  "keyframes": [{ "frame": 0, "value": -400, "slope": 0 }]
}
```

The editing tools address a track by the same three fields: `animates` (the pane
or material), `tag`, and `target`.

Note that `entry` and `animates` are different things. `entry` is always the file
inside the archive (`anim/MainMenu_In.bflan`); `animates` is the pane the track
drives (`Wnd_Panel`). Animations live inside archives, so both are usually needed
at once.

Target bytes worth knowing:

- **FLPA** (transform) — 0-2 translate XYZ, 3-5 rotate XYZ, 6-7 scale XY, 8-9 size XY
- **FLVI** (visibility) — 0
- **FLVC** (vertex colour) — 0-15 the four corners' RGBA, 16 pane alpha
- **FLMC** (material colour) — 0-3 black RGBA, 4-7 white RGBA
- **FLTS** (texture SRT) — 0-1 translate ST, 2 rotate, 3-4 scale ST

## What the render is, and is not

Both render tools return a real image, and the geometry is exact — they go through
the same transform code as the editor's canvas, so a preview cannot disagree with
the editor about where a pane sits. Rotation is drawn as a rotated quad.

They draw the **real textures** where they can be decoded — including nine-slice
window frames, and the layouts that part panes instantiate, which are usually most
of a screen. Anything that cannot be resolved falls back to a flat colour by pane
kind, and every response says how many of each it managed.

**Text is never drawn**: a text pane shows as a coloured box. And this is still a
preview rather than a screenshot — blend modes, texture combiners and per-character
transforms are not applied, so a busy screen will look approximate. What it is
reliable about is *where things are*, which is what an edit needs checking against.

`render_animation_frame` is the one that changes how animations can be worked on:
the curves are a list of numbers until you can see what they do to the layout.
Render frame 0 and frame 30 and the motion is obvious.

Every response also carries each pane's canvas-space rectangle as data, so nothing
has to be inferred from pixels.

## Why it is headless

It reads files directly rather than talking to a running editor. Talking to the app
would give texture-accurate previews and would also mean the tools work only while
an app is open, on the machine it is open on, with whatever files happen to be
loaded. This works in a terminal, in CI, and over SSH.

Both Yaz0 (`.szs`) and ZSTD (`.zs`) are read and written, which matters because
some titles — Tomodachi Life among them — ship their entire romfs as `.zs`. An
archive is re-compressed as it arrived: writing a `.zs` back uncompressed produces
a file the game will not load and that still opens perfectly here, which is the
worst way for it to be wrong.

## Concurrency

Tool calls are served **one at a time**, deliberately. They edit files, and two
calls against one file otherwise interleave into read-read-write-write, where the
second write silently discards the first edit. A read running during a write is
worse: it sees a half-written archive and reports that the file is not an archive
at all. Writes are atomic — a temporary file and a rename — for the same reason.
