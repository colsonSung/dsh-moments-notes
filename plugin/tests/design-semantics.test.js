import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeCanvasDocument } from '../lib/canvas-domain.js';

function base(extra = {}) {
  return normalizeCanvasDocument({
    version: 1,
    id: 'canvas-1',
    title: 'Design',
    createdAt: 1,
    updatedAt: 2,
    camera: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    edges: [],
    ...extra,
  });
}

function node(extra = {}) {
  return { id: 'n1', type: 'text', x: 0, y: 0, w: 240, h: 80, text: 'Hi', ...extra };
}

test('design semantics default to null so old boards keep their look', () => {
  const document = base({ nodes: [node()] });
  const [n] = document.nodes;
  assert.equal(n.fontFamily, null);
  assert.equal(n.fontWeight, null);
  assert.equal(n.lineHeight, null);
  assert.equal(n.letterSpacing, null);
  assert.equal(n.shadow, null);
  assert.equal(n.gradient, null);
  assert.equal(document.version, 1);
});

test('design semantics survive a save round trip', () => {
  const document = base({
    nodes: [node({
      fontSize: 48,
      textColor: '#0f172a',
      fontFamily: 'display',
      fontWeight: 700,
      lineHeight: 1.2,
      letterSpacing: -1.5,
      shadow: { x: 0, y: 8, blur: 24, color: '#635BFF' },
      gradient: { from: '#635bff', to: '#8b83ff', angle: 135 },
    })],
  });
  const [n] = document.nodes;
  assert.equal(n.fontFamily, 'display');
  assert.equal(n.fontWeight, 700);
  assert.equal(n.lineHeight, 1.2);
  assert.equal(n.letterSpacing, -1.5);
  assert.deepEqual(n.shadow, { x: 0, y: 8, blur: 24, color: '#635bff', opacity: 1 });
  assert.deepEqual(n.gradient, { from: '#635bff', to: '#8b83ff', angle: 135 });
});

test('a shadow keeps its defaults and a gradient needs both stops', () => {
  const document = base({ nodes: [node({ shadow: {} })] });
  assert.deepEqual(document.nodes[0].shadow, { x: 0, y: 0, blur: 0, color: '#000000', opacity: 1 });
  assert.throws(() => base({ nodes: [node({ gradient: { from: '#000000', angle: 90 } })] }), /both from and to/);
});

test('design semantics reject values outside their range', () => {
  const cases = [
    [{ fontFamily: 'comic' }, /fontFamily/],
    [{ fontWeight: 450 }, /fontWeight/],
    [{ fontWeight: 1000 }, /fontWeight/],
    [{ lineHeight: 0.5 }, /lineHeight/],
    [{ lineHeight: 4 }, /lineHeight/],
    [{ letterSpacing: 30 }, /letterSpacing/],
    [{ shadow: { color: 'rgba(0,0,0,.2)' } }, /shadow\.color/],
    [{ shadow: { opacity: 1.5 } }, /shadow\.opacity/],
    [{ gradient: { from: '#000000', to: '#ffffff', angle: 400 } }, /gradient\.angle/],
  ];
  for (const [extra, pattern] of cases) {
    assert.throws(() => base({ nodes: [node(extra)] }), pattern);
  }
});

test('a shape can carry a gradient and a shadow like a text node', () => {
  const document = base({
    nodes: [{
      id: 'cta',
      type: 'shape',
      shape: 'rect',
      x: 0,
      y: 0,
      w: 200,
      h: 56,
      gradient: { from: '#635bff', to: '#8b83ff', angle: 90 },
      shadow: { x: 0, y: 8, blur: 24, color: '#635bff' },
    }],
  });
  assert.equal(document.nodes[0].gradient.from, '#635bff');
  assert.equal(document.nodes[0].shadow.blur, 24);
});

test('a row container lays its members out with gap and padding', () => {
  const document = base({
    nodes: [
      { id: 'row', type: 'frame', x: 100, y: 50, w: 800, h: 300, layout: 'row', gap: 20, padding: 24, align: 'start', members: ['a', 'b', 'c'] },
      { id: 'a', type: 'shape', x: 0, y: 0, w: 200, h: 100 },
      { id: 'b', type: 'shape', x: 0, y: 0, w: 200, h: 100 },
      { id: 'c', type: 'shape', x: 0, y: 0, w: 200, h: 100 },
    ],
  });
  const byId = new Map(document.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get('a').x, 124);
  assert.equal(byId.get('b').x, 344);
  assert.equal(byId.get('c').x, 564);
  for (const id of ['a', 'b', 'c']) assert.equal(byId.get(id).y, 74);
});

test('a column container centres its members on the cross axis', () => {
  const document = base({
    nodes: [
      { id: 'col', type: 'frame', x: 0, y: 0, w: 400, h: 600, layout: 'column', gap: 12, padding: 20, align: 'center', members: ['a', 'b'] },
      { id: 'a', type: 'shape', x: 0, y: 0, w: 100, h: 60 },
      { id: 'b', type: 'shape', x: 0, y: 0, w: 200, h: 60 },
    ],
  });
  const byId = new Map(document.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get('a').x, 150);
  assert.equal(byId.get('a').y, 20);
  assert.equal(byId.get('b').x, 100);
  assert.equal(byId.get('b').y, 92);
});

test('stretch fills the cross axis of every member', () => {
  const document = base({
    nodes: [
      { id: 'row', type: 'frame', x: 0, y: 0, w: 600, h: 200, layout: 'row', gap: 0, padding: 10, align: 'stretch', members: ['a'] },
      { id: 'a', type: 'shape', x: 0, y: 0, w: 120, h: 40 },
    ],
  });
  const a = document.nodes.find((n) => n.id === 'a');
  assert.equal(a.h, 180);
  assert.equal(a.y, 10);
});

test('a nested container moves its own members with it', () => {
  const document = base({
    nodes: [
      { id: 'outer', type: 'frame', x: 0, y: 0, w: 800, h: 400, layout: 'row', gap: 40, padding: 20, align: 'start', members: ['inner'] },
      { id: 'inner', type: 'frame', x: 300, y: 300, w: 240, h: 120, layout: 'column', gap: 8, padding: 12, align: 'start', members: ['leaf'] },
      { id: 'leaf', type: 'text', x: 500, y: 500, w: 100, h: 40, text: 'inside' },
    ],
  });
  const byId = new Map(document.nodes.map((n) => [n.id, n]));
  const inner = byId.get('inner');
  const leaf = byId.get('leaf');
  assert.equal(inner.x, 20);
  assert.equal(inner.y, 20);
  assert.equal(leaf.x, inner.x + 12);
  assert.equal(leaf.y, inner.y + 12);
});

test('layout is idempotent across saves', () => {
  const first = base({
    nodes: [
      { id: 'row', type: 'frame', x: 10, y: 10, w: 500, h: 200, layout: 'row', gap: 16, padding: 8, align: 'center', members: ['a', 'b'] },
      { id: 'a', type: 'shape', x: 0, y: 0, w: 100, h: 40 },
      { id: 'b', type: 'shape', x: 0, y: 0, w: 100, h: 80 },
    ],
  });
  const second = normalizeCanvasDocument(first);
  assert.deepEqual(second.nodes.map(({ id, x, y }) => ({ id, x, y })), first.nodes.map(({ id, x, y }) => ({ id, x, y })));
});

test('layout fields are rejected outside their vocabulary and range', () => {
  const wrap = (fields) => () => base({
    nodes: [
      { id: 'row', type: 'frame', x: 0, y: 0, w: 400, h: 200, members: [], ...fields },
    ],
  });
  assert.throws(wrap({ layout: 'grid' }), /layout/);
  assert.throws(wrap({ gap: 500 }), /gap/);
  assert.throws(wrap({ padding: -1 }), /padding/);
  assert.throws(wrap({ align: 'middle' }), /align/);
});

test('a plain node keeps layout fields at their defaults', () => {
  const document = base({ nodes: [node({ layout: 'row', gap: 40 })] });
  assert.equal(document.nodes[0].layout, 'none');
  assert.equal(document.nodes[0].gap, 0);
});


test('constraints default to left/top and reject unknown pins', () => {
  const document = base({ nodes: [node({ constraints: { horizontal: 'right', vertical: 'bottom' } })] });
  assert.deepEqual(document.nodes[0].constraints, { horizontal: 'right', vertical: 'bottom' });
  const fallback = base({ nodes: [node()] });
  assert.deepEqual(fallback.nodes[0].constraints, { horizontal: 'left', vertical: 'top' });
  assert.throws(() => base({ nodes: [node({ constraints: { horizontal: 'middle' } })] }), /constraints\.horizontal/);
  assert.throws(() => base({ nodes: [node({ constraints: { vertical: 'centre' } })] }), /constraints\.vertical/);
});


test('a path shape keeps its anchors and handles and rejects unusable geometry', () => {
  const document = base({
    nodes: [{
      id: 'wave',
      type: 'shape',
      shape: 'path',
      x: 0,
      y: 0,
      w: 200,
      h: 100,
      stroke: '#635bff',
      strokeWidth: 3,
      path: {
        closed: false,
        points: [
          { x: 0, y: 50, out: { x: 20, y: -30 } },
          { x: 100, y: 50, in: { x: -20, y: -30 }, out: { x: 20, y: 30 } },
          { x: 200, y: 50 },
        ],
      },
    }],
  });
  const [wave] = document.nodes;
  assert.equal(wave.path.points.length, 3);
  assert.deepEqual(wave.path.points[0].out, { x: 20, y: -30 });
  assert.equal(wave.path.points[1].in.x, -20);
  assert.equal(wave.path.closed, false);

  assert.throws(() => base({ nodes: [{ id: 'p', type: 'shape', shape: 'path', x: 0, y: 0, w: 20, h: 20, path: { points: [{ x: 0, y: 0 }] } }] }), (error) => error.code === 'INVALID_PATH');
  assert.throws(() => base({ nodes: [{ id: 'p', type: 'shape', shape: 'path', x: 0, y: 0, w: 20, h: 20 }] }), (error) => error.code === 'INVALID_PATH');
  assert.throws(() => base({ nodes: [{ id: 'p', type: 'shape', shape: 'path', x: 0, y: 0, w: 20, h: 20, path: { points: [{ x: 0, y: 0 }, { x: 5, y: 5, out: 'x' }] } }] }), (error) => error.code === 'INVALID_PATH');
  assert.equal(base({ nodes: [node({ shape: 'rect' })] }).nodes[0].path, null, 'only path shapes carry geometry');
});


test('blur and blend are clamped and validated like every other effect', () => {
  const blurred = base({ nodes: [node({ type: 'shape', blur: 12.6, blend: 'multiply' })] });
  assert.equal(blurred.nodes[0].blur, 13);
  assert.equal(blurred.nodes[0].blend, 'multiply');
  assert.equal(base({ nodes: [node({ type: 'shape', blur: 9999 })] }).nodes[0].blur, 200, 'blur clamps to its ceiling');
  assert.equal(base({ nodes: [node({ type: 'shape', blur: -4 })] }).nodes[0].blur, 0, 'a negative blur is treated as none');
  assert.equal(base({ nodes: [node({ type: 'shape' })] }).nodes[0].blend, 'normal');
  assert.throws(
    () => base({ nodes: [node({ type: 'shape', blend: 'vivid' })] }),
    (error) => error.code === 'INVALID_CANVAS',
  );
});


test('rich text runs own the text and are validated run by run', () => {
  const document = base({
    nodes: [node({
      type: 'text',
      text: 'ignored when runs exist',
      spans: [
        { text: 'Pay ', fontWeight: 400, textColor: '#0f172a' },
        { text: 'now', fontWeight: 800, textColor: '#635bff', italic: true, underline: true },
      ],
    })],
  });
  const [rich] = document.nodes;
  assert.equal(rich.text, 'Pay now', 'the plain text is the join of the runs');
  assert.deepEqual(rich.spans[1], {
    text: 'now', fontWeight: 800, textColor: '#635bff', italic: true, underline: true,
  });
  assert.equal(base({ nodes: [node({ type: 'text' })] }).nodes[0].spans, null, 'plain text keeps no runs');
  assert.throws(
    () => base({ nodes: [node({ type: 'text', spans: [{ text: 'a', fontWeight: 40 }] })] }),
    (error) => error.code === 'INVALID_CANVAS',
  );
  assert.throws(
    () => base({ nodes: [node({ type: 'text', spans: [{ text: 'a', textColor: 'not-a-colour' }] })] }),
    (error) => error.code === 'INVALID_CANVAS',
  );
  assert.throws(
    () => base({ nodes: [node({ type: 'text', spans: [] })] }),
    (error) => error.code === 'INVALID_CANVAS',
  );
});


test('a container keeps a layout grid, clamped, and only containers do', () => {
  const document = base({
    nodes: [
      node({ id: 'frame', type: 'frame', grid: { kind: 'columns', count: 99, gutter: 999, margin: -5, visible: true } }),
      node({ id: 'shape', type: 'shape', grid: { kind: 'rows', count: 4 } }),
    ],
  });
  const frame = document.nodes.find((item) => item.id === 'frame');
  assert.deepEqual(frame.grid, { kind: 'columns', count: 24, gutter: 200, margin: 0, visible: true });
  const shape = document.nodes.find((item) => item.id === 'shape');
  assert.equal(shape.grid, null, 'only containers carry a grid');
  assert.throws(
    () => base({ nodes: [node({ id: 'bad', type: 'frame', grid: { kind: 'diagonal' } })] }),
    (error) => error.code === 'INVALID_CANVAS',
  );
  assert.equal(base({ nodes: [node({ id: 'f', type: 'frame' })] }).nodes[0].grid, null);
});


test('a themed board resolves its colour table from the active mode', () => {
  const document = base({
    theme: 'dark',
    tokens: { colors: {}, gradients: {}, type: {} },
    themes: {
      light: { colors: { ink: '#0f172a', surface: '#ffffff' } },
      dark: { colors: { ink: '#f8fafc', surface: '#0b1020' } },
    },
    nodes: [node({ type: 'shape', shape: 'rect', fillToken: 'surface' })],
  });
  assert.equal(document.theme, 'dark');
  assert.equal(document.tokens.colors.ink, '#f8fafc', 'the dark table wins for the names it defines');
  assert.equal(document.tokens.colors.surface, '#0b1020');
  assert.equal(document.nodes[0].fill, '#0b1020', 'the node resolved through the active mode');

  const light = base({
    theme: 'light',
    tokens: { colors: {}, gradients: {}, type: {} },
    themes: {
      light: { colors: { ink: '#0f172a' } },
      dark: { colors: { ink: '#f8fafc' } },
    },
  });
  assert.equal(light.tokens.colors.ink, '#0f172a');
});

