import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeCanvasDocument } from '../lib/canvas-domain.js';
import { connectorGeometry, exportHtml, exportSpec, exportSvg } from '../lib/design-export.js';
import { createDesignTools } from '../lib/design-tools.js';

function board() {
  return normalizeCanvasDocument({
    version: 1,
    id: 'board-1',
    title: 'Checkout',
    createdAt: 1,
    updatedAt: 2,
    camera: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'screen', type: 'frame', x: 0, y: 0, w: 1440, h: 900, fill: '#f8fafc', members: ['title', 'cta', 'row'] },
      { id: 'title', type: 'text', x: 64, y: 80, w: 700, h: 120, text: 'Pay & <go>', fontSize: 48, fontWeight: 700, fontFamily: 'display', lineHeight: 1.1, letterSpacing: -1.5, textColor: '#0f172a' },
      { id: 'cta', type: 'shape', shape: 'rect', x: 64, y: 240, w: 200, h: 56, radius: 12, fill: '#635bff', gradient: { from: '#635bff', to: '#8b83ff', angle: 135 }, shadow: { x: 0, y: 10, blur: 24, color: '#635bff', opacity: 0.4 }, rotation: 0 },
      { id: 'row', type: 'frame', x: 64, y: 360, w: 800, h: 200, layout: 'row', gap: 16, padding: 8, align: 'stretch', members: ['card'] },
      { id: 'card', type: 'frame', x: 72, y: 368, w: 200, h: 184, fill: '#ffffff', stroke: '#e2e8f0', strokeWidth: 1, radius: 16, members: [] },
      { id: 'photo', type: 'image', x: 900, y: 80, w: 240, h: 160, assetId: '123e4567-e89b-12d3-a456-426614174000', kind: 'image/png' },
    ],
    edges: [],
  });
}

test('SVG export carries the screen, gradients, shadows and type', () => {
  const svg = exportSvg(board());
  assert.match(svg, /<svg[^>]*width="1440"[^>]*height="900"/);
  assert.match(svg, /<rect width="100%" height="100%" fill="#f8fafc"/);
  assert.match(svg, /linearGradient id="grad-cta"/);
  assert.match(svg, /url\(#grad-cta\)/);
  assert.match(svg, /feDropShadow[^>]*flood-opacity="0.4"/);
  assert.match(svg, /font-weight="700"/);
  assert.match(svg, /letter-spacing="-1.5"/);
  assert.match(svg, /<image[^>]*href="\/api\/moments-notes\/asset\?id=123e4567-e89b-12d3-a456-426614174000&amp;ext=png"/);
});

test('SVG export escapes markup from node text', () => {
  const svg = exportSvg(board());
  assert.match(svg, /Pay &amp; &lt;go&gt;/);
  assert.doesNotMatch(svg, /Pay & <go>/);
});

test('HTML export renders positioned nodes, gradients and shadows', () => {
  const html = exportHtml(board());
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /\.screen \{ position: relative; width: 1440px; height: 900px/);
  assert.match(html, /left:64px;top:80px;width:700px;height:120px/);
  // The stack carries double quotes, so it must be escaped inside the style attribute.
  assert.match(html, /font-family:&quot;SF Pro Display&quot;/);
  assert.match(html, /font-weight:700/);
  assert.match(html, /letter-spacing:-1.5px/);
  assert.match(html, /<linearGradient id="grad-cta"/);
  assert.match(html, /url\(#grad-cta\)/);
  assert.match(html, /filter:drop-shadow\(0px 10px 24px rgba\(99, 91, 255, 0.4\)\)/);
  assert.match(html, /white-space:pre-wrap/);
  assert.match(html, /font-size:48px;font-weight:700;line-height:1.1;letter-spacing:-1.5px;color:#0f172a/);
  assert.match(html, /Pay &amp; &lt;go&gt;/);
});

test('spec export lists colours, type scale, radii, shadows and flow containers', () => {
  const spec = exportSpec(board());
  assert.equal(spec.board.width, 1440);
  assert.equal(spec.nodeCount, 6);
  assert.deepEqual(spec.counts, { frame: 3, text: 1, shape: 1, image: 1 });
  for (const colour of ['#0f172a', '#635bff', '#8b83ff', '#e2e8f0', '#f8fafc', '#ffffff']) {
    assert.ok(spec.colors.includes(colour), `spec lists ${colour}`);
  }
  const hero = spec.typography.find((entry) => entry.fontSize === 48);
  assert.equal(hero.fontWeight, 700);
  assert.equal(hero.fontFamily, 'display');
  assert.equal(hero.letterSpacing, -1.5);
  assert.deepEqual(spec.radii, [12, 16]);
  assert.equal(spec.shadows.length, 1);
  assert.deepEqual(spec.flow, [{ node: 'row', layout: 'row', gap: 16, padding: 8, align: 'stretch' }]);
});

test('the design_export tool writes files and rejects unusable calls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'moments-export-'));
  const store = {
    async list() { return [board()]; },
    async load() { return board(); },
  };
  const exporter = createDesignTools({ getCanvasStore: () => store }).find((tool) => tool.name === 'design_export');
  try {
    const spec = await exporter.execute({ boardId: 'board-1', format: 'spec' });
    assert.equal(spec.ok, true);
    assert.equal(spec.data.spec.nodeCount, 6);

    const missingPath = await exporter.execute({ boardId: 'board-1', format: 'html' });
    assert.equal(missingPath.ok, false);
    assert.equal(missingPath.data.error.code, 'PATH_REQUIRED');

    const target = join(directory, 'checkout.html');
    const written = await exporter.execute({ boardId: 'board-1', format: 'html', path: target });
    assert.equal(written.ok, true);
    assert.equal(written.data.path, target);
    const content = await readFile(target, 'utf8');
    assert.match(content, /<!doctype html>/);
    assert.match(content, /Pay &amp; &lt;go&gt;/);

    const relative = await exporter.execute({ boardId: 'board-1', format: 'svg', path: 'relative.svg' });
    assert.equal(relative.ok, false);
    assert.equal(relative.data.error.code, 'INVALID_PATH');

    const svg = await exporter.execute({ boardId: 'board-1', format: 'svg' });
    assert.equal(svg.ok, true);
    assert.equal(svg.data.format, 'svg');
    assert.match(svg.data.content, /grad-cta/);

    const unknown = await exporter.execute({ boardId: 'board-1', format: 'pdf' });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.data.error.code, 'INVALID_FORMAT');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a vector path exports as a cubic path with its handles', () => {
  const document = normalizeCanvasDocument({
    version: 1,
    id: 'board-2',
    title: 'Vector',
    createdAt: 1,
    updatedAt: 2,
    camera: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'screen', type: 'frame', x: 0, y: 0, w: 400, h: 400, fill: '#ffffff', members: ['wave', 'dot'] },
      {
        id: 'wave', type: 'shape', shape: 'path', x: 40, y: 40, w: 240, h: 120, stroke: '#635bff', strokeWidth: 4,
        path: {
          closed: false,
          points: [
            { x: 0, y: 100, out: { x: 40, y: -80 } },
            { x: 120, y: 20, in: { x: -40, y: -20 }, out: { x: 40, y: 20 } },
            { x: 240, y: 100 },
          ],
        },
      },
      {
        id: 'dot', type: 'shape', shape: 'path', x: 300, y: 300, w: 60, h: 60, fill: '#e11d48',
        path: { closed: true, points: [{ x: 30, y: 0, out: { x: 20, y: 0 } }, { x: 30, y: 60, in: { x: 0, y: 20 } }, { x: 0, y: 30 }] },
      },
    ],
    edges: [],
  });
  const svg = exportSvg(document);
  assert.match(svg, /<path d="M 0 100 C 40 20 80 0 120 20 C 160 40 240 100 240 100" fill="none" stroke="#635bff" stroke-width="4"/);
  const closed = exportSvg(document).match(/<path d="M 30 0[^"]*Z"[^>]*fill="#e11d48"/);
  assert.ok(closed, 'a closed path paints its fill');
});


test('a blurred node exports a gaussian filter and its blend mode', () => {
  const document = normalizeCanvasDocument({
    version: 1,
    id: 'board-3',
    title: 'Effects',
    createdAt: 1,
    updatedAt: 2,
    camera: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'screen', type: 'frame', x: 0, y: 0, w: 400, h: 300, fill: '#ffffff', members: ['glow', 'tint'] },
      { id: 'glow', type: 'shape', shape: 'ellipse', x: 20, y: 20, w: 120, h: 120, fill: '#635bff', blur: 16 },
      { id: 'tint', type: 'shape', shape: 'rect', x: 160, y: 20, w: 120, h: 120, fill: '#22c55e', blend: 'multiply' },
    ],
    edges: [],
  });
  const svg = exportSvg(document);
  assert.match(svg, /<feGaussianBlur stdDeviation="8"\/>/, 'blur becomes a gaussian filter at half the radius');
  assert.match(svg, /filter="url\(#fx-glow\)"/);
  const html = exportHtml(document);
  assert.match(html, /filter:blur\(16px\)/);
  assert.match(html, /mix-blend-mode:multiply/);
});


test('rich text exports styled runs to SVG and HTML', () => {
  const document = normalizeCanvasDocument({
    version: 1,
    id: 'board-4',
    title: 'Runs',
    createdAt: 1,
    updatedAt: 2,
    camera: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'screen', type: 'frame', x: 0, y: 0, w: 400, h: 200, fill: '#ffffff', members: ['line'] },
      {
        id: 'line', type: 'text', x: 20, y: 20, w: 360, h: 60, fontSize: 20,
        spans: [
          { text: 'Pay ', fontWeight: 400 },
          { text: 'now', fontWeight: 800, textColor: '#635bff', italic: true },
        ],
      },
    ],
    edges: [],
  });
  const svg = exportSvg(document);
  assert.match(svg, /<tspan x="0" y="[^"]*" font-weight="400">Pay <\/tspan>/);
  assert.match(svg, /font-family="Inter, &quot;SF Pro Text&quot;/, 'a font stack keeps its quotes inside the attribute');
  assert.match(svg, /<tspan x="0" y="[^"]*" font-weight="800" fill="#635bff" font-style="italic">now<\/tspan>/);
  const html = exportHtml(document);
  assert.match(html, /<span style="font-weight:400">Pay <\/span>/);
  assert.match(html, /<span style="font-weight:800;color:#635bff;font-style:italic">now<\/span>/);
});


/** A minimal well-formedness check for the SVG we build by concatenation. */
function assertWellFormedSvg(svg) {
  assert.match(svg, /^<svg[^>]*>/, 'the document opens with an svg root');
  assert.match(svg, /<\/svg>\s*$/, 'the document closes the svg root');
  for (let index = 0; index < svg.length; index += 1) {
    if (svg[index] !== '<') continue;
    let quoted = false;
    let cursor = index + 1;
    for (; cursor < svg.length; cursor += 1) {
      const current = svg[cursor];
      if (current === '"') quoted = !quoted;
      else if (current === '>' && !quoted) break;
      else if (current === '<' && !quoted) throw new Error(`a tag at offset ${index} contains an unescaped <`);
    }
    assert.equal(quoted, false, `the tag at offset ${index} leaves an attribute value open`);
    index = cursor;
  }
}

test('every export is well-formed no matter which effects the board uses', () => {
  const document = normalizeCanvasDocument({
    version: 1,
    id: 'board-5',
    title: 'Well formed',
    createdAt: 1,
    updatedAt: 2,
    camera: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'screen', type: 'frame', x: 0, y: 0, w: 600, h: 400, fill: '#ffffff', members: ['title', 'card', 'wave'] },
      {
        id: 'title', type: 'text', x: 20, y: 20, w: 400, h: 40, fontFamily: 'display', fontSize: 28,
        text: 'A "quoted" & <angled> headline',
        spans: [{ text: 'A "quoted" ', fontWeight: 800 }, { text: '& <angled> headline', italic: true, textColor: '#635bff' }],
      },
      {
        id: 'card', type: 'shape', shape: 'rect', x: 20, y: 80, w: 240, h: 120, radius: 16,
        gradient: { from: '#635bff', to: '#22c55e', angle: 135 },
        shadow: { x: 0, y: 12, blur: 30, color: '#0f172a', opacity: 0.2 },
        blur: 4, blend: 'multiply',
      },
      {
        id: 'wave', type: 'shape', shape: 'path', x: 300, y: 80, w: 200, h: 120, stroke: '#0ea5e9', strokeWidth: 3,
        path: { closed: false, points: [{ x: 0, y: 90, out: { x: 40, y: -60 } }, { x: 200, y: 20 }] },
      },
    ],
    edges: [],
  });
  assertWellFormedSvg(exportSvg(document));
  assert.match(htmlEscapeCheck(exportHtml(document)), /./);
});

function htmlEscapeCheck(html) {
  // The headline itself carries <, > and quotes: the HTML must escape them.
  assert.doesNotMatch(html, /<angled>/, 'text is escaped in the HTML');
  assert.match(html, /&lt;angled&gt;/);
  return html;
}


test('the SVG export wraps text at the node width instead of overflowing it', () => {
  const document = normalizeCanvasDocument({
    version: 1,
    id: 'board-6',
    title: 'Wrap',
    createdAt: 1,
    updatedAt: 2,
    camera: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'screen', type: 'frame', x: 0, y: 0, w: 400, h: 300, fill: '#ffffff', members: ['para'] },
      {
        id: 'para', type: 'text', x: 20, y: 20, w: 200, h: 120, fontSize: 16, lineHeight: 1.5,
        text: 'A design engine has to survive a handoff, and a handoff means text that wraps.',
      },
    ],
    edges: [],
  });
  const svg = exportSvg(document);
  const tspans = svg.match(/<tspan[^>]*>([^<]*)<\/tspan>/g) || [];
  assert.ok(tspans.length >= 3, 'the paragraph wraps into several lines');
  const limit = 200;
  for (const tspan of tspans) {
    const content = tspan.replace(/<[^>]+>/g, '');
    let width = 0;
    for (const char of content) {
      if (char === ' ') width += 0.28;
      else if (/[iljtfr1.,:;'!|]/.test(char)) width += 0.3;
      else if (/[mwMW@%]/.test(char)) width += 0.88;
      else if (/[A-Z0-9]/.test(char)) width += 0.62;
      else if (/[a-z]/.test(char)) width += 0.52;
      else width += 0.62;
    }
    assert.ok(width * 16 <= limit + 1, 'no exported line is wider than the box');
  }
});


test('a shape label is exported with its own centred text', () => {
  const document = normalizeCanvasDocument({
    version: 1, id: 'board-7', title: 'Shape labels', createdAt: 1, updatedAt: 2,
    camera: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'screen', type: 'frame', x: 0, y: 0, w: 400, h: 240, fill: '#ffffff', members: ['card'] },
      {
        id: 'card', type: 'shape', shape: 'rect', x: 40, y: 40, w: 240, h: 120,
        fill: '#c2e5ff', stroke: '#3dadff', strokeWidth: 2, text: 'Approve', textColor: '#000000', fontSize: 16,
      },
    ],
    edges: [],
  });
  const svg = exportSvg(document);
  assert.match(svg, /<text[^>]*text-anchor="middle"[^>]*>/);
  assert.match(svg, /Approve/);
  const html = exportHtml(document);
  assert.match(html, /Approve/);
});


test('connectors are exported with their colour, curve and arrow', () => {
  const document = normalizeCanvasDocument({
    version: 1, id: 'board-8', title: 'Edges', createdAt: 1, updatedAt: 2,
    camera: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'screen', type: 'frame', x: 0, y: 0, w: 400, h: 240, fill: '#ffffff', members: ['a', 'b'] },
      { id: 'a', type: 'shape', shape: 'rect', x: 40, y: 60, w: 100, h: 60 },
      { id: 'b', type: 'shape', shape: 'rect', x: 240, y: 120, w: 100, h: 60 },
    ],
    edges: [{
      id: 'e1', from: 'a', to: 'b', fromAnchor: 'right', toAnchor: 'left',
      stroke: '#f24822', strokeWidth: 3, dash: 'dashed', curve: 'elbow', endArrow: 'arrow',
    }],
  });
  const svg = exportSvg(document);
  assert.match(svg, /stroke="#f24822"/);
  assert.match(svg, /stroke-dasharray="9 5"/);
  // The head is geometry now: two strokes meeting at the line end.
  assert.match(svg, /fill="none" stroke="#f24822" stroke-width="1\.5"|stroke="#f24822"/);
  assert.match(svg, /<path d="M [\d.]+ [\d.]+ L [\d.]+ [\d.]+ L [\d.]+ [\d.]+" fill="none" stroke="#f24822"/);
  const html = exportHtml(document);
  assert.match(html, /<svg class="edges"/);
  assert.match(html, /stroke="#f24822"/);
});


test('every curved connector meets both borders at a right angle', () => {
  // The routing rule: a snapped end leaves and enters along its side's normal.
  // This is what the canvas and the export both draw, checked on the exported
  // geometry rather than on a screenshot.
  const board = normalizeCanvasDocument({
    version: 1, id: 'board-routing', title: 'Routing', createdAt: 1, updatedAt: 2,
    camera: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'screen', type: 'frame', x: 0, y: 0, w: 1200, h: 800, fill: '#ffffff', members: ['a', 'b', 'c'] },
      { id: 'a', type: 'shape', shape: 'rect', x: 40, y: 40, w: 200, h: 100 },
      { id: 'b', type: 'shape', shape: 'rect', x: 900, y: 600, w: 200, h: 100 },
      { id: 'c', type: 'shape', shape: 'rect', x: 950, y: 60, w: 160, h: 90 },
    ],
    edges: [
      { id: 'bezier', from: 'a', to: 'b', fromAnchor: 'auto', toAnchor: 'auto', curve: 'bezier' },
      { id: 'elbow', from: 'a', to: 'c', fromAnchor: 'auto', toAnchor: 'auto', curve: 'elbow' },
      { id: 'sides', from: 'a', to: 'b', fromAnchor: 'bottom', toAnchor: 'left', curve: 'bezier' },
    ],
  });
  const normals = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };
  for (const edge of board.edges) {
    const geometry = connectorGeometry(edge, board.nodes);
    assert.ok(geometry, `${edge.id} has a path`);
    for (const [point, angle, side, label] of [
      [geometry.start, geometry.startAngle, geometry.fromSide, 'start'],
      [geometry.end, geometry.endAngle, geometry.toSide, 'end'],
    ]) {
      const normal = normals[side];
      const dot = Math.abs(Math.cos(angle) * normal[0] + Math.sin(angle) * normal[1]);
      assert.ok(dot > 0.999, `${edge.id} ${label} meets its ${side} border square (dot ${dot.toFixed(3)})`);
    }
    // A snapped end sits on a side midpoint, never on a corner.
    for (const point of [geometry.start, geometry.end]) {
      const corner = board.nodes.some((node) => (
        (Math.abs(point.x - node.x) < 0.01 || Math.abs(point.x - (node.x + node.w)) < 0.01)
        && (Math.abs(point.y - node.y) < 0.01 || Math.abs(point.y - (node.y + node.h)) < 0.01)
      ));
      assert.equal(corner, false, 'no connector lands on a corner');
    }
  }
});

