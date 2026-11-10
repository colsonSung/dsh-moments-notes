/**
 * Design deliverables: one board, three files a person can hand over.
 *
 * The renderer reads the stored scene document — the same coordinates the
 * canvas shows — so an export cannot drift from what the board looks like.
 * SVG is the vector proof, HTML/CSS is the handoff a developer can open, and
 * the spec is the machine-readable inventory (colours, type scale, radii,
 * flow containers) a design-system review starts from.
 */

const FONT_STACKS = Object.freeze({
  sans: 'Inter, "SF Pro Text", "Helvetica Neue", system-ui, sans-serif',
  serif: 'Georgia, "Times New Roman", Times, serif',
  mono: '"SF Mono", Menlo, Consolas, monospace',
  display: '"SF Pro Display", Inter, "Helvetica Neue", system-ui, sans-serif',
});
const ASSET_ROUTE = '/api/moments-notes/asset';
const IMAGE_EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function hexChannels(hex) {
  const raw = String(hex || '#000000').replace('#', '');
  const full = raw.length === 3 ? raw.split('').map((part) => part + part).join('') : raw;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

function rgba(hex, alpha) {
  const [r, g, b] = hexChannels(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha === undefined ? 1 : alpha})`;
}

function safeId(node) {
  return String(node.id).replace(/[^a-zA-Z0-9_-]/g, '');
}

function shadowCss(shadow) {
  return `${shadow.x}px ${shadow.y}px ${shadow.blur}px ${rgba(shadow.color, shadow.opacity)}`;
}

function gradientCss(gradient) {
  return `linear-gradient(${gradient.angle}deg, ${gradient.from}, ${gradient.to})`;
}

function assetUrl(node) {
  if (!node.assetId) return '';
  const extension = IMAGE_EXTENSIONS[node.kind] || 'png';
  return `${ASSET_ROUTE}?id=${encodeURIComponent(node.assetId)}&ext=${extension}`;
}

function transformOf(node) {
  const parts = [];
  if (node.rotation) parts.push(`rotate(${node.rotation}deg)`);
  if (node.flipX || node.flipY) parts.push(`scale(${node.flipX ? -1 : 1}, ${node.flipY ? -1 : 1})`);
  return parts.join(' ');
}

function screenOf(board) {
  return board.nodes.find((node) => node.type === 'frame') || null;
}

/** The points of a polygon or star, measured inside a w×h box. */
function shapePoints(w, h, count, star) {
  const cx = w / 2;
  const cy = h / 2;
  const rx = w / 2;
  const ry = h / 2;
  const inner = star ? 0.42 : 1;
  const steps = star ? count * 2 : count;
  const points = [];
  for (let index = 0; index < steps; index += 1) {
    const ratio = star && index % 2 === 1 ? inner : 1;
    const angle = (Math.PI * 2 * index) / steps - Math.PI / 2;
    points.push(`${(cx + Math.cos(angle) * rx * ratio).toFixed(2)},${(cy + Math.sin(angle) * ry * ratio).toFixed(2)}`);
  }
  return points.join(' ');
}

/** One cubic segment of a vector path, or a straight line when it has no handles. */
function pathSegment(from, to) {
  const out = from.out;
  const incoming = to.in;
  if (!out && !incoming) return ` L ${to.x} ${to.y}`;
  const control1 = out ? `${from.x + out.x} ${from.y + out.y}` : `${from.x} ${from.y}`;
  const control2 = incoming ? `${to.x + incoming.x} ${to.y + incoming.y}` : `${to.x} ${to.y}`;
  return ` C ${control1} ${control2} ${to.x} ${to.y}`;
}

/** The `d` of a vector path, in the node's own box coordinates. */
function pathD(node) {
  const path = node.path;
  if (!path || !Array.isArray(path.points) || path.points.length < 2) return '';
  const [first] = path.points;
  let d = `M ${first.x} ${first.y}`;
  for (let index = 0; index < path.points.length - 1; index += 1) {
    d += pathSegment(path.points[index], path.points[index + 1]);
  }
  if (path.closed) {
    d += pathSegment(path.points[path.points.length - 1], first);
    d += ' Z';
  }
  return d;
}

function svgPaint(node) {
  const fill = node.gradient ? `url(#grad-${safeId(node)})` : node.fill || 'none';
  const stroke = node.stroke || 'none';
  return `fill="${fill}" stroke="${stroke}" stroke-width="${node.strokeWidth || 0}"`;
}

function svgShapeBody(node) {
  const w = Math.max(1, node.w);
  const h = Math.max(1, node.h);
  const paint = svgPaint(node);
  const label = node.text ? svgShapeLabel(node) : '';
  const radius = Math.min(node.radius || 0, w / 2, h / 2);
  if (node.shape === 'ellipse') return `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2}" ${paint}/>${label}`;
  if (node.shape === 'line' || node.shape === 'arrow') {
    const stroke = node.stroke || '#94a3b8';
    const width = node.strokeWidth || 2;
    const line = `<line x1="0" y1="${h / 2}" x2="${w}" y2="${h / 2}" fill="none" stroke="${stroke}" stroke-width="${width}"/>`;
    const head = node.shape === 'arrow'
      ? `<path d="M ${w} ${h / 2} L ${w - 10} ${h / 2 - 6} L ${w - 10} ${h / 2 + 6} z" fill="${stroke}"/>`
      : '';
    return line + head;
  }
  if (node.shape === 'path') {
    const pathPaint = node.fill ? paint : `fill="none" stroke="${node.stroke || 'none'}" stroke-width="${node.strokeWidth || 0}"`;
    return `<path d="${pathD(node)}" ${pathPaint}/>${label}`;
  }
  if (node.shape === 'polygon') return `<polygon points="${shapePoints(w, h, node.sides || 5, false)}" ${paint}/>${label}`;
  if (node.shape === 'star') return `<polygon points="${shapePoints(w, h, node.points || 5, true)}" ${paint}/>${label}`;
  return `<rect x="0" y="0" width="${w}" height="${h}" rx="${radius}" ry="${radius}" ${paint}/>${label}`;
}

/** A FigJam-style centred label inside a shape. */
function svgShapeLabel(node) {
  const size = node.fontSize || 14;
  const lineHeight = (node.lineHeight || 1.25) * size;
  const lines = textLines(node);
  const firstBaseline = (node.h - lines.length * lineHeight) / 2 + size * 0.82;
  return `<text x="${node.w / 2}" font-family="${attr(FONT_STACKS[node.fontFamily] || FONT_STACKS.sans)}" font-size="${size}" fill="${node.textColor || '#0f172a'}" text-anchor="middle">`
    + lines.map((line, index) => svgLineSpans(
      line,
      node.w / 2,
      (firstBaseline + index * lineHeight).toFixed(2),
    )).join('')
    + '</text>';
}

function svgTextBox(node) {
  const w = Math.max(1, node.w);
  const size = node.fontSize || 14;
  const lineHeight = (node.lineHeight || 1.25) * size;
  const lines = textLines(node);
  const anchor = node.textAlign === 'center' ? 'middle' : node.textAlign === 'right' ? 'end' : 'start';
  const x = node.textAlign === 'center' ? w / 2 : node.textAlign === 'right' ? w : 0;
  const attributes = [
    `x="${x}"`,
    `font-family="${attr(FONT_STACKS[node.fontFamily] || FONT_STACKS.sans)}"`,
    `font-size="${size}"`,
    node.fontWeight ? `font-weight="${node.fontWeight}"` : '',
    node.letterSpacing !== null && node.letterSpacing !== undefined ? `letter-spacing="${node.letterSpacing}"` : '',
    `fill="${node.textColor || '#0f172a'}"`,
    `text-anchor="${anchor}"`,
    node.opacity !== undefined && node.opacity !== null ? `opacity="${node.opacity}"` : '',
  ].filter(Boolean).join(' ');
  const runs = lines.map((line, index) => svgLineSpans(
    line,
    x,
    (size * 0.98 + index * lineHeight).toFixed(2),
  )).join('');
  return `<text ${attributes}>${runs}</text>`;
}

/**
 * How wide one character is, in em units.
 *
 * SVG has no text measurement, so wrapping has to be estimated. The table is
 * deliberately conservative: a slightly early break reads far better than a
 * line that overflows its box in the handoff file.
 */
function charEm(char, family) {
  if (family === 'mono') return 0.6;
  if (char === ' ') return 0.28;
  if (/[iljtfr1.,:;'!|]/.test(char)) return 0.3;
  if (/[mwMW@%]/.test(char)) return 0.88;
  if (/[A-Z0-9]/.test(char)) return 0.62;
  if (/[a-z]/.test(char)) return 0.52;
  return 0.62;
}

/** The styled characters of a text node, wrapped at the node width. */
function textLines(node) {
  const size = node.fontSize || 14;
  const limit = Math.max(1, node.w);
  const chunks = Array.isArray(node.spans) && node.spans.length
    ? node.spans.map((span) => ({
      text: String(span.text),
      style: {
        fontWeight: span.fontWeight,
        textColor: span.textColor,
        italic: span.italic,
        underline: span.underline,
      },
    }))
    : [{ text: String(node.text || ''), style: {} }];

  // Paragraphs come first: a stored newline is a hard break, never wrapped.
  const paragraphs = [[]];
  for (const chunk of chunks) {
    chunk.text.split('\n').forEach((part, index) => {
      if (index > 0) paragraphs.push([]);
      paragraphs[paragraphs.length - 1].push({ text: part, style: chunk.style });
    });
  }

  const lines = [];
  for (const paragraph of paragraphs) {
    const chars = [];
    for (const run of paragraph) {
      for (const char of run.text) chars.push({ char, style: run.style });
    }
    let line = [];
    let width = 0;
    for (const item of chars) {
      const advance = charEm(item.char, node.fontFamily) * size;
      if (width + advance > limit && line.length && item.char !== ' ') {
        let cut = line.length;
        for (let index = line.length - 1; index >= 0; index -= 1) {
          if (line[index].char === ' ') { cut = index; break; }
        }
        const head = cut < line.length ? line.slice(0, cut) : line;
        const tail = cut < line.length ? line.slice(cut + 1) : [];
        lines.push(head);
        line = tail;
        width = tail.reduce((sum, entry) => sum + charEm(entry.char, node.fontFamily) * size, 0);
      }
      line.push(item);
      width += advance;
    }
    lines.push(line);
  }
  return lines;
}

/** One wrapped line as tspans, with a new tspan whenever the style changes. */
function svgLineSpans(line, x, y) {
  if (!line.length) return `<tspan x="${x}" y="${y}"></tspan>`;
  const groups = [];
  for (const item of line) {
    const key = JSON.stringify(item.style);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.text += item.char;
    else groups.push({ key, style: item.style, text: item.char });
  }
  return groups.map((group) => {
    const style = [
      group.style.fontWeight ? `font-weight="${group.style.fontWeight}"` : '',
      group.style.textColor ? `fill="${group.style.textColor}"` : '',
      group.style.italic ? 'font-style="italic"' : '',
      group.style.underline ? 'text-decoration="underline"' : '',
    ].filter(Boolean).join(' ');
    return `<tspan x="${x}" y="${y}"${style ? ` ${style}` : ''}>${escapeHtml(group.text)}</tspan>`;
  }).join('');
}

/** One node as an SVG group, with its own gradient and shadow definitions. */
function gradientDef(node) {
  if (!node.gradient) return '';
  const rad = (node.gradient.angle * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  return `<linearGradient id="grad-${safeId(node)}" x1="${50 - dx * 50}%" y1="${50 - dy * 50}%" x2="${50 + dx * 50}%" y2="${50 + dy * 50}%">`
    + `<stop offset="0%" stop-color="${node.gradient.from}"/><stop offset="100%" stop-color="${node.gradient.to}"/></linearGradient>`;
}

function svgNode(node, defs) {
  const id = safeId(node);
  if (node.gradient) defs.push(`  ${gradientDef(node)}`);
  // One filter per node: a node can be blurred and shadowed at the same time,
  // and SVG only lets a node name a single filter.
  const effects = [];
  if (node.shadow) {
    effects.push(`<feDropShadow dx="${node.shadow.x}" dy="${node.shadow.y}" stdDeviation="${node.shadow.blur / 2}" `
      + `flood-color="${node.shadow.color}" flood-opacity="${node.shadow.opacity}"/>`);
  }
  if (node.blur) effects.push(`<feGaussianBlur stdDeviation="${node.blur / 2}"/>`);
  if (effects.length) {
    defs.push(`  <filter id="fx-${id}" x="-50%" y="-50%" width="200%" height="200%">${effects.join('')}</filter>`);
  }
  let body = '';
  if (node.type === 'shape') body = svgShapeBody(node);
  else if (node.type === 'image' && node.assetId) {
    body = `<image x="0" y="0" width="${node.w}" height="${node.h}" href="${escapeHtml(assetUrl(node))}" preserveAspectRatio="xMidYMid slice"/>`;
  } else if (node.type === 'frame' || node.type === 'group' || node.type === 'sticky' || node.type === 'note') {
    body = `<rect x="0" y="0" width="${Math.max(1, node.w)}" height="${Math.max(1, node.h)}" rx="${node.radius || 0}" ${svgPaint(node)}/>`;
  } else if (node.type === 'text') body = svgTextBox(node);
  const attributes = [
    `transform="translate(${node.x} ${node.y})${node.rotation ? ` rotate(${node.rotation})` : ''}${node.flipX || node.flipY ? ` scale(${node.flipX ? -1 : 1}, ${node.flipY ? -1 : 1})` : ''}"`,
    node.opacity !== undefined && node.opacity !== null ? `opacity="${node.opacity}"` : '',
    effects.length ? `filter="url(#fx-${id})"` : '',
  ].filter(Boolean).join(' ');
  return `  <g ${attributes}>${body}</g>`;
}

/** The point on a node a connector is pinned to. */
function edgePoint(node, anchor) {
  if (anchor === 'left') return { x: node.x, y: node.y + node.h / 2 };
  if (anchor === 'right') return { x: node.x + node.w, y: node.y + node.h / 2 };
  if (anchor === 'top') return { x: node.x + node.w / 2, y: node.y };
  if (anchor === 'bottom') return { x: node.x + node.w / 2, y: node.y + node.h };
  return { x: node.x + node.w / 2, y: node.y + node.h / 2 };
}

/** One head of a connector, drawn from the line's own geometry. */
function edgeHeadSvg(kind, point, angle, width, color, id) {
  if (!kind || kind === 'none') return '';
  const length = Math.min(8.5, 5 + width * 1.25);
  const spread = 0.58;
  const round = (value) => Math.round(value * 100) / 100;
  if (kind === 'circle') {
    const radius = Math.max(3, width * 2.4);
    return `<circle cx="${round(point.x)}" cy="${round(point.y)}" r="${round(radius)}" fill="${color}"/>`;
  }
  const left = {
    x: point.x - Math.cos(angle - spread) * length,
    y: point.y - Math.sin(angle - spread) * length,
  };
  const right = {
    x: point.x - Math.cos(angle + spread) * length,
    y: point.y - Math.sin(angle + spread) * length,
  };
  if (kind === 'triangle') {
    return `<path d="M ${round(left.x)} ${round(left.y)} L ${round(point.x)} ${round(point.y)} L ${round(right.x)} ${round(right.y)} Z" fill="${color}"/>`;
  }
  return `<path d="M ${round(left.x)} ${round(left.y)} L ${round(point.x)} ${round(point.y)} L ${round(right.x)} ${round(right.y)}" fill="none" stroke="${color}" stroke-width="${round(Math.max(1.2, Math.min(2.25, width * 0.6)))}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

/** The side an automatic connector uses: the one facing the other end. */
function edgeAutoAnchor(node, other) {
  const center = { x: node.x + node.w / 2, y: node.y + node.h / 2 };
  const target = { x: other.x + other.w / 2, y: other.y + other.h / 2 };
  const dx = target.x - center.x;
  const dy = target.y - center.y;
  if (dx === 0 && dy === 0) return 'right';
  const horizontal = Math.abs(dx) / Math.max(1, node.w / 2);
  const vertical = Math.abs(dy) / Math.max(1, node.h / 2);
  if (horizontal >= vertical) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}

/** The side one end is pinned to, resolving `auto` against the other end. */
function edgeSide(edge, node, other, key) {
  const anchor = key === 'from' ? (edge.fromAnchor || 'auto') : (edge.toAnchor || 'auto');
  return anchor === 'auto' ? edgeAutoAnchor(node, other) : anchor;
}

/** The outward normal of a side. */
function edgeNormal(side) {
  if (side === 'left') return { x: -1, y: 0 };
  if (side === 'right') return { x: 1, y: 0 };
  if (side === 'top') return { x: 0, y: -1 };
  return { x: 0, y: 1 };
}

/**
 * The geometry of one connector: where it starts and ends, the path to draw,
 * and the direction it travels at each end. Exported so the routing can be
 * asserted and audited without parsing SVG.
 */
export function connectorGeometry(edge, nodes) {
  const from = nodes.find((node) => node.id === edge.from);
  const to = nodes.find((node) => node.id === edge.to);
  if (!from || !to) return '';
  const fromSide = edgeSide(edge, from, to, 'from');
  const toSide = edgeSide(edge, to, from, 'to');
  const start = edgePoint(from, fromSide);
  const end = edgePoint(to, toSide);
  const startNormal = edgeNormal(fromSide);
  const endNormal = edgeNormal(toSide);
  const curve = edge.curve || 'bezier';
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy);
  const round = (value) => Math.round(value * 100) / 100;
  let d;
  let startAngle;
  let endAngle;

  if (curve === 'straight') {
    d = `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
    startAngle = Math.atan2(dy, dx);
    endAngle = startAngle;
  } else if (curve === 'elbow') {
    const stub = Math.max(16, Math.min(40, distance / 3));
    const first = { x: start.x + startNormal.x * stub, y: start.y + startNormal.y * stub };
    const last = { x: end.x + endNormal.x * stub, y: end.y + endNormal.y * stub };
    const points = [start, first];
    const horizontalLeave = Math.abs(startNormal.x) >= Math.abs(startNormal.y);
    if (Math.abs(first.x - last.x) > 0.5 && Math.abs(first.y - last.y) > 0.5) {
      if (horizontalLeave) {
        const middle = (first.x + last.x) / 2;
        points.push({ x: middle, y: first.y }, { x: middle, y: last.y });
      } else {
        const middle = (first.y + last.y) / 2;
        points.push({ x: first.x, y: middle }, { x: last.x, y: middle });
      }
    }
    points.push(last, end);
    const cleaned = points.filter((point, index) => (
      index === 0 || Math.hypot(point.x - points[index - 1].x, point.y - points[index - 1].y) > 0.5
    ));
    d = cleaned.map((point, index) => `${index === 0 ? 'M' : 'L'} ${round(point.x)} ${round(point.y)}`).join(' ');
    startAngle = Math.atan2(cleaned[1].y - start.y, cleaned[1].x - start.x);
    const beforeEnd = cleaned[cleaned.length - 2];
    endAngle = Math.atan2(end.y - beforeEnd.y, end.x - beforeEnd.x);
  } else {
    const bend = Math.max(24, Math.min(80, distance / 3));
    const c1 = { x: start.x + startNormal.x * bend, y: start.y + startNormal.y * bend };
    const c2 = { x: end.x + endNormal.x * bend, y: end.y + endNormal.y * bend };
    d = `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`;
    startAngle = Math.atan2(startNormal.y, startNormal.x);
    endAngle = Math.atan2(-endNormal.y, -endNormal.x);
  }

  return { d, start, end, startAngle, endAngle, fromSide, toSide };
}

/** The line and heads of one connector, in board coordinates. */
function edgeSvg(edge, nodes) {
  const geometry = connectorGeometry(edge, nodes);
  if (!geometry) return '';
  const { d, start, end, startAngle, endAngle } = geometry;
  const color = edge.stroke || '#64748b';
  const width = Number(edge.strokeWidth) || 2;
  const dash = edge.dash === 'dashed' ? ' stroke-dasharray="9 5"' : edge.dash === 'dotted' ? ' stroke-dasharray="1 5"' : '';
  const head = edgeHeadSvg(edge.endArrow || 'arrow', end, endAngle, width, color, edge.id);
  const tail = edgeHeadSvg(edge.startArrow || 'none', start, startAngle + Math.PI, width, color, edge.id);
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"${dash}/>${tail}${head}`;
}

/** Draw one board as a standalone SVG document. */
export function exportSvg(board) {
  const screen = screenOf(board);
  const width = screen ? screen.w : 1440;
  const height = screen ? screen.h : 900;
  const background = screen && screen.fill ? screen.fill : '#ffffff';
  const defs = [];
  const connectors = (board.edges || []).map((edge) => edgeSvg(edge, board.nodes)).filter(Boolean).join('\n');
  const groups = [];
  for (const node of board.nodes) {
    if (node === screen || node.visible === false) continue;
    groups.push(svgNode(node, defs));
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n`
    + `  <rect width="100%" height="100%" fill="${background}"/>\n`
    + (defs.length ? `  <defs>\n${defs.join('\n')}\n  </defs>\n` : '')
    + connectors
    + `${groups.join('\n')}\n</svg>\n`;
}

/** An attribute value with quotes neutralised: font stacks carry real quotes. */
function attr(value) {
  return String(value).replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** The inner HTML of a text node: styled runs, or the plain characters. */
function htmlTextRuns(node) {
  if (!Array.isArray(node.spans) || !node.spans.length) return escapeHtml(node.text || '');
  return node.spans.map((span) => {
    const style = [
      span.fontWeight ? `font-weight:${span.fontWeight}` : '',
      span.textColor ? `color:${span.textColor}` : '',
      span.italic ? 'font-style:italic' : '',
      span.underline ? 'text-decoration:underline' : '',
    ].filter(Boolean).join(';');
    return `<span${style ? ` style="${style}"` : ''}>${escapeHtml(span.text)}</span>`;
  }).join('');
}

/** The filter and blend declarations a rendered node needs, if any. */
function effectCss(node) {
  const declarations = [];
  if (node.blur) declarations.push(`filter:blur(${node.blur}px)`);
  if (node.blend && node.blend !== 'normal') declarations.push(`mix-blend-mode:${node.blend}`);
  return declarations.join(';');
}

function boxCss(node) {
  const declarations = [];
  if (node.fill) declarations.push(`background:${node.fill}`);
  if (node.gradient) declarations.push(`background:${gradientCss(node.gradient)}`);
  if (node.stroke && node.strokeWidth) declarations.push(`border:${node.strokeWidth}px solid ${node.stroke}`);
  else if (node.stroke) declarations.push(`outline:1px solid ${node.stroke}`);
  if (node.radius) declarations.push(`border-radius:${node.radius}px`);
  if (node.opacity !== undefined && node.opacity !== null && node.opacity !== 1) declarations.push(`opacity:${node.opacity}`);
  if (node.shadow) declarations.push(`box-shadow:${shadowCss(node.shadow)}`);
  if (node.blur) declarations.push(`filter:blur(${node.blur}px)`);
  if (node.blend && node.blend !== 'normal') declarations.push(`mix-blend-mode:${node.blend}`);
  return declarations.join(';');
}

function textCss(node) {
  const declarations = [
    `font-family:${FONT_STACKS[node.fontFamily] || FONT_STACKS.sans}`,
    `font-size:${node.fontSize || 14}px`,
  ];
  if (node.fontWeight) declarations.push(`font-weight:${node.fontWeight}`);
  declarations.push(`line-height:${node.lineHeight || 1.25}`);
  if (node.letterSpacing !== null && node.letterSpacing !== undefined) declarations.push(`letter-spacing:${node.letterSpacing}px`);
  if (node.textColor) declarations.push(`color:${node.textColor}`);
  if (node.textAlign) declarations.push(`text-align:${node.textAlign}`);
  return declarations.join(';');
}

function nodePosition(node, extra = '') {
  const transform = transformOf(node);
  return `position:absolute;left:${node.x}px;top:${node.y}px;width:${Math.max(1, node.w)}px;height:${Math.max(1, node.h)}px`
    + (transform ? `;transform:${transform}` : '')
    + (extra ? `;${extra}` : '');
}

/** Draw one board as a standalone HTML page a developer can open. */
export function exportHtml(board) {
  const screen = screenOf(board);
  const width = screen ? screen.w : 1440;
  const height = screen ? screen.h : 900;
  const background = screen && screen.fill ? screen.fill : '#ffffff';
  const blocks = [];
  for (const node of board.nodes) {
    if (node === screen || node.visible === false) continue;
    const effects = effectCss(node);
    if (node.type === 'shape') {
      blocks.push(`  <svg class="node shape" data-id="${escapeHtml(node.id)}" style="${escapeHtml(`${nodePosition(node)};overflow:visible${effects ? `;${effects}` : ''}`)}" `
        + `width="${Math.max(1, node.w)}" height="${Math.max(1, node.h)}" viewBox="0 0 ${Math.max(1, node.w)} ${Math.max(1, node.h)}">`
        + (node.gradient ? `<defs>${gradientDef(node)}</defs>` : '')
        + `<g${node.shadow ? ` style="filter:drop-shadow(${shadowCss(node.shadow)})"` : ''}>${svgShapeBody(node)}</g></svg>`);
      continue;
    }
    if (node.type === 'image' && node.assetId) {
      blocks.push(`  <img class="node image" data-id="${escapeHtml(node.id)}" alt="${escapeHtml(node.text || 'design image')}" src="${escapeHtml(assetUrl(node))}" style="${escapeHtml(`${nodePosition(node)};object-fit:cover`)}"/>`);
      continue;
    }
    if (node.type === 'text') {
      blocks.push(`  <div class="node text" data-id="${escapeHtml(node.id)}" style="${escapeHtml(`${nodePosition(node)};${textCss(node)};white-space:pre-wrap;word-break:break-word${effects ? `;${effects}` : ''}`)}">${htmlTextRuns(node)}</div>`);
      continue;
    }
    blocks.push(`  <div class="node box" data-id="${escapeHtml(node.id)}" data-type="${escapeHtml(node.type)}" style="${escapeHtml(`${nodePosition(node)};${boxCss(node)}`)}"></div>`);
  }
  const title = escapeHtml(board.title || 'Design');
  const connectors = (board.edges || []).length
    ? `<svg class="edges" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
      + (board.edges || []).map((edge) => edgeSvg(edge, board.nodes)).filter(Boolean).join('')
      + '</svg>'
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: ${background}; }
  .screen { position: relative; width: ${width}px; height: ${height}px; overflow: hidden; background: ${background}; }
  .node { margin: 0; }
  .text { overflow: hidden; }
  .edges { position: absolute; inset: 0; overflow: visible; pointer-events: none; }
</style>
</head>
<body>
<div class="screen">
${connectors}
${blocks.join('\n')}
</div>
</body>
</html>
`;
}

/**
 * Serve one board as an SVG for the chat tool card.
 *
 * The card shows the same vector the exporter writes: one renderer, so a
 * preview can never disagree with the deliverable. A missing board is a 404
 * rather than an empty picture.
 */
export function createDesignPreviewHandler({ getCanvasStore }) {
  return async (request) => {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    if (!id) return new Response('A design preview needs a board id', { status: 400 });
    const store = getCanvasStore?.();
    if (!store) return new Response('The design store is unavailable', { status: 503 });
    try {
      const board = await store.load(id);
      return new Response(exportSvg(board), {
        status: 200,
        headers: {
          'content-type': 'image/svg+xml; charset=utf-8',
          'cache-control': 'no-store',
        },
      });
    } catch {
      return new Response('Board not found', { status: 404 });
    }
  };
}

/** The machine-readable inventory of one board. */
export function exportSpec(board) {
  const nodes = board.nodes;
  const colors = new Set();
  const radii = new Set();
  const type = new Map();
  const shadows = [];
  const flow = [];
  for (const node of nodes) {
    for (const value of [node.fill, node.stroke, node.textColor]) {
      if (typeof value === 'string' && value.startsWith('#')) colors.add(value.toLowerCase());
    }
    if (node.gradient) {
      colors.add(node.gradient.from.toLowerCase());
      colors.add(node.gradient.to.toLowerCase());
    }
    if (node.radius) radii.add(node.radius);
    if (node.shadow) shadows.push({ node: node.id, ...node.shadow });
    if (node.type === 'text') {
      const key = JSON.stringify({
        fontFamily: node.fontFamily || 'sans',
        fontSize: node.fontSize || 14,
        fontWeight: node.fontWeight || 400,
        lineHeight: node.lineHeight || null,
        letterSpacing: node.letterSpacing || 0,
      });
      type.set(key, (type.get(key) || 0) + 1);
    }
    if (node.type === 'frame' || node.type === 'group') {
      if (node.layout && node.layout !== 'none') {
        flow.push({ node: node.id, layout: node.layout, gap: node.gap, padding: node.padding, align: node.align });
      }
    }
  }
  const screen = screenOf(board);
  const counts = {};
  for (const node of nodes) counts[node.type] = (counts[node.type] || 0) + 1;
  return {
    board: { id: board.id, title: board.title, width: screen ? screen.w : null, height: screen ? screen.h : null, background: screen ? screen.fill : null },
    nodeCount: nodes.length,
    counts,
    colors: [...colors].sort(),
    tokens: {
      colors: board.tokens?.colors || {},
      gradients: board.tokens?.gradients || {},
      type: board.tokens?.type || {},
    },
    radii: [...radii].sort((a, b) => a - b),
    typography: [...type.entries()].map(([key, count]) => ({ ...JSON.parse(key), count })).sort((a, b) => b.fontSize - a.fontSize),
    shadows,
    flow,
  };
}
