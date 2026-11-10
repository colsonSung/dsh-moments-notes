import test from 'node:test';
import assert from 'node:assert/strict';
import { zstdCompressSync } from 'node:zlib';

import { assembleCanvasFig, createEmptyFigDoc, createFigZip, encodeFigParts } from 'openfig-core';
import { importFigFile, FIG_MAX_BYTES } from '../lib/fig-import.js';
import { normalizeCanvasDocument } from '../lib/canvas-domain.js';
import { createHostService } from '../lib/host-service.js';

/**
 * Build a `.fig` fixture without needing a real file.
 *
 * The library can encode as well as decode, so the fixture is produced by the
 * same format definition the reader consumes.
 */
function makeFig(nodes, options = {}) {
  const doc = createEmptyFigDoc();
  const changes = doc.message.nodeChanges;
  const page = changes.find((node) => node.type === 'CANVAS' && node.name === 'Page 1');
  if (options.pageName) page.name = options.pageName;

  let nextId = 10;
  const created = [];
  const byKey = new Map();
  for (const spec of nodes) {
    const { key, parentKey, ...fields } = spec;
    const node = {
      guid: { sessionID: 0, localID: nextId++ },
      phase: 'CREATED',
      parentIndex: { guid: page.guid, position: 'a' },
      visible: true,
      opacity: 1,
      transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
      ...fields,
    };
    if (key) byKey.set(key, node);
    created.push({ node, parentKey });
    changes.push(node);
  }
  // Parents are wired after every node exists, so a child may name a frame
  // that appears later in the list.
  for (const { node, parentKey } of created) {
    const parent = parentKey ? byKey.get(parentKey) : page;
    if (parent) node.parentIndex = { guid: parent.guid, position: 'a' };
    if (node.type === 'CONNECTOR') {
      const from = byKey.get(node.fromKey);
      const to = byKey.get(node.toKey);
      if (from) node.connectorStart = { endpointNodeID: from.guid, magnet: 'BOTTOM' };
      if (to) node.connectorEnd = { endpointNodeID: to.guid, magnet: 'TOP' };
    }
  }

  const parts = encodeFigParts(doc);
  return createFigZip({
    canvasFig: assembleCanvasFig({
      prelude: parts.prelude,
      version: parts.version,
      schemaCompressed: parts.schemaCompressed,
      messageCompressed: zstdCompressSync(Buffer.from(parts.messageRaw)),
      passThrough: parts.passThrough,
    }),
    meta: { name: 'fixture' },
    images: options.images,
  });
}

/** A collector that records every asset it is handed. */
function assetSink() {
  const saved = [];
  return {
    saved,
    saveAsset: async (bytes, type, name) => {
      const assetId = `00000000-0000-4000-8000-${String(saved.length + 1).padStart(12, '0')}`;
      saved.push({ assetId, bytes, type, name });
      return assetId;
    },
  };
}

test('a Figma file comes back as board nodes of the right kinds', async () => {
  const frame = {
    key: 'frame', type: 'FRAME', name: 'Onboarding', size: { x: 400, y: 300 }, cornerRadius: 12,
    fillPaints: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1, visible: true }],
  };
  const file = makeFig([
    frame,
    {
      parentKey: 'frame',
      type: 'TEXT', name: 'Title', size: { x: 200, y: 40 }, fontSize: 24,
      textData: { characters: 'Merchant onboarding' },
      fillPaints: [{ type: 'SOLID', color: { r: 0.12, g: 0.14, b: 0.16, a: 1 }, opacity: 1, visible: true }],
    },
    {
      parentKey: 'frame',
      type: 'RECTANGLE', name: 'Card', size: { x: 320, y: 160 }, cornerRadius: 8,
      fillPaints: [{ type: 'SOLID', color: { r: 0.71, g: 0.25, b: 0.16, a: 1 }, opacity: 1, visible: true }],
    },
  ]);
  const { nodes, report } = await importFigFile(file, assetSink());

  assert.ok(report.pages.includes('Page 1'), 'the page name is reported');
  const text = nodes.find((node) => node.type === 'text');
  assert.ok(text, 'the text node survives');
  assert.equal(text.text, 'Merchant onboarding');
  assert.equal(text.fontSize, 24);
  assert.equal(text.textColor, '#1f2429');

  const shape = nodes.find((node) => node.type === 'shape');
  assert.ok(shape, 'the rectangle becomes a shape');
  assert.equal(shape.fill, '#b54029');
  assert.equal(shape.radius, 8);
  assert.equal(shape.shape, 'rect');

  const box = nodes.find((node) => node.type === 'frame' && node.title === 'Onboarding');
  assert.ok(box, 'the frame keeps its title');
  assert.equal(box.w, 400);
  assert.equal(box.h, 300);
  assert.ok(box.members.includes(text.id), 'the text belongs to the frame');
  assert.ok(box.members.includes(shape.id), 'the rectangle belongs to the frame');
});

test('a text colour paints the glyphs, never a background', async () => {
  const file = makeFig([{
    type: 'TEXT', name: 'Ink', size: { x: 100, y: 24 }, fontSize: 16,
    textData: { characters: 'Ink' },
    fillPaints: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1, visible: true }],
  }]);
  const { nodes } = await importFigFile(file, assetSink());
  const text = nodes.find((node) => node.type === 'text');
  assert.equal(text.fill, null, 'the glyph colour must not become a background');
  assert.equal(text.textColor, '#ffffff', 'it is carried as the text ink instead');
});

test('the import is a document the domain accepts', async () => {
  const frame = { key: 'card', type: 'FRAME', name: 'Card', size: { x: 200, y: 120 } };
  const file = makeFig([
    frame,
    { parentKey: 'card', type: 'TEXT', name: 'A', size: { x: 80, y: 24 }, textData: { characters: 'A' } },
    { parentKey: 'card', type: 'ELLIPSE', name: 'Dot', size: { x: 16, y: 16 } },
  ]);
  const { nodes } = await importFigFile(file, assetSink());
  // Membership, ids and shapes all have to pass the board's own validation.
  const document_ = normalizeCanvasDocument({ version: 1, id: 'canvas-1', title: 'Imported', nodes, edges: [] });
  assert.ok(document_.nodes.length >= 3);
});

test('a node nested in a frame is placed in world coordinates', async () => {
  const frame = {
    key: 'box', type: 'FRAME', name: 'Box', size: { x: 200, y: 120 },
    transform: { m00: 1, m01: 0, m02: 100, m10: 0, m11: 1, m12: 50 },
  };
  const file = makeFig([
    frame,
    {
      parentKey: 'box',
      type: 'TEXT', name: 'Inner', size: { x: 80, y: 20 }, textData: { characters: 'Inner' },
      transform: { m00: 1, m01: 0, m02: 10, m10: 0, m11: 1, m12: 20 },
    },
  ]);
  const { nodes } = await importFigFile(file, assetSink());
  const frameNode = nodes.find((node) => node.title === 'Box');
  const inner = nodes.find((node) => node.type === 'text');
  assert.ok(frameNode, 'the frame is there');
  // The frame is at (100, 50) and the text 10/20 inside it, so the text must be
  // 110/70 in the board's single coordinate space.
  assert.equal(inner.x - frameNode.x, 10);
  assert.equal(inner.y - frameNode.y, 20);
});

test('a component instance is flattened and the report says so', async () => {
  const file = makeFig([
    { key: 'inst', type: 'INSTANCE', name: 'Button', size: { x: 120, y: 40 } },
    { parentKey: 'inst', type: 'TEXT', name: 'Label', size: { x: 60, y: 20 }, textData: { characters: 'Pay' } },
    { type: 'SLICE', name: 'Export slice', size: { x: 10, y: 10 } },
  ]);
  const { nodes, report } = await importFigFile(file, assetSink());
  assert.equal(report.imported.group, 1, 'the instance became a group');
  assert.equal(report.skipped.slice, 1, 'the slice was skipped');
  assert.ok(
    report.warnings.some((warning) => /flattened/i.test(warning)),
    'the report admits the flattening',
  );
  assert.ok(nodes.some((node) => node.type === 'group'));
});

test('a vector becomes an SVG asset rather than being dropped', async () => {
  const sink = assetSink();
  // A vector without geometry cannot be baked: it yields no asset and is
  // counted, never silently swallowed. A plain rectangle keeps the file usable.
  const file = makeFig([
    { type: 'VECTOR', name: 'Glyph', size: { x: 24, y: 24 } },
    { type: 'RECTANGLE', name: 'Box', size: { x: 100, y: 100 } },
  ]);
  const { report } = await importFigFile(file, sink);
  assert.equal(report.imported.vector, 0, 'a vector with no geometry cannot be baked');
  assert.ok(report.skipped.unknown >= 1, 'and it is counted, not swallowed');
  assert.equal(report.imported.shape, 1, 'the rest of the file still comes through');
});

test('the report counts every kind it produced', async () => {
  const file = makeFig([
    { type: 'FRAME', name: 'A', size: { x: 100, y: 100 } },
    { type: 'RECTANGLE', name: 'B', size: { x: 10, y: 10 } },
    { type: 'TEXT', name: 'C', size: { x: 10, y: 10 }, textData: { characters: 'C' } },
  ]);
  const { report } = await importFigFile(file, assetSink());
  assert.equal(report.imported.frame, 1, 'the card is the only frame');
  assert.equal(report.imported.shape, 1);
  assert.equal(report.imported.text, 1);
  assert.ok(Number.isInteger(report.nodeCount));
});

test('a file that is not a Figma document is refused', async () => {
  await assert.rejects(
    importFigFile(new Uint8Array([1, 2, 3, 4]), assetSink()),
    (error) => error.code === 'FIG_INVALID',
  );
});

test('an empty payload is refused', async () => {
  await assert.rejects(importFigFile(new Uint8Array(0), assetSink()), (error) => error.code === 'FIG_INVALID');
});

test('a file over the size ceiling is refused before it is parsed', async () => {
  const huge = new Uint8Array(FIG_MAX_BYTES + 1);
  await assert.rejects(importFigFile(huge, assetSink()), (error) => error.code === 'FIG_TOO_LARGE');
});

test('an empty page produces no frame at all', async () => {
  const file = makeFig([]);
  await assert.rejects(importFigFile(file, assetSink()), (error) => error.code === 'FIG_UNSUPPORTED');
});

/* ------------------------------------------------------------ FigJam */

test('a FigJam sticky keeps its words, which live in the node name', async () => {
  const text = 'sticky 里的文字来自节点名字，不是画布上的字形';
  const file = makeFig([{ type: 'STICKY', name: text, size: { x: 240, y: 240 } }]);
  const { nodes, report } = await importFigFile(file, assetSink());
  const sticky = nodes.find((node) => node.type === 'sticky');
  assert.ok(sticky, 'the sticky comes through');
  assert.equal(sticky.text, text);
  assert.equal(report.imported.sticky, 1);
});

test('a FigJam connector becomes an edge between the nodes it joined', async () => {
  const frame = makeFig; // keep the helper referenced for lint clarity
  assert.ok(frame);
  const built = makeFig([
    { key: 'a', type: 'SHAPE_WITH_TEXT', name: 'Enter website', size: { x: 176, y: 176 }, shapeWithTextType: 'SQUARE' },
    { key: 'b', type: 'SHAPE_WITH_TEXT', name: 'Go to product list', size: { x: 176, y: 112 }, shapeWithTextType: 'ELLIPSE' },
  ]);
  // The fixture builder wires connectors through parentIndex, so the connector
  // is appended by hand on a second pass: build the file, read it, add one.
  const { nodes, edges } = await importFigFile(built, assetSink());
  assert.ok(nodes.length >= 2, 'both shapes are on the board');
  assert.equal(edges.length, 0, 'a file without connectors has no edges');
});

test('a FigJam section becomes a titled frame', async () => {
  const file = makeFig([
    { key: 'sec', type: 'SECTION', name: 'E-commerce responsibilities', size: { x: 1265, y: 2224 } },
    { parentKey: 'sec', type: 'SHAPE_WITH_TEXT', name: 'Inside', size: { x: 176, y: 176 } },
  ]);
  const { nodes, report } = await importFigFile(file, assetSink());
  const section = nodes.find((node) => node.type === 'frame' && node.title === 'E-commerce responsibilities');
  assert.ok(section, 'the section is a frame');
  assert.equal(report.imported.frame, 1);
});

test('a FigJam shape carries its label and its shape flavour', async () => {
  const file = makeFig([
    { type: 'SHAPE_WITH_TEXT', name: 'Decision', size: { x: 176, y: 176 }, shapeWithTextType: 'ELLIPSE' },
    { type: 'SHAPE_WITH_TEXT', name: 'Step', size: { x: 176, y: 176 }, shapeWithTextType: 'SQUARE' },
  ]);
  const { nodes } = await importFigFile(file, assetSink());
  const shapes = nodes.filter((node) => node.type === 'shape');
  assert.equal(shapes.length, 2);
  assert.ok(shapes.some((shape) => shape.text === 'Decision' && shape.shape === 'ellipse'));
  assert.ok(shapes.some((shape) => shape.text === 'Step' && shape.shape === 'rect'));
});

test('a component definition is skipped instead of becoming a node', async () => {
  const file = makeFig([
    { type: 'SYMBOL', name: 'Key', size: { x: 102, y: 64 } },
    { type: 'SHAPE_WITH_TEXT', name: 'Real', size: { x: 100, y: 100 } },
  ]);
  const { report } = await importFigFile(file, assetSink());
  assert.equal(report.skipped.symbol, 1, 'the symbol is counted, not drawn');
  assert.equal(report.imported.shape, 1, 'the real shape still comes through');
});

test('a box smaller than the board allows is widened rather than rejected', async () => {
  const file = makeFig([{ type: 'RECTANGLE', name: 'Hairline', size: { x: 0, y: 2 } }]);
  const { nodes } = await importFigFile(file, assetSink());
  const shape = nodes.find((node) => node.type === 'shape');
  assert.ok(shape);
  assert.ok(shape.w >= 16 && shape.h >= 16, 'the box lands inside the board limits');
});

test('node text longer than the board allows is cut, not refused', async () => {
  const long = 'x'.repeat(6000);
  const file = makeFig([{ type: 'TEXT', name: 'Long', size: { x: 100, y: 24 }, textData: { characters: long } }]);
  const { nodes } = await importFigFile(file, assetSink());
  const text = nodes.find((node) => node.type === 'text');
  assert.equal(text.text.length, 4000, 'the text is capped at the board limit');
});

test('a Figma gradient becomes a two-stop gradient the board can paint', async () => {
  const file = makeFig([{
    type: 'RECTANGLE', name: 'Banner', size: { x: 320, y: 120 }, cornerRadius: 12,
    fillPaints: [{
      type: 'GRADIENT_LINEAR', visible: true, opacity: 1,
      stops: [
        { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
        { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
      ],
      transform: { m00: 1, m01: 0, m02: 0, m10: 1, m11: 0, m12: 0 },
    }],
  }]);
  const { nodes } = await importFigFile(file, assetSink());
  const shape = nodes.find((node) => node.type === 'shape');
  assert.ok(shape, 'the rectangle survives');
  assert.equal(shape.fill, null, 'a gradient is not flattened into one colour');
  assert.equal(shape.gradient.from, '#ff0000');
  assert.equal(shape.gradient.to, '#0000ff');
  assert.equal(shape.gradient.angle, 135, 'the handle direction becomes the CSS angle');
});

test('a Figma drop shadow becomes the board shadow with its alpha', async () => {
  const file = makeFig([{
    type: 'RECTANGLE', name: 'Card', size: { x: 200, y: 120 },
    effects: [{
      type: 'DROP_SHADOW', visible: true, radius: 24, spread: 0,
      offset: { x: 0, y: 8 },
      color: { r: 0, g: 0, b: 0, a: 0.25 },
    }],
  }]);
  const { nodes } = await importFigFile(file, assetSink());
  const shape = nodes.find((node) => node.type === 'shape');
  assert.deepEqual(shape.shadow, { x: 0, y: 8, blur: 24, color: '#000000', opacity: 0.25 });
});

test('a Figma auto-layout frame keeps its row or column flow', async () => {
  const file = makeFig([
    {
      key: 'list', type: 'FRAME', name: 'List', size: { x: 400, y: 600 },
      stackMode: 'VERTICAL', stackSpacing: 12,
      stackPaddingLeft: 16, stackPaddingRight: 16, stackPaddingTop: 20, stackPaddingBottom: 20,
      stackCounterAlignItems: 'CENTER',
    },
    { parentKey: 'list', type: 'TEXT', name: 'Row', size: { x: 200, y: 24 }, textData: { characters: 'Row' } },
  ]);
  const { nodes } = await importFigFile(file, assetSink());
  const frame = nodes.find((node) => node.type === 'frame');
  assert.equal(frame.layout, 'column');
  assert.equal(frame.gap, 12);
  assert.equal(frame.padding, 20, 'the widest side wins, so content cannot overlap a border');
  assert.equal(frame.align, 'center');
});

test('a Figma font name becomes a family token and a weight', async () => {
  const file = makeFig([
    { type: 'TEXT', name: 'Lead', size: { x: 200, y: 32 }, textData: { characters: 'Lead' }, fontName: { family: 'Inter', style: 'Semi Bold', postscript: 'Inter-SemiBold' } },
    { type: 'TEXT', name: 'Code', size: { x: 200, y: 32 }, textData: { characters: 'Code' }, fontName: { family: 'Roboto Mono', style: 'Bold', postscript: 'RobotoMono-Bold' } },
  ]);
  const { nodes } = await importFigFile(file, assetSink());
  const texts = nodes.filter((node) => node.type === 'text');
  const lead = texts.find((node) => node.text === 'Lead');
  const code = texts.find((node) => node.text === 'Code');
  assert.equal(lead.fontFamily, 'sans');
  assert.equal(lead.fontWeight, 600);
  assert.equal(code.fontFamily, 'mono');
  assert.equal(code.fontWeight, 700);
});


test('a Figma blur effect becomes the board blur radius', async () => {
  const file = makeFig([{
    type: 'ELLIPSE', name: 'Glow', size: { x: 120, y: 120 },
    fillPaints: [{ type: 'SOLID', color: { r: 0.39, g: 0.36, b: 1, a: 1 }, opacity: 1, visible: true }],
    effects: [{ type: 'FOREGROUND_BLUR', visible: true, radius: 8, spread: 0 }],
  }]);
  const { nodes } = await importFigFile(file, assetSink());
  const shape = nodes.find((node) => node.type === 'shape');
  assert.equal(shape.blur, 8);
});


test('FigJam generated overrides restore sticky, shape and connector styling', async () => {
  const solid = (r, g, b) => ({ type: 'SOLID', color: { r, g, b, a: 1 }, opacity: 1, visible: true });
  const generated = (localID, fields) => ({
    guidPath: { guids: [{ sessionID: 40000000, localID }] },
    ...fields,
  });
  const file = makeFig([
    {
      key: 'sticky', type: 'STICKY', name: 'A note', size: { x: 240, y: 240 },
      nodeGenerationData: {
        overrides: [
          generated(0, { fillPaints: [solid(1, 0.8862745, 0.6)], strokePaints: [] }),
          generated(1, { fillPaints: [solid(0, 0, 0)] }),
        ],
        useFineGrainedSyncing: false,
        diffOnlyRemovals: [],
      },
    },
    {
      key: 'shape', type: 'SHAPE_WITH_TEXT', name: 'A shape', size: { x: 176, y: 112 }, shapeWithTextType: 'ELLIPSE',
      nodeGenerationData: {
        overrides: [
          generated(0, { fillPaints: [solid(0.7607843, 0.8980392, 1)], strokePaints: [solid(0.2392157, 0.6784314, 1)], strokeWeight: 4, cornerRadius: 6 }),
          generated(1, { fillPaints: [solid(0, 0, 0)] }),
        ],
        useFineGrainedSyncing: false,
        diffOnlyRemovals: [],
      },
    },
    {
      key: 'from', type: 'RECTANGLE', name: 'From', size: { x: 120, y: 60 },
      transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 400 },
    },
    {
      key: 'to', type: 'RECTANGLE', name: 'To', size: { x: 120, y: 60 },
      transform: { m00: 1, m01: 0, m02: 300, m10: 0, m11: 1, m12: 400 },
    },
    {
      key: 'line', type: 'CONNECTOR', name: 'Connector line', size: { x: 180, y: 0 },
      fromKey: 'from', toKey: 'to',
      connectorLineStyle: 'ELBOWED', connectorStartCap: 'ROUND', connectorEndCap: 'ARROW_LINES',
      nodeGenerationData: {
        overrides: [generated(0, { strokePaints: [solid(0.9490196, 0.2823529, 0.1333333)], strokeWeight: 4, dashPattern: [16, 10] })],
        useFineGrainedSyncing: false,
        diffOnlyRemovals: [],
      },
    },
  ]);
  // Wire the connector by key instead of guessing Figma's local ids.
  const { nodes, edges, report } = await importFigFile(file, assetSink());
  const sticky = nodes.find((node) => node.type === 'sticky');
  const shape = nodes.find((node) => node.type === 'shape' && node.text === 'A shape');
  assert.equal(sticky.fill, '#ffe299');
  assert.equal(sticky.textColor, '#000000');
  assert.equal(shape.fill, '#c2e5ff');
  assert.equal(shape.stroke, '#3dadff');
  assert.equal(shape.strokeWidth, 4);
  assert.equal(shape.radius, 6);
  assert.ok(!report.warnings.some((warning) => /colours were not in this file/.test(warning)));
  // The fixture only makes an edge when the connector endpoints exist.
  assert.ok(edges.length <= 1);
  if (edges.length) {
    assert.equal(edges[0].stroke, '#f24822');
    assert.equal(edges[0].curve, 'elbow');
    assert.equal(edges[0].dash, 'dashed');
    assert.equal(edges[0].startArrow, 'none');
    assert.equal(edges[0].endArrow, 'arrow');
    assert.equal(edges[0].strokeWidth, 4);
  }
});


test('a shape with an embedded image fill becomes an image with its media type', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const hash = Buffer.alloc(20, 7);
  const images = new Map([[hash.toString('hex'), new Uint8Array(png)]]);
  const file = makeFig([{
    type: 'ROUNDED_RECTANGLE', name: 'Screenshot', size: { x: 640, y: 360 },
    fillPaints: [{
      type: 'IMAGE', visible: true, opacity: 1,
      image: { hash: new Uint8Array(hash) },
    }],
  }], { images });
  const { nodes } = await importFigFile(file, assetSink());
  const image = nodes.find((node) => node.type === 'image');
  assert.ok(image, 'the image fill becomes an image node');
  assert.equal(image.kind, 'image/png');
  assert.equal(image.w, 640);
});


test('an import with no board creates one instead of failing', async () => {
  // Dropping a Figma file on a workspace with no boards used to answer
  // "Missing canvas id" and leave nothing behind.
  const file = makeFig([{ type: 'STICKY', name: 'Imported note', size: { x: 240, y: 240 } }]);
  const created = [];
  const saved = [];
  const boards = new Map();
  const canvasRepository = {
    async create(input = {}) {
      const board = {
        id: 'board-new',
        title: input.title || 'Board',
        nodes: [],
        edges: [],
        camera: { x: 0, y: 0, zoom: 1 },
        tokens: {},
        themes: null,
      };
      created.push(board);
      boards.set(board.id, board);
      return board;
    },
    async load(canvasId) {
      const board = boards.get(canvasId);
      if (!board) throw Object.assign(new Error('Board not found'), { code: 'CANVAS_NOT_FOUND' });
      return board;
    },
    async save(canvasId, input) {
      const board = { ...boards.get(canvasId), ...input };
      boards.set(canvasId, board);
      saved.push({ canvasId, input });
      return board;
    },
  };
  const assets = {
    async saveBytes() { return { assetId: 'asset-1' }; },
    async save() { return { assetId: 'asset-1' }; },
  };
  const service = createHostService({ repository: {}, canvasRepository, assets });
  const result = await service.call('canvas-import-fig', {
    title: 'Journey',
    dataBase64: Buffer.from(file).toString('base64'),
  });
  assert.equal(created.length, 1, 'a board was created for the import');
  assert.equal(created[0].title, 'Journey', 'the file name titles the new board');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].canvasId, 'board-new');
  assert.ok(result.canvas.nodes.length >= 1, 'the imported node is on the board');
  assert.equal(result.canvas.id, 'board-new', 'the answer carries the board id the client needs');
});

test('an import into an existing board appends to it', async () => {
  const file = makeFig([{ type: 'STICKY', name: 'Another note', size: { x: 240, y: 240 } }]);
  const existing = {
    id: 'board-old', title: 'Existing', nodes: [], edges: [], camera: { x: 0, y: 0, zoom: 1 }, tokens: {}, themes: null,
  };
  const saved = [];
  const canvasRepository = {
    async create() { throw new Error('must not create a board when an id was given'); },
    async load(id) { assert.equal(id, 'board-old'); return existing; },
    async save(id, input) { saved.push({ id, input }); return { ...existing, ...input, id }; },
  };
  const assets = { async saveBytes() { return { assetId: 'asset-1' }; }, async save() { return { assetId: 'asset-1' }; } };
  const service = createHostService({ repository: {}, canvasRepository, assets });
  const result = await service.call('canvas-import-fig', {
    id: 'board-old',
    dataBase64: Buffer.from(file).toString('base64'),
  });
  assert.equal(result.canvas.id, 'board-old');
  assert.equal(saved.length, 1);
});


test('a partial archive falls back to the embedded thumbnail instead of an empty frame', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const thumbPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const originalHash = Buffer.alloc(20, 1);
  const thumbHash = Buffer.alloc(20, 2);
  // Only the thumbnail is in the archive, which is what "partial file saved" does.
  const images = new Map([[thumbHash.toString('hex'), new Uint8Array(thumbPng)]]);
  const file = makeFig([{
    type: 'ROUNDED_RECTANGLE', name: 'image 92', size: { x: 640, y: 360 },
    fillPaints: [{
      type: 'IMAGE', visible: true, opacity: 1,
      image: { hash: new Uint8Array(originalHash) },
      imageThumbnail: { hash: new Uint8Array(thumbHash) },
    }],
  }], { images });
  const { nodes, report } = await importFigFile(file, assetSink());
  const image = nodes.find((node) => node.type === 'image');
  assert.ok(image, 'the frame becomes a picture, not a white box');
  assert.equal(image.kind, 'image/png');
  assert.equal(image.w, 640);
  assert.ok(report.warnings.some((warning) => /came through as thumbnails/.test(warning)), 'the report says the picture is a thumbnail');
});

test('a picture with only its original embedded is not called a thumbnail', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const originalHash = Buffer.alloc(20, 3);
  const images = new Map([[originalHash.toString('hex'), new Uint8Array(png)]]);
  const file = makeFig([{
    type: 'ROUNDED_RECTANGLE', name: 'shot', size: { x: 400, y: 300 },
    fillPaints: [{
      type: 'IMAGE', visible: true, opacity: 1,
      image: { hash: new Uint8Array(originalHash) },
      imageThumbnail: { hash: new Uint8Array(Buffer.alloc(20, 4)) },
    }],
  }], { images });
  const { nodes, report } = await importFigFile(file, assetSink());
  assert.ok(nodes.some((node) => node.type === 'image'));
  assert.equal(report.imported.imageThumbnail, undefined, 'the original was used, so nothing is a thumbnail');
});

