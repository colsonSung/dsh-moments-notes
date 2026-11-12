# Changelog

## 3.7.1 — 2026-11-12

- The folded sidebar opens from the logo alone. The logo already was the way
  back in, and a chevron beside it said the same thing twice: the rail showed
  an arrow where the logo was enough, and the arrow took the room the icon
  rail needed. The logo stands on its own now, and pressing it opens the
  sidebar as before.

## 3.7.0 — 2026-11-11

The board that was dragged around kept losing its contents, and the frame that
was resized kept ending up somewhere else. Both had the same cause, and it was
in the document rather than in the gesture.

- A container whose members no longer sit inside it gets them back. The import
  of a nested frame flattens it into a sibling container, and a resize that
  re-places members by their pins can then throw those members thousands of
  units away: the frame's own box and its children's boxes describe two
  different places. On the board in the report, one frame held 13 members 63,000
  units to the left of its own edge. The container's box is the part the person
  still recognises, so the members move back into it and keep the arrangement
  they had with each other. A member that pokes out of the edge by a little is
  left alone — that is an ordinary loose child, not a lost one.
- Resizing such a container carries its members along with it instead of
  re-placing them by pins that no longer describe anything. The box follows the
  pointer and the contents follow the box.
- The build version sits on the canvas bar, not only in the menu, so a
  screenshot answers "is the fix I made actually running?" without opening
  anything.

The drag was run against the board in the report: pulling the north-west corner
100 pixels to the left moved the frame from x=26993 to x=26716, grew it from
2639 to 2916 units, moved its 13 members by the same 277 units, and left every
one of them inside the frame.

## 3.6.1 — 2026-11-11

- Resize handles stop fighting each other on small selections. Four 8px handles
  with a fixed 9px hit halo overlap on a box that is 25×11 screen pixels at 37%
  zoom, so the last one in the DOM received every press: dragging a corner could
  grow the box from a different corner than the one aimed at. The halo now
  shrinks with the selection, and when halos do overlap the press resolves to the
  corner nearest the pointer.
- The board menu shows the build version, and a contract test keeps it equal to
  the package version: "did I get the fix?" was answerable only from a terminal.

## 3.6.0 — 2026-11-11

Resizing a node follows the pointer and stays where it was dropped. Three
separate causes were stacked on top of each other, which is why earlier fixes
kept looking like they had not worked:

- The box of every frame and component was re-measured from its members on each
  update, so a resize snapped back the moment anything else changed. Containers
  now carry `autoSize`: frames and components keep the size they were given,
  groups keep following their members (and resizing a group scales them).
- A resize wrote the document without asking for a save, so a correct box
  reverted on the next load — the picture on screen and the file disagreed.
- The drag is measured in screen pixels and divided by the camera zoom, so the
  corner lands under the pointer at 55% as well as at 100%.

Each of the three now has a regression test, and the whole path was dragged in
the real app at 55% zoom: 600×400 → 782×509 board units for a 100×60 pixel drag,
with the same numbers in the saved document.

## 3.5.2 — 2026-11-11

- The inspector collapses from its own header, not only from the toolbar: a
  chevron at the panel's top edge closes it, and a small "Inspector" tab stays in
  its place so reopening is one click where the panel used to be. The choice is
  remembered across reloads.

## 3.5.1 — 2026-11-11

- The issue report measures a label against what is painted under it, not against
  the page behind it: a white button label was reported as 1.05:1 against the
  page, when the button under it gives 21:1.
- Layer names dropped into boxes too small to hold them ("Rectangle 555" in a
  16×16 box) are no longer carried in as copy on import, and are skipped by the
  report when a board already has them — a placeholder is not a sentence.

## 3.5.0 — 2026-11-11

The agent can now look at its own work, and a Figma import stops being a
one-time announcement.

- `design_inspect` gained a `view`: `issues` reports what a reviewer would say
  about the board (text past its box, peers on top of each other, a member
  outside its frame, ink below 4.5:1), `image` asks the open page for a PNG and
  returns its path, `import` returns the latest Figma import report.
- The snapshot responder runs with the plugin, not with the Design panel: it
  reads the saved board and draws it with the export renderer, so an agent can
  see a board while the person is in the conversation view. The raster is capped
  at 2048px; a region can be asked for when detail matters.
- Figma imports keep their report: node counts, per-kind imports, skipped
  components/slices/unknowns with up to 20 sample names each, thumbnail warnings
  and the source file, stored in `import-reports.json` and readable from
  `⋯ → Last import report`.
- A bundled skill (`skills/moments-design/`) teaches the model how to draw
  something editable — stacks before coordinates, tokens before literals,
  components before copies — and to check `issues` and the picture before saying
  a design is done.
- The SVG/PNG renderer now draws what the canvas draws: authored type size,
  weight and line height with wrapping, imported pictures embedded as data URLs,
  shadows, gradients and vector paths. Text used to be fixed at 13px and
  pictures were missing from every export.

## 3.4.3 — 2026-11-10

- Connectors keep their own ink. The edge stylesheet set both `stroke` and
  `stroke-width`, and a CSS declaration beats an SVG presentation attribute, so
  every line was painted in one theme grey at 1.5px no matter what colour and
  weight it carried — at 37% zoom on a white frame that read as a floating
  arrowhead with no line.

## 3.4.2 — 2026-11-10

- A dark theme gets a dark overlay. The host's overlay token is a mid grey in the
  dark theme, which turned the AI field, the files menu and every hint into grey
  chips on a black board.

## 3.4.1 — 2026-11-10

- Ink follows the fill, not the theme: a white frame imported from FigJam keeps
  dark text in the dark theme instead of white-on-white.

## 3.4.0 — 2026-11-10

- The vector tool has a readable icon and a caption bar that says what each tool
  does; point editing is its own mode, so selecting a path no longer lets a
  small drag deform it.

## 3.3.1 — 2026-11-10

- The AI request field folds into a bottom-left button instead of overlapping the
  connector style panel.

## 3.3.0 — 2026-11-10

- First release: notes, daily review, and the Design canvas with Figma import,
  export, tokens, components, connectors, comments and version history.
