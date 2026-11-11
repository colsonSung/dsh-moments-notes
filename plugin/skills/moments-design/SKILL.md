---
name: moments-design
description: Design on the Moments canvas through the design_* tools — build screens with stacks, tokens and components instead of absolute boxes, read the board back with design_inspect (issues and image) before calling a design done, and read a Figma import report before editing an imported board.
---

# Moments design

A board is not a picture, it is a structure someone will edit tomorrow. The
tools let you write any box anywhere; this guide is about writing boxes that
survive the next edit, and about checking your own work instead of asserting it.

## The loop

1. `design_begin` — one board, one screen frame. Pick the frame size for the
   thing being designed (1440×900 desktop, 390×844 phone, 1280×800 dashboard).
2. `design_tokens` — colours, gradients and type styles first, if the board has
   more than a handful of nodes. A design built from tokens stays consistent
   when one value changes.
3. `design_nodes` — the screen, in one transaction per region. Whole batches
   commit or fail together.
4. `design_inspect` with `view: "issues"` — read what breaks a rule.
5. `design_inspect` with `view: "image"` — look at the drawing, when the Design
   panel is open. Fix what the picture shows and the checks did not catch.
6. `design_finish` — only after the two checks above, never before.

If a write fails, the board is unchanged: fix the batch and send it again.
Never re-send a successful batch to "make sure".

## Structure: stacks before coordinates

Children of a flowing container are placed by the container. Do not compute
x/y for them — declare the flow and let the layout do the arithmetic:

```json
{ "op": "insert", "node": {
  "type": "frame", "x": 120, "y": 120, "w": 420, "h": 320,
  "fill": "#ffffff", "radius": 16, "layout": "column",
  "gap": 12, "padding": 24, "align": "stretch"
}}
```

Rules that keep a screen editable:

- A vertical stack for page sections, a horizontal one for rows of peers; nesting
  deeper than four levels means the structure is wrong, not the nesting.
- `align: "stretch"` is what makes a card's inner content respect its padding;
  `align: "start"` is for chips and avatars that must not stretch.
- Absolute coordinates are for free placement on a canvas and for overlays
  (badges, floating buttons). They are not a substitute for a stack.
- Give every container a name (`title`) that says what it holds: `Pricing card`,
  `Row · plan features`. An unnamed frame is a box nobody can find again.
- Text inside a box: size the box to the text, not the reverse. If the copy
  changes, the box should grow.

## Tokens before literals

When a colour or a type size appears more than twice, it belongs in
`design_tokens`, and nodes name the token (`fillToken`, `textColorToken`,
`typeToken`) instead of repeating `#635bff`. Rules of thumb:

- One surface scale (`surface-1`, `surface-2`), one ink scale (`ink`, `ink-muted`),
  one accent, plus semantic status colours. Not ten unnamed greys.
- Type scale of four to six steps, defined once; body text at 14–16px, nothing
  under 12px, labels at 12–13px.
- Contrast: body text needs 4.5:1 against its surface, large text 3:1. The
  `issues` view checks this for you.

## Components before copies

A repeated element (button, card, list row, nav item) is a component with
instances: build it once, place instances, override text and icons. Copying a
finished box five times is how a board becomes unmaintainable in a week.

- Variants for states (default / hover / disabled) belong as separate components
  named by state, not as recoloured copies scattered on the canvas.
- Instances carry overrides; the master carries the geometry.

## Reading an imported board

A Figma import is faithful to what it could read and silent about the rest.
Before editing an imported board, ask `design_inspect` with `view: "import"`:
it returns how many nodes the file had, how many landed, what was skipped
(components, slices, unsupported nodes) and what is only a thumbnail. Then:

- Do not "fix" a blank area until you know whether it was blank in the source.
- Ported text may overflow because the source font is not available here; the
  `issues` view names those nodes, and growing the box is usually the fix.
- Imported shapes keep absolute positions. Converting a whole imported flowchart
  to stacks is a rewrite; only re-structure the region being worked on.

## Verify before saying done

Two checks, both cheap, both required:

| Check | Command | What it answers |
| --- | --- | --- |
| Rules | `design_inspect { view: "issues" }` | Does text fit, do peers overlap, does anything hang outside its frame, is the ink readable |
| Picture | `design_inspect { view: "image", region?, scale? }` | Does it actually look like the thing |

`view: "image"` needs the Design panel open on that board; if nothing answers,
say so and fall back to the rules view rather than claiming a visual check. The
returned path can be opened with the image reader.

What these cannot tell you: whether the design is good, whether the spacing feels
right, whether the hierarchy reads. Say what you checked and what you did not.

## Handoff

`design_export` writes the deliverable from the saved board:

- `spec` — colours, type scale, radii, shadows, flow containers (design tokens
  for a developer).
- `html` — a page built from the board, matching how it renders.
- `svg` — the vector scene.

Export after the board is finished; export files describe the board, they do not
check it.

## References

- `references/layout.md` — stack recipes for common screens and the geometry rules
  the canvas enforces.
- `references/tokens.md` — building the token set and the type scale.
- `references/verification.md` — reading issue codes and deciding what to fix.
