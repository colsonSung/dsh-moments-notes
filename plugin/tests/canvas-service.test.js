import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cameraForImport, createHostService } from '../lib/host-service.js';
import { openCanvasRepository } from '../lib/canvas-repository.js';

function repositoryStub() {
  return {
    async snapshot() { return { notes: [], trash: [], tags: [], stats: {} }; },
  };
}

function canvasRepositoryStub() {
  const calls = [];
  const canvas = {
    version: 1,
    id: 'canvas-1',
    title: 'Board',
    createdAt: 1,
    updatedAt: 1,
    camera: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    edges: [],
  };
  return {
    calls,
    async list() {
      calls.push(['list']);
      return [canvas, { ...canvas, id: 'canvas-2', title: 'Later', updatedAt: 5 }];
    },
    async load(id) {
      calls.push(['load', id]);
      if (id !== 'canvas-1') {
        const error = new Error(`Canvas not found: ${id}`);
        error.code = 'CANVAS_NOT_FOUND';
        throw error;
      }
      return canvas;
    },
    async create(input) {
      calls.push(['create', input]);
      return { ...canvas, id: 'canvas-3', title: input.title ?? 'Board' };
    },
    async save(id, input) {
      calls.push(['save', id, input]);
      if (id !== 'canvas-1') {
        const error = new Error(`Canvas not found: ${id}`);
        error.code = 'CANVAS_NOT_FOUND';
        throw error;
      }
      return { ...canvas, id, nodes: input.nodes ?? [], edges: input.edges ?? [], camera: input.camera ?? canvas.camera };
    },
    async delete(id) {
      calls.push(['delete', id]);
      return { deleted: true, id };
    },
  };
}

test('canvas-list returns the board summaries ordered by the newest update', async () => {
  const canvasRepository = canvasRepositoryStub();
  const service = createHostService({ repository: repositoryStub(), canvasRepository });
  const result = await service.call('canvas-list', {});

  assert.deepEqual(result, {
    canvases: [
      { id: 'canvas-2', title: 'Later', nodeCount: 0, edgeCount: 0, groupCount: 0, frameCount: 0, shapeCount: 0, starred: false, imageCount: 0, commentCount: 0, openCommentCount: 0, createdAt: 1, updatedAt: 5 },
      { id: 'canvas-1', title: 'Board', nodeCount: 0, edgeCount: 0, groupCount: 0, frameCount: 0, shapeCount: 0, starred: false, imageCount: 0, commentCount: 0, openCommentCount: 0, createdAt: 1, updatedAt: 1 },
    ],
  });
  assert.deepEqual(canvasRepository.calls, [['list']]);
});

test('canvas-load returns one board and rejects an unknown id', async () => {
  const canvasRepository = canvasRepositoryStub();
  const service = createHostService({ repository: repositoryStub(), canvasRepository });
  const loaded = await service.call('canvas-load', { id: 'canvas-1' });

  assert.equal(loaded.canvas.id, 'canvas-1');
  assert.deepEqual(canvasRepository.calls, [['load', 'canvas-1']]);
  await assert.rejects(service.call('canvas-load', { id: 'missing' }), (error) => error.code === 'CANVAS_NOT_FOUND');
  await assert.rejects(service.call('canvas-load', {}), (error) => error.code === 'INVALID_CANVAS_ID');
});

test('canvas-create stores a board with the requested title', async () => {
  const canvasRepository = canvasRepositoryStub();
  const service = createHostService({ repository: repositoryStub(), canvasRepository });
  const created = await service.call('canvas-create', { title: 'Roadmap' });

  assert.equal(created.canvas.id, 'canvas-3');
  assert.equal(created.canvas.title, 'Roadmap');
  assert.deepEqual(canvasRepository.calls, [['create', { title: 'Roadmap' }]]);

  const fallback = await service.call('canvas-create', {});
  assert.equal(fallback.canvas.title, 'Board');
});

test('canvas-save replaces the document and keeps the title when it is omitted', async () => {
  const canvasRepository = canvasRepositoryStub();
  const service = createHostService({ repository: repositoryStub(), canvasRepository });
  const saved = await service.call('canvas-save', {
    id: 'canvas-1',
    nodes: [{ id: 'n1', type: 'sticky', text: 'body' }],
    edges: [],
    camera: { x: 0, y: 0, zoom: 2 },
  });

  assert.equal(saved.canvas.nodes.length, 1);
  assert.equal(saved.canvas.camera.zoom, 2);
  assert.deepEqual(canvasRepository.calls[0], ['save', 'canvas-1', {
    nodes: [{ id: 'n1', type: 'sticky', text: 'body' }],
    edges: [],
    camera: { x: 0, y: 0, zoom: 2 },
  }]);

  await service.call('canvas-save', { id: 'canvas-1', title: 'Renamed' });
  assert.deepEqual(canvasRepository.calls[1], ['save', 'canvas-1', { title: 'Renamed' }]);
  await assert.rejects(service.call('canvas-save', { id: 'missing' }), (error) => error.code === 'CANVAS_NOT_FOUND');
  await assert.rejects(service.call('canvas-save', {}), (error) => error.code === 'INVALID_CANVAS_ID');
});

test('canvas-delete removes a board', async () => {
  const canvasRepository = canvasRepositoryStub();
  const service = createHostService({ repository: repositoryStub(), canvasRepository });
  assert.deepEqual(await service.call('canvas-delete', { id: 'canvas-1' }), { deleted: true, id: 'canvas-1' });
  await assert.rejects(service.call('canvas-delete', {}), (error) => error.code === 'INVALID_CANVAS_ID');
});

test('the canvas methods refuse to run when no canvas store is mounted', async () => {
  const service = createHostService({ repository: repositoryStub() });
  for (const method of ['canvas-list', 'canvas-load', 'canvas-create', 'canvas-save', 'canvas-delete']) {
    await assert.rejects(service.call(method, { id: 'canvas-1' }), (error) => {
      assert.equal(error.code, 'INVALID_OPERATION');
      assert.match(error.message, /canvas store is not ready/);
      return true;
    });
  }
});

test('an unknown method is still rejected by the canvas contract', async () => {
  const service = createHostService({ repository: repositoryStub(), canvasRepository: canvasRepositoryStub() });
  await assert.rejects(service.call('canvas-draw', { id: 'canvas-1' }), (error) => {
    assert.equal(error.code, 'INVALID_OPERATION');
    return true;
  });
});

test('the canvas methods drive a real canvas store end to end', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'flomo-canvas-service-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const canvasRepository = await openCanvasRepository({
    filePath: join(directory, 'canvases.json'),
    now: () => 1000,
    id: (() => {
      let value = 0;
      return () => `canvas-${++value}`;
    })(),
  });
  t.after(() => canvasRepository.close());
  const service = createHostService({ repository: repositoryStub(), canvasRepository });

  const created = await service.call('canvas-create', { title: 'Roadmap' });
  assert.equal(created.canvas.title, 'Roadmap');
  assert.equal(created.canvas.nodes.length, 0);

  const saved = await service.call('canvas-save', {
    id: created.canvas.id,
    nodes: [{ id: 'n1', type: 'sticky', text: 'body' }],
    edges: [],
    camera: { x: 0, y: 0, zoom: 1 },
  });
  assert.equal(saved.canvas.nodes.length, 1);
  assert.equal(saved.canvas.title, 'Roadmap', 'an omitted title keeps the current one');

  const listed = await service.call('canvas-list', {});
  assert.deepEqual(listed.canvases, [{
    id: created.canvas.id,
    title: 'Roadmap',
    nodeCount: 1,
    edgeCount: 0,
    groupCount: 0,
    frameCount: 0,
    shapeCount: 0,
    starred: false,
    imageCount: 0,
    commentCount: 0,
    openCommentCount: 0,
    createdAt: 1000,
    updatedAt: 1000,
  }]);

  const loaded = await service.call('canvas-load', { id: created.canvas.id });
  assert.equal(loaded.canvas.nodes[0].text, 'body');

  assert.deepEqual(await service.call('canvas-delete', { id: created.canvas.id }), {
    deleted: true,
    id: created.canvas.id,
  });
  await assert.rejects(service.call('canvas-load', { id: created.canvas.id }), (error) => error.code === 'CANVAS_NOT_FOUND');
});

test('a canvas document the Host cannot accept is rejected with INVALID_CANVAS', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'flomo-canvas-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const canvasRepository = await openCanvasRepository({ filePath: join(directory, 'canvases.json') });
  t.after(() => canvasRepository.close());
  const service = createHostService({ repository: repositoryStub(), canvasRepository });

  const created = await service.call('canvas-create', {});
  await assert.rejects(service.call('canvas-save', {
    id: created.canvas.id,
    nodes: [{ id: 'n1', type: 'widget' }],
    edges: [],
    camera: { x: 0, y: 0, zoom: 1 },
  }), (error) => error.code === 'INVALID_CANVAS');

  const loaded = await service.call('canvas-load', { id: created.canvas.id });
  assert.deepEqual(loaded.canvas.nodes, [], 'the rejected save changed nothing');
});

test('canvas-list counts the groups and the shapes of a board', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'flomo-canvas-counts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const canvasRepository = await openCanvasRepository({ filePath: join(directory, 'canvases.json') });
  t.after(() => canvasRepository.close());
  const service = createHostService({ repository: repositoryStub(), canvasRepository });

  const created = await service.call('canvas-create', { title: 'Roadmap' });
  await service.call('canvas-save', {
    id: created.canvas.id,
    nodes: [
      { id: 's1', type: 'shape' },
      { id: 'g1', type: 'group', members: ['s1'] },
      { id: 'n1', type: 'sticky' },
    ],
    edges: [],
    camera: { x: 0, y: 0, zoom: 1 },
  });

  const listed = await service.call('canvas-list', {});
  assert.equal(listed.canvases.length, 1);
  assert.equal(listed.canvases[0].nodeCount, 3);
  assert.equal(listed.canvases[0].groupCount, 1);
  assert.equal(listed.canvases[0].shapeCount, 1);
});

test('the canvas methods report the new validation codes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'flomo-canvas-codes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const canvasRepository = await openCanvasRepository({ filePath: join(directory, 'canvases.json') });
  t.after(() => canvasRepository.close());
  const service = createHostService({ repository: repositoryStub(), canvasRepository });
  const created = await service.call('canvas-create', { title: 'Roadmap' });

  await assert.rejects(service.call('canvas-save', {
    id: created.canvas.id,
    nodes: [{ id: 's1', type: 'shape', fill: 'red' }],
    edges: [],
    camera: { x: 0, y: 0, zoom: 1 },
  }), (error) => error.code === 'INVALID_COLOR');

  await assert.rejects(service.call('canvas-save', {
    id: created.canvas.id,
    nodes: [{ id: 'g1', type: 'group', members: ['ghost'] }],
    edges: [],
    camera: { x: 0, y: 0, zoom: 1 },
  }), (error) => error.code === 'INVALID_MEMBERS');

  const loaded = await service.call('canvas-load', { id: created.canvas.id });
  assert.deepEqual(loaded.canvas.nodes, [], 'a rejected save changed nothing');
});

test('canvas-star flips the flag without replacing the document', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'flomo-canvas-star-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const canvasRepository = await openCanvasRepository({ filePath: join(directory, 'canvases.json'), now: () => 1000 });
  t.after(() => canvasRepository.close());
  const service = createHostService({ repository: repositoryStub(), canvasRepository });

  const created = await service.call('canvas-create', { title: 'Roadmap' });
  await service.call('canvas-save', {
    id: created.canvas.id,
    nodes: [{ id: 'n1', type: 'sticky', text: 'body' }],
    edges: [],
    camera: { x: 0, y: 0, zoom: 1 },
  });

  const starred = await service.call('canvas-star', { id: created.canvas.id, starred: true });
  assert.equal(starred.canvas.starred, true);
  assert.equal(starred.canvas.nodes.length, 1, 'starring keeps the nodes');

  const listed = await service.call('canvas-list', {});
  assert.equal(listed.canvases[0].starred, true, 'the summary carries the flag');

  const unstarred = await service.call('canvas-star', { id: created.canvas.id, starred: false });
  assert.equal(unstarred.canvas.starred, false);
  await assert.rejects(
    service.call('canvas-star', { id: created.canvas.id, starred: 'yes' }),
    (error) => error.code === 'invalid-operation' || error.code === 'INVALID_OPERATION',
  );
  await assert.rejects(
    service.call('canvas-star', { id: 'missing', starred: true }),
    (error) => error.code === 'CANVAS_NOT_FOUND',
  );
});

test('canvas-export serves the handoff files from the saved board', async () => {
  const canvasRepository = canvasRepositoryStub();
  const service = createHostService({ repository: repositoryStub(), canvasRepository });

  const svg = await service.call('canvas-export', { id: 'canvas-1', format: 'svg' });
  assert.match(svg.text, /^<svg/);
  assert.equal(svg.filename, 'Board.svg');
  assert.equal(svg.format, 'svg');

  const html = await service.call('canvas-export', { id: 'canvas-1', format: 'html' });
  assert.match(html.text, /<!doctype html>/);
  assert.match(html.filename, /\.html$/);

  const spec = await service.call('canvas-export', { id: 'canvas-1', format: 'spec' });
  const parsed = JSON.parse(spec.text);
  assert.equal(parsed.nodeCount, 0);
  assert.match(spec.filename, /\.spec\.json$/);

  await assert.rejects(
    service.call('canvas-export', { id: 'missing', format: 'svg' }),
    (error) => error.code === 'CANVAS_NOT_FOUND',
  );
});


test('canvas-arrange lays the members out and refuses a payload without nodes', async () => {
  const service = createHostService({ repository: repositoryStub(), canvasRepository: canvasRepositoryStub() });
  const nodes = [
    { id: 'frame', type: 'frame', x: 0, y: 0, w: 300, h: 300, layout: 'column', gap: 8, padding: 12, members: ['a', 'b'], constraints: { horizontal: 'left', vertical: 'top' } },
    { id: 'a', type: 'shape', shape: 'rect', x: 0, y: 0, w: 100, h: 40, fill: null, stroke: null, strokeWidth: 0, opacity: 1, radius: 0, textAlign: 'left', members: [], title: '', sides: 5, points: 5, flipX: false, flipY: false, assetId: null, fontSize: 14, textColor: null, rotation: 0, text: '', noteId: null, noteUpdatedAt: null, color: 'none', locked: false, visible: true, shape: 'rect', path: null },
    { id: 'b', type: 'shape', shape: 'rect', x: 0, y: 0, w: 100, h: 40, fill: null, stroke: null, strokeWidth: 0, opacity: 1, radius: 0, textAlign: 'left', members: [], title: '', sides: 5, points: 5, flipX: false, flipY: false, assetId: null, fontSize: 14, textColor: null, rotation: 0, text: '', noteId: null, noteUpdatedAt: null, color: 'none', locked: false, visible: true, path: null },
  ];
  const result = await service.call('canvas-arrange', { nodes });
  const second = result.nodes.find((node) => node.id === 'b');
  assert.equal(second.y, 12 + 40 + 8, 'the second member follows the first plus the gap');
  await assert.rejects(service.call('canvas-arrange', {}), (error) => error.code === 'INVALID_OPERATION');
});


test('an import camera frames readable content instead of empty paper', () => {
  // A wide whiteboard: fitting all of it would be an unreadable overview.
  const wide = [
    { id: 'a', x: 0, y: 0, w: 40000, h: 20000, members: [] },
    { id: 'focus', x: 20000, y: 8000, w: 1200, h: 900, members: ['m1', 'm2', 'm3'] },
  ];
  const camera = cameraForImport(wide);
  assert.ok(camera, 'an import gets a camera');
  assert.ok(camera.zoom >= 0.3, `the camera is readable, got ${camera.zoom}`);
  assert.ok(camera.zoom <= 1);
  // The focus frame (centre 20600, 8450) lands near the middle of the view.
  const centerX = 600 - camera.x;
  const centerY = 400 - camera.y;
  assert.ok(Math.abs(centerX / camera.zoom - 20600) < 2, 'the view is centred on the main frame');
  assert.ok(Math.abs(centerY / camera.zoom - 8450) < 2);

  // A small import keeps its whole content in view.
  const small = [{ id: 'a', x: 0, y: 0, w: 400, h: 300, members: [] }];
  const fitted = cameraForImport(small);
  assert.ok(fitted.zoom > 1 ? fitted.zoom <= 1 : true);
  assert.ok(fitted.zoom >= 0.9, 'a small board opens nearly 1:1');

  assert.equal(cameraForImport([]), null);
});

