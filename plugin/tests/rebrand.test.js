import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prepareDataFile, name, ROUTE } from '../index.js';
import { createMemoTool } from '../lib/host-service.js';

test('Moments identity is used by the plugin, route and agent tool', () => {
  assert.equal(name, 'moments-notes');
  assert.equal(ROUTE, '/api/moments-notes');
  assert.equal(createMemoTool({ repository: {} }).name, 'moments_memo');
});

for (const legacyName of ['shiguang-notes', 'flomo-notes']) {
  test(`activation migrates ${legacyName} without deleting or overwriting data`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'moments-migration-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const legacyDir = join(dir, legacyName);
    await mkdir(legacyDir, { recursive: true });
    const legacyPath = join(legacyDir, 'notes.json');
    const legacy = JSON.stringify({ version: 1, notes: [{ id: 'legacy-note' }] }, null, 2);
    await writeFile(legacyPath, legacy, 'utf8');

    const filePath = await prepareDataFile({ profileContext: { dir } });
    assert.equal(filePath, join(dir, 'moments-notes', 'notes.json'));
    assert.equal(await readFile(filePath, 'utf8'), legacy);
    assert.equal(await readFile(legacyPath, 'utf8'), legacy);

    const newer = JSON.stringify({ version: 1, notes: [{ id: 'newer-note' }] });
    await writeFile(filePath, newer, 'utf8');
    assert.equal(await prepareDataFile({ profileContext: { dir } }), filePath);
    assert.equal(await readFile(filePath, 'utf8'), newer);
  });
}

test('a Moments store created concurrently wins over legacy migration', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'moments-migration-race-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const legacyDir = join(dir, 'shiguang-notes');
  await mkdir(legacyDir, { recursive: true });
  const legacyPath = join(legacyDir, 'notes.json');
  const legacy = Buffer.alloc(64 * 1024 * 1024, 7);
  await writeFile(legacyPath, legacy);
  const filePath = join(dir, 'moments-notes', 'notes.json');
  const current = 'CURRENT-MOMENTS-STORE';
  let started = false;
  let completed = false;
  let writer;
  const preparing = prepareDataFile({ profileContext: { dir } });
  const watcher = setInterval(() => {
    if (started) return;
    void (async () => {
      const directory = await stat(join(dir, 'moments-notes')).catch(() => null);
      if (!directory) return;
      const entries = await readdir(join(dir, 'moments-notes'));
      if (!entries.some((entry) => entry.includes('.migrating-'))) return;
      started = true;
      writer = writeFile(filePath, current, 'utf8').then(() => { completed = true; });
    })();
  }, 1);
  await preparing;
  clearInterval(watcher);
  await writer;
  assert.equal(completed, true, 'concurrent writer must finish before migration publishes');
  assert.equal(createHash('sha256').update(await readFile(filePath)).digest('hex'), createHash('sha256').update(current).digest('hex'));
  assert.equal((await stat(legacyPath)).size, legacy.length);
});
