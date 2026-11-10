import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeCanvasDocument } from '../lib/canvas-domain.js';
import { openCanvasRepository } from '../lib/canvas-repository.js';

/** A board exactly as an earlier version of the plugin stored it. */
function legacyBoard() {
  return {
    version: 1,
    id: 'legacy-1',
    title: 'Old board',
    starred: false,
    createdAt: 1000,
    updatedAt: 2000,
    camera: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'frame', type: 'frame', x: 0, y: 0, w: 800, h: 600, rotation: 0, text: '', noteId: null, noteUpdatedAt: null, color: 'none', locked: false, visible: true, shape: 'rect', fill: null, stroke: null, strokeWidth: 0, opacity: 1, radius: 0, textAlign: 'left', members: ['note'], title: '', sides: 5, points: 5, flipX: false, flipY: false, assetId: null, fontSize: 14, textColor: null },
      { id: 'note', type: 'sticky', x: 40, y: 40, w: 200, h: 120, rotation: 0, text: 'Legacy', noteId: null, noteUpdatedAt: null, color: 'amber', locked: false, visible: true, shape: 'rect', fill: null, stroke: null, strokeWidth: 0, opacity: 1, radius: 0, textAlign: 'left', members: [], title: '', sides: 5, points: 5, flipX: false, flipY: false, assetId: null, fontSize: 14, textColor: null },
    ],
    edges: [],
    comments: [],
  };
}

test('a board stored by an earlier version still loads and gains every newer field', () => {
  const document = normalizeCanvasDocument(legacyBoard());
  assert.equal(document.nodes.length, 2, 'nothing is dropped');
  assert.deepEqual(document.tokens, { colors: {}, gradients: {}, type: {} }, 'tokens default to empty');
  const [frame, note] = document.nodes;
  assert.deepEqual(frame.constraints, { horizontal: 'left', vertical: 'top' }, 'constraints default to top-left');
  assert.equal(frame.layout, 'none');
  assert.equal(frame.path, null);
  assert.equal(note.origin, null);
  assert.equal(note.fillToken, null);
  assert.equal(note.componentId, null);
  assert.equal(note.text, 'Legacy', 'content survives untouched');
});

test('a legacy board round-trips through the repository without losing its content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'moments-legacy-'));
  const repository = await openCanvasRepository({ filePath: join(directory, 'canvases.json') });
  try {
    const created = await repository.create({ title: 'Legacy' });
    const legacy = { ...legacyBoard(), id: created.id };
    const saved = await repository.save(created.id, {
      title: legacy.title,
      nodes: legacy.nodes,
      edges: legacy.edges,
      camera: legacy.camera,
    });
    assert.equal(saved.nodes.find((node) => node.id === 'note').text, 'Legacy');
    const loaded = await repository.load(created.id);
    assert.equal(loaded.nodes.length, 2);
    assert.deepEqual(loaded.tokens, { colors: {}, gradients: {}, type: {} });
  } finally {
    repository.close();
    await rm(directory, { recursive: true, force: true });
  }
});
