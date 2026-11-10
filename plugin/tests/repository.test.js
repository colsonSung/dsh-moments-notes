import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openRepository } from '../lib/repository.js';

const DATA = 'iVBORw0KGgo=';

function attachment(id = 'attachment-1') {
  return {
    id,
    name: 'pixel.png',
    type: 'image/png',
    size: 8,
    dataUrl: `data:image/png;base64,${DATA}`,
  };
}

function persistedNote(id, overrides = {}) {
  return {
    id,
    content: `content ${id}`,
    createdAt: 10,
    updatedAt: 10,
    pinned: false,
    deletedAt: null,
    attachments: [],
    ...overrides,
  };
}

function sequence(prefix) {
  let value = 0;
  return () => `${prefix}-${++value}`;
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'flomo-repository-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function fixture(t, options = {}) {
  const directory = await temporaryDirectory(t);
  const filePath = join(directory, 'nested', 'notes.json');
  const repository = await openRepository({
    filePath,
    now: options.now || (() => 1000),
    id: options.id || sequence('id'),
  });
  t.after(() => repository.close());
  return { directory, filePath, repository };
}

test('openRepository creates parent directories and a durable empty store', async (t) => {
  const { directory, filePath, repository } = await fixture(t);
  assert.deepEqual(await repository.list(), []);
  const persisted = JSON.parse(await readFile(filePath, 'utf8'));
  assert.deepEqual(persisted, { version: 1, notes: [] });
  assert.deepEqual(await readdir(join(directory, 'nested')), ['notes.json']);
});

test('create generates the canonical note shape and reopen preserves notes and attachments', async (t) => {
  const { filePath, repository } = await fixture(t);
  const created = await repository.create({
    content: '  Capture #Work/Project  ',
    attachments: [{ ...attachment(null), name: ' pixel.png ' }],
  });

  assert.deepEqual(created, {
    id: 'id-1',
    content: '  Capture #Work/Project  ',
    createdAt: 1000,
    updatedAt: 1000,
    pinned: false,
    deletedAt: null,
    attachments: [{
      id: 'id-2',
      name: 'pixel.png',
      type: 'image/png',
      size: 8,
      dataUrl: `data:image/png;base64,${DATA}`,
    }],
  });
  created.content = 'mutated outside';
  assert.equal((await repository.list())[0].content, '  Capture #Work/Project  ');

  await repository.close();
  const reopened = await openRepository({ filePath, now: () => 2000, id: sequence('new') });
  t.after(() => reopened.close());
  const notes = await reopened.list();
  assert.equal(notes.length, 1);
  assert.equal(notes[0].content, '  Capture #Work/Project  ');
  assert.deepEqual(notes[0].attachments[0], created.attachments[0]);
  assert.equal(JSON.parse(await readFile(filePath, 'utf8')).notes.length, 1);
});

test('create validates input and duplicate generated ids without poisoning later mutations', async (t) => {
  let duplicate = false;
  const { filePath, repository } = await fixture(t, {
    id: () => duplicate ? 'same-id' : sequence('unused')(),
  });
  await assert.rejects(repository.create(), /input|object/i);
  await assert.rejects(repository.create({ content: '  ' }), /blank|empty|content/i);
  await assert.rejects(repository.create({ content: 'ok', attachments: [{}] }), /attachment/i);
  assert.equal((await repository.exportData()).notes.length, 0);

  duplicate = true;
  await repository.create({ content: 'first' });
  await assert.rejects(repository.create({ content: 'duplicate' }), /duplicate|already/i);
  const persisted = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(persisted.notes.length, 1);
  assert.equal(persisted.notes[0].content, 'first');
});

test('update, pin, trash, restore and purge enforce lifecycle and persist timestamps', async (t) => {
  let time = 0;
  const { filePath, repository } = await fixture(t, { now: () => ++time });
  const created = await repository.create({ content: 'initial', attachments: [attachment()] });
  const updated = await repository.update(created.id, { content: 'updated' });
  assert.equal(updated.content, 'updated');
  assert.equal(updated.createdAt, 1);
  assert.equal(updated.updatedAt, 2);
  assert.deepEqual(updated.attachments, created.attachments);
  assert.equal((await repository.update(created.id, {})).updatedAt, 2, 'empty update is a no-op');

  const pinned = await repository.setPinned(created.id, true);
  assert.equal(pinned.pinned, true);
  assert.equal(pinned.updatedAt, 3);
  await assert.rejects(repository.setPinned(created.id, 'yes'), /pinned|boolean/i);
  await assert.rejects(repository.update(created.id, { createdAt: 99 }), /immutable|supported|content/i);

  const trashed = await repository.trash(created.id);
  assert.equal(trashed.deletedAt, 4);
  assert.equal(trashed.updatedAt, 4);
  assert.deepEqual(await repository.list(), []);
  assert.equal((await repository.list({ deletedOnly: true })).length, 1);
  assert.equal((await repository.trash(created.id)).deletedAt, 4, 'trashing twice is idempotent');

  const restored = await repository.restore(created.id);
  assert.equal(restored.deletedAt, null);
  assert.equal(restored.updatedAt, 5);
  await assert.rejects(repository.purge(created.id), /trash|deleted/i);
  await repository.trash(created.id);
  assert.deepEqual(await repository.purge(created.id), { id: created.id, purged: true });
  assert.deepEqual((await repository.exportData()).notes, []);
  await assert.rejects(repository.update('missing', { content: 'x' }), (error) => error.code === 'NOTE_NOT_FOUND');
  await assert.rejects(repository.trash('missing'), /not found/i);

  await repository.close();
  const reopened = await openRepository({ filePath });
  t.after(() => reopened.close());
  assert.deepEqual((await reopened.exportData()).notes, []);
});

test('list filters and snapshot expose tags, trash, statistics and a zero-filled heatmap', async (t) => {
  const times = [
    new Date(2025, 0, 1, 9).getTime(),
    new Date(2025, 0, 2, 9).getTime(),
    new Date(2025, 0, 3, 9).getTime(),
    new Date(2025, 0, 4, 9).getTime(),
    new Date(2025, 0, 4, 10).getTime(),
  ];
  let index = 0;
  const now = () => times[Math.min(index++, times.length - 1)];
  const { repository } = await fixture(t, { now });
  const first = await repository.create({ content: 'Alpha #Work/Project' });
  await repository.create({ content: 'Beta #work/other', attachments: [attachment()] });
  await repository.create({ content: 'Gamma #personal' });
  await repository.setPinned(first.id, true);
  await repository.trash(first.id);

  assert.deepEqual((await repository.list({ tag: 'work' })).map(({ content }) => content), ['Beta #work/other']);
  assert.deepEqual((await repository.list({ query: 'gamma' })).map(({ content }) => content), ['Gamma #personal']);
  assert.deepEqual((await repository.list({ deletedOnly: true })).map(({ id }) => id), [first.id]);
  assert.equal((await repository.list({ includeDeleted: true, limit: 5000 })).length, 3);
  await assert.rejects(repository.list({ limit: -1 }), /limit/i);
  await assert.rejects(repository.list({ offset: 1.5 }), /offset/i);

  const snapshot = await repository.snapshot({ heatmapDays: 4 });
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.notes.length, 2);
  assert.equal(snapshot.trash.length, 1);
  assert.deepEqual(snapshot.tags, [
    { name: 'personal', count: 1 },
    { name: 'work', count: 1 },
    { name: 'work/other', count: 1 },
  ]);
  assert.equal(snapshot.stats.total, 3);
  assert.equal(snapshot.stats.active, 2);
  assert.equal(snapshot.stats.trashed, 1);
  assert.equal(snapshot.stats.pinned, 0);
  assert.equal(snapshot.stats.attachments, 1);
  assert.equal(snapshot.heatmap.length, 4);
  assert.equal(snapshot.heatmap.reduce((sum, day) => sum + day.count, 0), 2);
  snapshot.notes[0].content = 'outside mutation';
  assert.notEqual((await repository.list())[0].content, 'outside mutation');
});

test('mutations are serialized with no lost updates and leave only the atomic destination', async (t) => {
  const { directory, filePath, repository } = await fixture(t, {
    now: () => Date.now(),
    id: sequence('serial'),
  });
  await Promise.all(Array.from({ length: 24 }, (_, index) => repository.create({ content: `note ${index}` })));
  const notes = await repository.list({ limit: 100 });
  assert.equal(notes.length, 24);
  await Promise.all(notes.map((note, index) => repository.update(note.id, { content: `updated ${index}` })));
  await Promise.all(notes.slice(0, 8).map((note) => repository.trash(note.id)));

  const exported = await repository.exportData();
  assert.equal(exported.notes.length, 24);
  assert.equal(exported.notes.filter(({ deletedAt }) => deletedAt !== null).length, 8);
  assert.equal(exported.notes.every(({ content }) => content.startsWith('updated ')), true);
  assert.deepEqual(await readdir(join(directory, 'nested')), ['notes.json']);
  assert.equal(JSON.parse(await readFile(filePath, 'utf8')).notes.length, 24);

  await repository.close();
  const reopened = await openRepository({ filePath });
  t.after(() => reopened.close());
  assert.equal((await reopened.exportData()).notes.length, 24);
});

test('related and review operate on active notes and bound their result count', async (t) => {
  const now = new Date(2025, 5, 15, 12).getTime();
  const { repository } = await fixture(t, { now: () => now });
  const notes = [
    persistedNote('source', { content: 'Alpha #work/project', createdAt: 10, updatedAt: 10 }),
    persistedNote('related', { content: 'Beta #work/project', createdAt: 20, updatedAt: 20 }),
    persistedNote('old-today', { content: 'Memory', createdAt: new Date(2024, 5, 15, 8).getTime(), updatedAt: new Date(2024, 5, 15, 8).getTime() }),
    persistedNote('deleted', { content: '#work/project', createdAt: 30, updatedAt: 30, deletedAt: 40 }),
  ];
  await repository.importData({ version: 1, notes }, 'replace');
  assert.deepEqual((await repository.related('source', 5)).map(({ id }) => id), ['related']);
  assert.deepEqual(await repository.related('missing'), []);
  assert.equal((await repository.review('random', { limit: 99 })).length, 3);
  assert.deepEqual((await repository.review('on-this-day')).map(({ id }) => id), ['old-today']);
  assert.deepEqual((await repository.review({ mode: 'onThisDay', limit: 0 })), []);
  await assert.rejects(repository.review('future'), /review|mode/i);
  await assert.rejects(repository.related('source', -1), /limit/i);
});

test('exportData returns an isolated complete backup including trash', async (t) => {
  const { repository } = await fixture(t, { now: () => 500 });
  const note = await repository.create({ content: 'backup', attachments: [attachment()] });
  await repository.trash(note.id);
  const exported = await repository.exportData();
  assert.equal(exported.version, 1);
  assert.equal(exported.exportedAt, 500);
  assert.equal(exported.notes.length, 1);
  assert.notEqual(exported.notes[0].deletedAt, null);
  exported.notes[0].content = 'changed';
  exported.notes[0].attachments[0].name = 'changed';
  const again = await repository.exportData();
  assert.equal(again.notes[0].content, 'backup');
  assert.equal(again.notes[0].attachments[0].name, 'pixel.png');
});

test('merge import rejects duplicate payload ids without applying earlier records', async (t) => {
  const { repository } = await fixture(t);
  await repository.importData({ version: 1, notes: [persistedNote('same', { updatedAt: 20 })] }, 'replace');
  await assert.rejects(repository.importData({ version: 1, notes: [
    persistedNote('new', { createdAt: 30, updatedAt: 30 }),
    persistedNote('same', { content: 'newest', updatedAt: 40 }),
    persistedNote('same', { content: 'duplicate payload', updatedAt: 50 }),
  ] }, 'merge'), /duplicate/i);
  assert.deepEqual((await repository.exportData()).notes.map(({ id }) => id), ['same']);
});

test('merge and replace imports are durable and report accurate counts', async (t) => {
  const { filePath, repository } = await fixture(t);
  await repository.importData({ version: 1, notes: [persistedNote('same', { updatedAt: 20 })] }, 'replace');
  const merged = await repository.importData({ version: 1, notes: [
    persistedNote('new', { createdAt: 30, updatedAt: 30 }),
    persistedNote('same', { content: 'newest', updatedAt: 40 }),
  ] }, 'merge');
  assert.deepEqual(merged, { imported: 2, inserted: 1, updated: 1, skipped: 0, total: 2 });
  const skipped = await repository.importData({ version: 1, notes: [
    persistedNote('same', { content: 'older', updatedAt: 10 }),
    persistedNote('new', { content: 'equal', updatedAt: 30 }),
  ] });
  assert.deepEqual(skipped, { imported: 0, inserted: 0, updated: 0, skipped: 2, total: 2 });
  assert.equal((await repository.exportData()).notes.find(({ id }) => id === 'same').content, 'newest');

  const replaced = await repository.importData(JSON.stringify({
    version: 1,
    notes: [persistedNote('only', { content: 'replacement' })],
  }), 'replace');
  assert.deepEqual(replaced, { imported: 1, inserted: 1, updated: 0, skipped: 0, total: 1 });
  await repository.close();
  const reopened = await openRepository({ filePath });
  t.after(() => reopened.close());
  assert.deepEqual((await reopened.exportData()).notes.map(({ id }) => id), ['only']);
});

test('import validates the entire payload before changing durable state', async (t) => {
  const { filePath, repository } = await fixture(t);
  const original = persistedNote('original', { content: 'keep me' });
  await repository.importData({ version: 1, notes: [original] }, 'replace');
  const before = await readFile(filePath, 'utf8');

  await assert.rejects(repository.importData(null), /import|payload|object/i);
  await assert.rejects(repository.importData('{broken'), /JSON|import/i);
  await assert.rejects(repository.importData({ version: 2, notes: [] }), /version/i);
  await assert.rejects(repository.importData({ version: 1, notes: {} }), /array/i);
  await assert.rejects(repository.importData({ version: 1, notes: [persistedNote('a'), persistedNote('a')] }), /duplicate/i);
  await assert.rejects(repository.importData({ version: 1, notes: [
    persistedNote('valid'),
    persistedNote('invalid', { attachments: [{ ...attachment(), size: 999 }] }),
  ] }), /size|bytes/i);
  await assert.rejects(repository.importData({ version: 1, notes: [] }, 'unknown'), /mode/i);
  assert.equal(await readFile(filePath, 'utf8'), before);
  assert.deepEqual((await repository.exportData()).notes, [original]);

  const cleared = await repository.importData({ version: 1, notes: [] }, 'replace');
  assert.equal(cleared.total, 0);
  assert.deepEqual((await repository.exportData()).notes, []);
});

test('corrupt or invalid persisted data is rejected clearly and never overwritten', async (t) => {
  const directory = await temporaryDirectory(t);
  const filePath = join(directory, 'notes.json');
  await writeFile(filePath, '{broken', 'utf8');
  await assert.rejects(openRepository({ filePath }), /corrupt|invalid|JSON/i);
  assert.equal(await readFile(filePath, 'utf8'), '{broken');

  await writeFile(filePath, JSON.stringify({ version: 2, notes: [] }), 'utf8');
  await assert.rejects(openRepository({ filePath }), /version/i);
  assert.equal(JSON.parse(await readFile(filePath, 'utf8')).version, 2);

  await writeFile(filePath, JSON.stringify({ version: 1, notes: [persistedNote('same'), persistedNote('same')] }), 'utf8');
  await assert.rejects(openRepository({ filePath }), /duplicate/i);
  assert.equal(JSON.parse(await readFile(filePath, 'utf8')).notes.length, 2);
});

test('close drains accepted writes, is idempotent and rejects every later operation', async (t) => {
  const { filePath, repository } = await fixture(t, { id: sequence('close') });
  const pending = Promise.all([
    repository.create({ content: 'one' }),
    repository.create({ content: 'two' }),
  ]);
  const closing = repository.close();
  await Promise.all([pending, closing]);
  await repository.close();
  await assert.rejects(repository.list(), /closed/i);
  await assert.rejects(repository.create({ content: 'three' }), /closed/i);
  await assert.rejects(repository.exportData(), /closed/i);
  assert.equal(JSON.parse(await readFile(filePath, 'utf8')).notes.length, 2);
});

test('openRepository validates options and clock values', async (t) => {
  const directory = await temporaryDirectory(t);
  const filePath = join(directory, 'notes.json');
  await assert.rejects(openRepository(), /filePath/i);
  await assert.rejects(openRepository({ filePath: ' ' }), /filePath/i);
  await assert.rejects(openRepository({ filePath, now: true }), /now/i);
  await assert.rejects(openRepository({ filePath, id: 'id' }), /id/i);
  const repository = await openRepository({ filePath, now: () => new Date(1000), id: () => 'one' });
  t.after(() => repository.close());
  assert.equal((await repository.create({ content: 'date clock' })).createdAt, 1000);
  await assert.rejects(repository.create({ content: 'duplicate' }), /duplicate/i);
});

test('trash is purged after thirty days on demand and on repository reopen', async (t) => {
  const day = 24 * 60 * 60 * 1000;
  let now = 1_000_000;
  const { filePath, repository } = await fixture(t, { now: () => now });
  const oldNote = await repository.create({ content: 'expired trash' });
  await repository.trash(oldNote.id);
  now += 29 * day;
  const recentNote = await repository.create({ content: 'recent trash' });
  await repository.trash(recentNote.id);
  now += 2 * day;

  await repository.close();
  const reopened = await openRepository({ filePath, now: () => now, id: sequence('reopened') });
  t.after(() => reopened.close());
  assert.deepEqual((await reopened.snapshot({ includeDeleted: true })).trash.map((note) => note.id), [recentNote.id]);

  now += 28 * day;
  const result = await reopened.purgeExpired();
  assert.equal(result.purged, 1);
  assert.deepEqual((await reopened.snapshot({ includeDeleted: true })).trash, []);
});
