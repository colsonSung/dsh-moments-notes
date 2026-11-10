import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openCanvasRepository } from '../lib/canvas-repository.js';
import { createDesignTools } from '../lib/design-tools.js';

async function withTools(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'moments-design-'));
  const filePath = join(directory, 'canvases.json');
  const repository = await openCanvasRepository({ filePath });
  const byName = new Map(createDesignTools({ getCanvasStore: () => repository }).map((tool) => [tool.name, tool]));
  const begin = byName.get('design_begin');
  const nodes = byName.get('design_nodes');
  const finish = byName.get('design_finish');
  const inspect = byName.get('design_inspect');
  try {
    await callback({ repository, begin, nodes, finish, inspect, filePath });
  } finally {
    repository.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('design_begin creates a board with one root screen frame', async () => {
  await withTools(async ({ repository, begin }) => {
    const result = await begin.execute({ title: 'Landing', width: 1440, height: 900, background: '#f8fafc' });
    assert.equal(result.ok, true);
    assert.equal(result.data.title, 'Landing');
    assert.equal(result.data.width, 1440);
    const stored = await repository.load(result.data.boardId);
    const screens = stored.nodes.filter((node) => node.type === 'frame');
    assert.equal(screens.length, 1);
    assert.equal(screens[0].w, 1440);
    assert.equal(screens[0].h, 900);
    assert.equal(screens[0].fill, '#f8fafc');
    assert.equal(screens[0].title, 'Screen 1');
    assert.equal(stored.nodes.length, 1);
  });
});

test('design_begin rejects a screen outside the allowed range', async () => {
  await withTools(async ({ repository, begin }) => {
    const result = await begin.execute({ width: 40 });
    assert.equal(result.ok, false);
    assert.equal(result.data.error.code, 'INVALID_DIMENSION');
    assert.deepEqual(await repository.list(), []);
  });
});

test('design_nodes inserts, updates and deletes in one transactional batch', async () => {
  await withTools(async ({ repository, begin, nodes }) => {
    const created = await begin.execute({ title: 'Board' });
    const boardId = created.data.boardId;
    const batch = await nodes.execute({
      boardId,
      ops: [
        { op: 'insert', node: { id: 'title', type: 'text', x: 80, y: 96, w: 600, h: 64, text: 'Payments, made simple', fontSize: 48, textColor: '#0f172a' }, parentId: 'screen-1' },
        { op: 'insert', node: { id: 'cta', type: 'shape', shape: 'rect', x: 80, y: 200, w: 180, h: 48, fill: '#635bff', radius: 12 }, parentId: 'screen-1' },
        { op: 'insert', node: { id: 'cta-label', type: 'text', x: 100, y: 212, w: 140, h: 24, text: 'Get started', fontSize: 16, textColor: '#ffffff' }, parentId: 'screen-1' },
      ],
    });
    assert.equal(batch.ok, true);
    assert.deepEqual(batch.data.inserted, ['title', 'cta', 'cta-label']);

    const updated = await nodes.execute({ boardId, ops: [{ op: 'update', id: 'cta', patch: { x: 96, fill: '#4f46e5' } }] });
    assert.equal(updated.ok, true);
    let stored = await repository.load(boardId);
    const cta = stored.nodes.find((node) => node.id === 'cta');
    assert.equal(cta.x, 96);
    assert.equal(cta.fill, '#4f46e5');

    const removed = await nodes.execute({ boardId, ops: [{ op: 'delete', id: 'cta-label' }] });
    assert.equal(removed.ok, true);
    stored = await repository.load(boardId);
    assert.equal(stored.nodes.some((node) => node.id === 'cta-label'), false);
    const screen = stored.nodes.find((node) => node.id === 'screen-1');
    assert.equal(screen.members.includes('cta-label'), false);
    assert.equal(screen.members.includes('title'), true);
  });
});

test('design_nodes assigns ids to nodes that arrive without one', async () => {
  await withTools(async ({ begin, nodes }) => {
    const created = await begin.execute({});
    const result = await nodes.execute({
      boardId: created.data.boardId,
      ops: [
        { op: 'insert', node: { type: 'text', x: 1, y: 1, w: 100, h: 40, text: 'A' } },
        { op: 'insert', node: { type: 'text', x: 1, y: 60, w: 100, h: 40, text: 'B' } },
      ],
    });
    assert.equal(result.ok, true);
    assert.equal(result.data.inserted.length, 2);
    assert.equal(new Set(result.data.inserted).size, 2);
  });
});

test('a rejected batch leaves the stored board untouched', async () => {
  await withTools(async ({ repository, begin, nodes }) => {
    const created = await begin.execute({});
    const boardId = created.data.boardId;
    const before = await repository.load(boardId);

    const duplicate = await nodes.execute({
      boardId,
      ops: [
        { op: 'insert', node: { id: 'screen-1', type: 'text', x: 0, y: 0, w: 100, h: 40, text: 'clash' } },
      ],
    });
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.data.error.code, 'DUPLICATE_NODE_ID');

    const danglingParent = await nodes.execute({
      boardId,
      ops: [{ op: 'insert', node: { id: 'ghost', type: 'text', x: 0, y: 0, w: 100, h: 40, text: 'x' }, parentId: 'nope' }],
    });
    assert.equal(danglingParent.ok, false);
    assert.equal(danglingParent.data.error.code, 'PARENT_NOT_FOUND');

    const invalidDocument = await nodes.execute({
      boardId,
      ops: [{ op: 'insert', node: { id: 'weird', type: 'spaceship', x: 0, y: 0, w: 100, h: 40 } }],
    });
    assert.equal(invalidDocument.ok, false);
    assert.equal(invalidDocument.data.error.code, 'INVALID_CANVAS');

    const after = await repository.load(boardId);
    assert.deepEqual(after.nodes, before.nodes);
  });
});

test('design_nodes rejects a type change on update', async () => {
  await withTools(async ({ begin, nodes }) => {
    const created = await begin.execute({});
    const result = await nodes.execute({
      boardId: created.data.boardId,
      ops: [{ op: 'update', id: 'screen-1', patch: { type: 'group' } }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.data.error.code, 'TYPE_IMMUTABLE');
  });
});

test('deleting a node also drops connectors that used it', async () => {
  await withTools(async ({ repository, begin, nodes }) => {
    const created = await begin.execute({});
    const boardId = created.data.boardId;
    await nodes.execute({
      boardId,
      ops: [
        { op: 'insert', node: { id: 'a', type: 'sticky', x: 0, y: 0, w: 120, h: 120, text: 'a' } },
        { op: 'insert', node: { id: 'b', type: 'sticky', x: 200, y: 0, w: 120, h: 120, text: 'b' } },
      ],
    });
    const document = await repository.load(boardId);
    await repository.save(boardId, {
      title: document.title,
      nodes: document.nodes,
      edges: [{ id: 'e1', from: 'a', to: 'b', label: 'flow' }],
      camera: document.camera,
    });
    const result = await nodes.execute({ boardId, ops: [{ op: 'delete', id: 'a' }] });
    assert.equal(result.ok, true);
    const stored = await repository.load(boardId);
    assert.equal(stored.edges.length, 0);
  });
});

test('design_finish reports readiness and can rename the board', async () => {
  await withTools(async ({ begin, finish }) => {
    const created = await begin.execute({ title: 'Draft' });
    const finished = await finish.execute({ boardId: created.data.boardId, title: 'Checkout — mobile' });
    assert.equal(finished.ok, true);
    assert.equal(finished.data.title, 'Checkout — mobile');
    assert.equal(finished.data.frameCount, 1);
    assert.deepEqual(finished.data.problems, []);
  });
});

test('design_finish flags a board without a screen', async () => {
  await withTools(async ({ repository, finish }) => {
    const empty = await repository.create({ title: 'Bare' });
    const result = await finish.execute({ boardId: empty.id });
    assert.equal(result.ok, false);
    assert.ok(result.data.problems.length >= 1);
  });
});

test('design_inspect lists boards and reads one board with a bounded node list', async () => {
  await withTools(async ({ begin, nodes, inspect }) => {
    const first = await begin.execute({ title: 'One' });
    await begin.execute({ title: 'Two' });
    await nodes.execute({
      boardId: first.data.boardId,
      ops: [
        { op: 'insert', node: { id: 'a', type: 'text', x: 0, y: 0, w: 100, h: 40, text: 'hello' } },
        { op: 'insert', node: { id: 'b', type: 'text', x: 0, y: 60, w: 100, h: 40, text: 'world' } },
      ],
    });

    const listed = await inspect.execute({});
    assert.equal(listed.ok, true);
    assert.equal(listed.data.boards.length, 2);

    const oneBoard = await inspect.execute({ boardId: first.data.boardId, limit: 2 });
    assert.equal(oneBoard.ok, true);
    assert.equal(oneBoard.data.nodes.length, 2);
    assert.equal(oneBoard.data.truncated, true);

    const filtered = await inspect.execute({ boardId: first.data.boardId, nodeIds: ['b'] });
    assert.deepEqual(filtered.data.nodes.map((node) => node.id), ['b']);

    const missing = await inspect.execute({ boardId: 'nope' });
    assert.equal(missing.ok, false);
    assert.equal(missing.data.error.code, 'CANVAS_NOT_FOUND');
  });
});

test('every design tool reports an unavailable store instead of throwing', async () => {
  const byName = new Map(createDesignTools({ getCanvasStore: () => null }).map((tool) => [tool.name, tool]));
  const begin = byName.get('design_begin');
  const nodes = byName.get('design_nodes');
  const finish = byName.get('design_finish');
  const inspect = byName.get('design_inspect');
  for (const tool of [begin, nodes, finish, inspect]) {
    const result = await tool.execute({ boardId: 'x', ops: [{ op: 'delete', id: 'y' }] });
    assert.equal(result.ok, false);
    assert.equal(result.data.error.code, 'CANVAS_UNAVAILABLE');
  }
});
