import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openRepository } from '../lib/repository.js';
import { createHostService } from '../lib/host-service.js';

const PIXEL = {
  id: 'pixel-1', name: 'pixel.png', type: 'image/png', size: 8,
  dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
};

test('real Host repository supports image-only notes and lossless partial updates', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'flomo-host-integration-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repository = await openRepository({ filePath: join(dir, 'notes.json') });
  t.after(() => repository.close());
  const service = createHostService({ repository });

  const created = await service.call('create', { content: '', attachments: [PIXEL] });
  assert.equal(created.content, '');
  assert.equal(created.attachments.length, 1);

  const textUpdated = await service.call('update', { id: created.id, content: '图片补充说明' });
  assert.equal(textUpdated.content, '图片补充说明');
  assert.equal(textUpdated.attachments.length, 1);

  const imageUpdated = await service.call('update', {
    id: created.id,
    attachments: [{ ...PIXEL, id: 'pixel-2', name: 'second.png' }],
  });
  assert.equal(imageUpdated.content, '图片补充说明');
  assert.equal(imageUpdated.attachments[0].id, 'pixel-2');

  await assert.rejects(
    service.call('create', { content: '   ', attachments: [] }),
    (error) => error.code === 'VALIDATION_ERROR',
  );
});

test('overlong text tags cannot poison snapshots or reopened repositories', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'flomo-long-tag-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = join(dir, 'notes.json');
  const repository = await openRepository({ filePath });
  const service = createHostService({ repository });
  await service.call('create', { content: `#${'a'.repeat(201)}`, attachments: [] });
  const snapshot = await service.call('snapshot', {});
  assert.equal(snapshot.notes.length, 1);
  assert.deepEqual(snapshot.tags, []);
  await repository.close();
  const reopened = await openRepository({ filePath });
  t.after(() => reopened.close());
  const restored = await createHostService({ repository: reopened }).call('snapshot', {});
  assert.equal(restored.notes.length, 1);
  assert.deepEqual(restored.tags, []);
});
