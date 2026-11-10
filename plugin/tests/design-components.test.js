import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeCanvasDocument } from '../lib/canvas-domain.js';
import { openCanvasRepository } from '../lib/canvas-repository.js';
import { createDesignTools } from '../lib/design-tools.js';

function doc(extra = {}) {
  return normalizeCanvasDocument({
    version: 1,
    id: 'board-1',
    title: 'Components',
    createdAt: 1,
    updatedAt: 2,
    camera: { x: 0, y: 0, zoom: 1 },
    nodes: [
      {
        id: 'master', type: 'component', x: 100, y: 100, w: 240, h: 120, title: 'Card',
        fill: '#ffffff', members: ['m-title', 'm-body'],
      },
      { id: 'm-title', type: 'text', x: 120, y: 120, w: 180, h: 24, text: 'Master title', fontSize: 16, fontWeight: 700 },
      { id: 'm-body', type: 'text', x: 120, y: 152, w: 180, h: 40, text: 'Master body', fontSize: 13 },
      {
        id: 'instance-1', type: 'instance', componentId: 'master', x: 400, y: 100,
        overrides: { 'm-title': { text: 'Instance title' } },
      },
      { id: 'instance-2', type: 'instance', componentId: 'master', x: 100, y: 320 },
    ],
    edges: [],
    ...extra,
  });
}

test('an instance expands into a locked copy of its component', () => {
  const document = doc();
  const byId = new Map(document.nodes.map((node) => [node.id, node]));
  const instance = byId.get('instance-1');
  assert.equal(instance.w, 240);
  assert.equal(instance.h, 120);

  const generated = document.nodes.filter((node) => node.origin);
  assert.ok(generated.length >= 3, 'a group plus two children are generated');
  const root = generated.find((node) => node.origin.source === 'master');
  assert.equal(root.type, 'frame', 'the instance carries the master box as a frame');
  assert.equal(root.locked, true);
  assert.equal(root.x, 400);
  assert.equal(root.y, 100);
  assert.equal(root.members.length, 2);

  const title = generated.find((node) => node.origin.source === 'm-title');
  assert.equal(title.text, 'Instance title', 'the override wins');
  assert.equal(title.x, 400 + (120 - 100), 'the copy is translated by the instance offset');
  assert.equal(title.y, 100 + (120 - 100));
  assert.equal(title.locked, true);
  assert.equal(title.origin.instance, 'instance-1');
});

test('a second instance expands from the same component with its own offset', () => {
  const document = doc();
  const copies = document.nodes.filter((node) => node.origin && node.origin.source === 'm-body');
  assert.equal(copies.length, 2);
  const positions = copies.map((node) => [node.x, node.y]).sort((a, b) => a[1] - b[1]);
  assert.deepEqual(positions, [[420, 152], [120, 372]]);
});

test('expansion is idempotent: normalizing an expanded board rebuilds the same copies', () => {
  const first = doc();
  const second = normalizeCanvasDocument(first);
  const signature = (canvas) => canvas.nodes
    .filter((node) => node.origin)
    .map((node) => [node.id, node.x, node.y])
    .sort();
  assert.deepEqual(signature(second), signature(first));
});

test('editing the master updates every instance on the next save', () => {
  const repositoryDoc = doc();
  const restyled = normalizeCanvasDocument({
    ...repositoryDoc,
    nodes: repositoryDoc.nodes.map((node) => (
      node.id === 'm-title' ? { ...node, text: 'Renamed master' } : node
    )),
  });
  const copies = restyled.nodes.filter((node) => node.origin && node.origin.source === 'm-title');
  assert.equal(copies.length, 2);
  // instance-1 overrides the title, so its copy keeps the override; the plain
  // instance must follow the master.
  const plain = copies.find((node) => node.origin.instance === 'instance-2');
  const overridden = copies.find((node) => node.origin.instance === 'instance-1');
  assert.equal(plain.text, 'Renamed master');
  assert.equal(overridden.text, 'Instance title');
});

test('a missing component and a component that contains an instance are both rejected', () => {
  assert.throws(() => normalizeCanvasDocument({
    version: 1, id: 'b', createdAt: 0, updatedAt: 0,
    nodes: [{ id: 'i1', type: 'instance', componentId: 'nope', x: 0, y: 0 }], edges: [],
  }), (error) => error.code === 'INVALID_INSTANCE');

  assert.throws(() => normalizeCanvasDocument({
    version: 1, id: 'b', createdAt: 0, updatedAt: 0,
    nodes: [
      { id: 'master', type: 'component', x: 0, y: 0, w: 200, h: 200, members: ['i1'] },
      { id: 'i1', type: 'instance', componentId: 'master', x: 0, y: 0 },
    ], edges: [],
  }), (error) => error.code === 'INVALID_INSTANCE');
});

test('an override may only retype a field the component already has', () => {
  assert.throws(() => normalizeCanvasDocument({
    version: 1, id: 'b', createdAt: 0, updatedAt: 0,
    nodes: [
      { id: 'master', type: 'component', x: 0, y: 0, w: 200, h: 200, members: ['child'] },
      { id: 'child', type: 'text', x: 0, y: 0, w: 100, h: 20, text: 'a' },
      { id: 'i1', type: 'instance', componentId: 'master', x: 300, y: 0, overrides: { child: { bogusField: 1 } } },
    ], edges: [],
  }), (error) => error.code === 'INVALID_OVERRIDE');
});

test('the design tools place components and instances and refuse edits on generated nodes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'moments-components-'));
  const repository = await openCanvasRepository({ filePath: join(directory, 'canvases.json') });
  const byName = new Map(createDesignTools({ getCanvasStore: () => repository }).map((tool) => [tool.name, tool]));
  const begin = byName.get('design_begin');
  const nodes = byName.get('design_nodes');
  try {
    const created = await begin.execute({ title: 'Components' });
    const boardId = created.data.boardId;

    const built = await nodes.execute({
      boardId,
      ops: [
        { op: 'insert', node: { id: 'master', type: 'component', x: 100, y: 100, w: 240, h: 120, title: 'Card', fill: '#ffffff', members: [] } },
        { op: 'insert', node: { id: 'm-title', type: 'text', x: 124, y: 124, w: 180, h: 24, text: 'Card title', fontSize: 16 }, parentId: 'master' },
        { op: 'insert', node: { id: 'inst-1', type: 'instance', componentId: 'master', x: 400, y: 100 } },
      ],
    });
    assert.equal(built.ok, true);

    const stored = await repository.load(boardId);
    const generated = stored.nodes.filter((node) => node.origin && node.origin.instance === 'inst-1');
    assert.ok(generated.length >= 2);

    const unknownComponent = await nodes.execute({
      boardId,
      ops: [{ op: 'insert', node: { id: 'inst-2', type: 'instance', componentId: 'ghost', x: 0, y: 0 } }],
    });
    assert.equal(unknownComponent.ok, false);
    assert.equal(unknownComponent.data.error.code, 'UNKNOWN_COMPONENT');

    const generatedIdValue = generated[0].id;
    const editGenerated = await nodes.execute({
      boardId,
      ops: [{ op: 'update', id: generatedIdValue, patch: { text: 'hacked' } }],
    });
    assert.equal(editGenerated.ok, false);
    assert.equal(editGenerated.data.error.code, 'GENERATED_NODE');
  } finally {
    repository.close();
    await rm(directory, { recursive: true, force: true });
  }
});
