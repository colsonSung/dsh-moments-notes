import test from 'node:test';
import assert from 'node:assert/strict';

import { createHostService, createMemoTool } from '../lib/host-service.js';

function repositoryStub() {
  const calls = [];
  const note = {
    id: 'memo-1', content: '第一条 #工作/项目', createdAt: 1, updatedAt: 1,
    pinned: false, deletedAt: null, attachments: [],
  };
  return {
    calls,
    async snapshot() { calls.push(['snapshot']); return { notes: [note], trash: [{ ...note, id: 'deleted', deletedAt: 2 }], tags: [], stats: {} }; },
    async create(input) { calls.push(['create', input]); return { ...note, ...input, id: 'memo-1' }; },
    async update(id, input) { calls.push(['update', id, input]); return { ...note, ...input, id }; },
    async setPinned(id, pinned) { calls.push(['pin', id, pinned]); return { ...note, id, pinned }; },
    async trash(id) { calls.push(['trash', id]); return { ...note, id, deletedAt: 2 }; },
    async restore(id) { calls.push(['restore', id]); return { ...note, id }; },
    async purge(id) { calls.push(['purge', id]); return { id, purged: true }; },
    async related(id, limit) { calls.push(['related', id, limit]); return [note]; },
    async review(mode) { calls.push(['review', mode]); return [note]; },
    async exportData() { calls.push(['export']); return { version: 1, notes: [note] }; },
    async importData(data, mode) { calls.push(['import', data, mode]); return { imported: 1, total: 1 }; },
    async list(filters) { calls.push(['list', filters]); return [note]; },
  };
}

test('Host service exposes one bounded operation contract for the UI', async () => {
  const repository = repositoryStub();
  const service = createHostService({ repository });
  const snapshot = await service.call('snapshot', {});
  assert.equal(snapshot.notes.length, 2);
  assert.equal(snapshot.notes[1].id, 'deleted');
  await service.call('create', { content: 'hello', attachments: [] });
  await service.call('update', { id: 'memo-1', content: 'updated' });
  await service.call('pin', { id: 'memo-1', pinned: true });
  await service.call('trash', { id: 'memo-1' });
  await service.call('restore', { id: 'memo-1' });
  await service.call('purge', { id: 'memo-1' });
  await service.call('related', { id: 'memo-1', limit: 3 });
  await service.call('review', { mode: 'random' });
  await service.call('export', {});
  await service.call('import', { data: { version: 1, notes: [] }, mode: 'merge' });
  assert.deepEqual(repository.calls.map(([name]) => name), [
    'snapshot', 'create', 'update', 'pin', 'trash', 'restore', 'purge',
    'related', 'review', 'export', 'import',
  ]);
});

test('Host service rejects unknown methods and invalid review modes', async () => {
  const service = createHostService({ repository: repositoryStub() });
  await assert.rejects(service.call('not-real', {}), (error) => {
    assert.match(error.message, /Unsupported note action/);
    assert.equal(error.code, 'INVALID_OPERATION');
    return true;
  });
  await assert.rejects(service.call('review', { mode: 'future' }), (error) => {
    assert.match(error.message, /Unsupported review mode/);
    assert.equal(error.code, 'INVALID_OPERATION');
    return true;
  });
});

test('Host service drives the desktop float through the bridge', async () => {
  const calls = [];
  const floatBridge = {
    open: async () => { calls.push('open'); return { open: true }; },
    close: async () => { calls.push('close'); return { open: false }; },
    status: () => { calls.push('status'); return { open: true, available: true }; },
  };
  const service = createHostService({ repository: repositoryStub(), floatBridge });
  assert.deepEqual(await service.call('float-open', {}), { open: true });
  assert.deepEqual(await service.call('float-close', {}), { open: false });
  assert.deepEqual(await service.call('float-status', {}), { open: true, available: true });
  assert.deepEqual(calls, ['open', 'close', 'status']);
});

test('Host service refuses the desktop float when no bridge is mounted', async () => {
  const service = createHostService({ repository: repositoryStub() });
  await assert.rejects(service.call('float-open', {}), (error) => {
    assert.match(error.message, /desktop float is not ready/);
    assert.equal(error.code, 'INVALID_OPERATION');
    return true;
  });
});

test('memo tool creates and searches through the same repository with bounded output', async () => {
  const repository = repositoryStub();
  const tool = createMemoTool({ repository });
  assert.equal(tool.name, 'moments_memo');
  const created = await tool.execute({ action: 'create', content: '记录 #工作' });
  assert.equal(created.ok, true);
  assert.equal(created.action, 'create');
  assert.match(created.summary, /memo-1/);
  const found = await tool.execute({ action: 'search', query: '第一', limit: 999 });
  assert.equal(found.ok, true);
  const listCall = repository.calls.find(([name]) => name === 'list');
  assert.equal(listCall[1].query, '第一');
  assert.equal(listCall[1].limit, 50);
  assert.equal(found.data.notes.length, 1);
  assert.equal(found.data.notes[0].attachments.length, 0);
  assert.match(tool.output.render({}, found)[0].text, /Found/);
});

test('memo tool reports create validation without calling the repository', async () => {
  const repository = repositoryStub();
  const tool = createMemoTool({ repository });
  const result = await tool.execute({ action: 'create', content: '  ' });
  assert.equal(result.ok, false);
  assert.equal(repository.calls.length, 0);
});

test('memo tool bounds large note content, attachment metadata and echoed queries', async () => {
  const repository = repositoryStub();
  const huge = 'x'.repeat(20000);
  const hugeQuery = 'secret-query-'.repeat(1000);
  repository.list = async () => [{
    id: 'huge', content: huge, createdAt: 1, updatedAt: 1, pinned: false, deletedAt: null,
    attachments: Array.from({ length: 30 }, (_, index) => ({ id: `a${index}`, name: huge, type: 'image/png', size: 10 })),
  }];
  const tool = createMemoTool({ repository });
  const result = await tool.execute({ action: 'search', query: hugeQuery });
  const note = result.data.notes[0];
  assert.ok(note.content.length <= 2000);
  assert.match(note.content, /…$/);
  assert.ok(note.attachments.length <= 10);
  assert.ok(note.attachments[0].name.length <= 200);
  assert.ok(result.summary.length <= 300);
  assert.equal(result.summary.includes(hugeQuery), false);
  const created = await tool.execute({ action: 'create', content: huge });
  assert.ok(created.summary.length <= 300);
});

test('memo tool also bounds a repository-returned ID in the rendered create summary', async () => {
  const repository = repositoryStub();
  const hugeId = 'id-secret-'.repeat(1000);
  repository.create = async (input) => ({
    id: hugeId, content: input.content, createdAt: 1, updatedAt: 1,
    pinned: false, deletedAt: null, attachments: [],
  });
  const result = await createMemoTool({ repository }).execute({ action: 'create', content: 'bounded' });
  assert.ok(result.summary.length <= 300);
  assert.equal(result.summary.includes(hugeId), false);
  assert.equal(toolText(result).includes(hugeId), false);
});

function toolText(result) {
  return createMemoTool({ repository: repositoryStub() }).output.render({}, result)[0].text;
}
