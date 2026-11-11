/**
 * Import a Figma `.fig` file into a Moments board.
 *
 * `.fig` has no published specification, but it is self-describing: every file
 * carries its own Kiwi schema, which is what makes third-party readers possible.
 * Parsing lives here, on the Host, because the client is a single vanilla file
 * that cannot carry `fflate` + `kiwi-schema` + `fzstd`.
 *
 * The rule for this module is *restore what can be restored and say what cannot*:
 * every node that is skipped or degraded is counted, so an import never loses
 * something silently.
 */

import { randomUUID } from 'node:crypto';

export const FIG_MAX_BYTES = 50 * 1024 * 1024;
export const FIG_MAX_NODES = 20000;
export const FIG_MAX_IMAGES = 500;
export const FIG_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Page frames are stacked vertically with this gap. */
const PAGE_GAP = 160;

function failure(message, code = 'FIG_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}

/* --------------------------------------------------------------- matrices */

const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** Parent × local, in the [a c e; b d f] convention Figma uses. */
function multiply(parent, local) {
  return {
    a: parent.a * local.a + parent.c * local.b,
    b: parent.b * local.a + parent.d * local.b,
    c: parent.a * local.c + parent.c * local.d,
    d: parent.b * local.c + parent.d * local.d,
    e: parent.a * local.e + parent.c * local.f + parent.e,
    f: parent.b * local.e + parent.d * local.f + parent.f,
  };
}

/** Figma's six-number transform into the same convention. */
function toMatrix(transform) {
  if (!transform) return IDENTITY;
  const { m00 = 1, m01 = 0, m02 = 0, m10 = 0, m11 = 1, m12 = 0 } = transform;
  return { a: m00, b: m10, c: m01, d: m11, e: m02, f: m12 };
}

/** What a placement contributes: position, unrotated size and rotation. */
function placementOf(matrix, size) {
  const scaleX = Math.hypot(matrix.a, matrix.b) || 1;
  const scaleY = Math.hypot(matrix.c, matrix.d) || 1;
  const rotation = (Math.atan2(matrix.b, matrix.a) * 180) / Math.PI;
  const width = Math.abs((size?.x ?? 0) * scaleX);
  const height = Math.abs((size?.y ?? 0) * scaleY);
  // The board has a floor and a ceiling for every box; a divider line or a
  // hairline frame has to land inside them rather than fail the whole import.
  const clamp = (value, min, max) => Math.min(max, Math.max(min, Math.round(value * 100) / 100));
  return {
    x: clamp(matrix.e, -1000000, 1000000),
    y: clamp(matrix.f, -1000000, 1000000),
    // The per-type ceiling is applied when the board node is built: a section
    // may legitimately be wider than a leaf, and clamping it here would hide
    // that before the type is known.
    w: clamp(width, 16, 100000),
    h: clamp(height, 16, 100000),
    rotation: Math.abs(rotation) < 0.01 ? 0 : Math.round(((rotation % 360) + 360) % 360 * 100) / 100,
  };
}

/* ----------------------------------------------------------------- colour */

/** A Figma colour (0–1 channels) as a `#rrggbb` literal, or null. */
function toHex(color) {
  if (!color || typeof color !== 'object') return null;
  const channel = (value) => {
    const clamped = Math.max(0, Math.min(1, Number(value) || 0));
    return Math.round(clamped * 255).toString(16).padStart(2, '0');
  };
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

/** The first visible solid paint of a node, as a hex literal. */
function solidFill(paints) {
  if (!Array.isArray(paints)) return null;
  for (const paint of paints) {
    if (!paint || paint.visible === false) continue;
    if (paint.type === 'SOLID') {
      const hex = toHex(paint.color);
      if (hex) return hex;
    }
  }
  return null;
}

/** The first image paint of a node, if it carries one. */
function imagePaint(paints) {
  if (!Array.isArray(paints)) return null;
  for (const paint of paints) {
    if (!paint || paint.visible === false) continue;
    if (paint.type === 'IMAGE' && paint.image) return paint;
  }
  return null;
}

/** A number inside a range, or the fallback. */
function bounded(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

/**
 * The two-stop gradient the board can paint, from a Figma gradient paint.
 *
 * Figma stores handle positions in unit space with y pointing down; the angle
 * of the second handle away from the first is the direction the gradient
 * travels, which maps onto the CSS angle our model stores.
 */
function gradientOf(paints) {
  if (!Array.isArray(paints)) return null;
  for (const paint of paints) {
    if (!paint || paint.visible === false) continue;
    if (typeof paint.type !== 'string' || !paint.type.startsWith('GRADIENT')) continue;
    const rawStops = Array.isArray(paint.stops)
      ? paint.stops
      : Array.isArray(paint.gradientStops) ? paint.gradientStops : [];
    const stops = rawStops
      .filter((stop) => stop && stop.color)
      .sort((left, right) => (Number(left.position) || 0) - (Number(right.position) || 0));
    if (stops.length < 2) continue;
    const from = toHex(stops[0].color);
    const to = toHex(stops[stops.length - 1].color);
    if (!from || !to) continue;
    let angle = 180;
    // The gradient's own transform maps unit space onto the node: its first
    // column is the direction the gradient runs, y pointing down.
    const matrix = paint.transform;
    if (matrix && Number.isFinite(Number(matrix.m00)) && Number.isFinite(Number(matrix.m10))) {
      const dx = Number(matrix.m00);
      const dy = Number(matrix.m10);
      if (dx || dy) angle = Math.round(((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360);
    } else if (Array.isArray(paint.gradientHandlePositions) && paint.gradientHandlePositions.length >= 2) {
      const dx = Number(paint.gradientHandlePositions[1]?.x) - Number(paint.gradientHandlePositions[0]?.x);
      const dy = Number(paint.gradientHandlePositions[1]?.y) - Number(paint.gradientHandlePositions[0]?.y);
      if (Number.isFinite(dx) && Number.isFinite(dy) && (dx || dy)) {
        angle = Math.round(((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360);
      }
    }
    return { from, to, angle };
  }
  return null;
}

/** The first drop shadow of a node, in the shape the board stores. */
function shadowOf(effects) {
  if (!Array.isArray(effects)) return null;
  for (const effect of effects) {
    if (!effect || effect.visible === false) continue;
    if (effect.type !== 'DROP_SHADOW') continue;
    const color = effect.color || {};
    const hex = toHex({ r: color.r, g: color.g, b: color.b });
    if (!hex) continue;
    return {
      x: Math.round(bounded(effect.offset?.x, 0, -400, 400)),
      y: Math.round(bounded(effect.offset?.y, 0, -400, 400)),
      blur: Math.round(bounded(effect.radius, 0, 0, 400)),
      color: hex,
      opacity: bounded(color.a, 1, 0, 1),
    };
  }
  return null;
}

/** The blur radius of the first blur effect on a node. */
function blurOf(effects) {
  if (!Array.isArray(effects)) return 0;
  for (const effect of effects) {
    if (!effect || effect.visible === false) continue;
    if (typeof effect.type !== 'string' || !effect.type.endsWith('_BLUR')) continue;
    const radius = bounded(effect.radius, 0, 0, 200);
    if (radius > 0) return Math.round(radius);
  }
  return 0;
}

/** A Figma auto-layout frame, in the row/column vocabulary the board runs. */
function layoutOf(node) {
  const mode = String(node.stackMode || node.layoutMode || '').toUpperCase();
  if (mode !== 'VERTICAL' && mode !== 'HORIZONTAL') return null;
  const alignMap = { MIN: 'start', CENTER: 'center', MAX: 'end', STRETCH: 'stretch', BASELINE: 'start', SPACE_BETWEEN: 'start' };
  const rawAlign = node.stackCounterAlignItems ?? node.counterAxisAlignItems;
  return {
    layout: mode === 'VERTICAL' ? 'column' : 'row',
    gap: Math.round(bounded(node.stackSpacing ?? node.itemSpacing, 0, 0, 400)),
    // The board keeps one padding for all four sides, so take the widest side
    // rather than a side that would let content overlap the border.
    padding: Math.round(bounded(
      Math.max(
        Number(node.stackPaddingLeft ?? node.paddingLeft) || 0,
        Number(node.stackPaddingRight ?? node.paddingRight) || 0,
        Number(node.stackPaddingTop ?? node.paddingTop) || 0,
        Number(node.stackPaddingBottom ?? node.paddingBottom) || 0,
      ),
      0, 0, 400,
    )),
    align: alignMap[String(rawAlign || 'MIN').toUpperCase()] || 'start',
  };
}

/** The family token a Figma font name maps to. */
function fontFamilyOf(node) {
  const family = String(node.fontName?.family ?? node.textData?.fontName?.family ?? '').toLowerCase();
  if (!family) return null;
  if (/mono|code|menlo|courier|consolas/.test(family)) return 'mono';
  if (/serif|georgia|times|playfair|garamond|baskerville/.test(family)) return 'serif';
  if (/display/.test(family)) return 'display';
  return 'sans';
}

/** The weight a Figma style name maps to, in hundreds. */
function fontWeightOf(node) {
  const style = String(node.fontName?.style ?? node.textData?.fontName?.style ?? '').toLowerCase();
  if (!style) return null;
  if (/thin|hairline/.test(style)) return 100;
  if (/extra ?light|ultra ?light/.test(style)) return 200;
  if (/light/.test(style)) return 300;
  if (/medium/.test(style)) return 500;
  if (/semi ?bold|demi/.test(style)) return 600;
  if (/extra ?bold|black|heavy/.test(style)) return 800;
  if (/bold/.test(style)) return 700;
  return 400;
}

/** Whether any paint of the list is a gradient. */
function hasGradient(paints) {
  return Array.isArray(paints) && paints.some((paint) => paint
    && paint.visible !== false
    && typeof paint.type === 'string'
    && paint.type.startsWith('GRADIENT'));
}

/* ------------------------------------------------------------------ shape */

/** The shape kind our model knows, from a Figma node type. */
function shapeKind(type, node) {
  switch (type) {
    case 'RECTANGLE':
    case 'ROUNDED_RECTANGLE':
      return 'rect';
    case 'ELLIPSE': return 'ellipse';
    case 'LINE': return 'line';
    case 'STAR': return 'star';
    case 'POLYGON':
    case 'REGULAR_POLYGON': return 'polygon';
    case 'SHAPE_WITH_TEXT': {
      // FigJam shapes: a diamond has no editor here, so it reads as a box.
      const flavour = String(node?.shapeWithTextType ?? '').toUpperCase();
      if (flavour === 'ELLIPSE' || flavour === 'SUMMING_JUNCTION') return 'ellipse';
      return 'rect';
    }
    default: return null;
  }
}

/** FigJam keeps the text of a sticky or a shape in its name, not in textData. */
function nodeLabel(node) {
  const characters = textOf(node);
  if (characters) return characters;
  const name = typeof node.name === 'string' ? node.name.trim() : '';
  // A frame's name is its title, not its content.
  if (!name) return null;
  if (node.type === 'FRAME' || node.type === 'SECTION' || node.type === 'GROUP') return null;
  return name;
}

/** The side or corner count of a polygon or star node. */
function shapeCount(node, star) {
  const raw = star ? (node.pointCount ?? node.starPoints) : node.pointCount;
  const value = Number(raw);
  if (!Number.isFinite(value)) return 5;
  return Math.max(3, Math.min(24, Math.round(value)));
}

/**
 * FigJam keeps the real paints in generated overrides, not on the node.
 *
 * The root override is the object's background and border; localID 1 is its
 * text. Reading only the top-level paints is why a FigJam import used to look
 * like white boxes with grey lines.
 */
function generationOverride(node, localID) {
  const overrides = node?.nodeGenerationData?.overrides;
  if (!Array.isArray(overrides)) return null;
  return overrides.find((item) => {
    const path = item?.guidPath?.guids;
    return Array.isArray(path) && path.length === 1
      // The marker is the decimal Figma id 40000000, not the hex literal
      // 0x40000000; confusing them leaves every FigJam paint unread.
      && path[0]?.sessionID === 40000000
      && path[0]?.localID === localID;
  }) ?? null;
}

/** Merge only the style fields, leaving geometry and placement on the node. */
function withFigJamStyles(node) {
  const root = generationOverride(node, 0);
  const text = generationOverride(node, 1);
  if (!root && !text) return node;
  const paints = (field) => (Array.isArray(node[field]) && node[field].length
    ? node[field]
    : root?.[field] ?? node[field]);
  return {
    ...node,
    fillPaints: paints('fillPaints'),
    strokePaints: paints('strokePaints'),
    effects: node.effects?.length ? node.effects : root?.effects ?? node.effects,
    strokeWeight: Number(node.strokeWeight) > 0 ? node.strokeWeight : root?.strokeWeight ?? node.strokeWeight,
    cornerRadius: Number(node.cornerRadius) > 0 ? node.cornerRadius : root?.cornerRadius ?? node.cornerRadius,
    fontSize: node.fontSize ?? text?.fontSize,
    fontName: node.fontName ?? text?.fontName,
    textData: node.textData?.characters ? node.textData : text?.textData ?? node.textData,
    // Text colour is not the object's fill: it lives in the text override.
    textColorPaints: text?.fillPaints ?? node.textColorPaints,
  };
}

/* ------------------------------------------------------------------ text */

/** The first font size the node carries, within the range the model allows. */
function fontSizeOf(node) {
  const size = Number(node.fontSize);
  if (!Number.isFinite(size) || size <= 0) return null;
  return Math.max(6, Math.min(512, Math.round(size * 100) / 100));
}

/** The characters of a text node, or null when it has none. */
function textOf(node) {
  const characters = node.textData?.characters;
  if (typeof characters !== 'string' || !characters.trim()) return null;
  return characters;
}

/* ------------------------------------------------------------- the importer */

/**
 * Read a `.fig` file into board nodes.
 *
 * @param {Uint8Array} bytes the whole file
 * @param {{
 *   saveAsset?: (bytes: Uint8Array, type: string, name: string) => Promise<string>,
 *   now?: () => number,
 * }} options
 * @returns {Promise<{ nodes: object[], edges: object[], report: object }>}
 */
export async function importFigFile(bytes, options = {}) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw failure('The Figma file is empty', 'FIG_INVALID');
  }
  if (bytes.length > FIG_MAX_BYTES) {
    throw failure(`A Figma file must be ${Math.round(FIG_MAX_BYTES / 1024 / 1024)} MB or smaller`, 'FIG_TOO_LARGE');
  }

  // Loaded on demand: a broken or missing parser must not take the plugin down.
  let fig;
  try {
    fig = await import('openfig-core');
  } catch {
    throw failure('The Figma reader is not available in this build', 'FIG_UNSUPPORTED');
  }

  let document_;
  try {
    document_ = fig.parseFig(bytes);
  } catch (error) {
    throw failure(`This file could not be read as a Figma document: ${error?.message || 'unknown error'}`, 'FIG_INVALID');
  }

  const allNodes = Array.isArray(document_.nodes) ? document_.nodes : [];
  if (allNodes.length > FIG_MAX_NODES) {
    throw failure(`This document has ${allNodes.length} nodes; the limit is ${FIG_MAX_NODES}`, 'FIG_TOO_COMPLEX');
  }

  const saveAsset = options.saveAsset;
  const nodes = [];
  const edges = [];
  const report = {
    imported: { frame: 0, group: 0, sticky: 0, text: 0, shape: 0, image: 0, vector: 0, edge: 0 },
    skipped: { slice: 0, symbol: 0, unknown: 0 },
    warnings: [],
    pages: [],
    nodeCount: allNodes.length,
    // Which nodes were left behind, not only how many: a count nobody can act
    // on is a dead end once the import dialog is gone.
    skippedSamples: { slice: [], symbol: [], unknown: [] },
  };
  const sampleSkipped = (kind, node) => {
    const list = report.skippedSamples[kind];
    if (!Array.isArray(list) || list.length >= 20) return;
    list.push({
      id: typeof fig.nodeId === 'function' ? fig.nodeId(node) : null,
      name: String(node?.name || '').slice(0, 80),
      type: String(node?.type || ''),
    });
  };
  const seenImages = new Map();
  const idOf = (node) => fig.nodeId(node) ?? randomUUID();

  /** The hex key of an image hash, however Kiwi decoded it. */
  const hashKey = (hash) => {
    if (!hash) return '';
    if (typeof hash === 'string') return hash;
    if (hash instanceof Uint8Array) return Buffer.from(hash).toString('hex');
    if (typeof hash === 'object') {
      // Kiwi decodes byte arrays as plain objects with numeric keys.
      return Buffer.from(Object.values(hash)).toString('hex');
    }
    return '';
  };

  /** The bytes stored under one hash, if the archive carries them. */
  const bytesOf = (hash) => {
    const key = hashKey(hash);
    return key ? document_.images?.get?.(key) ?? null : null;
  };

  /**
   * The bytes of one image fill.
   *
   * A "partial file saved" archive keeps a thumbnail for every picture but not
   * always the original. Showing the thumbnail beats showing an empty frame,
   * so the original is preferred and the thumbnail is the fallback; the report
   * says which one was used.
   */
  const imageBytes = (paint) => {
    const original = bytesOf(paint?.image?.hash);
    if (original) return { bytes: original, thumbnail: false };
    const thumb = bytesOf(paint?.imageThumbnail?.hash);
    if (thumb) return { bytes: thumb, thumbnail: true };
    return null;
  };

  /** Store one image fill and return the asset id the node should reference. */
  const assetOf = async (paint, name) => {
    const found = imageBytes(paint);
    if (!found || !saveAsset) return null;
    const raw = found.bytes;
    if (raw.length > FIG_MAX_IMAGE_BYTES) {
      report.warnings.push(`An image larger than 10 MB was skipped (${name || 'unnamed'})`);
      return null;
    }
    const key = Buffer.from(raw.slice(0, 32)).toString('hex');
    if (seenImages.has(key)) return seenImages.get(key);
    if (seenImages.size >= FIG_MAX_IMAGES) {
      report.warnings.push('The file holds more images than a board can take; the rest were skipped');
      return null;
    }
    const type = sniffImageType(raw);
    const assetId = await saveAsset(raw, type, name || 'fig-image');
    const asset = { assetId, kind: type, thumbnail: found.thumbnail };
    if (found.thumbnail) report.imported.imageThumbnail = (report.imported.imageThumbnail || 0) + 1;
    seenImages.set(key, asset);
    return asset;
  };

  /** Build one node of ours from one Figma node. */
  const build = async (sourceNode, absolute, offset) => {
    const node = withFigJamStyles(sourceNode);
    const place = placementOf(absolute, node.size);
    const base = {
      id: idOf(node),
      x: place.x + offset.x,
      y: place.y + offset.y,
      // A FigJam section is routinely wider than a leaf node may be. The Host
      // derives a container's box from its members and holds containers to a
      // looser ceiling, so the import clamps to the same two limits.
      ...(() => {
        const limit = ['GROUP', 'FRAME', 'SECTION', 'COMPONENT', 'INSTANCE', 'SYMBOL'].includes(node.type)
          ? 100000
          : 8000;
        return { w: Math.min(limit, Math.max(16, place.w)), h: Math.min(limit, Math.max(16, place.h)) };
      })(),
      rotation: place.rotation,
      text: '',
      noteId: null,
      noteUpdatedAt: null,
      color: 'none',
      locked: false,
      visible: node.visible !== false,
      shape: 'rect',
      fill: null,
      stroke: null,
      strokeWidth: 0,
      opacity: typeof node.opacity === 'number' ? Math.max(0, Math.min(1, node.opacity)) : 1,
      radius: Number(node.cornerRadius) > 0 ? Math.min(999, Math.round(node.cornerRadius)) : 0,
      textAlign: 'left',
      members: [],
      title: '',
      sides: 5,
      points: 5,
      flipX: false,
      flipY: false,
      assetId: null,
      fontSize: 14,
      textColor: null,
    };

    // On a text node the fill paints the glyphs, not a background: it becomes
    // textColor below, and giving it to `fill` would draw a coloured block.
    if (node.type !== 'TEXT') {
      const fill = solidFill(node.fillPaints);
      const stroke = solidFill(node.strokePaints);
      if (fill) base.fill = fill;
      if (stroke) {
        base.stroke = stroke;
        base.strokeWidth = Math.max(1, Math.min(64, Math.round(Number(node.strokeWeight) || 1)));
      }
      // A gradient replaces the flat fill; a drop shadow rides on the box.
      if (!fill) {
        const gradient = gradientOf(node.fillPaints);
        if (gradient) base.gradient = gradient;
      }
      const shadow = shadowOf(node.effects);
      if (shadow) base.shadow = shadow;
      const blur = blurOf(node.effects);
      if (blur) base.blur = blur;
    }

    // FigJam stickies carry their words in the node name.
    if (node.type === 'STICKY') {
      if (!Array.isArray(node.fillPaints) || !node.fillPaints.length) {
        if (!report.warnings.includes('FigJam colours were not in this file: stickies, shapes and connectors arrive without their fills')) {
          report.warnings.push('FigJam colours were not in this file: stickies, shapes and connectors arrive without their fills');
        }
      }
      const characters = nodeLabel(node) || '';
      const ink = toHex((node.textColorPaints ?? node.fillPaints)?.find?.((paint) => paint?.type === 'SOLID')?.color);
      report.imported.sticky += 1;
      return {
        ...base,
        type: 'sticky',
        text: characters.slice(0, 4000),
        color: 'none',
        textColor: ink,
      };
    }

    // A text node keeps its characters, size, alignment and colour.
    if (node.type === 'TEXT') {
      const characters = textOf(node);
      if (characters) {
        const result = { ...base, type: 'text', text: characters.slice(0, 4000) };
        const size = fontSizeOf(node);
        if (size) result.fontSize = size;
        const ink = toHex((node.textColorPaints ?? node.fillPaints)?.find?.((paint) => paint?.type === 'SOLID')?.color);
        if (ink) result.textColor = ink;
        const family = fontFamilyOf(node);
        if (family) result.fontFamily = family;
        const weight = fontWeightOf(node);
        if (weight) result.fontWeight = weight;
        if (node.textAlignHorizontal === 'CENTER') result.textAlign = 'center';
        else if (node.textAlignHorizontal === 'RIGHT') result.textAlign = 'right';
        report.imported.text += 1;
        return result;
      }
    }

    // A shape with an image fill is an image on the board, not a white box.
    const shapeImage = imagePaint(node.fillPaints);
    if (shapeImage) {
      const assetId = await assetOf(shapeImage, node.name);
      if (assetId) {
        report.imported.image += 1;
        return {
          ...base,
          type: 'image',
          assetId: assetId.assetId ?? assetId,
          kind: assetId.kind ?? null,
          w: base.w,
          h: base.h,
        };
      }
      if (!report.warnings.includes('Some image fills were not embedded in this file; their frames were kept')) {
        report.warnings.push('Some image fills were not embedded in this file; their frames were kept');
      }
    }

    const kind = shapeKind(node.type, node);
    if (kind) {
      const result = {
        ...base,
        type: 'shape',
        shape: kind,
        sides: shapeCount(node, false),
        points: shapeCount(node, true),
      };
      if (kind === 'star') result.points = shapeCount(node, true);
      if (kind === 'polygon') result.sides = shapeCount(node, false);
      // A layer name carried into a box too small to hold a word is not copy:
      // keeping it makes every such box look like clipped text forever.
      const characters = nodeLabel(node);
      const holdsText = base.w >= 32 && base.h >= 18;
      if (characters && holdsText) result.text = characters.slice(0, 2000);
      if (characters && !holdsText) report.labelsDropped = (report.labelsDropped || 0) + 1;
      report.imported.shape += 1;
      return result;
    }

    // A vector has no editable form in this board; it is carried as an SVG so
    // that what the person sees is exactly what Figma drew.
    if (node.type === 'VECTOR' || node.type === 'BOOLEAN_OPERATION') {
      const assetId = await vectorAsset(fig, document_, node, base, saveAsset, report);
      if (assetId) {
        report.imported.vector += 1;
        return {
          ...base,
          type: 'image',
          assetId: assetId.assetId ?? assetId,
          kind: assetId.kind ?? 'image/svg+xml',
          w: base.w,
          h: base.h,
        };
      }
      report.skipped.unknown += 1;
      sampleSkipped('unknown', node);
      return null;
    }

    // A FigJam section is a named area; it maps onto a frame. Sections do
    // carry their paint, so the colour bands of a FigJam file survive here
    // even when the shapes inside lose theirs.
    if (node.type === 'SECTION') {
      report.imported.frame += 1;
      const filled = solidFill(node.fillPaints);
      const lined = solidFill(node.strokePaints);
      const result = {
        ...base,
        type: 'frame',
        title: String(node.name || '').slice(0, 120),
      };
      if (filled) result.fill = filled;
      if (lined) {
        result.stroke = lined;
        result.strokeWidth = Math.max(1, Math.min(64, Math.round(Number(node.strokeWeight) || 1)));
      }
      return result;
    }

    // A frame that clips and has an identity transform is a page or a card.
    if (node.type === 'FRAME') {
      const isGroup = node.resizeToFit === true;
      const result = {
        ...base,
        type: isGroup ? 'group' : 'frame',
        title: isGroup ? '' : String(node.name || '').slice(0, 120),
      };
      // A frame that flows its children keeps flowing here: the board runs the
      // same row/column layout pass on save.
      if (!isGroup) {
        const flow = layoutOf(node);
        if (flow) Object.assign(result, flow);
      }
      report.imported[isGroup ? 'group' : 'frame'] += 1;
      return result;
    }

    if (node.type === 'GROUP' || node.type === 'COMPONENT' || node.type === 'INSTANCE') {
      // Instances are flattened: the visual survives, the component semantics
      // do not, and the report says so.
      if (node.type !== 'GROUP') {
        if (!report.warnings.includes('Component instances were flattened into groups')) {
          report.warnings.push('Component instances were flattened into groups');
        }
      }
      report.imported.group += 1;
      return { ...base, type: 'group' };
    }

    if (node.type === 'SLICE') {
      report.skipped.slice += 1;
      sampleSkipped('slice', node);
      return null;
    }

    // A component definition is not content; the instances that use it are.
    if (node.type === 'SYMBOL') {
      report.skipped.symbol += 1;
      sampleSkipped('symbol', node);
      return null;
    }

    // Connectors are collected as edges below, not built as nodes.
    if (node.type === 'CONNECTOR') return null;

    // A fill the model cannot paint: keep the picture rather than the shape.
    const painted = imagePaint(node.fillPaints);
    if (painted) {
      const assetId = await assetOf(painted, node.name);
      if (assetId) {
        report.imported.image += 1;
        return { ...base, type: 'image', assetId: assetId.assetId ?? assetId, kind: assetId.kind ?? null };
      }
    }

    report.skipped.unknown += 1;
    sampleSkipped('unknown', node);
    return null;
  };

  // Pages are laid out down the board. A page does not become a frame of its
  // own: the board's containers derive their box from their members, so a page
  // frame would clip any frame nested inside it.
  const pages = Array.isArray(document_.nodes)
    ? document_.nodes.filter((node) => node.type === 'CANVAS')
    : [];
  const topLevel = pages.length ? pages : [{ ...document_.nodes[0], type: 'CANVAS' }];
  const isContainer = (node) => node.type === 'group' || node.type === 'frame';
  const childrenOf = (node) => document_.childrenMap?.get?.(idOf(node)) ?? [];
  // A page only matters when it holds something: Figma always ships a couple of
  // empty utility canvases that would otherwise look like extra pages.
  const livePages = topLevel.filter((page) => childrenOf(page).length > 0);

  let cursorY = 0;
  for (const page of topLevel) {
    const children = childrenOf(page);
    if (!children.length) continue;
    report.pages.push(String(page.name || 'Page'));

    // Every descendant, with its transform accumulated into board coordinates.
    const stack = [];
    const walk = (node, parentMatrix) => {
      const absolute = multiply(parentMatrix, toMatrix(node.transform));
      stack.push({ node, absolute });
      for (const child of document_.childrenMap?.get?.(idOf(node)) ?? []) {
        walk(child, absolute);
      }
    };
    for (const child of children) walk(child, IDENTITY);

    const boxes = stack.map(({ node, absolute }) => placementOf(absolute, node.size));
    const minX = boxes.length ? Math.min(...boxes.map((box) => box.x)) : 0;
    const minY = boxes.length ? Math.min(...boxes.map((box) => box.y)) : 0;
    const maxY = boxes.length ? Math.max(...boxes.map((box) => box.y + box.h)) : 0;
    const offset = { x: -minX + 80, y: -minY + 80 + cursorY };

    // With more than one page the board needs to say which page it is looking at.
    if (livePages.length > 1) {
      nodes.push({
        id: randomUUID(), type: 'text', text: String(page.name || 'Page').slice(0, 200),
        x: Math.round(offset.x), y: Math.round(offset.y - 56),
        w: 320, h: 40, rotation: 0,
        noteId: null, noteUpdatedAt: null, color: 'none', locked: false, visible: true,
        shape: 'rect', fill: null, stroke: null, strokeWidth: 0, opacity: 1, radius: 0,
        textAlign: 'left', members: [], title: '', sides: 5, points: 5,
        flipX: false, flipY: false, assetId: null, fontSize: 20, textColor: null,
      });
      report.imported.text += 1;
    }

    const built = [];
    for (const { node, absolute } of stack) {
      const produced = await build(node, absolute, offset);
      if (produced) built.push(produced);
    }

    // A container may only hold plain nodes, so it takes the children that fit
    // and the tree is flattened where Figma nested frames inside frames.
    let flattened = false;
    for (const { node } of stack) {
      const produced = built.find((item) => item.id === idOf(node));
      if (!produced) continue;
      // The stack holds Figma nodes (upper case); the check is on what we built.
      if (produced.type !== 'group' && produced.type !== 'frame') continue;
      const members = [];
      for (const child of document_.childrenMap?.get?.(idOf(node)) ?? []) {
        const childBuilt = built.find((item) => item.id === idOf(child));
        if (!childBuilt) continue;
        if (isContainer(childBuilt)) { flattened = true; continue; }
        members.push(childBuilt.id);
      }
      produced.members = members;
    }
    if (flattened && !report.warnings.includes('Nested frames were flattened into sibling containers')) {
      report.warnings.push('Nested frames were flattened into sibling containers');
    }

    // A container with nothing inside it would draw an empty sliver.
    for (let index = built.length - 1; index >= 0; index -= 1) {
      const item = built[index];
      if ((item.type === 'group' || item.type === 'frame') && item.members.length === 0) {
        built.splice(index, 1);
        report.skipped.unknown += 1;
        sampleSkipped('unknown', item);
        if (!report.warnings.includes('Intermediate containers were merged away')) {
          report.warnings.push('Intermediate containers were merged away');
        }
      }
    }

    nodes.push(...built);

    if (stack.some(({ node }) => hasGradient(node.fillPaints) || hasGradient(node.strokePaints))) {
      if (!report.warnings.includes('Gradients were approximated by their first colour')) {
        report.warnings.push('Gradients were approximated by their first colour');
      }
    }
    cursorY += (maxY - minY) + PAGE_GAP;
  }

  // Connectors link two Figma nodes; both ends have to have survived the import.
  const builtIds = new Set(nodes.map((node) => node.id));
  const anchorOf = (magnet) => {
    switch (String(magnet || '').toUpperCase()) {
      case 'TOP': return 'top';
      case 'BOTTOM': return 'bottom';
      case 'LEFT': return 'left';
      case 'RIGHT': return 'right';
      default: return 'auto';
    }
  };
  const guidId = (guid) => (guid ? `${guid.sessionID}:${guid.localID}` : null);
  const seenEdges = new Set();
  for (const node of Array.isArray(document_.nodes) ? document_.nodes : []) {
    if (node.type !== 'CONNECTOR') continue;
    const generated = generationOverride(node, 0);
    const stroke = solidFill(generated?.strokePaints ?? node.strokePaints);
    const weight = Number(generated?.strokeWeight ?? node.strokeWeight);
    const dashed = Array.isArray(generated?.dashPattern ?? node.dashPattern)
      && (generated?.dashPattern ?? node.dashPattern).length > 0;
    const curve = node.connectorLineStyle === 'ELBOWED'
      ? 'elbow'
      : node.connectorLineStyle === 'STRAIGHT' ? 'straight' : 'bezier';
    const arrow = (cap) => (cap === 'ARROW_LINES' || cap === 'ARROW' ? 'arrow' : 'none');
    const from = guidId(node.connectorStart?.endpointNodeID);
    const to = guidId(node.connectorEnd?.endpointNodeID);
    // A connector with both ends on the same node is a loop the board cannot draw.
    if (!from || !to || from === to) continue;
    if (!builtIds.has(from) || !builtIds.has(to)) continue;
    const id = idOf(node);
    if (seenEdges.has(id)) continue;
    seenEdges.add(id);
    edges.push({
      id,
      from,
      to,
      fromAnchor: anchorOf(node.connectorStart?.magnet),
      toAnchor: anchorOf(node.connectorEnd?.magnet),
      label: String(node.connectorLabelText || '').slice(0, 200),
      stroke,
      strokeWidth: Number.isFinite(weight) && weight > 0 ? Math.min(8, Math.max(1, weight)) : 2,
      dash: dashed ? 'dashed' : 'solid',
      startArrow: arrow(node.connectorStartCap),
      endArrow: arrow(node.connectorEndCap),
      curve,
    });
    report.imported.edge += 1;
  }

  // A partial archive carries thumbnails instead of originals. Saying so is
  // the difference between "the import lost my pictures" and "the file only
  // kept small versions of them".
  if (report.imported.imageThumbnail > 0) {
    report.warnings.unshift(
      `${report.imported.imageThumbnail} image${report.imported.imageThumbnail === 1 ? '' : 's'} came through as `
      + 'thumbnails: the archive did not embed the originals',
    );
  }
  if (!nodes.length) {
    throw failure('This Figma file has nothing that a board can hold', 'FIG_UNSUPPORTED');
  }
  if (report.warnings.length > 8) report.warnings = report.warnings.slice(0, 8);
  return { nodes, edges, report };
}

/** The media type of image bytes, from their magic number. */
function sniffImageType(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
  if (bytes[0] === 0x52 && bytes[1] === 0x49) return 'image/webp';
  return 'image/png';
}

/**
 * Turn a vector node into an SVG asset.
 *
 * Figma draws these with a vector network the board has no editor for, so the
 * shape is baked into an SVG of the same size: the picture is faithful, the
 * geometry is not editable. That is the honest trade for "restore as much as
 * possible".
 */
async function vectorAsset(fig, document_, node, base, saveAsset, report) {
  if (!saveAsset) return null;
  let paths;
  try {
    paths = fig.resolveVectorNodePaths(document_, node);
  } catch {
    return null;
  }
  const fill = paths?.fill ?? [];
  const stroke = paths?.stroke ?? [];
  if (!fill.length && !stroke.length) return null;

  const width = Math.max(1, base.w);
  const height = Math.max(1, base.h);
  const fillColor = solidFill(node.fillPaints) || 'currentColor';
  const strokeColor = solidFill(node.strokePaints);
  const strokeWidth = Math.max(0, Math.min(64, Number(node.strokeWeight) || 0));

  const body = [];
  for (const path of fill) {
    if (!path?.svgPath) continue;
    body.push(`<path d="${escapeAttribute(path.svgPath)}" fill="${fillColor}"/>`);
  }
  for (const path of stroke) {
    if (!path?.svgPath) continue;
    const paint = strokeColor || 'currentColor';
    body.push(`<path d="${escapeAttribute(path.svgPath)}" fill="none" stroke="${paint}" stroke-width="${strokeWidth || 1}"/>`);
  }
  if (!body.length) return null;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body.join('')}</svg>`;
  const bytes = new TextEncoder().encode(svg);
  const assetId = await saveAsset(bytes, 'image/svg+xml', node.name || 'fig-vector');
  return { assetId, kind: 'image/svg+xml' };
}

/** Escape the characters that would break an SVG attribute. */
function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
