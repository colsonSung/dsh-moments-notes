# Layout on the Moments canvas

## What the canvas computes for you

A container (`frame`, `group`, `component`) with `layout: "row"` or
`"column"` places its members itself:

- `gap` — space between members.
- `padding` — space between the container edge and its members.
- `align` — `start`, `center`, `end` or `stretch` on the cross axis.

Members of a flowing container do not need `x`/`y`. Give them a width (or let
them stretch) and let the container stack them.

```json
[
  { "op": "insert", "node": {
    "id": "page", "type": "frame", "x": 0, "y": 0, "w": 1440, "h": 900,
    "fill": "#f7f8fa", "layout": "column", "gap": 32, "padding": 48, "align": "start"
  }},
  { "op": "insert", "parentId": "page", "node": {
    "id": "header", "type": "frame", "w": 1344, "h": 64,
    "fill": "#ffffff", "radius": 12, "layout": "row", "gap": 16, "padding": 16, "align": "center"
  }},
  { "op": "insert", "parentId": "header", "node": {
    "id": "title", "type": "text", "w": 320, "h": 28, "text": "Accounts",
    "fontSize": 20, "fontWeight": 600, "textColor": "#101418"
  }}
]
```

## Screens that are worth copying

**Dashboard section** — column frame, padding 32, gap 24; a header row with
`align: "center"`; a grid of cards built as one row with `gap: 16` and each card
`align: "stretch"`.

**Form** — column frame, gap 16; each field is a column frame with gap 6: a label
text at 13px `ink-muted`, then the input as a shape with height 40, radius 8 and
`align: "stretch"`.

**Card grid** — outer column for rows, inner row for cards, cards `w` fixed and
`align: "stretch"` so a taller card does not break the rhythm.

**Mobile screen** — 390×844 frame, column, padding 20, gap 16; the primary action
pinned to the bottom as an absolutely-positioned child (the one place absolute
coordinates are right), sized to the frame width minus the padding.

## Geometry the canvas enforces

| Limit | Value | What happens |
| --- | --- | --- |
| Node size | 16 … 8000 per axis (containers up to 100000) | Rejected with `INVALID_CANVAS` |
| Gap / padding | 0 … 400 | Rounded to integers |
| Ops per batch | 200 | Rejected above the cap; split the work |
| Coordinates | −1,000,000 … 1,000,000 | Rejected outside the range |

## Text sizing

A text node holds one block of copy. Its box is a constraint, not a suggestion:
text that does not fit is a defect, and `design_inspect { view: "issues" }`
reports it as `text-overflow`.

- Let a text node grow with its content: set `h` from lines × fontSize ×
  lineHeight, plus the box padding.
- Inside a card, a title of one line at 18px needs about 24px of height; a body
  paragraph at 14px needs about 20px per line.
- Prefer two nodes (title + body) over one node with a paragraph break when the
  two parts have different weights or colours.

## Naming

Name what the thing is for, not what it looks like: `Sidebar`, `Row · invoices`,
`Button · primary`, `Empty state`. A board is a document other people read.
