import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CANVAS_LIMITS,
  createEmptyCanvas,
  normalizeCanvasDocument,
  summarizeCanvas,
} from '../lib/canvas-domain.js';

function node(id, overrides = {}) {
  return { id, type: 'sticky', x: 0, y: 0, w: 240, h: 160, text: 'body', ...overrides };
}

function edge(id, from, to, overrides = {}) {
  return { id, from, to, ...overrides };
}

function scene(overrides = {}) {
  return {
    version: 1,
    id: 'canvas-1',
    title: 'Board',
    createdAt: 10,
    updatedAt: 10,
    camera: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    edges: [],
    ...overrides,
  };
}

function rejectsCanvas(run) {
  return assert.throws(run, (error) => {
    assert.equal(error.code, 'INVALID_CANVAS', `expected INVALID_CANVAS, got ${error.code}: ${error.message}`);
    return true;
  });
}

test('normalizeCanvasDocument fills the default fields and drops unknown ones', () => {
  const input = { id: 'canvas-1', nodes: [{ id: 'n1', type: 'sticky', mystery: 'drop' }], edges: [], extra: true };
  const result = normalizeCanvasDocument(input);

  assert.deepEqual(result, {
    version: 1,
    id: 'canvas-1',
    title: 'Board',
    starred: false,
    createdAt: 0,
    updatedAt: 0,
    camera: { x: 0, y: 0, zoom: 1 },
    theme: 'light',
    themes: null,
    tokens: { colors: {}, gradients: {}, type: {} },
    nodes: [{
      id: 'n1',
      type: 'sticky',
      x: 0,
      y: 0,
      w: 240,
      h: 160,
      rotation: 0,
      text: '',
      spans: null,
      noteId: null,
      noteUpdatedAt: null,
      color: 'none',
      locked: false,
      visible: true,
      shape: 'rect',
      path: null,
      fill: null,
      stroke: null,
      strokeWidth: 0,
      opacity: 1,
      radius: 0,
      textAlign: 'left',
      members: [],
      title: '',
      sides: 5,
      points: 5,
      flipX: false,
      flipY: false,
      assetId: null,
      kind: null,
      fontSize: 14,
      textColor: null,
      fontFamily: null,
      fontWeight: null,
      lineHeight: null,
      letterSpacing: null,
      shadow: null,
      blur: 0,
      blend: 'normal',
      gradient: null,
      layout: 'none',
      grid: null,
      gap: 0,
      padding: 0,
      align: 'start',
      autoSize: false,
      constraints: { horizontal: 'left', vertical: 'top' },
      fillToken: null,
      strokeToken: null,
      textColorToken: null,
      gradientToken: null,
      typeToken: null,
      shadowColorToken: null,
      componentId: null,
      overrides: {},
      origin: null,
    }],
    edges: [],
    comments: [],
  });
  assert.equal(input.extra, true, 'the input keeps its unknown fields');
});

test('normalizeCanvasDocument returns a deep copy and never touches the input', () => {
  const input = scene({ nodes: [node('n1')], edges: [edge('e1', 'n1', 'n1')] });
  const result = normalizeCanvasDocument(input);

  result.nodes[0].text = 'changed';
  result.camera.zoom = 2;
  result.edges[0].label = 'changed';

  assert.equal(input.nodes[0].text, 'body');
  assert.equal(input.camera.zoom, 1);
  assert.equal(input.edges[0].label, undefined);
  assert.notEqual(result.nodes, input.nodes);
  assert.notEqual(result.nodes[0], input.nodes[0]);
});

test('normalizeCanvasDocument keeps a complete node shape and the anchor vocabulary', () => {
  const result = normalizeCanvasDocument(scene({
    nodes: [
      node('n1', { type: 'note', noteId: 'memo-1', noteUpdatedAt: 42, color: 'amber', locked: true, visible: false }),
      node('n2', { fromAnchor: 'top' }),
    ],
    edges: [edge('e1', 'n1', 'n2', { fromAnchor: 'left', toAnchor: 'bottom', label: 'links' })],
  }));

  assert.deepEqual(result.nodes[0], {
    id: 'n1',
    type: 'note',
    x: 0,
    y: 0,
    w: 240,
    h: 160,
    rotation: 0,
    text: 'body',
    spans: null,
    noteId: 'memo-1',
    noteUpdatedAt: 42,
    color: 'amber',
    locked: true,
    visible: false,
    shape: 'rect',
    path: null,
    fill: null,
    stroke: null,
    strokeWidth: 0,
    opacity: 1,
    radius: 0,
    textAlign: 'left',
    members: [],
    title: '',
    sides: 5,
    points: 5,
    flipX: false,
    flipY: false,
    assetId: null,
    kind: null,
    fontSize: 14,
    textColor: null,
    fontFamily: null,
    fontWeight: null,
    lineHeight: null,
    letterSpacing: null,
    shadow: null,
    blur: 0,
    blend: 'normal',
    gradient: null,
    layout: 'none',
    grid: null,
    gap: 0,
    padding: 0,
    align: 'start',
    autoSize: false,
    constraints: { horizontal: 'left', vertical: 'top' },
    fillToken: null,
    strokeToken: null,
    textColorToken: null,
    gradientToken: null,
    typeToken: null,
    shadowColorToken: null,
    componentId: null,
    overrides: {},
    origin: null,
  });
  assert.deepEqual(result.edges[0], {
    id: 'e1',
    from: 'n1',
    to: 'n2',
    fromAnchor: 'left',
    toAnchor: 'bottom',
    label: 'links',
    strokeWidth: 2,
    dash: 'solid',
    startArrow: 'none',
    endArrow: 'arrow',
    curve: 'bezier',
    stroke: null,
  });
});

test('normalizeCanvasDocument trims overlong content but keeps the structure intact', () => {
  const longText = 'x'.repeat(CANVAS_LIMITS.NODE_TEXT_MAX_LENGTH + 500);
  const longLabel = 'y'.repeat(CANVAS_LIMITS.EDGE_LABEL_MAX_LENGTH + 50);
  const longId = 'z'.repeat(CANVAS_LIMITS.ID_MAX_LENGTH + 30);
  const result = normalizeCanvasDocument(scene({
    title: 't'.repeat(CANVAS_LIMITS.TITLE_MAX_LENGTH + 40),
    nodes: [node(longId, { text: longText })],
    edges: [edge(`edge-${longId}`, longId, longId, { label: longLabel })],
  }));

  assert.equal(result.title.length, CANVAS_LIMITS.TITLE_MAX_LENGTH);
  assert.equal(result.nodes[0].text.length, CANVAS_LIMITS.NODE_TEXT_MAX_LENGTH);
  assert.equal(result.nodes[0].id.length, CANVAS_LIMITS.ID_MAX_LENGTH);
  assert.equal(result.edges[0].label.length, CANVAS_LIMITS.EDGE_LABEL_MAX_LENGTH);
});

test('normalizeCanvasDocument normalizes the title and the colour token', () => {
  assert.equal(normalizeCanvasDocument(scene({ title: '   ' })).title, 'Board');
  assert.equal(normalizeCanvasDocument(scene({ title: ' Roadmap ' })).title, 'Roadmap');
  assert.equal(normalizeCanvasDocument(scene({ nodes: [node('n1', { color: 'violet' })] })).nodes[0].color, 'none');
  assert.equal(normalizeCanvasDocument(scene({ nodes: [node('n1', { color: '#ff0000' })] })).nodes[0].color, 'none');
  assert.equal(normalizeCanvasDocument(scene({ nodes: [node('n1', { color: 'sage' })] })).nodes[0].color, 'sage');
  assert.throws(() => normalizeCanvasDocument(scene({ title: 42 })), (error) => error.code === 'INVALID_TITLE');
});

test('normalizeCanvasDocument rejects a document that is not an object', () => {
  assert.throws(() => normalizeCanvasDocument(null), (error) => error.code === 'INVALID_CANVAS');
  assert.throws(() => normalizeCanvasDocument('scene'), (error) => error.code === 'INVALID_CANVAS');
  assert.throws(() => normalizeCanvasDocument([]), (error) => error.code === 'INVALID_CANVAS');
});

test('normalizeCanvasDocument rejects an unusable canvas id', () => {
  assert.throws(() => normalizeCanvasDocument({}), (error) => error.code === 'INVALID_CANVAS_ID');
  assert.throws(() => normalizeCanvasDocument(scene({ id: '  ' })), (error) => error.code === 'INVALID_CANVAS_ID');
});

test('normalizeCanvasDocument rejects an unsupported version', () => {
  assert.throws(() => normalizeCanvasDocument(scene({ version: 2 })), (error) => error.code === 'INVALID_CANVAS');
});

test('normalizeCanvasDocument rejects an illegal node type', () => {
  rejectsCanvas(() => normalizeCanvasDocument(scene({ nodes: [node('n1', { type: 'widget' })] })));
  rejectsCanvas(() => normalizeCanvasDocument(scene({ nodes: [node('n1', { type: null })] })));
  rejectsCanvas(() => normalizeCanvasDocument(scene({ nodes: [node('n1', { type: 7 })] })));
});

test('normalizeCanvasDocument rejects a node without an id', () => {
  rejectsCanvas(() => normalizeCanvasDocument(scene({ nodes: [{ type: 'sticky' }] })));
  rejectsCanvas(() => normalizeCanvasDocument(scene({ nodes: [node('n1', { id: '  ' })] })));
});

test('normalizeCanvasDocument rejects duplicate node ids', () => {
  rejectsCanvas(() => normalizeCanvasDocument(scene({ nodes: [node('n1'), node('n1')] })));
});

test('normalizeCanvasDocument rejects duplicate edge ids', () => {
  rejectsCanvas(() => normalizeCanvasDocument(scene({
    nodes: [node('n1'), node('n2')],
    edges: [edge('e1', 'n1', 'n2'), edge('e1', 'n2', 'n1')],
  })));
});

test('normalizeCanvasDocument rejects an edge that points at a missing node', () => {
  rejectsCanvas(() => normalizeCanvasDocument(scene({
    nodes: [node('n1')],
    edges: [edge('e1', 'n1', 'ghost')],
  })));
  rejectsCanvas(() => normalizeCanvasDocument(scene({
    nodes: [node('n1')],
    edges: [edge('e1', 'ghost', 'n1')],
  })));
});

test('normalizeCanvasDocument rejects more than five hundred nodes', () => {
  const nodes = Array.from({ length: CANVAS_LIMITS.NODE_COUNT_MAX + 1 }, (_, index) => node(`n${index}`));
  rejectsCanvas(() => normalizeCanvasDocument(scene({ nodes })));
  const allowed = Array.from({ length: CANVAS_LIMITS.NODE_COUNT_MAX }, (_, index) => node(`n${index}`));
  assert.equal(normalizeCanvasDocument(scene({ nodes: allowed })).nodes.length, CANVAS_LIMITS.NODE_COUNT_MAX);
});

test('normalizeCanvasDocument rejects more than one thousand edges', () => {
  const edges = Array.from({ length: CANVAS_LIMITS.EDGE_COUNT_MAX + 1 }, (_, index) => edge(`e${index}`, 'n1', 'n2'));
  rejectsCanvas(() => normalizeCanvasDocument(scene({ nodes: [node('n1'), node('n2')], edges })));
  const allowed = Array.from({ length: CANVAS_LIMITS.EDGE_COUNT_MAX }, (_, index) => edge(`e${index}`, 'n1', 'n2'));
  assert.equal(normalizeCanvasDocument(scene({ nodes: [node('n1'), node('n2')], edges: allowed })).edges.length, CANVAS_LIMITS.EDGE_COUNT_MAX);
});

test('normalizeCanvasDocument rejects a node size outside the allowed range', () => {
  rejectsCanvas(() => normalizeCanvasDocument(scene({ nodes: [node('n1', { w: CANVAS_LIMITS.NODE_SIZE_MIN - 1 })] })));
  rejectsCanvas(() => normalizeCanvasDocument(scene({ nodes: [node('n1', { w: CANVAS_LIMITS.NODE_SIZE_MAX + 1 })] })));
  rejectsCanvas(() => normalizeCanvasDocument(scene({ nodes: [node('n1', { h: CANVAS_LIMITS.NODE_SIZE_MIN - 1 })] })));
  rejectsCanvas(() => normalizeCanvasDocument(scene({ nodes: [node('n1', { h: CANVAS_LIMITS.NODE_SIZE_MAX + 1 })] })));
  rejectsCanvas(() => normalizeCanvasDocument(scene({ nodes: [node('n1', { w: 'wide' })] })));
});

test('a coordinate that is far out is clamped, not rejected', () => {
  // An infinite canvas may not refuse a save because a node went far: the
  // range keeps a value finite and JSON-safe, it does not police position.
  const left = normalizeCanvasDocument(scene({ nodes: [node('n1', { x: CANVAS_LIMITS.COORDINATE_MIN - 1 })] }));
  assert.equal(left.nodes[0].x, CANVAS_LIMITS.COORDINATE_MIN);
  const right = normalizeCanvasDocument(scene({ nodes: [node('n1', { x: CANVAS_LIMITS.COORDINATE_MAX + 1 })] }));
  assert.equal(right.nodes[0].x, CANVAS_LIMITS.COORDINATE_MAX);
  // A non-finite value is a corrupt document, which is a different problem.
  rejectsCanvas(() => normalizeCanvasDocument(scene({ nodes: [node('n1', { x: Number.NaN })] })));
  rejectsCanvas(() => normalizeCanvasDocument(scene({ nodes: [node('n1', { x: Infinity })] })));
});

test('normalizeCanvasDocument rejects a camera zoom outside the allowed range', () => {
  rejectsCanvas(() => normalizeCanvasDocument(scene({ camera: { x: 0, y: 0, zoom: CANVAS_LIMITS.ZOOM_MIN - 0.01 } })));
  rejectsCanvas(() => normalizeCanvasDocument(scene({ camera: { x: 0, y: 0, zoom: CANVAS_LIMITS.ZOOM_MAX + 0.01 } })));
  rejectsCanvas(() => normalizeCanvasDocument(scene({ camera: { x: 0, y: 0, zoom: 'far' } })));
  // A camera position is clamped like any coordinate; the zoom is a ratio,
  // so an out-of-range zoom is still refused.
  const panned = normalizeCanvasDocument(scene({ camera: { x: CANVAS_LIMITS.COORDINATE_MAX + 1, y: 0, zoom: 1 } }));
  assert.equal(panned.camera.x, CANVAS_LIMITS.COORDINATE_MAX);
  assert.deepEqual(normalizeCanvasDocument(scene({ camera: undefined })).camera, { x: 0, y: 0, zoom: 1 });
});

test('normalizeCanvasDocument rejects a note node without a note id', () => {
  rejectsCanvas(() => normalizeCanvasDocument(scene({ nodes: [node('n1', { type: 'note' })] })));
  rejectsCanvas(() => normalizeCanvasDocument(scene({ nodes: [node('n1', { type: 'note', noteId: '  ' })] })));
  rejectsCanvas(() => normalizeCanvasDocument(scene({ nodes: [node('n1', { type: 'note', noteId: 'memo-1', noteUpdatedAt: -1 })] })));
  const sticky = normalizeCanvasDocument(scene({ nodes: [node('n1', { noteId: 'memo-1' })] }));
  assert.equal(sticky.nodes[0].noteId, null, 'a non-note node never binds a note');
});

test('normalizeCanvasDocument rejects an illegal rotation or anchor', () => {
  rejectsCanvas(() => normalizeCanvasDocument(scene({ nodes: [node('n1', { rotation: 360 })] })));
  rejectsCanvas(() => normalizeCanvasDocument(scene({ nodes: [node('n1', { rotation: -1 })] })));
  rejectsCanvas(() => normalizeCanvasDocument(scene({
    nodes: [node('n1'), node('n2')],
    edges: [edge('e1', 'n1', 'n2', { fromAnchor: 'middle' })],
  })));
  rejectsCanvas(() => normalizeCanvasDocument(scene({
    nodes: [node('n1'), node('n2')],
    edges: [edge('e1', 'n1', 'n2', { toAnchor: 3 })],
  })));
});

test('normalizeCanvasDocument rejects a node list that is not an array', () => {
  rejectsCanvas(() => normalizeCanvasDocument(scene({ nodes: { id: 'n1' } })));
  rejectsCanvas(() => normalizeCanvasDocument(scene({ edges: 'none' })));
  rejectsCanvas(() => normalizeCanvasDocument(scene({ nodes: ['n1'] })));
  rejectsCanvas(() => normalizeCanvasDocument(scene({ nodes: [node('n1', { locked: 'yes' })] })));
  rejectsCanvas(() => normalizeCanvasDocument(scene({ nodes: [node('n1', { visible: 1 })] })));
  rejectsCanvas(() => normalizeCanvasDocument(scene({ nodes: [node('n1', { text: 12 })] })));
});

test('createEmptyCanvas builds the canonical empty board', () => {
  assert.deepEqual(createEmptyCanvas({ id: 'canvas-1', now: 1000 }), {
    version: 1,
    id: 'canvas-1',
    title: 'Board',
    starred: false,
    createdAt: 1000,
    updatedAt: 1000,
    camera: { x: 0, y: 0, zoom: 1 },
    theme: 'light',
    themes: null,
    tokens: { colors: {}, gradients: {}, type: {} },
    nodes: [],
    edges: [],
    comments: [],
  });
  assert.equal(createEmptyCanvas({ id: 'canvas-1', title: '  ', now: 0 }).title, 'Board');
  assert.equal(createEmptyCanvas({ id: 'canvas-1', title: 'Roadmap', now: 0 }).title, 'Roadmap');
  assert.throws(() => createEmptyCanvas({ id: '  ' }), (error) => error.code === 'INVALID_CANVAS_ID');
});

test('summarizeCanvas counts the nodes and the edges of one board', () => {
  const canvas = normalizeCanvasDocument(scene({
    nodes: [node('n1'), node('n2')],
    edges: [edge('e1', 'n1', 'n2')],
  }));
  assert.deepEqual(summarizeCanvas(canvas), {
    id: 'canvas-1',
    title: 'Board',
    nodeCount: 2,
    edgeCount: 1,
    groupCount: 0,
    frameCount: 0,
    shapeCount: 0,
    starred: false,
    imageCount: 0,
    commentCount: 0,
    openCommentCount: 0,
    createdAt: 10,
    updatedAt: 10,
  });
});

function rejectsMembers(run) {
  return assert.throws(run, (error) => {
    assert.equal(error.code, 'INVALID_MEMBERS', `expected INVALID_MEMBERS, got ${error.code}: ${error.message}`);
    return true;
  });
}

function shapeNode(overrides = {}) {
  return normalizeCanvasDocument(scene({
    nodes: [node('s1', { type: 'shape', ...overrides })],
  })).nodes[0];
}

test('normalizeCanvasDocument accepts the shape and group node types', () => {
  const result = normalizeCanvasDocument(scene({
    nodes: [
      node('s1', {
        type: 'shape',
        shape: 'ellipse',
        fill: '#A1B2C3',
        stroke: '#fff',
        strokeWidth: 2,
        opacity: 0.5,
        radius: 8,
        textAlign: 'center',
      }),
      node('g1', { type: 'group', members: ['n1', 'n2'] }),
      node('n1'),
      node('n2'),
    ],
  }));

  const shape = result.nodes[0];
  assert.equal(shape.type, 'shape');
  assert.equal(shape.shape, 'ellipse');
  assert.equal(shape.fill, '#a1b2c3');
  assert.equal(shape.stroke, '#fff');
  assert.equal(shape.strokeWidth, 2);
  assert.equal(shape.opacity, 0.5);
  assert.equal(shape.radius, 8);
  assert.equal(shape.textAlign, 'center');
  assert.deepEqual(shape.members, []);

  const group = result.nodes[1];
  assert.equal(group.type, 'group');
  assert.deepEqual(group.members, ['n1', 'n2']);
  assert.equal(group.shape, 'rect', 'a group is not a shape');
});

test('normalizeCanvasDocument rejects an illegal shape flavour or text alignment', () => {
  rejectsCanvas(() => normalizeCanvasDocument(scene({ nodes: [node('s1', { type: 'shape', shape: 'triangle' })] })));
  rejectsCanvas(() => normalizeCanvasDocument(scene({ nodes: [node('s1', { type: 'shape', shape: 'RECT' })] })));
  rejectsCanvas(() => normalizeCanvasDocument(scene({ nodes: [node('n1', { textAlign: 'justify' })] })));
  rejectsCanvas(() => normalizeCanvasDocument(scene({ nodes: [node('n1', { textAlign: 3 })] })));
});

test('normalizeCanvasDocument accepts only colour literals and lowercases them', () => {
  assert.equal(shapeNode({ fill: '#abc' }).fill, '#abc');
  assert.equal(shapeNode({ fill: '#ABC' }).fill, '#abc');
  assert.equal(shapeNode({ fill: '#A1B2C3' }).fill, '#a1b2c3');
  assert.equal(shapeNode({ fill: ' #abc ' }).fill, '#abc');
  assert.equal(shapeNode({ stroke: '#000' }).stroke, '#000');
  assert.equal(shapeNode({}).fill, null);
  assert.equal(shapeNode({}).stroke, null);
});

test('normalizeCanvasDocument rejects colour names and malformed literals', () => {
  for (const value of ['red', 'rgba(0, 0, 0, 0.5)', 'hsl(120, 50%, 50%)', 'rgb(1, 2, 3)', '#12345', '#', 42, true, {}]) {
    assert.throws(
      () => shapeNode({ fill: value }),
      (error) => error.code === 'INVALID_COLOR',
      `expected INVALID_COLOR for ${String(value)}`,
    );
  }
});

test('normalizeCanvasDocument rejects style numbers outside their range', () => {
  assert.equal(shapeNode({ strokeWidth: 0 }).strokeWidth, 0);
  assert.equal(shapeNode({ strokeWidth: 64 }).strokeWidth, 64);
  assert.equal(shapeNode({ opacity: 0 }).opacity, 0);
  assert.equal(shapeNode({ opacity: 1 }).opacity, 1);
  assert.equal(shapeNode({ radius: 999 }).radius, 999);
  for (const overrides of [
    { strokeWidth: 65 }, { strokeWidth: -1 }, { strokeWidth: 'thick' },
    { opacity: 1.1 }, { opacity: -0.1 },
    { radius: 1000 }, { radius: -1 },
  ]) {
    assert.throws(
      () => shapeNode(overrides),
      (error) => error.code === 'INVALID_CANVAS',
      `expected INVALID_CANVAS for ${JSON.stringify(overrides)}`,
    );
  }
});

test('normalizeCanvasDocument accepts a group that holds two members', () => {
  const result = normalizeCanvasDocument(scene({
    nodes: [node('g1', { type: 'group', members: ['n1', 'n2'] }), node('n1'), node('n2')],
  }));
  assert.deepEqual(result.nodes[0].members, ['n1', 'n2']);
});

test('normalizeCanvasDocument rejects a group member that does not exist', () => {
  rejectsMembers(() => normalizeCanvasDocument(scene({
    nodes: [node('g1', { type: 'group', members: ['ghost'] })],
  })));
});

test('a group may contain another group', () => {
  // A layer tree is not a flat list: nesting is the whole point.
  const result = normalizeCanvasDocument(scene({
    nodes: [
      node('g1', { type: 'group', members: ['g2'] }),
      node('g2', { type: 'group', members: ['n1'] }),
      node('n1'),
    ],
  }));
  assert.deepEqual(result.nodes.find((item) => item.id === 'g1').members, ['g2']);
  assert.deepEqual(result.nodes.find((item) => item.id === 'g2').members, ['n1']);
});

test('a container may not contain its own ancestor', () => {
  rejectsMembers(() => normalizeCanvasDocument(scene({
    nodes: [
      node('g1', { type: 'group', members: ['g2'] }),
      node('g2', { type: 'group', members: ['g1'] }),
    ],
  })));
});

test('normalizeCanvasDocument rejects a node that belongs to two groups', () => {
  rejectsMembers(() => normalizeCanvasDocument(scene({
    nodes: [
      node('g1', { type: 'group', members: ['n1'] }),
      node('g2', { type: 'group', members: ['n1'] }),
      node('n1'),
    ],
  })));
});

test('normalizeCanvasDocument rejects a group that lists itself', () => {
  rejectsMembers(() => normalizeCanvasDocument(scene({
    nodes: [node('g1', { type: 'group', members: ['g1'] })],
  })));
});

test('normalizeCanvasDocument accepts an empty group', () => {
  const result = normalizeCanvasDocument(scene({ nodes: [node('g1', { type: 'group', members: [] })] }));
  assert.deepEqual(result.nodes[0].members, []);
});

test('normalizeCanvasDocument drops the group fields on a node that is not a group', () => {
  const result = normalizeCanvasDocument(scene({
    nodes: [node('n1', { members: ['n2'], shape: 'ellipse' }), node('n2')],
  }));
  assert.deepEqual(result.nodes[0].members, []);
  assert.equal(result.nodes[0].shape, 'rect');
});

test('normalizeCanvasDocument loads a document written before the new fields', () => {
  const legacy = {
    version: 1,
    id: 'canvas-1',
    title: 'Legacy',
    createdAt: 10,
    updatedAt: 10,
    camera: { x: 5, y: 6, zoom: 1.5 },
    nodes: [{
      id: 'n1',
      type: 'sticky',
      x: 0,
      y: 0,
      w: 240,
      h: 160,
      rotation: 0,
      text: 'legacy',
      noteId: null,
      noteUpdatedAt: null,
      color: 'none',
      locked: false,
      visible: true,
    }],
    edges: [],
  };
  const result = normalizeCanvasDocument(legacy);
  assert.equal(result.nodes[0].type, 'sticky');
  assert.equal(result.nodes[0].text, 'legacy');
  assert.equal(result.nodes[0].shape, 'rect');
  assert.equal(result.nodes[0].fill, null);
  assert.equal(result.nodes[0].stroke, null);
  assert.equal(result.nodes[0].strokeWidth, 0);
  assert.equal(result.nodes[0].opacity, 1);
  assert.equal(result.nodes[0].radius, 0);
  assert.equal(result.nodes[0].textAlign, 'left');
  assert.deepEqual(result.nodes[0].members, []);
});

test('normalizeCanvasDocument accepts a frame with members, a title and a fill', () => {
  const result = normalizeCanvasDocument(scene({
    nodes: [
      node('f1', { type: 'frame', title: 'Flow', members: ['n1', 'n2'], fill: '#fbfaf8' }),
      node('n1'),
      node('n2'),
    ],
  }));
  const frame = result.nodes[0];
  assert.equal(frame.type, 'frame');
  assert.equal(frame.title, 'Flow');
  assert.deepEqual(frame.members, ['n1', 'n2']);
  assert.equal(frame.fill, '#fbfaf8');
});

test('frames and groups nest into each other', () => {
  const inFrame = normalizeCanvasDocument(scene({
    nodes: [
      node('f1', { type: 'frame', members: ['g1'] }),
      node('g1', { type: 'group', members: ['n1'] }),
      node('n1'),
    ],
  }));
  assert.deepEqual(inFrame.nodes.find((item) => item.id === 'f1').members, ['g1']);

  const inGroup = normalizeCanvasDocument(scene({
    nodes: [
      node('g1', { type: 'group', members: ['f1'] }),
      node('f1', { type: 'frame', members: ['n1'] }),
      node('n1'),
    ],
  }));
  assert.deepEqual(inGroup.nodes.find((item) => item.id === 'g1').members, ['f1']);

  // ... but a node still belongs to exactly one container.
  rejectsMembers(() => normalizeCanvasDocument(scene({
    nodes: [
      node('g1', { type: 'group', members: ['n1'] }),
      node('f1', { type: 'frame', members: ['n1'] }),
      node('n1'),
    ],
  })));
});

test('normalizeCanvasDocument trims an overlong frame title and drops it off a non-frame', () => {
  const longTitle = 'x'.repeat(CANVAS_LIMITS.TITLE_MAX_LENGTH + 20);
  const frame = normalizeCanvasDocument(scene({
    nodes: [node('f1', { type: 'frame', title: longTitle })],
  }));
  assert.equal(frame.nodes[0].title.length, CANVAS_LIMITS.TITLE_MAX_LENGTH);
  const sticky = normalizeCanvasDocument(scene({ nodes: [node('n1', { title: 'Flow' })] }));
  assert.equal(sticky.nodes[0].title, '');
});

test('normalizeCanvasDocument reads and writes the starred flag with a false default', () => {
  assert.equal(normalizeCanvasDocument(scene({})).starred, false);
  assert.equal(normalizeCanvasDocument(scene({ starred: true })).starred, true);
  assert.throws(
    () => normalizeCanvasDocument(scene({ starred: 'yes' })),
    (error) => error.code === 'INVALID_CANVAS',
  );
});

test('an out-of-range node names itself in the error', () => {
  const document = {
    version: 1, id: 'board-x', title: 'Limits', createdAt: 1, updatedAt: 2,
    camera: { x: 0, y: 0, zoom: 1 },
    nodes: [{ id: 'wide-shape', type: 'shape', shape: 'rect', x: 0, y: 0, w: 9000, h: 400 }],
    edges: [],
  };
  assert.throws(
    () => normalizeCanvasDocument(document),
    /node\.w must be between 16 and 8000 — node wide-shape has w=9000/,
  );
});

test('a container may be wider than a single node, because its box is derived', () => {
  // A Figma section holding a flow is routinely wider than one object; the cap
  // that protects a leaf node would reject the whole board on save.
  const document = {
    version: 1, id: 'board-wide', title: 'Wide', createdAt: 1, updatedAt: 2,
    camera: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'section', type: 'frame', x: 0, y: 0, w: 12241, h: 504, members: ['leaf'] },
      { id: 'leaf', type: 'shape', shape: 'rect', x: 100, y: 100, w: 400, h: 200 },
    ],
    edges: [],
  };
  const normalized = normalizeCanvasDocument(document);
  assert.equal(normalized.nodes.find((node) => node.id === 'section').w, 12241);
  // The same width on a leaf is still refused.
  assert.throws(
    () => normalizeCanvasDocument({
      ...document,
      nodes: [{ ...document.nodes[0], id: 'leaf2', type: 'shape', shape: 'rect', members: [], w: 12241 }],
    }),
    /node\.w must be between 16 and 8000/,
  );
});

