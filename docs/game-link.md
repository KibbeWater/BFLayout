# Game link

BFLayout can listen for the running game telling it which screen is on display.

This exists because of the one question the files cannot answer. A romfs holds 544
layouts and no index of what draws what — the mapping from a screen you are looking
at to the file that draws it lives in the game's code, not in its data. Finding a
screen by opening layouts until one looks right is how an afternoon disappears.

The game knows, though, and [Colony](../../Tomodachi-MM)'s per-frame hook is already
standing next to the answer. A plugin that posts the current screen name closes the
loop.

## What BFLayout does

Sidebar → **Search** → **Game link**. Starting it binds an HTTP listener to
`127.0.0.1` on a port you choose (47600 by default).

It is off until you start it, it is loopback-only, and it accepts exactly one
message. It **records** what it is told and offers to search for it — it never opens
anything on its own. A tool that opens files because something on a socket asked it
to has a remote-control problem, and this is a socket that a plugin inside an
emulator can reach.

## The contract

### `GET /health`

```json
{ "ok": true, "app": "bflayout" }
```

Use it to decide whether the editor is running before spending a frame on a POST.

### `POST /screen`

```json
{
  "screen": "ScreenDialog",
  "layout": "Dialog.bflyt",
  "archive": "Layout/Dialog.szs",
  "detail": "opened by TalkTask"
}
```

Only `screen` is required, and only `screen` is really needed: the name is enough to
search the index with. Everything else narrows the result if the plugin happens to
know it. Bodies over 16 kB are rejected.

Replies `{"ok": true}`, or `400` with `{"error": …}` if the body is not JSON or
carries no `screen`.

## The plugin side

This lives in Colony, not here. Roughly:

```rust
use colony::screen;

#[colony::main(name = "screen-report")]
fn main() {
    let mut last = String::new();

    colony::frame::on_calc(move || {
        let current = screen::current_name();
        if current == last {
            return;                 // one POST per change, never per frame
        }
        last = current.clone();

        colony::net::post(
            "http://127.0.0.1:47600/screen",
            &format!(r#"{{"screen":"{current}"}}"#),
        );
    });
}
```

Two things matter more than the exact API:

**Post on change, not per frame.** At 60 Hz a per-frame POST is 60 round trips a
second through the emulator's network stack for information that changes every few
seconds.

**Never block the frame callback.** The callback runs on the game's own thread. A
synchronous request to a listener that is not there stalls the game for the connect
timeout, which reads as the mod hanging the game. Fire and forget, or queue it for
another thread.

The emulator has to allow the guest to reach host loopback. On Ryujinx and Astris
this is the normal case for LAN-enabled titles; if it is not, run the POST from the
loader rather than from guest code.

## When the screen name is not the layout name

Usually it is not. `ScreenDialog` is a class, `Dialog.bflyt` is a file, and the two
agree only by convention. That is why the report is fed into the **index search**
rather than resolved directly: searching for `Dialog` across every pane, part and
layout name in the dump finds the file even when the naming does not line up, and
shows you the near misses when it does not.
