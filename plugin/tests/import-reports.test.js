import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeImportReport, openImportReports } from '../lib/import-reports.js';

async function withStore(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'moments-reports-'));
  const filePath = join(directory, 'import-reports.json');
  const store = await openImportReports({ filePath });
  try {
    await callback({ store, filePath, directory });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('a report keeps the counts that matter and drops the rest', () => {
  const report = normalizeImportReport({
    boardId: 'b1',
    source: 'flow.jam',
    nodeCount: 1107,
    imported: { shape: 168, text: 40, empty: 0 },
    skipped: { symbol: 78, unknown: 412, slice: 0 },
    warnings: ['93 images came through as thumbnails'],
    skippedSamples: { symbol: [{ id: '1:2', name: 'Button/Primary', type: 'SYMBOL' }], slice: [] },
    junk: 'ignored',
  });
  assert.equal(report.boardId, 'b1');
  assert.equal(report.nodeCount, 1107);
  assert.deepEqual(report.imported, { shape: 168, text: 40 });
  assert.deepEqual(report.skipped, { symbol: 78, unknown: 412 });
  assert.deepEqual(report.skippedSamples.symbol, [{ id: '1:2', name: 'Button/Primary', type: 'SYMBOL' }]);
  assert.equal(report.skippedSamples.slice, undefined);
  assert.ok(report.id.startsWith('report-'));
});

test('a report needs a board to belong to', async () => {
  await withStore(async ({ store }) => {
    await assert.rejects(() => store.record({ nodeCount: 1 }), /boardId/);
    await assert.rejects(() => store.record(null), /object/);
  });
});

test('the newest report is the one a reader gets', async () => {
  await withStore(async ({ store }) => {
    await store.record({ boardId: 'b1', source: 'first.jam', nodeCount: 10, imported: { shape: 10 } });
    await store.record({ boardId: 'b1', source: 'second.jam', nodeCount: 20, imported: { shape: 20 } });
    const latest = await store.latest('b1');
    assert.equal(latest.source, 'second.jam');
    assert.equal((await store.list('b1')).length, 2);
    assert.equal(await store.latest('nope'), null);
  });
});

test('reports survive a reopen, which is the whole point', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'moments-reports-'));
  const filePath = join(directory, 'import-reports.json');
  try {
    const first = await openImportReports({ filePath });
    await first.record({ boardId: 'b1', source: 'flow.jam', nodeCount: 413, skipped: { symbol: 78 } });
    const second = await openImportReports({ filePath });
    const report = await second.latest('b1');
    assert.equal(report.nodeCount, 413);
    assert.deepEqual(report.skipped, { symbol: 78 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a board keeps a bounded history instead of growing without end', async () => {
  await withStore(async ({ store }) => {
    for (let index = 0; index < 8; index += 1) {
      await store.record({ boardId: 'b1', source: `import-${index}.jam`, nodeCount: index });
    }
    const reports = await store.list('b1');
    assert.equal(reports.length, 5);
    assert.equal(reports.at(-1).source, 'import-7.jam');
  });
});

test('a corrupted store is replaced rather than breaking the plugin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'moments-reports-'));
  const filePath = join(directory, 'import-reports.json');
  try {
    await writeFile(filePath, '{ this is not json', 'utf8');
    const store = await openImportReports({ filePath });
    assert.equal(await store.latest('b1'), null);
    await store.record({ boardId: 'b1', nodeCount: 3 });
    const written = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(written.version, 1);
    assert.equal(written.reports.b1.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('concurrent records do not lose an entry', async () => {
  await withStore(async ({ store }) => {
    await Promise.all(
      Array.from({ length: 6 }, (_, index) => store.record({ boardId: 'b1', source: `s${index}.jam` })),
    );
    const reports = await store.list('b1');
    assert.equal(reports.length, 5);
  });
});
