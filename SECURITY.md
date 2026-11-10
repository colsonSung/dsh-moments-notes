# Security policy

## The short version

Moments has no credentials of its own. It does not ask for API keys, it does not
read the Harness credentials, and it does not talk to any third-party server. Its
whole surface is: the files in your own profile, the native helper process it
starts, and the one row it adds to your profile's patch file.

| What | Where it lives | How to change it |
| --- | --- | --- |
| notes | `<profile>/moments-notes/notes.json` | export or delete them in the panel |
| design boards | `<profile>/moments-notes/canvases.json` | delete a board in Design mode |
| attachments | `<profile>/moments-notes/assets/` | remove the image from the note |
| draft | `<profile>/moments-notes/draft.json` | send, cancel, or empty the composer |
| diagnostic log | `<profile>/moments-notes/diagnostics.log` | delete the file; rotated at 1 MB |
| bundle row | `<profile>/cordis.patch.yml` | remove the `moments-notes` entry |

There is no token to rotate, because no token is issued.

## What the plugin can reach

* **The profile directory.** Everything the plugin stores lives under
  `<profile>/moments-notes/`. The store writes are atomic (temporary file plus
  rename) and serialised, so a crash cannot leave a half-written note.
* **The native float.** The always-on-top window is a separate macOS process
  (`native/bin/moments-float`) that the Host starts as a child process and drives
  over one JSON event per line on stdin/stdout. It reads no files and makes no
  network call. Closing the window, ending its input, `SIGINT` or `SIGTERM` ends
  the process, so it never leaves an orphan behind. If the helper was never
  built, the plugin says so and falls back to an in-page float.
* **Imported files.** A `.fig` / `.jam` / `.deck` file you drop on the board is
  parsed **locally** by [`openfig-core`](https://www.npmjs.com/package/openfig-core)
  on the Host. The file is never uploaded anywhere.
* **The agent tools.** The plugin registers `moments_memo` and the six
  `design_*` tools. They write through the same Host store the panel reads,
  so anything an agent can do here is something you could have done by hand.

## Reporting

Open an issue at <https://github.com/colsonSung/dsh-moments-notes/issues>. If the
report is sensitive, say so in the issue without the details and ask for a private
channel.
