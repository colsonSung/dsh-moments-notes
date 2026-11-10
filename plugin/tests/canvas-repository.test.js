import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openCanvasRepository } from '../lib/canvas-repository.js';

function sequence(prefix) {
  let value = 0;
  return () => `${prefix}-${++value}`;
}

function node(id, overrides = {}) {
  return { id, type: 'sticky', x: 0, y: 0, w: 240, h: 160, text: 'body', ...overrides };
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'flomo-canvas-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function fixture(t, options = {}) {
  const directory = await temporaryDirectory(t);
  const filePath = join(directory, 'nested', 'canvases.json');
  const repository = await openCanvasRepository({
    filePath,
    now: options.now || (() => 1000),
    id: options.id || sequence('canvas'),
  });
  t.after(() => repository.close());
  return { directory, filePath, repository };
}

test('openCanvasRepository creates the store file and an empty canvas list', async (t) => {
  const { directory, filePath, repository } = await fixture(t);
  assert.deepEqual(await repository.list(), []);
  const persisted = JSON.parse(await readFile(filePath, 'utf8'));
  assert.deepEqual(persisted, { version: 1, canvases: [] });
  // The history file is a real artifact; what the assertion rules out is a
  // leftover temporary file from a broken write.
  const left = await readdir(join(directory, 'nested'));
  assert.deepEqual(left.filter((name) => !name.endsWith('.history.json')), ['canvases.json']);
});

test('create stores a canonical empty board with a generated id', async (t) => {
  const { filePath, repository } = await fixture(t);
  const created = await repository.create({ title: 'Roadmap' });

  assert.deepEqual(created, {
    version: 1,
    id: 'canvas-1',
    title: 'Roadmap',
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

  const fallback = await repository.create({});
  assert.equal(fallback.title, 'Board');
  assert.equal(fallback.id, 'canvas-2');
  assert.equal(JSON.parse(await readFile(filePath, 'utf8')).canvases.length, 2);
});

test('create rejects an unusable title before touching the store', async (t) => {
  const { filePath, repository } = await fixture(t);
  await assert.rejects(repository.create({ title: 42 }), (error) => error.code === 'INVALID_TITLE');
  const blank = await repository.create({ title: '   ' });
  assert.equal(blank.title, 'Board', 'a blank title falls back to the default');
  assert.equal(JSON.parse(await readFile(filePath, 'utf8')).canvases.length, 1);
});

test('save replaces the document it is given and keeps what it omits', async (t) => {
  let time = 1000;
  const { repository } = await fixture(t, { now: () => time });
  const created = await repository.create({ title: 'Roadmap' });

  time = 2000;
  const saved = await repository.save(created.id, {
    nodes: [node('n1')],
    edges: [],
    camera: { x: 10, y: 20, zoom: 2 },
  });

  assert.equal(saved.id, created.id);
  assert.equal(saved.title, 'Roadmap', 'an omitted title keeps the current one');
  assert.equal(saved.createdAt, 1000, 'createdAt is preserved');
  assert.equal(saved.updatedAt, 2000, 'updatedAt follows the clock');
  assert.equal(saved.nodes.length, 1);
  assert.deepEqual(saved.camera, { x: 10, y: 20, zoom: 2 });

  // A partial write must not be able to delete a board: an update that only
  // names a field keeps everything it does not mention.
  time = 3000;
  const partial = await repository.save(created.id, {});
  assert.equal(partial.nodes.length, 1, 'an omitted node list keeps the current nodes');
  assert.deepEqual(partial.edges, []);
  assert.equal(partial.updatedAt, 3000);
  assert.equal(partial.createdAt, 1000);

  // An explicit empty list still clears the scene.
  const cleared = await repository.save(created.id, { nodes: [], edges: [] });
  assert.deepEqual(cleared.nodes, []);
  assert.deepEqual(cleared.edges, []);

  const renamed = await repository.save(created.id, { title: '  Plan  ' });
  assert.equal(renamed.title, 'Plan');
});

test('load returns the normalized document that was saved', async (t) => {
  const { repository } = await fixture(t);
  const created = await repository.create({ title: 'Roadmap' });
  await repository.save(created.id, {
    nodes: [node('n1', { text: 'body' })],
    edges: [{ id: 'e1', from: 'n1', to: 'n1', label: 'loop' }],
    camera: { x: 0, y: 0, zoom: 1 },
  });

  const loaded = await repository.load(created.id);
  assert.equal(loaded.nodes[0].text, 'body');
  assert.equal(loaded.nodes[0].color, 'none');
  assert.equal(loaded.edges[0].label, 'loop');
  assert.equal(loaded.edges[0].fromAnchor, 'auto');
  assert.equal(loaded.updatedAt, 1000);
});

test('an unknown board is rejected with CANVAS_NOT_FOUND', async (t) => {
  const { repository } = await fixture(t);
  await assert.rejects(repository.load('missing'), (error) => error.code === 'CANVAS_NOT_FOUND');
  await assert.rejects(repository.save('missing', { nodes: [], edges: [] }), (error) => error.code === 'CANVAS_NOT_FOUND');
  await assert.rejects(repository.delete('missing'), (error) => error.code === 'CANVAS_NOT_FOUND');
  await assert.rejects(repository.load('   '), (error) => error.code === 'INVALID_CANVAS_ID');
});

test('delete removes a board and later loads reject it', async (t) => {
  const { filePath, repository } = await fixture(t);
  const created = await repository.create({ title: 'Roadmap' });
  assert.deepEqual(await repository.delete(created.id), { deleted: true, id: created.id });
  await assert.rejects(repository.load(created.id), (error) => error.code === 'CANVAS_NOT_FOUND');
  assert.equal(JSON.parse(await readFile(filePath, 'utf8')).canvases.length, 0);
});

test('concurrent writes are serialized without losing a board', async (t) => {
  const { directory, filePath, repository } = await fixture(t, { id: sequence('serial') });
  const created = await Promise.all(Array.from({ length: 12 }, (_, index) => repository.create({ title: `Board ${index}` })));
  assert.equal(created.length, 12);
  assert.equal((await repository.list()).length, 12);

  await Promise.all(created.map((canvas, index) => repository.save(canvas.id, {
    nodes: [node(`n${index}`)],
    edges: [],
    camera: { x: 0, y: 0, zoom: 1 },
  })));

  const canvases = await repository.list();
  assert.equal(canvases.length, 12);
  assert.equal(canvases.every((canvas) => canvas.nodes.length === 1), true);
  assert.equal(JSON.parse(await readFile(filePath, 'utf8')).canvases.length, 12);
  // The history file is a real artifact; what the assertion rules out is a
  // leftover temporary file from a broken write.
  const left = await readdir(join(directory, 'nested'));
  assert.deepEqual(left.filter((name) => !name.endsWith('.history.json')), ['canvases.json']);
});

test('a read waits for the write that was queued before it', async (t) => {
  const { repository } = await fixture(t);
  const created = await repository.create({ title: 'Roadmap' });
  const saving = repository.save(created.id, {
    nodes: [node('n1')],
    edges: [],
    camera: { x: 0, y: 0, zoom: 1 },
  });
  const loading = repository.load(created.id);
  const [, loaded] = await Promise.all([saving, loading]);
  assert.equal(loaded.nodes.length, 1, 'the read observes the newest committed state');
});

test('a rejected save leaves the stored board untouched', async (t) => {
  const { filePath, repository } = await fixture(t);
  const created = await repository.create({ title: 'Roadmap' });
  await assert.rejects(repository.save(created.id, {
    nodes: [node('n1', { type: 'widget' })],
    edges: [],
    camera: { x: 0, y: 0, zoom: 1 },
  }), (error) => error.code === 'INVALID_CANVAS');

  const loaded = await repository.load(created.id);
  assert.deepEqual(loaded.nodes, []);
  assert.equal(JSON.parse(await readFile(filePath, 'utf8')).canvases[0].nodes.length, 0);
});

test('close drains accepted writes and rejects every later operation', async (t) => {
  const { filePath, repository } = await fixture(t, { id: sequence('close') });
  const pending = Promise.all([
    repository.create({ title: 'one' }),
    repository.create({ title: 'two' }),
  ]);
  const closing = repository.close();
  await Promise.all([pending, closing]);
  await repository.close();
  await assert.rejects(repository.create({ title: 'three' }), /closed/i);
  await assert.rejects(repository.list(), /closed/i);
  await assert.rejects(repository.load('canvas-1'), /closed/i);
  assert.equal(JSON.parse(await readFile(filePath, 'utf8')).canvases.length, 2);
});

test('the store survives a reopen and keeps every board', async (t) => {
  const { filePath, repository } = await fixture(t);
  const created = await repository.create({ title: 'Roadmap' });
  await repository.save(created.id, {
    nodes: [node('n1')],
    edges: [],
    camera: { x: 0, y: 0, zoom: 1 },
  });
  await repository.close();

  const reopened = await openCanvasRepository({ filePath, now: () => 5000, id: sequence('reopened') });
  t.after(() => reopened.close());
  const canvases = await reopened.list();
  assert.equal(canvases.length, 1);
  assert.equal(canvases[0].title, 'Roadmap');
  assert.equal(canvases[0].nodes.length, 1);
  assert.equal(canvases[0].createdAt, 1000);
});

test('a corrupt or unsupported store is rejected and never overwritten', async (t) => {
  const directory = await temporaryDirectory(t);
  const filePath = join(directory, 'canvases.json');

  await writeFile(filePath, '{broken', 'utf8');
  await assert.rejects(openCanvasRepository({ filePath }), /corrupt|invalid|JSON/i);
  assert.equal(await readFile(filePath, 'utf8'), '{broken');

  await writeFile(filePath, JSON.stringify({ version: 2, canvases: [] }), 'utf8');
  await assert.rejects(openCanvasRepository({ filePath }), /version/i);
  assert.equal(JSON.parse(await readFile(filePath, 'utf8')).version, 2);

  await writeFile(filePath, JSON.stringify({
    version: 1,
    canvases: [{ version: 1, id: 'broken', title: 'x', createdAt: 1, updatedAt: 1, camera: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: 'n1', type: 'widget' }], edges: [] }],
  }), 'utf8');
  await assert.rejects(openCanvasRepository({ filePath }), /invalid canvas/i);
  assert.equal(JSON.parse(await readFile(filePath, 'utf8')).canvases.length, 1);
});

test('openCanvasRepository validates its options', async (t) => {
  const directory = await temporaryDirectory(t);
  const filePath = join(directory, 'canvases.json');
  await assert.rejects(openCanvasRepository(), /filePath/i);
  await assert.rejects(openCanvasRepository({ filePath: ' ' }), /filePath/i);
  await assert.rejects(openCanvasRepository({ filePath, now: true }), /now/i);
  await assert.rejects(openCanvasRepository({ filePath, id: 'id' }), /id/i);
});

test('a board with the new fields survives a save and load round trip', async (t) => {
  const { repository } = await fixture(t);
  const created = await repository.create({ title: 'Roadmap' });
  await repository.save(created.id, {
    nodes: [
      { id: 's1', type: 'shape', shape: 'ellipse', fill: '#A1B2C3', strokeWidth: 2, opacity: 0.5, radius: 8, textAlign: 'center' },
      { id: 'g1', type: 'group', members: ['s1'] },
    ],
    edges: [],
    camera: { x: 0, y: 0, zoom: 1 },
  });

  const loaded = await repository.load(created.id);
  assert.equal(loaded.nodes[0].type, 'shape');
  assert.equal(loaded.nodes[0].shape, 'ellipse');
  assert.equal(loaded.nodes[0].fill, '#a1b2c3');
  assert.equal(loaded.nodes[0].strokeWidth, 2);
  assert.equal(loaded.nodes[0].opacity, 0.5);
  assert.equal(loaded.nodes[0].radius, 8);
  assert.equal(loaded.nodes[0].textAlign, 'center');
  assert.deepEqual(loaded.nodes[1].members, ['s1']);
});

test('a board with illegal members is rejected and the stored board stays untouched', async (t) => {
  const { filePath, repository } = await fixture(t);
  const created = await repository.create({ title: 'Roadmap' });
  await assert.rejects(repository.save(created.id, {
    nodes: [{ id: 'g1', type: 'group', members: ['ghost'] }],
    edges: [],
    camera: { x: 0, y: 0, zoom: 1 },
  }), (error) => error.code === 'INVALID_MEMBERS');

  const loaded = await repository.load(created.id);
  assert.deepEqual(loaded.nodes, []);
  assert.equal(JSON.parse(await readFile(filePath, 'utf8')).canvases[0].nodes.length, 0);
});

test('a store written before the new fields still opens with the defaults filled in', async (t) => {
  const directory = await temporaryDirectory(t);
  const filePath = join(directory, 'canvases.json');
  await writeFile(filePath, JSON.stringify({
    version: 1,
    canvases: [{
      version: 1,
      id: 'canvas-legacy',
      title: 'Legacy',
      createdAt: 1,
      updatedAt: 2,
      camera: { x: 0, y: 0, zoom: 1 },
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
    }],
  }), 'utf8');

  const repository = await openCanvasRepository({ filePath });
  t.after(() => repository.close());
  const loaded = await repository.load('canvas-legacy');
  assert.equal(loaded.nodes[0].text, 'legacy');
  assert.equal(loaded.nodes[0].shape, 'rect');
  assert.equal(loaded.nodes[0].fill, null);
  assert.equal(loaded.nodes[0].stroke, null);
  assert.equal(loaded.nodes[0].strokeWidth, 0);
  assert.equal(loaded.nodes[0].opacity, 1);
  assert.equal(loaded.nodes[0].radius, 0);
  assert.equal(loaded.nodes[0].textAlign, 'left');
  assert.deepEqual(loaded.nodes[0].members, []);
});

test('saving keeps a version and restoring puts it back', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'moments-history-'));
  const repository = await openCanvasRepository({ filePath: join(directory, 'canvases.json') });
  try {
    const created = await repository.create({ title: 'Versions' });
    const first = await repository.save(created.id, {
      nodes: [{ id: 'n1', type: 'sticky', text: 'first' }],
      edges: [],
    });
    const second = await repository.save(created.id, {
      nodes: [
        { id: 'n1', type: 'sticky', text: 'first' },
        { id: 'n2', type: 'sticky', text: 'second' },
      ],
      edges: [],
    });
    assert.equal(second.nodes.length, 2);

    const versions = await repository.history(created.id);
    assert.equal(versions.length, 2, 'each save keeps the document it replaced');
    assert.deepEqual(versions.map((version) => version.nodeCount), [0, 1], 'newest last');
    assert.ok(versions.every((version) => typeof version.at === 'number'));

    const restored = await repository.restore(created.id, versions[1].id);
    assert.equal(restored.nodes.length, 1, 'the version comes back');
    assert.equal(restored.nodes[0].text, 'first');
    // Restoring is itself a change: the two-node state is now a version too.
    const afterRestore = await repository.history(created.id);
    assert.equal(afterRestore.length, 3);
    await assert.rejects(
      repository.restore(created.id, 'nope'),
      (error) => error.code === 'VERSION_NOT_FOUND',
    );
  } finally {
    repository.close();
    await rm(directory, { recursive: true, force: true });
  }
});


test('a save that omits the edge list does not delete the connectors', async (t) => {
  let time = 1000;
  const { repository } = await fixture(t, { now: () => time });
  const created = await repository.create({ title: 'Flow' });
  const nodes = [
    { id: 'a', type: 'shape', shape: 'rect', x: 0, y: 0, w: 200, h: 100 },
    { id: 'b', type: 'shape', shape: 'rect', x: 400, y: 0, w: 200, h: 100 },
  ];
  time = 2000;
  await repository.save(created.id, {
    nodes,
    edges: [{ id: 'e1', from: 'a', to: 'b', fromAnchor: 'right', toAnchor: 'left', endArrow: 'arrow' }],
  });

  // A partial writer (a migration, a script) that only carries nodes must not
  // take the connectors with it.
  time = 3000;
  const partial = await repository.save(created.id, { nodes: nodes.map((node) => ({ ...node, y: node.y + 40 })) });
  assert.equal(partial.edges.length, 1, 'the connector survives a node-only save');
  assert.equal(partial.nodes[0].y, 40, 'the explicit node list is applied');

  const cleared = await repository.save(created.id, { edges: [] });
  assert.equal(cleared.edges.length, 0, 'an explicit empty list still clears them');
  assert.equal(cleared.nodes.length, 2, 'and keeps the nodes it did not mention');
});

