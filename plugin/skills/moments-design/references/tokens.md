# Tokens and type

## Why tokens

A board built from literal hex values cannot be restyled. One call to
`design_tokens` changes every node that names the token, which is the difference
between "change the brand colour" and "change it in forty places and miss three".

## A token set that covers a product screen

```json
{
  "boardId": "<id>",
  "colors": {
    "surface-1": "#ffffff",
    "surface-2": "#f3f4f6",
    "surface-3": "#e8eaed",
    "ink": "#101418",
    "ink-muted": "#5b6169",
    "ink-faint": "#8b9199",
    "line": "#e2e5e9",
    "accent": "#635bff",
    "accent-ink": "#ffffff",
    "success": "#12805c",
    "warning": "#a35a00",
    "danger": "#b42318"
  },
  "type": {
    "display": { "fontFamily": "display", "fontSize": 40, "fontWeight": 700, "lineHeight": 1.15, "letterSpacing": -0.5 },
    "title": { "fontFamily": "sans", "fontSize": 24, "fontWeight": 600, "lineHeight": 1.25 },
    "body": { "fontFamily": "sans", "fontSize": 15, "fontWeight": 400, "lineHeight": 1.5 },
    "label": { "fontFamily": "sans", "fontSize": 13, "fontWeight": 500, "lineHeight": 1.35 },
    "caption": { "fontFamily": "sans", "fontSize": 12, "fontWeight": 400, "lineHeight": 1.4 }
  }
}
```

Rules:

- One surface scale, one ink scale. Three surfaces is almost always enough for a
  screen; a fourth means the elevation story is unclear.
- Semantic names, not appearance names: `danger`, not `red`; `ink-muted`, not
  `grey-600`. Appearance changes; meaning does not.
- Semantic status colours are not decoration: success never means "big number",
  danger never means "brand accent".
- Merge, do not replace: `mode: "replace"` wipes token tables nothing else
  restores.

## Binding a node to a token

Nodes take `fillToken`, `strokeToken`, `textColorToken`, `gradientToken`,
`shadowColorToken` and `typeToken`. A token reference overrides the matching
literal on the next save, so a node with both should be read as "token wins".

```json
{ "op": "insert", "node": {
  "type": "shape", "shape": "rect", "x": 48, "y": 240, "w": 320, "h": 120,
  "radius": 14, "fillToken": "surface-1", "strokeToken": "line", "strokeWidth": 1,
  "shadow": { "x": 0, "y": 1, "blur": 2, "color": "#10141814" }
}}
```

## Type scale

- Four to six steps. A screen with eight sizes has no scale, only accidents.
- Body at 14–16px; UI labels at 12–13px; nothing below 12px.
- Line height 1.4–1.6 for reading text, 1.2–1.3 for headings.
- Weight does the hierarchy work before size does: 600 on a 15px label reads as
  a title more cleanly than 24px of regular.
- Letter spacing goes negative only above 24px, and by a fraction of a pixel.

## Contrast

Body text needs 4.5:1 against its surface, large text (≥ 18.66px, or bold ≥ 14px)
needs 3:1. Muted ink on a light surface is the usual failure: `#9aa0a6` on
`#ffffff` is 2.64:1 and unreadable, while `#6b7280` is 4.8:1 and fine.

`design_inspect { view: "issues" }` reports `low-contrast` with the measured
ratio and both colours, so this is checked rather than estimated.

## Dark mode

If both themes matter, build them as two token sets in the same board rather than
two boards: a dark board that is a copy drifts from the light one within a week.
Name the surfaces by role, then give the dark set the dark values.
