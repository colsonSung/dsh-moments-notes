/**
 * Canvas scene document rules.
 *
 * The Host owns the scene graph: the Client edits optimistically and the
 * Host decides what is stored. Every rule below comes from
 * `docs/canvas-design.md` and its increment `docs/canvas-v2-design.md`.
 * Structural damage (an illegal type, a duplicate id, a dangling edge, a
 * value outside its range) rejects the whole document; only oversized
 * *content* is trimmed, because a silently dropped node is worse than a
 * rejected save.
 */

export const CANVAS_VERSION = 1;

/** The look a connector can wear. */
export const EDGE_VOCABULARY = Object.freeze({
  dashes: Object.freeze(['solid', 'dashed', 'dotted']),
  heads: Object.freeze(['none', 'arrow', 'triangle', 'circle']),
  curves: Object.freeze(['bezier', 'straight', 'elbow']),
  anchors: Object.freeze(['auto', 'top', 'right', 'bottom', 'left']),
  strokeWidth: Object.freeze({ min: 1, max: 8, default: 2 }),
});
export const DEFAULT_CANVAS_TITLE = 'Board';

export const CANVAS_LIMITS = Object.freeze({
  NODE_COUNT_MAX: 500,
  EDGE_COUNT_MAX: 1000,
  ID_MAX_LENGTH: 200,
  NOTE_ID_MAX_LENGTH: 256,
  TITLE_MAX_LENGTH: 120,
  NODE_TEXT_MAX_LENGTH: 4000,
  EDGE_LABEL_MAX_LENGTH: 200,
  NODE_SIZE_MIN: 16,
  NODE_SIZE_MAX: 8000,
  // A container's box is derived from its members, and a real Figma section or
  // a board region can be far wider than one object. Clamping it would either
  // reject a legitimate document or shrink the frame until its own members
  // hang outside it, so containers get their own ceiling.
  CONTAINER_SIZE_MAX: 100000,
  COORDINATE_MIN: -1_000_000,
  COORDINATE_MAX: 1_000_000,
  ZOOM_MIN: 0.05,
  ZOOM_MAX: 8,
  ROTATION_MIN: 0,
  ROTATION_MAX: 360,
  STROKE_WIDTH_MIN: 0,
  STROKE_WIDTH_MAX: 64,
  OPACITY_MIN: 0,
  OPACITY_MAX: 1,
  RADIUS_MIN: 0,
  RADIUS_MAX: 999,
});

const NODE_TYPES = Object.freeze(['note', 'sticky', 'text', 'shape', 'image', 'group', 'frame', 'component', 'instance']);
const ASSET_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTAINER_TYPES = Object.freeze(['group', 'frame', 'component']);
/** The gap a container keeps between its edge and the members inside it. */
const CANVAS_GROUP_PADDING = 12;
/** Nodes an instance expansion produces carry this marker and are rebuilt on every save. */
const INSTANCE_LIMIT = 64;
const NODE_SHAPES = Object.freeze(['rect', 'ellipse', 'line', 'arrow', 'polygon', 'star', 'path']);
const BLEND_MODES = Object.freeze([
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
  'color-dodge', 'color-burn', 'soft-light', 'hard-light', 'difference', 'exclusion',
]);
const BLUR_MAX = 200;
const TEXT_SPAN_MAX = 100;
const GRID_COUNT_MAX = 24;
const GRID_GUTTER_MAX = 200;
const GRID_MARGIN_MAX = 400;
const PATH_POINTS_MIN = 2;
const PATH_POINTS_MAX = 200;
const COMMENT_LIMIT = 500;
const COMMENT_BODY_MAX = 2000;
const SIDES_MIN = 3;
const SIDES_MAX = 24;
const NODE_FONT_MIN = 6;
const NODE_FONT_MAX = 512;
const TEXT_ALIGNS = Object.freeze(['left', 'center', 'right']);
const NODE_COLORS = Object.freeze(['amber', 'rose', 'sage', 'sky', 'none']);
const EDGE_ANCHORS = Object.freeze(['auto', 'top', 'right', 'bottom', 'left']);
/** The dash patterns a connector can wear. */
const EDGE_DASHES = Object.freeze(['solid', 'dashed', 'dotted']);
const EDGE_HEADS = Object.freeze(['none', 'arrow', 'triangle', 'circle']);
const EDGE_CURVES = Object.freeze(['bezier', 'straight', 'elbow']);
const EDGE_STROKE_MIN = 1;
const EDGE_STROKE_MAX = 8;
const EDGE_STROKE_DEFAULT = 2;
const DEFAULT_NODE_WIDTH = 240;
const DEFAULT_NODE_HEIGHT = 160;
const COLOR_LITERAL_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
/** The font families a design node may name; each maps to a CSS stack on the client. */
const FONT_FAMILIES = Object.freeze(['sans', 'serif', 'mono', 'display']);
const FONT_WEIGHT_MIN = 100;
const FONT_WEIGHT_MAX = 900;
const LINE_HEIGHT_MIN = 0.8;
const LINE_HEIGHT_MAX = 3;
const LETTER_SPACING_MIN = -5;
const LETTER_SPACING_MAX = 20;
const SHADOW_OFFSET_MAX = 400;
/** The flow a container can lay its members out in. */
const LAYOUT_MODES = Object.freeze(['none', 'row', 'column']);
const LAYOUT_ALIGNS = Object.freeze(['start', 'center', 'end', 'stretch']);
const LAYOUT_GAP_MAX = 400;
/** How a child holds its place when its container is resized. */
const CONSTRAINT_HORIZONTAL = Object.freeze(['left', 'right', 'center', 'left-right', 'scale']);
const CONSTRAINT_VERTICAL = Object.freeze(['top', 'bottom', 'center', 'top-bottom', 'scale']);
const LAYOUT_PADDING_MAX = 400;
/** The names a design token may carry, so a reference never looks like prose. */
const TOKEN_NAME_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
const TOKEN_LIMIT = 200;
const GRADIENT_ANGLE_MIN = 0;
const GRADIENT_ANGLE_MAX = 360;

function failure(message, code = 'INVALID_CANVAS', options) {
  const error = new Error(message, options);
  error.code = code;
  return error;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function truncate(value, maximum) {
  return value.length > maximum ? value.slice(0, maximum) : value;
}

function finiteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw failure(`${label} must be a finite number`, 'INVALID_CANVAS');
  }
  return value;
}

function timestamp(value, label, fallback = 0) {
  if (value === undefined || value === null) {
    const base = fallback instanceof Date ? fallback.getTime() : fallback;
    if (!Number.isSafeInteger(base) || base < 0) {
      throw failure(`${label} must be a non-negative integer timestamp`, 'INVALID_CANVAS');
    }
    return base;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw failure(`${label} must be a non-negative integer timestamp`, 'INVALID_CANVAS');
  }
  return value;
}

/** Normalize the canvas id used to address one board. */
export function normalizeCanvasId(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw failure('Canvas id must be a non-empty string', 'INVALID_CANVAS_ID');
  }
  return truncate(value.trim(), CANVAS_LIMITS.ID_MAX_LENGTH);
}

/** Normalize a board title: blank falls back to the default, long titles are trimmed. */
export function normalizeCanvasTitle(value) {
  if (value === undefined || value === null) return DEFAULT_CANVAS_TITLE;
  if (typeof value !== 'string') {
    throw failure('Canvas title must be a string', 'INVALID_TITLE');
  }
  const title = value.trim();
  if (!title) return DEFAULT_CANVAS_TITLE;
  return truncate(title, CANVAS_LIMITS.TITLE_MAX_LENGTH);
}

function coordinate(value, label) {
  if (value === undefined || value === null) return 0;
  const number = finiteNumber(value, label);
  // An infinite canvas cannot reject a coordinate for being far out: the
  // range only keeps a value finite and within what JSON round-trips safely.
  // Clamping keeps the save alive instead of dropping the whole document.
  if (!Number.isFinite(number)) {
    throw failure(`${label} must be a finite number`, 'INVALID_CANVAS');
  }
  return Math.max(CANVAS_LIMITS.COORDINATE_MIN, Math.min(CANVAS_LIMITS.COORDINATE_MAX, number));
}

/** The size of one node, with the node named when it is out of range. */
function nodeSizeOf(value, fallback, field, id, maximum = CANVAS_LIMITS.NODE_SIZE_MAX) {
  try {
    if (value === undefined || value === null) return fallback;
    const number = finiteNumber(value, `node.${field}`);
    if (number < CANVAS_LIMITS.NODE_SIZE_MIN || number > maximum) {
      throw failure(
        `node.${field} must be between ${CANVAS_LIMITS.NODE_SIZE_MIN} and ${maximum}`,
        'INVALID_CANVAS',
      );
    }
    return number;
  } catch (error) {
    throw failure(`${error.message} — node ${id} has ${field}=${String(value)}`, 'INVALID_CANVAS');
  }
}

function nodeSize(value, fallback, label) {
  if (value === undefined || value === null) return fallback;
  const number = finiteNumber(value, label);
  if (number < CANVAS_LIMITS.NODE_SIZE_MIN || number > CANVAS_LIMITS.NODE_SIZE_MAX) {
    throw failure(
      `${label} must be between ${CANVAS_LIMITS.NODE_SIZE_MIN} and ${CANVAS_LIMITS.NODE_SIZE_MAX}`,
      'INVALID_CANVAS',
    );
  }
  return number;
}

function nodeRotation(value) {
  if (value === undefined || value === null) return 0;
  const number = finiteNumber(value, 'node rotation');
  if (number < CANVAS_LIMITS.ROTATION_MIN || number >= CANVAS_LIMITS.ROTATION_MAX) {
    throw failure(
      `node rotation must be within [${CANVAS_LIMITS.ROTATION_MIN}, ${CANVAS_LIMITS.ROTATION_MAX})`,
      'INVALID_CANVAS',
    );
  }
  return number;
}

function nodeText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw failure('node text must be a string', 'INVALID_CANVAS');
  }
  return truncate(value, CANVAS_LIMITS.NODE_TEXT_MAX_LENGTH);
}

/**
 * The styled runs inside one text node.
 *
 * The runs own the text: the plain `text` field is always their join, so a
 * board can still be searched and edited as text while the pixels stay styled.
 */
function nodeSpans(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw failure('node spans must be an array', 'INVALID_CANVAS');
  if (!value.length) throw failure('node spans must hold at least one run', 'INVALID_CANVAS');
  if (value.length > TEXT_SPAN_MAX) {
    throw failure(`a text node cannot hold more than ${TEXT_SPAN_MAX} runs`, 'INVALID_CANVAS');
  }
  return value.map((span, index) => {
    if (!isObject(span)) throw failure(`node spans[${index}] must be an object`, 'INVALID_CANVAS');
    if (typeof span.text !== 'string') {
      throw failure(`node spans[${index}].text must be a string`, 'INVALID_CANVAS');
    }
    const run = { text: span.text };
    if (span.fontWeight !== undefined && span.fontWeight !== null) {
      run.fontWeight = Math.round(boundedNumber(span.fontWeight, 400, 100, 900, `node spans[${index}].fontWeight`));
    }
    const ink = nodeTextColor(span.textColor);
    if (ink) run.textColor = ink;
    if (span.italic === true) run.italic = true;
    if (span.underline === true) run.underline = true;
    return run;
  });
}

function nodeBoolean(value, fallback, label) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    throw failure(`${label} must be a boolean`, 'INVALID_CANVAS');
  }
  return value;
}

/**
 * The colour of a node.
 *
 * There is one value for "no colour": an unset colour and an explicit one
 * look the same on the canvas, so keeping both would store a distinction
 * that carries no meaning.
 */
function nodeColor(value) {
  if (value === undefined || value === null) return 'none';
  if (typeof value !== 'string' || !NODE_COLORS.includes(value)) return 'none';
  return value;
}

function nodeNoteId(value, required) {
  const usable = typeof value === 'string' && value.trim();
  if (!usable) {
    if (required) throw failure('note nodes require a noteId', 'INVALID_CANVAS');
    return null;
  }
  return truncate(value.trim(), CANVAS_LIMITS.NOTE_ID_MAX_LENGTH);
}

function nodeNoteUpdatedAt(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw failure('node noteUpdatedAt must be a non-negative integer timestamp', 'INVALID_CANVAS');
  }
  return value;
}

/** The stored picture an `image` node shows. */
function nodeAssetId(value, required) {
  if (value === undefined || value === null) {
    if (required) throw failure('image nodes require an assetId', 'INVALID_CANVAS');
    return null;
  }
  if (typeof value !== 'string' || !ASSET_ID_PATTERN.test(value.trim())) {
    throw failure('node assetId must be a stored asset id', 'INVALID_CANVAS');
  }
  return value.trim().toLowerCase();
}

/** The size of the text of a node, within a range a board can show. */
function nodeFontSize(value) {
  if (value === undefined || value === null) return 14;
  const size = Number(value);
  if (!Number.isFinite(size) || size < NODE_FONT_MIN || size > NODE_FONT_MAX) {
    throw failure(`node fontSize must be between ${NODE_FONT_MIN} and ${NODE_FONT_MAX}`, 'INVALID_CANVAS');
  }
  return Math.round(size * 100) / 100;
}

/** The ink of the text of a node, as a colour literal, or null to follow the theme. */
function nodeTextColor(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value.trim())) {
    throw failure('node textColor must be a #rrggbb literal', 'INVALID_CANVAS');
  }
  return value.trim().toLowerCase();
}

/**
 * One anchor of a vector path, in the node's own box coordinates.
 *
 * Handles are offsets from the anchor: `out` pulls the outgoing segment and
 * `in` the incoming one, which is exactly how a cubic segment is written.
 */
function pathPoint(value, index) {
  if (!isObject(value)) throw failure(`path points[${index}] must be an object`, 'INVALID_PATH');
  const handle = (candidate, label) => {
    if (candidate === undefined || candidate === null) return null;
    if (!isObject(candidate)) throw failure(`${label} must be an object`, 'INVALID_PATH');
    return { x: coordinate(candidate.x, label + '.x'), y: coordinate(candidate.y, label + '.y') };
  };
  return {
    x: coordinate(value.x, 'path point x'),
    y: coordinate(value.y, 'path point y'),
    in: handle(value.in, `path points[${index}].in`),
    out: handle(value.out, `path points[${index}].out`),
  };
}

/** The geometry of a `path` shape. */
function nodePath(value, required) {
  if (value === undefined || value === null) {
    if (required) throw failure('path shapes need a path with at least two points', 'INVALID_PATH');
    return null;
  }
  if (!isObject(value)) throw failure('node path must be an object', 'INVALID_PATH');
  if (!Array.isArray(value.points)) throw failure('node path.points must be an array', 'INVALID_PATH');
  if (value.points.length < PATH_POINTS_MIN) {
    throw failure(`a path needs at least ${PATH_POINTS_MIN} points`, 'INVALID_PATH');
  }
  if (value.points.length > PATH_POINTS_MAX) {
    throw failure(`a path cannot hold more than ${PATH_POINTS_MAX} points`, 'INVALID_PATH');
  }
  return {
    closed: nodeBoolean(value.closed, false, 'path.closed'),
    points: value.points.map((point, index) => pathPoint(point, index)),
  };
}

/** The shape flavour of a `shape` node. */
function nodeShape(value) {
  if (value === undefined || value === null) return 'rect';
  if (typeof value !== 'string' || !NODE_SHAPES.includes(value)) {
    throw failure(`node shape must be one of ${NODE_SHAPES.join(', ')}`, 'INVALID_CANVAS');
  }
  return value;
}

/**
 * Accept one colour literal and nothing else.
 *
 * The Host stores a renderable, checkable literal only, so colour names,
 * rgba() and hsl() are rejected rather than translated.
 */
function colorLiteral(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw failure(`${label} must be a colour literal such as #a1b2c3`, 'INVALID_COLOR');
  }
  const literal = value.trim();
  if (!COLOR_LITERAL_PATTERN.test(literal)) {
    throw failure(`${label} must be #rgb or #rrggbb`, 'INVALID_COLOR');
  }
  return literal.toLowerCase();
}

function boundedNumber(value, fallback, minimum, maximum, label) {
  if (value === undefined || value === null) return fallback;
  const number = finiteNumber(value, label);
  if (number < minimum || number > maximum) {
    throw failure(`${label} must be between ${minimum} and ${maximum}`, 'INVALID_CANVAS');
  }
  return number;
}

/** The number of sides of a polygon or corners of a star. */
function nodeSides(value, label) {
  if (value === undefined || value === null) return 5;
  if (!Number.isSafeInteger(value) || value < SIDES_MIN || value > SIDES_MAX) {
    throw failure(`${label} must be an integer between ${SIDES_MIN} and ${SIDES_MAX}`, 'INVALID_CANVAS');
  }
  return value;
}

function nodeStrokeWidth(value) {
  return boundedNumber(value, 0, CANVAS_LIMITS.STROKE_WIDTH_MIN, CANVAS_LIMITS.STROKE_WIDTH_MAX, 'node strokeWidth');
}

function nodeOpacity(value) {
  return boundedNumber(value, 1, CANVAS_LIMITS.OPACITY_MIN, CANVAS_LIMITS.OPACITY_MAX, 'node opacity');
}

function nodeRadius(value) {
  return boundedNumber(value, 0, CANVAS_LIMITS.RADIUS_MIN, CANVAS_LIMITS.RADIUS_MAX, 'node radius');
}

function nodeTextAlign(value) {
  if (value === undefined || value === null) return 'left';
  if (typeof value !== 'string' || !TEXT_ALIGNS.includes(value)) {
    throw failure(`node textAlign must be one of ${TEXT_ALIGNS.join(', ')}`, 'INVALID_CANVAS');
  }
  return value;
}

/** The family token of a text node, or null to follow the base stack. */
function nodeFontFamily(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !FONT_FAMILIES.includes(value)) {
    throw failure(`node fontFamily must be one of ${FONT_FAMILIES.join(', ')}`, 'INVALID_CANVAS');
  }
  return value;
}

/** The weight of a text node, in hundreds, or null for the base weight. */
function nodeFontWeight(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < FONT_WEIGHT_MIN || value > FONT_WEIGHT_MAX || value % 100 !== 0) {
    throw failure('node fontWeight must be a hundred between 100 and 900', 'INVALID_CANVAS');
  }
  return value;
}

/** The line height multiple of a text node, or null for the base rhythm. */
function nodeLineHeight(value) {
  if (value === undefined || value === null) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < LINE_HEIGHT_MIN || number > LINE_HEIGHT_MAX) {
    throw failure(`node lineHeight must be between ${LINE_HEIGHT_MIN} and ${LINE_HEIGHT_MAX}`, 'INVALID_CANVAS');
  }
  return Math.round(number * 100) / 100;
}

/** The tracking of a text node in px, or null for the base tracking. */
function nodeLetterSpacing(value) {
  if (value === undefined || value === null) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < LETTER_SPACING_MIN || number > LETTER_SPACING_MAX) {
    throw failure(`node letterSpacing must be between ${LETTER_SPACING_MIN} and ${LETTER_SPACING_MAX}`, 'INVALID_CANVAS');
  }
  return Math.round(number * 100) / 100;
}

/** One drop shadow on a node, or null. */
/** The blur radius, in pixels, applied to the whole node. */
function nodeBlur(value) {
  if (value === undefined || value === null) return 0;
  const radius = Number(value);
  if (!Number.isFinite(radius)) throw failure('node blur must be a number', 'INVALID_CANVAS');
  // A blur is a soft effect: silly values are clamped to the ceiling rather
  // than rejected, so an imported or generated radius can never break a save.
  return Math.round(Math.max(0, Math.min(BLUR_MAX, radius)));
}

/** How a node composites onto what is beneath it. */
function nodeBlend(value) {
  if (value === undefined || value === null) return 'normal';
  const mode = String(value);
  if (!BLEND_MODES.includes(mode)) {
    throw failure(`node blend must be one of ${BLEND_MODES.join(', ')}`, 'INVALID_CANVAS');
  }
  return mode;
}

/**
 * The layout grid of a container: column guides, row guides or none.
 *
 * It is a guide, not output: the grid never appears in an export, only on the
 * canvas, because a handoff file must not carry construction lines.
 */
function nodeGrid(value) {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) throw failure('node grid must be an object', 'INVALID_CANVAS');
  const kind = value.kind === 'rows' ? 'rows' : value.kind === 'columns' ? 'columns' : null;
  if (!kind) throw failure('node grid.kind must be columns or rows', 'INVALID_CANVAS');
  // A grid is a slider-driven guide: silly numbers are clamped, never fatal.
  const clamp = (raw, fallback, minimum, maximum, label) => {
    if (raw === undefined || raw === null) return fallback;
    const number = Number(raw);
    if (!Number.isFinite(number)) throw failure(`${label} must be a number`, 'INVALID_CANVAS');
    return Math.round(Math.max(minimum, Math.min(maximum, number)));
  };
  return {
    kind,
    count: clamp(value.count, 12, 1, GRID_COUNT_MAX, 'node grid.count'),
    gutter: clamp(value.gutter, 16, 0, GRID_GUTTER_MAX, 'node grid.gutter'),
    margin: clamp(value.margin, 24, 0, GRID_MARGIN_MAX, 'node grid.margin'),
    visible: nodeBoolean(value.visible, true, 'node grid.visible'),
  };
}

function nodeShadow(value) {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) throw failure('node shadow must be an object', 'INVALID_CANVAS');
  const x = boundedNumber(value.x, 0, -SHADOW_OFFSET_MAX, SHADOW_OFFSET_MAX, 'node shadow.x');
  const y = boundedNumber(value.y, 0, -SHADOW_OFFSET_MAX, SHADOW_OFFSET_MAX, 'node shadow.y');
  const blur = boundedNumber(value.blur, 0, 0, SHADOW_OFFSET_MAX, 'node shadow.blur');
  const color = colorLiteral(value.color, 'node shadow.color') ?? '#000000';
  // A design shadow is almost always translucent; the alpha lives with the
  // colour so the stored value is one literal, not a colour plus a separate knob.
  const opacity = boundedNumber(value.opacity, 1, 0, 1, 'node shadow.opacity');
  return { x, y, blur, color, opacity };
}

/** A two-stop linear gradient used instead of a flat fill, or null. */
function nodeGradient(value) {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) throw failure('node gradient must be an object', 'INVALID_CANVAS');
  const from = colorLiteral(value.from, 'node gradient.from');
  const to = colorLiteral(value.to, 'node gradient.to');
  if (!from || !to) throw failure('node gradient needs both from and to colours', 'INVALID_COLOR');
  const angle = boundedNumber(value.angle, 180, GRADIENT_ANGLE_MIN, GRADIENT_ANGLE_MAX, 'node gradient.angle');
  return { from, to, angle };
}

/** The component an instance points at. */
function nodeComponentId(value, required) {
  if (value === undefined || value === null || value === '') {
    if (required) throw failure('instance nodes require a componentId', 'INVALID_INSTANCE');
    return null;
  }
  if (typeof value !== 'string' || !value.trim()) {
    throw failure('node componentId must be a node id', 'INVALID_INSTANCE');
  }
  return truncate(value.trim(), CANVAS_LIMITS.ID_MAX_LENGTH);
}

/** Per-node overrides an instance applies on top of its component. */
function nodeOverrides(value) {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) throw failure('instance overrides must be an object', 'INVALID_OVERRIDE');
  const overrides = {};
  for (const [sourceId, patch] of Object.entries(value)) {
    if (!isObject(patch)) throw failure(`override for ${sourceId} must be an object`, 'INVALID_OVERRIDE');
    const allowed = ['text', 'fill', 'stroke', 'textColor', 'fontSize', 'fontWeight', 'visible', 'opacity', 'radius'];
    const clean = {};
    for (const field of Object.keys(patch)) {
      if (!allowed.includes(field)) {
        throw failure(`override for ${sourceId} names an unsupported field: ${field}`, 'INVALID_OVERRIDE');
      }
      clean[field] = patch[field];
    }
    overrides[truncate(sourceId, CANVAS_LIMITS.ID_MAX_LENGTH)] = clean;
  }
  return overrides;
}

/** The marker that says a node was generated by an instance expansion. */
function nodeOrigin(value) {
  if (value === undefined || value === null) return null;
  if (!isObject(value) || typeof value.instance !== 'string') {
    throw failure('node origin must name its instance', 'INVALID_CANVAS');
  }
  return {
    instance: truncate(value.instance, CANVAS_LIMITS.ID_MAX_LENGTH),
    source: typeof value.source === 'string' ? truncate(value.source, CANVAS_LIMITS.ID_MAX_LENGTH) : null,
  };
}

/** A short, stable id for a node an instance generated. */
function generatedId(instanceId, sourceId) {
  let hash = 5381;
  const seed = `${instanceId}:${sourceId}`;
  for (let index = 0; index < seed.length; index += 1) {
    hash = ((hash * 33) ^ seed.charCodeAt(index)) >>> 0;
  }
  const safe = sourceId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'node';
  return `inst-${hash.toString(36)}-${safe}`;
}

/** A token name, or null when the node names no token. */
function tokenName(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !TOKEN_NAME_PATTERN.test(value)) {
    throw failure(`${label} must be a token name such as "brand"`, 'INVALID_TOKEN');
  }
  return value;
}

/**
 * The board's design tokens: colours, gradients and type styles a node can
 * name instead of repeating a literal.
 *
 * A node keeps its token reference and the resolved literal: the reference is
 * what re-themes the board, the literal is what every renderer reads without
 * having to know the token system exists.
 */
/**
 * Two colour tables for one board: the light and the dark mode of its palette.
 *
 * A themed board keeps the same token names in both tables, so switching the
 * theme re-resolves every node that names a token — nothing else changes.
 */
function normalizeThemes(input) {
  if (input === undefined || input === null) return null;
  if (!isObject(input)) throw failure('Canvas themes must be an object', 'INVALID_TOKEN');
  const table = {};
  for (const name of ['light', 'dark']) {
    const value = input[name];
    if (value === undefined || value === null) continue;
    const resolved = normalizeTokens({ colors: isObject(value) ? (value.colors ?? value) : {} });
    table[name] = { colors: resolved.colors };
  }
  if (!table.light && !table.dark) return null;
  return { light: table.light ?? table.dark, dark: table.dark ?? table.light };
}

function normalizeTokens(input) {
  const empty = { colors: {}, gradients: {}, type: {} };
  if (input === undefined || input === null) return empty;
  if (!isObject(input)) throw failure('Canvas tokens must be an object', 'INVALID_TOKEN');
  const colors = {};
  const gradients = {};
  const type = {};
  if (input.colors !== undefined && input.colors !== null) {
    if (!isObject(input.colors)) throw failure('Canvas colour tokens must be an object', 'INVALID_TOKEN');
    const entries = Object.entries(input.colors);
    if (entries.length > TOKEN_LIMIT) throw failure(`A board cannot hold more than ${TOKEN_LIMIT} colour tokens`, 'INVALID_TOKEN');
    for (const [name, value] of entries) {
      if (!TOKEN_NAME_PATTERN.test(name)) throw failure(`Unusable colour token name: ${name}`, 'INVALID_TOKEN');
      try {
        const literal = colorLiteral(value, `colour token ${name}`);
        if (!literal) throw failure(`Colour token ${name} needs a value`, 'INVALID_TOKEN');
        colors[name] = literal;
      } catch (error) {
        if (error.code === 'INVALID_TOKEN') throw error;
        throw failure(`Colour token ${name}: ${error.message}`, 'INVALID_TOKEN');
      }
    }
  }
  if (input.gradients !== undefined && input.gradients !== null) {
    if (!isObject(input.gradients)) throw failure('Canvas gradient tokens must be an object', 'INVALID_TOKEN');
    for (const [name, value] of Object.entries(input.gradients)) {
      if (!TOKEN_NAME_PATTERN.test(name)) throw failure(`Unusable gradient token name: ${name}`, 'INVALID_TOKEN');
      try {
        const gradient = nodeGradient(value);
        if (!gradient) throw failure(`Gradient token ${name} needs from and to`, 'INVALID_TOKEN');
        gradients[name] = gradient;
      } catch (error) {
        if (error.code === 'INVALID_TOKEN') throw error;
        throw failure(`Gradient token ${name}: ${error.message}`, 'INVALID_TOKEN');
      }
    }
  }
  if (input.type !== undefined && input.type !== null) {
    if (!isObject(input.type)) throw failure('Canvas type tokens must be an object', 'INVALID_TOKEN');
    for (const [name, value] of Object.entries(input.type)) {
      if (!TOKEN_NAME_PATTERN.test(name)) throw failure(`Unusable type token name: ${name}`, 'INVALID_TOKEN');
      if (!isObject(value)) throw failure(`Type token ${name} must be an object`, 'INVALID_TOKEN');
      const entry = {};
      try {
        if (value.fontFamily !== undefined) entry.fontFamily = nodeFontFamily(value.fontFamily);
        if (value.fontWeight !== undefined) entry.fontWeight = nodeFontWeight(value.fontWeight);
        if (value.fontSize !== undefined) entry.fontSize = nodeFontSize(value.fontSize);
        if (value.lineHeight !== undefined) entry.lineHeight = nodeLineHeight(value.lineHeight);
        if (value.letterSpacing !== undefined) entry.letterSpacing = nodeLetterSpacing(value.letterSpacing);
      } catch (error) {
        throw failure(`Type token ${name}: ${error.message}`, 'INVALID_TOKEN');
      }
      type[name] = entry;
    }
  }
  return { colors, gradients, type };
}

/** Replace a node's literals with the values its tokens name. An unknown token is ignored, not fatal. */
function applyTokens(nodes, tokens) {
  for (const node of nodes) {
    if (node.fillToken && tokens.colors[node.fillToken]) node.fill = tokens.colors[node.fillToken];
    if (node.strokeToken && tokens.colors[node.strokeToken]) node.stroke = tokens.colors[node.strokeToken];
    if (node.textColorToken && tokens.colors[node.textColorToken]) node.textColor = tokens.colors[node.textColorToken];
    if (node.gradientToken && tokens.gradients[node.gradientToken]) node.gradient = tokens.gradients[node.gradientToken];
    if (node.shadowColorToken && node.shadow && tokens.colors[node.shadowColorToken]) {
      node.shadow = { ...node.shadow, color: tokens.colors[node.shadowColorToken] };
    }
    const style = node.typeToken ? tokens.type[node.typeToken] : null;
    if (style) {
      if (style.fontFamily !== undefined) node.fontFamily = style.fontFamily;
      if (style.fontWeight !== undefined) node.fontWeight = style.fontWeight;
      if (style.fontSize !== undefined) node.fontSize = style.fontSize;
      if (style.lineHeight !== undefined) node.lineHeight = style.lineHeight;
      if (style.letterSpacing !== undefined) node.letterSpacing = style.letterSpacing;
    }
  }
}

/** The pins that keep a child where it belongs when its container resizes. */
function nodeConstraints(value) {
  const empty = { horizontal: 'left', vertical: 'top' };
  if (value === undefined || value === null) return empty;
  if (!isObject(value)) throw failure('node constraints must be an object', 'INVALID_CANVAS');
  const horizontal = value.horizontal === undefined || value.horizontal === null ? 'left' : value.horizontal;
  const vertical = value.vertical === undefined || value.vertical === null ? 'top' : value.vertical;
  if (typeof horizontal !== 'string' || !CONSTRAINT_HORIZONTAL.includes(horizontal)) {
    throw failure(`node constraints.horizontal must be one of ${CONSTRAINT_HORIZONTAL.join(', ')}`, 'INVALID_CANVAS');
  }
  if (typeof vertical !== 'string' || !CONSTRAINT_VERTICAL.includes(vertical)) {
    throw failure(`node constraints.vertical must be one of ${CONSTRAINT_VERTICAL.join(', ')}`, 'INVALID_CANVAS');
  }
  return { horizontal, vertical };
}

/** How a container arranges its members: a flex row, a flex column, or free placement. */
function nodeLayout(value) {
  if (value === undefined || value === null) return 'none';
  if (typeof value !== 'string' || !LAYOUT_MODES.includes(value)) {
    throw failure(`node layout must be one of ${LAYOUT_MODES.join(', ')}`, 'INVALID_CANVAS');
  }
  return value;
}

/** The space between two laid-out members. */
function nodeGap(value) {
  return Math.round(boundedNumber(value, 0, 0, LAYOUT_GAP_MAX, 'node gap'));
}

/** The inset between a laid-out container's edge and its members. */
function nodePadding(value) {
  return Math.round(boundedNumber(value, 0, 0, LAYOUT_PADDING_MAX, 'node padding'));
}

/** Where a laid-out member sits on the axis it does not flow along. */
function nodeAlign(value) {
  if (value === undefined || value === null) return 'start';
  if (typeof value !== 'string' || !LAYOUT_ALIGNS.includes(value)) {
    throw failure(`node align must be one of ${LAYOUT_ALIGNS.join(', ')}`, 'INVALID_CANVAS');
  }
  return value;
}

/** The name a frame carries above its box; blank is allowed. */
function nodeFrameTitle(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw failure('node frame title must be a string', 'INVALID_CANVAS');
  }
  return truncate(value.trim(), CANVAS_LIMITS.TITLE_MAX_LENGTH);
}

/** The member list of a container node; the relationships are checked in a second pass. */
function nodeMembers(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw failure('node members must be an array', 'INVALID_CANVAS');
  }
  return value.map((member) => {
    if (typeof member !== 'string' || !member.trim()) {
      throw failure('container members must be node ids', 'INVALID_MEMBERS');
    }
    return truncate(member.trim(), CANVAS_LIMITS.ID_MAX_LENGTH);
  });
}

function entityId(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw failure(`${label} id must be a non-empty string`, 'INVALID_CANVAS');
  }
  return truncate(value.trim(), CANVAS_LIMITS.ID_MAX_LENGTH);
}

function edgeAnchor(value, label) {
  if (value === undefined || value === null) return 'auto';
  if (typeof value !== 'string' || !EDGE_ANCHORS.includes(value)) {
    throw failure(`${label} must be one of ${EDGE_ANCHORS.join(', ')}`, 'INVALID_CANVAS');
  }
  return value;
}

function edgeLabel(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw failure('edge label must be a string', 'INVALID_CANVAS');
  }
  return truncate(value, CANVAS_LIMITS.EDGE_LABEL_MAX_LENGTH);
}

function normalizeCamera(input) {
  if (input === undefined || input === null) return { x: 0, y: 0, zoom: 1 };
  if (!isObject(input)) throw failure('Canvas camera must be an object', 'INVALID_CANVAS');
  const zoom = input.zoom === undefined || input.zoom === null
    ? 1
    : finiteNumber(input.zoom, 'camera.zoom');
  if (zoom < CANVAS_LIMITS.ZOOM_MIN || zoom > CANVAS_LIMITS.ZOOM_MAX) {
    throw failure(
      `camera.zoom must be between ${CANVAS_LIMITS.ZOOM_MIN} and ${CANVAS_LIMITS.ZOOM_MAX}`,
      'INVALID_CANVAS',
    );
  }
  return {
    x: coordinate(input.x, 'camera.x'),
    y: coordinate(input.y, 'camera.y'),
    zoom,
  };
}

function normalizeNode(input) {
  if (!isObject(input)) throw failure('Canvas node must be an object', 'INVALID_CANVAS');
  const id = entityId(input.id, 'node');
  if (typeof input.type !== 'string' || !NODE_TYPES.includes(input.type)) {
    throw failure(`Unsupported canvas node type: ${String(input.type)}`, 'INVALID_CANVAS');
  }
  const bindsNote = input.type === 'note';
  const isShape = input.type === 'shape';
  const isContainer = CONTAINER_TYPES.includes(input.type);
  const sizeLimit = isContainer ? CANVAS_LIMITS.CONTAINER_SIZE_MAX : CANVAS_LIMITS.NODE_SIZE_MAX;
  const spans = input.type === 'text' ? nodeSpans(input.spans) : null;
  // The runs win when both are given: the flattened text is a projection, not
  // a second source of truth that could drift from the runs.
  const text = spans
    ? truncate(spans.map((span) => span.text).join(''), CANVAS_LIMITS.NODE_TEXT_MAX_LENGTH)
    : nodeText(input.text);
  return {
    id,
    type: input.type,
    x: coordinate(input.x, 'node.x'),
    y: coordinate(input.y, 'node.y'),
    // The message names the node and the value, so a log line says which one
    // broke the limit instead of only which field.
    w: nodeSizeOf(input.w, DEFAULT_NODE_WIDTH, 'w', id, sizeLimit),
    h: nodeSizeOf(input.h, DEFAULT_NODE_HEIGHT, 'h', id, sizeLimit),
    rotation: nodeRotation(input.rotation),
    text,
    spans,
    noteId: bindsNote ? nodeNoteId(input.noteId, true) : null,
    noteUpdatedAt: bindsNote ? nodeNoteUpdatedAt(input.noteUpdatedAt) : null,
    color: nodeColor(input.color),
    locked: nodeBoolean(input.locked, false, 'node.locked'),
    visible: nodeBoolean(input.visible, true, 'node.visible'),
    // A field that does not apply to this node type falls back to its
    // default, the same way an unknown field is dropped.
    shape: isShape ? nodeShape(input.shape) : 'rect',
    path: isShape && nodeShape(input.shape) === 'path' ? nodePath(input.path, true) : null,
    fill: colorLiteral(input.fill, 'node fill'),
    stroke: colorLiteral(input.stroke, 'node stroke'),
    strokeWidth: nodeStrokeWidth(input.strokeWidth),
    opacity: nodeOpacity(input.opacity),
    radius: nodeRadius(input.radius),
    textAlign: nodeTextAlign(input.textAlign),
    members: isContainer ? nodeMembers(input.members) : [],
    title: input.type === 'frame' || input.type === 'component' ? nodeFrameTitle(input.title) : '',
    sides: input.type === 'shape' ? nodeSides(input.sides, 'node sides') : 5,
    points: input.type === 'shape' ? nodeSides(input.points, 'node points') : 5,
    flipX: nodeBoolean(input.flipX, false, 'node flipX'),
    flipY: nodeBoolean(input.flipY, false, 'node flipY'),
    assetId: input.type === 'image' ? nodeAssetId(input.assetId, true) : null,
    kind: typeof input.kind === 'string' && input.kind.startsWith('image/') ? input.kind : null,
    fontSize: nodeFontSize(input.fontSize),
    textColor: nodeTextColor(input.textColor),
    fontFamily: nodeFontFamily(input.fontFamily),
    fontWeight: nodeFontWeight(input.fontWeight),
    lineHeight: nodeLineHeight(input.lineHeight),
    letterSpacing: nodeLetterSpacing(input.letterSpacing),
    shadow: nodeShadow(input.shadow),
    blur: nodeBlur(input.blur),
    blend: nodeBlend(input.blend),
    gradient: nodeGradient(input.gradient),
    // Whether the box follows the members. A group is defined by what it
    // holds, so its box is derived. A frame or a component is a surface of its
    // own size: resizing it must stick, or every resize would snap back to the
    // members the moment the document is normalised.
    autoSize: isContainer ? nodeBoolean(input.autoSize, input.type === 'group', 'node autoSize') : false,
    layout: isContainer ? nodeLayout(input.layout) : 'none',
    grid: isContainer ? nodeGrid(input.grid) : null,
    gap: isContainer ? nodeGap(input.gap) : 0,
    padding: isContainer ? nodePadding(input.padding) : 0,
    align: isContainer ? nodeAlign(input.align) : 'start',
    constraints: nodeConstraints(input.constraints),
    componentId: input.type === 'instance' ? nodeComponentId(input.componentId, true) : null,
    overrides: input.type === 'instance' ? nodeOverrides(input.overrides) : {},
    origin: nodeOrigin(input.origin),
    fillToken: tokenName(input.fillToken, 'node fillToken'),
    strokeToken: tokenName(input.strokeToken, 'node strokeToken'),
    textColorToken: tokenName(input.textColorToken, 'node textColorToken'),
    gradientToken: tokenName(input.gradientToken, 'node gradientToken'),
    typeToken: tokenName(input.typeToken, 'node typeToken'),
    shadowColorToken: tokenName(input.shadowColorToken, 'node shadowColorToken'),
  };
}

/**
 * One comment on the board.
 *
 * A comment points at a node when it is about that node and carries its own
 * place on the canvas otherwise; either way it has a body and a resolved
 * flag, and it never disappears just because the node it named went away.
 */
function normalizeComment(input, nodeIds) {
  if (!isObject(input)) throw failure('Canvas comment must be an object', 'INVALID_COMMENT');
  const id = entityId(input.id, 'comment');
  if (typeof input.body !== 'string') {
    throw failure('Comment body must be a string', 'INVALID_COMMENT');
  }
  const body = truncate(input.body.trim(), COMMENT_BODY_MAX);
  if (!body) throw failure('Comment body must not be empty', 'INVALID_COMMENT');
  const nodeId = typeof input.nodeId === 'string' && input.nodeId.trim() ? input.nodeId.trim() : null;
  return {
    id,
    // A comment that named a node which is no longer there becomes a place
    // on the canvas instead of being deleted with the node.
    nodeId: nodeId && nodeIds.has(nodeId) ? nodeId : null,
    x: coordinate(input.x, 'comment.x'),
    y: coordinate(input.y, 'comment.y'),
    body,
    resolved: nodeBoolean(input.resolved, false, 'comment.resolved'),
    createdAt: timestamp(input.createdAt, 'createdAt'),
  };
}

function normalizeComments(input, nodes) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw failure('Canvas comments must be an array', 'INVALID_CANVAS');
  if (input.length > COMMENT_LIMIT) {
    throw failure(`Canvas cannot hold more than ${COMMENT_LIMIT} comments`, 'INVALID_CANVAS');
  }
  const nodeIds = new Set(nodes.map(({ id }) => id));
  const ids = new Set();
  return input.map((comment) => {
    const normalized = normalizeComment(comment, nodeIds);
    if (ids.has(normalized.id)) {
      throw failure(`Duplicate comment id: ${normalized.id}`, 'INVALID_CANVAS');
    }
    ids.add(normalized.id);
    return normalized;
  });
}

function normalizeNodes(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw failure('Canvas nodes must be an array', 'INVALID_CANVAS');
  if (input.length > CANVAS_LIMITS.NODE_COUNT_MAX) {
    throw failure(`Canvas cannot hold more than ${CANVAS_LIMITS.NODE_COUNT_MAX} nodes`, 'INVALID_CANVAS');
  }
  const ids = new Set();
  return input.map((node) => {
    const normalized = normalizeNode(node);
    if (ids.has(normalized.id)) {
      throw failure(`Duplicate canvas node id: ${normalized.id}`, 'INVALID_CANVAS');
    }
    ids.add(normalized.id);
    return normalized;
  });
}

/**
 * Check the group relationships once every node is known.
 *
 * The member rules look at the whole document, so they run as a second
 * pass over the already normalized nodes: a member must exist, must not
 * be a group itself, must not belong to another group, and a group must
 * not contain itself.
 */
function validateMembers(nodes) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const ownerByNode = new Map();
  for (const container of nodes) {
    if (!CONTAINER_TYPES.includes(container.type)) continue;
    const label = container.type === 'frame' ? 'Frame' : 'Group';
    if (container.members.includes(container.id)) {
      throw failure(`${label} ${container.id} lists itself as a member`, 'INVALID_MEMBERS');
    }
    for (const memberId of container.members) {
      const member = nodeById.get(memberId);
      if (!member) {
        throw failure(
          `${label} ${container.id} refers to a node that does not exist: ${memberId}`,
          'INVALID_MEMBERS',
        );
      }
      const owner = ownerByNode.get(memberId);
      if (owner && owner !== container.id) {
        throw failure(
          `Node ${memberId} belongs to two containers: ${owner} and ${container.id}`,
          'INVALID_MEMBERS',
        );
      }
      ownerByNode.set(memberId, container.id);
    }
  }

  // Nesting is allowed, so the parent chain has to stay acyclic: walk up from
  // each container and refuse a member that is already above it.
  for (const container of nodes) {
    if (!CONTAINER_TYPES.includes(container.type)) continue;
    for (const memberId of container.members) {
      let cursor = ownerByNode.get(container.id);
      let hops = 0;
      while (cursor && hops <= nodes.length) {
        if (cursor === memberId) {
          throw failure(
            `Container ${container.id} would contain its own ancestor: ${memberId}`,
            'INVALID_MEMBERS',
          );
        }
        cursor = ownerByNode.get(cursor);
        hops += 1;
      }
    }
  }
}

/** One of an enumeration, or the default when the field is absent. */
function edgeEnum(value, allowed, fallback, label) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw failure(`${label} must be one of ${allowed.join(', ')}`, 'INVALID_CANVAS');
  }
  return value;
}

/** The stroke weight of a connector. */
function edgeStrokeWidth(value) {
  if (value === undefined || value === null) return EDGE_STROKE_DEFAULT;
  if (!Number.isFinite(value) || value < EDGE_STROKE_MIN || value > EDGE_STROKE_MAX) {
    throw failure(`edge strokeWidth must be between ${EDGE_STROKE_MIN} and ${EDGE_STROKE_MAX}`, 'INVALID_CANVAS');
  }
  return Math.round(value * 10) / 10;
}

function normalizeEdge(input, nodeIds) {
  if (!isObject(input)) throw failure('Canvas edge must be an object', 'INVALID_CANVAS');
  const id = entityId(input.id, 'edge');
  const from = entityId(input.from, 'edge from');
  const to = entityId(input.to, 'edge to');
  if (!nodeIds.has(from) || !nodeIds.has(to)) {
    throw failure(`Canvas edge ${id} points at a node that does not exist`, 'INVALID_CANVAS');
  }
  return {
    id,
    from,
    to,
    fromAnchor: edgeAnchor(input.fromAnchor, 'edge.fromAnchor'),
    toAnchor: edgeAnchor(input.toAnchor, 'edge.toAnchor'),
    label: edgeLabel(input.label),
    strokeWidth: edgeStrokeWidth(input.strokeWidth),
    dash: edgeEnum(input.dash, EDGE_DASHES, 'solid', 'edge dash'),
    startArrow: edgeEnum(input.startArrow, EDGE_HEADS, 'none', 'edge startArrow'),
    endArrow: edgeEnum(input.endArrow, EDGE_HEADS, 'arrow', 'edge endArrow'),
    curve: edgeEnum(input.curve, EDGE_CURVES, 'bezier', 'edge curve'),
    stroke: colorLiteral(input.stroke, 'edge stroke'),
  };
}

/**
 * Lay out the members of every container that declares a flow.
 *
 * Positions are written back into the stored document instead of being
 * recomputed by each renderer: the file is the single truth the canvas, the
 * exporter and the tests all read. The pass is idempotent — a second save
 * computes the same coordinates — and it moves a member that is itself a
 * container together with everything inside it, so nesting stays coherent.
 */
/**
 * Bring back members that a container no longer holds.
 *
 * A resize that re-placed members by their pins, and an import that flattened
 * nested frames into siblings, can leave a container's members thousands of
 * units away from the container itself. The container's own box is the one
 * place the person still recognises, so the members move back into it and
 * keep the arrangement they had with each other.
 *
 * Only a member set that lies entirely outside is repaired: a member that
 * pokes out of the edge by a little is an ordinary loose child.
 */
export function repairEscapedMembers(nodes) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const container of nodes) {
    if (!CONTAINER_TYPES.includes(container.type)) continue;
    const members = (container.members || []).map((id) => byId.get(id)).filter(Boolean);
    if (members.length === 0) continue;
    const union = boundsOf(members);
    if (!union) continue;
    const box = { x: container.x, y: container.y, w: container.w, h: container.h };
    // Overlapping boxes mean the members are merely loose, not lost.
    const overlaps = union.x < box.x + box.w && union.x + union.w > box.x
      && union.y < box.y + box.h && union.y + union.h > box.y;
    if (overlaps) continue;
    const dx = Math.round(box.x + CANVAS_GROUP_PADDING - union.x);
    const dy = Math.round(box.y + CANVAS_GROUP_PADDING - union.y);
    translateTree(byId, members, dx, dy);
  }
  return nodes;
}

/** The box that holds every given node. */
function boundsOf(nodes) {
  if (!nodes.length) return null;
  let x = Infinity;
  let y = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const node of nodes) {
    if (!node) continue;
    x = Math.min(x, node.x);
    y = Math.min(y, node.y);
    right = Math.max(right, node.x + node.w);
    bottom = Math.max(bottom, node.y + node.h);
  }
  if (!Number.isFinite(x)) return null;
  return { x, y, w: right - x, h: bottom - y };
}

/** Move a node and everything it holds by the same amount. */
function translateTree(byId, nodes, dx, dy) {
  if (!dx && !dy) return;
  for (const node of nodes) {
    node.x += dx;
    node.y += dy;
    if (!CONTAINER_TYPES.includes(node.type)) continue;
    for (const memberId of node.members || []) {
      const member = byId.get(memberId);
      if (member) translateTree(byId, [member], dx, dy);
    }
  }
}

export function applyAutoLayout(nodes) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const translate = (node, dx, dy) => {
    if (!dx && !dy) return;
    node.x += dx;
    node.y += dy;
    if (!CONTAINER_TYPES.includes(node.type)) return;
    for (const memberId of node.members) {
      const member = byId.get(memberId);
      if (member) translate(member, dx, dy);
    }
  };
  for (const container of nodes) {
    if (!CONTAINER_TYPES.includes(container.type) || container.layout === 'none') continue;
    const members = container.members.map((id) => byId.get(id)).filter(Boolean);
    if (members.length === 0) continue;
    const row = container.layout === 'row';
    const padding = container.padding;
    const innerX = container.x + padding;
    const innerY = container.y + padding;
    const innerW = Math.max(0, container.w - padding * 2);
    const innerH = Math.max(0, container.h - padding * 2);
    const crossInner = row ? innerH : innerW;
    let cursor = row ? innerX : innerY;
    for (const member of members) {
      const cross = row ? member.h : member.w;
      let crossStart = row ? innerY : innerX;
      if (container.align === 'center') crossStart += (crossInner - cross) / 2;
      else if (container.align === 'end') crossStart += crossInner - cross;
      else if (container.align === 'stretch') {
        const filled = Math.max(CANVAS_LIMITS.NODE_SIZE_MIN, Math.round(crossInner));
        if (row) member.h = filled;
        else member.w = filled;
        crossStart = row ? innerY : innerX;
      }
      const targetX = Math.round(row ? cursor : crossStart);
      const targetY = Math.round(row ? crossStart : cursor);
      translate(member, targetX - member.x, targetY - member.y);
      cursor += (row ? member.w : member.h) + container.gap;
    }
  }
  return nodes;
}

/**
 * Turn every instance into real nodes.
 *
 * Instances are references, not containers: the expansion rebuilds their whole
 * subtree from the component on every save, which is what makes a master edit
 * reach every instance. The copies are marked with `origin` so the next save
 * drops them and rebuilds instead of stacking a second copy.
 */
export function expandInstances(nodes) {
  const authored = nodes.filter((node) => !node.origin);
  const byId = new Map(authored.map((node) => [node.id, node]));
  const components = new Map(authored.filter((node) => node.type === 'component').map((node) => [node.id, node]));
  const instances = authored.filter((node) => node.type === 'instance');
  if (instances.length > INSTANCE_LIMIT) {
    throw failure(`A board cannot hold more than ${INSTANCE_LIMIT} instances`, 'INVALID_INSTANCE');
  }
  for (const component of components.values()) {
    for (const memberId of component.members) {
      const member = byId.get(memberId);
      if (member && member.type === 'instance') {
        throw failure(`Component ${component.id} cannot contain an instance yet`, 'INVALID_INSTANCE');
      }
    }
  }
  const generated = [];
  for (const instance of instances) {
    const component = components.get(instance.componentId);
    if (!component) {
      throw failure(`Instance ${instance.id} points at a missing component: ${instance.componentId}`, 'INVALID_INSTANCE');
    }
    const deltaX = instance.x - component.x;
    const deltaY = instance.y - component.y;
    const clones = new Map();
    const cloneNode = (source) => {
      const cached = clones.get(source.id);
      if (cached) return cached;
      const override = instance.overrides[source.id];
      if (override && Object.keys(override).length) {
        // An override may only paint or retype what the component already has.
        for (const field of Object.keys(override)) {
          if (!(field in source)) {
            throw failure(`Override ${field} on ${source.id} is not a node field`, 'INVALID_OVERRIDE');
          }
        }
      }
      const clone = {
        ...structuredClone(source),
        ...(override || {}),
        id: generatedId(instance.id, source.id),
        origin: { instance: instance.id, source: source.id },
        locked: true,
        members: [],
        x: source.x + deltaX,
        y: source.y + deltaY,
      };
      clones.set(source.id, clone);
      clone.members = (source.members || []).map((memberId) => {
        const member = byId.get(memberId);
        if (!member) throw failure(`Component member missing: ${memberId}`, 'INVALID_INSTANCE');
        return cloneNode(member).id;
      });
      return clone;
    };
    const children = [];
    for (const memberId of component.members) {
      const member = byId.get(memberId);
      if (!member) throw failure(`Component member missing: ${memberId}`, 'INVALID_INSTANCE');
      children.push(cloneNode(member));
    }
    instance.w = component.w;
    instance.h = component.h;
    // The instance owns the component's own box too: fill, border, radius and
    // shadow live on the master node, so the copy renders them as a frame.
    generated.push({
      id: generatedId(instance.id, component.id),
      type: 'frame',
      title: '',
      origin: { instance: instance.id, source: component.id },
      x: instance.x,
      y: instance.y,
      w: component.w,
      h: component.h,
      rotation: component.rotation,
      text: '',
      noteId: null,
      noteUpdatedAt: null,
      color: 'none',
      shape: 'rect',
      textAlign: 'left',
      sides: 5,
      points: 5,
      flipX: false,
      flipY: false,
      assetId: null,
      fontSize: 14,
      textColor: null,
      fontFamily: null,
      fontWeight: null,
      lineHeight: null,
      letterSpacing: null,
      layout: 'none',
      gap: 0,
      padding: 0,
      align: 'start',
      constraints: { horizontal: 'left', vertical: 'top' },
      componentId: null,
      overrides: {},
      fillToken: null,
      strokeToken: null,
      textColorToken: null,
      gradientToken: null,
      typeToken: null,
      shadowColorToken: null,
      locked: true,
      visible: true,
      fill: component.fill,
      stroke: component.stroke,
      strokeWidth: component.strokeWidth,
      radius: component.radius,
      opacity: component.opacity,
      shadow: component.shadow ? { ...component.shadow } : null,
      gradient: component.gradient ? { ...component.gradient } : null,
      members: children.map((child) => child.id),
    });
    generated.push(...children);
  }
  return [...authored, ...generated];
}

function normalizeEdges(input, nodes) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw failure('Canvas edges must be an array', 'INVALID_CANVAS');
  if (input.length > CANVAS_LIMITS.EDGE_COUNT_MAX) {
    throw failure(`Canvas cannot hold more than ${CANVAS_LIMITS.EDGE_COUNT_MAX} edges`, 'INVALID_CANVAS');
  }
  const nodeIds = new Set(nodes.map(({ id }) => id));
  const ids = new Set();
  return input.map((edge) => {
    const normalized = normalizeEdge(edge, nodeIds);
    if (ids.has(normalized.id)) {
      throw failure(`Duplicate canvas edge id: ${normalized.id}`, 'INVALID_CANVAS');
    }
    ids.add(normalized.id);
    return normalized;
  });
}

/**
 * Validate and normalize one scene document.
 *
 * The result is a fresh object; the input is never touched. Structural
 * damage throws `INVALID_CANVAS`, an unusable canvas id throws
 * `INVALID_CANVAS_ID` and an unusable title throws `INVALID_TITLE`.
 *
 * @param {object} input Partial scene document.
 * @param {{ id?: string, title?: string, now?: number|Date }} [options]
 *   Overrides used by the repository to keep a board id and title stable.
 * @returns {object} The normalized scene document.
 */
export function normalizeCanvasDocument(input, options = {}) {
  if (!isObject(input)) throw failure('Canvas document must be an object', 'INVALID_CANVAS');
  if (input.version !== undefined && input.version !== CANVAS_VERSION) {
    throw failure(`Unsupported canvas version: ${String(input.version)}`, 'INVALID_CANVAS');
  }
  const id = normalizeCanvasId(options.id ?? input.id);
  const title = options.title !== undefined
    ? normalizeCanvasTitle(options.title)
    : input.title !== undefined
      ? normalizeCanvasTitle(input.title)
      : DEFAULT_CANVAS_TITLE;
  const themes = normalizeThemes(input.themes);
  const theme = input.theme === 'dark' ? 'dark' : 'light';
  const tokens = normalizeTokens(input.tokens);
  // A themed board's colour table comes from the active mode: the token table
  // stored on the document is the resolved result, never a third source.
  if (themes && themes[theme]) {
    // The active mode wins for every name it defines; a colour that only the
    // flat table knows survives, so a partial mode cannot erase tokens.
    tokens.colors = { ...tokens.colors, ...themes[theme].colors };
  }
  const nodes = normalizeNodes(input.nodes);
  // The member rules need every node, so they run between the node pass
  // and the edge pass.
  validateMembers(nodes);
  // A container that has lost its members gets them back before anything
  // else measures or lays out: every later step reads these coordinates.
  repairEscapedMembers(nodes);
  // Flow layout runs before edges so a connector anchors to the final box.
  applyAutoLayout(nodes);
  // Tokens resolve last: a node keeps its reference and gains the literal
  // every renderer reads, so re-theming is a token edit, not a node rewrite.
  applyTokens(nodes, tokens);
  // Instances expand into real nodes after their components are final: the
  // copies carry the master's resolved coordinates, styles and tokens.
  const expanded = expandInstances(nodes);
  validateMembers(expanded);
  const edges = normalizeEdges(input.edges, nodes);
  return {
    version: CANVAS_VERSION,
    id,
    title,
    starred: nodeBoolean(input.starred, false, 'canvas starred'),
    createdAt: timestamp(input.createdAt, 'createdAt', options.now),
    updatedAt: timestamp(input.updatedAt, 'updatedAt', options.now),
    camera: normalizeCamera(input.camera),
    theme,
    themes,
    tokens,
    nodes: expanded,
    edges,
    comments: normalizeComments(input.comments, nodes),
  };
}

/**
 * Build the empty board a new canvas starts from.
 *
 * @param {{ id: string, title?: string, now?: number|Date }} input
 * @returns {object} The normalized empty scene document.
 */
export function createEmptyCanvas(input = {}) {
  if (!isObject(input)) throw failure('Canvas input must be an object', 'INVALID_CANVAS');
  const now = input.now === undefined || input.now === null ? 0 : input.now;
  const stamp = timestamp(now instanceof Date ? now.getTime() : now, 'now');
  return normalizeCanvasDocument({
    version: CANVAS_VERSION,
    id: input.id,
    title: input.title === undefined ? DEFAULT_CANVAS_TITLE : input.title,
    createdAt: stamp,
    updatedAt: stamp,
    starred: false,
    camera: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    edges: [],
    comments: [],
  });
}

/**
 * Reduce one scene document to the summary the board list shows.
 *
 * @param {object} canvas Scene document.
 * @returns {{ id: string, title: string, nodeCount: number, edgeCount: number, groupCount: number, shapeCount: number, createdAt: number, updatedAt: number }}
 */
export function summarizeCanvas(canvas) {
  if (!isObject(canvas)) throw failure('Canvas document must be an object', 'INVALID_CANVAS');
  const nodes = Array.isArray(canvas.nodes) ? canvas.nodes : [];
  return {
    id: canvas.id,
    title: canvas.title,
    nodeCount: nodes.length,
    edgeCount: Array.isArray(canvas.edges) ? canvas.edges.length : 0,
    groupCount: nodes.filter(({ type }) => type === 'group').length,
    frameCount: nodes.filter(({ type }) => type === 'frame').length,
    shapeCount: nodes.filter(({ type }) => type === 'shape').length,
    starred: canvas.starred === true,
    imageCount: nodes.filter(({ type }) => type === 'image').length,
    commentCount: Array.isArray(canvas.comments) ? canvas.comments.length : 0,
    openCommentCount: Array.isArray(canvas.comments)
      ? canvas.comments.filter((comment) => comment.resolved !== true).length
      : 0,
    createdAt: canvas.createdAt,
    updatedAt: canvas.updatedAt,
  };
}
