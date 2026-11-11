# Changelog

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
