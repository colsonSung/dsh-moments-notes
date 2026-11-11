/**
 * What is wrong with a board, in the terms a person would say it.
 *
 * An agent that draws on the canvas can read the document back, but a document
 * is geometry: it says a text node is 320×48, not that the sentence inside it
 * needs two lines and is therefore clipped. These checks turn the document into
 * the sentences a reviewer would write — text runs past its box, two cards sit
 * on top of each other, a label is dark-on-dark — so "look at it" becomes
 * something the agent can do without a screenshot.
 *
 * Every finding is evidence, not a verdict: this module never decides that a
 * design is good, only that a specific box breaks a specific rule.
 */

const TEXT_LINE_FACTOR = 0.58; // average glyph width as a fraction of the font size
const OVERLAP_MIN_RATIO = 0.25; // two boxes overlap "on purpose" below this
const CONTAINER_TYPES = new Set(['frame', 'group', 'component']);
const TEXT_MIN_CONTRAST = 4.5;
const LARGE_TEXT_SIZE = 18.66; // WCAG large text
const LARGE_TEXT_MIN_CONTRAST = 3;
const MAX_ISSUES = 40;
const PLACEHOLDER_NAME = /^(?:Rectangle|Frame|Ellipse|Group|Vector|Line|Star|Polygon|Image|Slice|Text)(?: \d+)?$/i;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** '#rrggbb' (or '#rgb') as {r,g,b} in 0..255, or null. */
export function parseHex(value) {
  if (typeof value !== 'string') return null;
  const hex = value.trim().replace(/^#/, '');
  const full = hex.length === 3 ? hex.split('').map((part) => part + part).join('') : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

/** Relative luminance, the weighting WCAG uses. */
export function luminance(color) {
  const parsed = typeof color === 'string' ? parseHex(color) : color;
  if (!parsed) return null;
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(parsed.r) + 0.7152 * channel(parsed.g) + 0.0722 * channel(parsed.b);
}

/** WCAG contrast ratio between two hex colours, or null when either is unknown. */
export function contrastRatio(foreground, background) {
  const first = luminance(foreground);
  const second = luminance(background);
  if (first === null || second === null) return null;
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100;
}

/** The ink a fill can carry, mirroring the canvas renderer's rule. */
export function inkOnFill(fill) {
  const level = luminance(fill);
  if (level === null) return null;
  return level > 0.45 ? '#101418' : '#f4f6f8';
}

function bounds(node) {
  return { x: Number(node.x) || 0, y: Number(node.y) || 0, w: Number(node.w) || 0, h: Number(node.h) || 0 };
}

function overlapArea(left, right) {
  const x = Math.max(0, Math.min(left.x + left.w, right.x + right.w) - Math.max(left.x, right.x));
  const y = Math.max(0, Math.min(left.y + left.h, right.y + right.h) - Math.max(left.y, right.y));
  return x * y;
}

function contains(outer, inner) {
  const margin = 2;
  return inner.x + margin >= outer.x
    && inner.y + margin >= outer.y
    && inner.x + inner.w - margin <= outer.x + outer.w
    && inner.y + inner.h - margin <= outer.y + outer.h;
}

/**
 * The surface each node is drawn on: its own fill, or the nearest filled
 * container above it (by membership first, then by covering box).
 */
export function fillBehind(nodes) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const parent = new Map();
  for (const node of nodes) {
    if (!CONTAINER_TYPES.has(node.type)) continue;
    for (const member of node.members || []) parent.set(member, node.id);
  }
  // Anything painted can be the surface a label sits on, not only containers:
  // a button is a shape, and its white label must be measured against the
  // button, never against the page behind it.
  const covering = nodes
    .filter((node) => typeof node.fill === 'string' && node.type !== 'text' && node.type !== 'image')
    .sort((left, right) => bounds(left).w * bounds(left).h - bounds(right).w * bounds(right).h);
  const resolved = new Map();
  for (const node of nodes) {
    let fill = typeof node.fill === 'string' ? node.fill : null;
    // What a label is drawn on is decided by what is painted under it, not by
    // membership alone: a button label belongs to the page, but its colour has
    // to be measured against the button. Smallest painted cover wins, because
    // that is the surface nearest the text.
    if (!fill) {
      const box = bounds(node);
      const centerX = box.x + box.w / 2;
      const centerY = box.y + box.h / 2;
      const host = covering.find((painted) => painted.id !== node.id && (() => {
        const area = bounds(painted);
        return centerX >= area.x && centerX <= area.x + area.w && centerY >= area.y && centerY <= area.y + area.h;
      })());
      fill = host ? host.fill : null;
    }
    // A label with nothing painted under its centre still sits on its container.
    let cursor = byId.get(parent.get(node.id));
    const seen = new Set([node.id]);
    while (!fill && cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      fill = typeof cursor.fill === 'string' ? cursor.fill : null;
      cursor = byId.get(parent.get(cursor.id));
    }
    resolved.set(node.id, fill);
  }
  return resolved;
}

/** How many lines the text needs inside the given width. */
export function textLines(node) {
  const text = typeof node.text === 'string' ? node.text : '';
  if (!text.trim()) return 0;
  const size = Number(node.fontSize) > 0 ? Number(node.fontSize) : 14;
  const perLine = Math.max(4, Math.floor((Number(node.w) || 0) / (size * TEXT_LINE_FACTOR)));
  return text
    .split('\n')
    .map((line) => Math.max(1, Math.ceil(line.length / perLine)))
    .reduce((total, value) => total + value, 0);
}

function textPadding(node) {
  if (node.type === 'sticky') return 16;
  if (node.type === 'text') return 0;
  if (node.type === 'shape') return 8;
  return 12;
}

/**
 * Analyse one board.
 *
 * @param {{nodes?: object[], edges?: object[]}} canvas the stored document
 * @returns {{issues: object[], summary: {nodes: number, issues: number, byCode: object}}}
 */
export function analyzeDesign(canvas) {
  const nodes = Array.isArray(canvas?.nodes) ? canvas.nodes : [];
  const edges = Array.isArray(canvas?.edges) ? canvas.edges : [];
  const issues = [];
  const add = (issue) => {
    if (issues.length >= MAX_ISSUES) return;
    issues.push(issue);
  };
  const behind = fillBehind(nodes);
  const byId = new Map(nodes.map((node) => [node.id, node]));

  // 1. Text that does not fit its box.
  for (const node of nodes) {
    if (node.visible === false || node.type === 'image') continue;
    const text = typeof node.text === 'string' ? node.text : '';
    if (!text.trim()) continue;
    if (node.type === 'text') continue; // a text box grows; it never clips
    // A layer name carried into a tiny box ("Rectangle 555") is a placeholder,
    // not a sentence someone wrote; reporting it as clipped copy teaches the
    // reader to ignore the report.
    if (PLACEHOLDER_NAME.test(text.trim())) continue;
    const lines = textLines(node);
    const size = Number(node.fontSize) > 0 ? Number(node.fontSize) : 14;
    const lineHeight = Number(node.lineHeight) > 0 ? Number(node.lineHeight) : 1.25;
    const needed = lines * size * lineHeight + textPadding(node) * 2;
    const have = Number(node.h) || 0;
    if (needed > have + size * 0.5) {
      add({
        code: 'text-overflow',
        severity: 'error',
        nodeId: node.id,
        message: `Text needs about ${Math.round(needed)}px of height but its box is ${Math.round(have)}px`,
        detail: { text: text.slice(0, 80), lines, needed: Math.round(needed), height: Math.round(have) },
        suggestion: 'Grow the box height, shorten the text, or split it into two nodes',
      });
    }
  }

  // 2. Two leaves sitting on top of each other.
  const leaves = nodes.filter((node) => (
    node.visible !== false && !CONTAINER_TYPES.has(node.type) && node.type !== 'instance' && node.type !== 'image'
  ));
  for (let i = 0; i < leaves.length && issues.length < MAX_ISSUES; i += 1) {
    for (let j = i + 1; j < leaves.length && issues.length < MAX_ISSUES; j += 1) {
      const left = leaves[i];
      const right = leaves[j];
      const leftBox = bounds(left);
      const rightBox = bounds(right);
      const area = overlapArea(leftBox, rightBox);
      if (area <= 0) continue;
      const smaller = Math.min(leftBox.w * leftBox.h, rightBox.w * rightBox.h) || 1;
      const ratio = area / smaller;
      if (ratio < OVERLAP_MIN_RATIO) continue;
      // A label sitting inside its card is intentional; only peers collide.
      if (contains(leftBox, rightBox) || contains(rightBox, leftBox)) continue;
      add({
        code: 'overlap',
        severity: 'warning',
        nodeId: left.id,
        relatedNodeId: right.id,
        message: `${describe(left)} and ${describe(right)} overlap by ${Math.round(ratio * 100)}%`,
        detail: { ratio: Math.round(ratio * 100) / 100 },
        suggestion: 'Move one of them, or make the overlap deliberate with a container',
      });
    }
  }

  // 3. A node that hangs outside the frame that owns it.
  for (const node of nodes) {
    if (node.visible === false || CONTAINER_TYPES.has(node.type)) continue;
    const parentId = [...byId.values()]
      .filter((item) => CONTAINER_TYPES.has(item.type))
      .sort((a, b) => bounds(a).w * bounds(a).h - bounds(b).w * bounds(b).h)
      .find((item) => (item.members || []).includes(node.id))?.id;
    if (!parentId) continue;
    const parent = byId.get(parentId);
    if (!parent) continue;
    if (contains(bounds(parent), bounds(node))) continue;
    add({
      code: 'outside-frame',
      severity: 'warning',
      nodeId: node.id,
      relatedNodeId: parent.id,
      message: `${describe(node)} extends past the edge of ${describe(parent)}`,
      suggestion: 'Move it back inside, or drop the membership and let it float',
    });
  }

  // 4. Ink that cannot be read on the surface it sits on.
  for (const node of nodes) {
    if (node.visible === false) continue;
    const text = typeof node.text === 'string' ? node.text : '';
    if (!text.trim()) continue;
    const surface = behind.get(node.id) || null;
    if (!surface) continue;
    const ink = typeof node.textColor === 'string' ? node.textColor : inkOnFill(surface);
    if (!ink) continue;
    const ratio = contrastRatio(ink, surface);
    if (ratio === null) continue;
    const size = Number(node.fontSize) > 0 ? Number(node.fontSize) : 14;
    const floor = size >= LARGE_TEXT_SIZE ? LARGE_TEXT_MIN_CONTRAST : TEXT_MIN_CONTRAST;
    if (ratio >= floor) continue;
    add({
      code: 'low-contrast',
      severity: 'warning',
      nodeId: node.id,
      message: `Text contrast is ${ratio}:1 against its surface (needs ${floor}:1)`,
      detail: { ink, surface, ratio, floor },
      suggestion: 'Darken the ink or lighten the surface',
    });
  }

  // 5. A board that has nothing to look at.
  if (nodes.length === 0) {
    add({
      code: 'empty-board',
      severity: 'info',
      message: 'The board is empty',
      suggestion: 'Create a screen frame first',
    });
  }

  const byCode = {};
  for (const issue of issues) byCode[issue.code] = (byCode[issue.code] || 0) + 1;
  return {
    issues,
    summary: { nodes: nodes.length, edges: edges.length, issues: issues.length, byCode },
  };
}

/** A node as a sentence fragment: what it is and the first words it holds. */
function describe(node) {
  const label = String(node.title || node.text || '').trim().replace(/\s+/g, ' ').slice(0, 32);
  const kind = node.type === 'shape' ? (node.shape || 'shape') : node.type;
  const where = `(${Math.round(Number(node.x) || 0)},${Math.round(Number(node.y) || 0)})`;
  return label ? `${kind} "${label}" ${where}` : `${kind} ${node.id.slice(0, 8)} ${where}`;
}

export const DESIGN_ISSUE_LIMITS = Object.freeze({
  MAX_ISSUES,
  OVERLAP_MIN_RATIO,
  TEXT_MIN_CONTRAST,
  LARGE_TEXT_MIN_CONTRAST,
  LARGE_TEXT_SIZE: clamp(LARGE_TEXT_SIZE, 1, 100),
});
