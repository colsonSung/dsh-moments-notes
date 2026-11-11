# Verifying a design

Two checks, different questions. Both are cheap. Neither replaces a person's
judgement.

## 1. Rules — `design_inspect { view: "issues" }`

Returns `issues` (bounded to 40) and `checks` (counts). Each issue carries
`code`, `severity`, `nodeId`, a sentence, and for some codes a `relatedNodeId`,
`detail` and `suggestion`.

| Code | Severity | Meaning | Usual fix |
| --- | --- | --- | --- |
| `text-overflow` | error | The box is too short for the copy inside it | Grow `h`, shorten the text, or split the node |
| `overlap` | warning | Two peers cover each other by more than 25% of the smaller one | Move one, or make the overlap a container relationship |
| `outside-frame` | warning | A member extends past the frame that owns it | Move it inside, or drop the membership |
| `low-contrast` | warning | Ink against its surface is below 4.5:1 (3:1 for large text) | Darken the ink or lighten the surface |
| `empty-board` | info | Nothing on the board | Create a screen frame |

Reading a report:

- `text-overflow` is the one that silently ships. A card whose body copy is
  clipped looks fine in geometry and broken on screen.
- `overlap` between a label and its card is not reported (containment is
  intentional); between two cards it is.
- `outside-frame` on an imported board usually means the source used a clip the
  import could not reproduce, not that someone misplaced a box.

Severity is advice about order, not about permission: fix errors first, then
warnings that a person would notice.

## 2. Picture — `design_inspect { view: "image" }`

The Host cannot draw a board (no fonts, no rasteriser). The open Design panel
can, so the tool asks it and writes the PNG to
`<profile>/moments-notes/snapshots/`, returning its path, size and the rules
report alongside.

- It needs the Design panel open on that board. If nothing answers within the
  wait, the result says `reason: "no-canvas"` — report that honestly instead of
  claiming a visual check.
- `region: {x,y,w,h}` renders one area at `scale` up to 3, which is how you look
  at a single card without shrinking a 46000px board into mush.
- Look at the returned file before changing anything else. The checks cannot see
  rhythm, alignment, or the fact that two perfectly-sized boxes look wrong
  together.

## What neither check can tell you

Whether the design is good. Whether the hierarchy reads at a glance. Whether the
spacing feels right. Whether the copy is any good.

So when reporting back: say which checks ran, what they found, and that a person
still has to look. "The checks pass" is not "the design is done".

## After a failed write

`design_nodes` is one transaction: a rejected batch leaves the board exactly as
it was. Read the error, fix it, send the batch again. Do not re-send a batch that
already succeeded "to be safe" — that duplicates nodes, and the duplicate is
invisible until someone counts them.

If a batch is too large, it is rejected before anything is written; split by
region rather than by trial.
