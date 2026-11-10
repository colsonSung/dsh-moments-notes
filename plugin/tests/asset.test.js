import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assetContentType,
  assetExtension,
  dataUrlToBytes,
  isAssetId,
  openAssetStore,
} from '../lib/asset-store.js';
import { normalizeCanvasDocument } from '../lib/canvas-domain.js';

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const SVG = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>').toString('base64');

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'moments-assets-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let counter = 0;
  const store = await openAssetStore({ directory, id: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}` });
  return { directory, store };
}

test('a data URL is read into its bytes and media type', () => {
  const png = dataUrlToBytes(PNG_1PX);
  assert.equal(png.type, 'image/png');
  assert.ok(png.bytes.length > 0);
  const svg = dataUrlToBytes(SVG);
  assert.equal(svg.type, 'image/svg+xml');
});

test('dataUrlToBytes refuses anything that is not a supported picture', () => {
  assert.throws(() => dataUrlToBytes('data:text/plain;base64,aGk='), (error) => error.code === 'INVALID_ASSET');
  assert.throws(() => dataUrlToBytes('not a data url'), (error) => error.code === 'INVALID_ASSET');
  assert.throws(() => dataUrlToBytes(42), (error) => error.code === 'INVALID_ASSET');
  assert.throws(
    () => dataUrlToBytes(`data:image/png;base64,${'A'.repeat(20 * 1024 * 1024)}`),
    (error) => error.code === 'INVALID_ASSET',
  );
});

test('the asset store writes a file and reads the same bytes back', async (t) => {
  const { directory, store } = await fixture(t);
  const saved = await store.save({ dataUrl: PNG_1PX, name: 'shot.png' });
  assert.equal(saved.type, 'image/png');
  assert.equal(saved.name, 'shot.png');
  assert.ok(isAssetId(saved.assetId));

  const files = await readdir(directory);
  assert.deepEqual(files, [`${saved.assetId}.png`]);

  const back = await store.read(saved.assetId, 'png');
  assert.equal(back.type, 'image/png');
  assert.deepEqual(Buffer.from(back.bytes), dataUrlToBytes(PNG_1PX).bytes);
});

test('an unknown asset is reported as missing rather than thrown as a crash', async (t) => {
  const { store } = await fixture(t);
  await assert.rejects(store.read('11111111-1111-4111-8111-111111111111', 'png'), (error) => error.code === 'ASSET_NOT_FOUND');
});

test('an asset id cannot escape its folder', () => {
  assert.equal(isAssetId('../../etc/passwd'), false);
  assert.equal(isAssetId('0f142a3f-3489-49d7-ae79-50528e98d223'), true);
  assert.equal(isAssetId('0F142A3F-3489-49D7-AE79-50528E98D223'), true);
  assert.equal(isAssetId('0f142a3f'), false);
});

test('the extension and the media type map both ways', () => {
  assert.equal(assetExtension('image/png'), 'png');
  assert.equal(assetExtension('image/svg+xml'), 'svg');
  assert.equal(assetExtension('text/plain'), null);
  assert.equal(assetContentType('jpg'), 'image/jpeg');
  assert.equal(assetContentType('svg'), 'image/svg+xml');
});

test('an image node names a stored asset and nothing else', () => {
  const base = {
    version: 1,
    id: 'canvas-1',
    title: 'Board',
    nodes: [{ id: 'i1', type: 'image', x: 0, y: 0, w: 200, h: 200, assetId: '0f142a3f-3489-49d7-ae79-50528e98d223' }],
    edges: [],
  };
  const result = normalizeCanvasDocument(base);
  assert.equal(result.nodes[0].assetId, '0f142a3f-3489-49d7-ae79-50528e98d223');

  assert.throws(
    () => normalizeCanvasDocument({ ...base, nodes: [{ id: 'i1', type: 'image', x: 0, y: 0, w: 200, h: 200 }] }),
    (error) => error.code === 'INVALID_CANVAS',
  );
  assert.throws(
    () => normalizeCanvasDocument({ ...base, nodes: [{ id: 'i1', type: 'image', x: 0, y: 0, w: 200, h: 200, assetId: '../../etc/passwd' }] }),
    (error) => error.code === 'INVALID_CANVAS',
  );
});

test('every shape vocabulary the toolbar offers is accepted', () => {
  const shapes = ['rect', 'ellipse', 'line', 'arrow', 'polygon', 'star'];
  for (const shape of shapes) {
    const result = normalizeCanvasDocument({
      version: 1,
      id: 'canvas-1',
      title: 'Board',
      nodes: [{ id: 's1', type: 'shape', shape, x: 0, y: 0, w: 100, h: 100, sides: 6, points: 7 }],
      edges: [],
    });
    assert.equal(result.nodes[0].shape, shape);
    assert.equal(result.nodes[0].sides, 6);
    assert.equal(result.nodes[0].points, 7);
  }
  assert.throws(
    () => normalizeCanvasDocument({ version: 1, id: 'canvas-1', nodes: [{ id: 's1', type: 'shape', shape: 'blob', x: 0, y: 0, w: 100, h: 100 }] }),
    (error) => error.code === 'INVALID_CANVAS',
  );
});

test('a flip flag is normalised to a boolean', () => {
  const result = normalizeCanvasDocument({
    version: 1,
    id: 'canvas-1',
    nodes: [{ id: 'n1', type: 'sticky', x: 0, y: 0, w: 100, h: 100, flipX: true }],
    edges: [],
  });
  assert.equal(result.nodes[0].flipX, true);
  assert.equal(result.nodes[0].flipY, false);
  assert.throws(
    () => normalizeCanvasDocument({ version: 1, id: 'canvas-1', nodes: [{ id: 'n1', type: 'sticky', x: 0, y: 0, w: 100, h: 100, flipX: 'yes' }], edges: [] }),
    (error) => error.code === 'INVALID_CANVAS',
  );
});

test('comments survive a scene save and never leak through it', () => {
  const withComment = normalizeCanvasDocument({
    version: 1,
    id: 'canvas-1',
    nodes: [{ id: 'n1', type: 'sticky', x: 0, y: 0, w: 100, h: 100 }],
    edges: [],
    comments: [{ id: 'c1', nodeId: 'n1', body: 'look here', x: 0, y: 0, resolved: false, createdAt: 1 }],
  });
  assert.equal(withComment.comments.length, 1);
  assert.equal(withComment.comments[0].nodeId, 'n1');

  // A comment that points at a node which is gone becomes a canvas comment.
  const orphaned = normalizeCanvasDocument({
    version: 1,
    id: 'canvas-1',
    nodes: [],
    edges: [],
    comments: [{ id: 'c1', nodeId: 'ghost', body: 'still here', x: 5, y: 6, resolved: false, createdAt: 1 }],
  });
  assert.equal(orphaned.comments[0].nodeId, null);
  assert.equal(orphaned.comments[0].body, 'still here');

  assert.throws(
    () => normalizeCanvasDocument({ version: 1, id: 'canvas-1', nodes: [], edges: [], comments: [{ id: 'c1', body: '   ' }] }),
    (error) => error.code === 'INVALID_COMMENT',
  );
});
