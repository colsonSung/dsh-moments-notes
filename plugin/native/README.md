# The Moments desktop float

`moments-float` is a small AppKit/SwiftUI application that the Host starts as a
child process. It opens a window that stays above ordinary windows on every
Space, so a thought can be captured while another application is in front.

The window has two shapes: a compact capture card, and an expanded panel that
lists the whole history and searches through it. The expand and collapse button
sits in the header next to the close button.

The same idea a sibling live-transcript plugin uses: a native helper owns the
window, and the Host talks to it over JSONL.

## Build

Requirements: macOS 13 or later and a Swift compiler.

```sh
native/build.sh
```

The script locates the compiler and the macOS SDK itself, so it also works
before the Xcode license has been accepted (where `xcrun` refuses to run).

Output: `native/bin/moments-float`.

The helper carries its own self-test, which parses every event shape without
opening a window:

```sh
native/bin/moments-float --self-test
```

## Dragging and images

The header drags the window from AppKit's own event stream: the drag surface is
a transparent `NSViewRepresentable` sitting **behind** the header content, so the
shape and close buttons and the expanded search field keep every click. A
SwiftUI `DragGesture` used to steer the frame instead; it delivered `onChanged`
in bursts, so the card trailed the pointer and stopped a few points away from
where the pointer was released. The AppKit events arrive one for one, so the
frame moves by exactly the pointer's travel.

A screenshot can reach a note by three routes, and all three normalise to PNG:

- **Choose image…** in the composer's image menu opens `NSOpenPanel` (images
  only, multiple selection allowed).
- **Paste image**, `⌘V`, or **Edit ▸ Paste** read the clipboard, whether it
  holds image bytes or a file copied in the Finder. The helper installs a small
  menu bar for this: a borderless accessory window has no Edit menu, and `⌘V` is
  a menu item, not a text-view shortcut — without the menu a pasted screenshot
  never reached the editor.
- Dropping an image file (or image data) on the card attaches it.

Attachments keep the source file's name; the same limits as the web panel apply
(8 per note, 5 MB each, 10 MB total) and a rejected image says why above the
tool row.

## Drafts

Closing the window must not cost a thought. While the person types, the window
waits three seconds after the last change and writes a `draft` command; closing
the window — the ✕, a `control` `close`, SIGTERM, stdin EOF — flushes the draft
first, so even a keystroke followed by an immediate close survives. The Host
stores it as `draft.json` beside `notes.json` and hands it back through a
`draft` event when the window opens again: the text, the attachments (with
their bytes), and whether the draft was editing a note. A saved, cancelled or
emptied draft clears the stored file.

## Protocol

The Host writes one JSON event per line to stdin. The window writes one JSON
command per line to stdout. Unknown event types are ignored, and malformed JSONL
is reported in the window instead of ending the process.

### Host to window

| Event | Meaning |
|---|---|
| `{"type":"notes","notes":[…],"total":N}` | Answer a query: the matching notes and their count. |
| `{"type":"draft","draft":{"content":"…","editingId":"…","attachments":[…]}}` | Restore the unfinished thought from the last closed window. |
| `{"type":"note","note":{…}}` | Load one full note, with image bytes, for editing. |
| `{"type":"status","detail":"…"}` | Set the status line. |
| `{"type":"error","detail":"…"}` | Show a failure. |
| `{"type":"saved","detail":"…"}` | The last write succeeded; the editor clears. |
| `{"type":"control","detail":"close"}` | Close the window and exit. |

### Window to Host

| Command | Meaning |
|---|---|
| `{"type":"ready"}` | The window is open; ask for the first list and the draft. |
| `{"type":"draft","draft":{"content":"…","editingId":"…","attachments":[…]}}` | Keep this draft for the next window; an empty one clears it. |
| `{"type":"query","query":"…"}` | Ask for the notes matching a search; an empty query asks for all. |
| `{"type":"load","id":"…"}` | Send one full note. |
| `{"type":"create","content":"…","attachments":[…]}` | Create a note. |
| `{"type":"update","id":"…","content":"…","attachments":[…]}` | Update a note. |
| `{"type":"trash","id":"…"}` | Move a note to the trash. |
| `{"type":"pin","id":"…","pinned":true}` | Pin or unpin a note. |

Attachments carry `id`, `name`, `type`, `size` and a base64 `dataUrl`, exactly
like the attachments the web panel sends.

Closing the window, stdin EOF, SIGINT or SIGTERM ends the process, so a closed
window never leaves an orphan behind.
