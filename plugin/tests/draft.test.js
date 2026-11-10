import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDraftStore, normalizeDraft } from '../lib/draft.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG.split(',')[1], 'base64').length;

function image(overrides = {}) {
  return {
    id: 'a1',
    name: 'screenshot.png',
    type: 'image/png',
    size: PNG_BYTES,
    dataUrl: PNG,
    ...overrides,
  };
}

async function withFolder(run) {
  const folder = await mkdtemp(join(tmpdir(), 'moments-draft-'));
  try {
    return await run(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

test('a draft keeps the text, the images and the note being edited', () => {
  const draft = normalizeDraft({
    content: '还没发送的想法 #工作',
    editingId: 'n7',
    attachments: [image()],
  });
  assert.equal(draft.content, '还没发送的想法 #工作');
  assert.equal(draft.editingId, 'n7');
  assert.equal(draft.attachments.length, 1);
  assert.equal(draft.attachments[0].dataUrl, PNG);
  assert.equal(draft.version, 1);
  assert.equal(typeof draft.savedAt, 'number');
});

test('an empty draft is nothing to restore', () => {
  assert.equal(normalizeDraft(null), null);
  assert.equal(normalizeDraft({ content: '   ', attachments: [] }), null);
  // An edit state without text or images could never be saved again.
  assert.equal(normalizeDraft({ content: '', editingId: 'n7' }), null);
});

test('one broken image does not cost the draft its text', () => {
  const draft = normalizeDraft({
    content: '正文还在',
    attachments: [image({ type: 'image/not-a-real-type' }), image({ id: 'a2', name: 'ok.png' })],
  });
  assert.equal(draft.content, '正文还在');
  assert.equal(draft.attachments.length, 1);
  assert.equal(draft.attachments[0].name, 'ok.png');
});

test('content longer than the note editor carries is truncated', () => {
  const draft = normalizeDraft({ content: 'x'.repeat(250_000) });
  assert.equal(draft.content.length, 200_000);
});

test('the draft survives a round trip through the store', async () => {
  await withFolder(async (folder) => {
    const store = createDraftStore({ filePath: join(folder, 'draft.json') });
    assert.equal(await store.read(), null, 'a fresh store has nothing');

    const written = await store.write({ content: '关窗前写的', editingId: 'n1', attachments: [image()] });
    assert.equal(written.content, '关窗前写的');

    const restored = await store.read();
    assert.equal(restored.content, '关窗前写的');
    assert.equal(restored.editingId, 'n1');
    assert.equal(restored.attachments.length, 1);

    const files = await readdir(folder);
    assert.deepEqual(files, ['draft.json'], 'the write is atomic, no temporary file is left behind');
  });
});

test('an empty draft removes the file instead of storing nothing', async () => {
  await withFolder(async (folder) => {
    const store = createDraftStore({ filePath: join(folder, 'draft.json') });
    await store.write({ content: '先写一条' });
    assert.ok(await store.read());
    await store.write({ content: '   ', attachments: [] });
    assert.equal(await store.read(), null);
    await assert.rejects(readFile(join(folder, 'draft.json'), 'utf8'), { code: 'ENOENT' });
  });
});

test('saving a note clears the draft', async () => {
  await withFolder(async (folder) => {
    const store = createDraftStore({ filePath: join(folder, 'draft.json') });
    await store.write({ content: '要发的' });
    await store.clear();
    assert.equal(await store.read(), null);
  });
});

test('a corrupt draft file is dropped, not thrown at the float', async () => {
  await withFolder(async (folder) => {
    const filePath = join(folder, 'draft.json');
    await writeFile(filePath, '{not json', 'utf8');
    const warnings = [];
    const store = createDraftStore({ filePath, logger: { warn: (message) => warnings.push(message) } });
    assert.equal(await store.read(), null);
    assert.equal(warnings.length, 1, 'the corrupt file is reported');
    await assert.rejects(readFile(filePath, 'utf8'), { code: 'ENOENT' }, 'the corrupt file is removed');
  });
});

test('writes from a debounce and a closing window queue instead of interleaving', async () => {
  await withFolder(async (folder) => {
    const store = createDraftStore({ filePath: join(folder, 'draft.json') });
    await Promise.all([
      store.write({ content: '第一版' }),
      store.write({ content: '第二版' }),
      store.write({ content: '第三版' }),
    ]);
    const restored = await store.read();
    assert.equal(restored.content, '第三版', 'the last write wins and the file is valid');
  });
});

test('the bridge and the store together keep a draft and clear it when the note is saved', async () => {
  const { createFloatBridge } = await import('../lib/float-bridge.js');
  await withFolder(async (folder) => {
    const store = createDraftStore({ filePath: join(folder, 'draft.json') });
    const sent = [];
    const listeners = new Set();
    const float = {
      open: true,
      isOpen() { return this.open; },
      async send(event) { sent.push(event); return true; },
      async stop() { this.open = false; },
      onCommand(handler) { listeners.add(handler); return () => listeners.delete(handler); },
      emit(event) { for (const listener of listeners) listener(event); },
    };
    const repository = {
      async snapshot() { return { notes: [{ id: 'n1', content: '被编辑的笔记', deletedAt: null }] }; },
      async list() { return []; },
      async create() { return { id: 'n2' }; },
      async update() { return { id: 'n1' }; },
      subscribe() { return () => {}; },
    };
    const bridge = createFloatBridge({ repository, desktopFloat: float, draftStore: store });

    // The window writes a draft after three seconds of typing.
    float.emit({ type: 'draft', draft: { content: '还没发送', editingId: 'n1', attachments: [] } });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal((await store.read()).content, '还没发送');

    // The next window opens and gets it back.
    float.emit({ type: 'ready' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const restored = sent.find((event) => event.type === 'draft');
    assert.equal(restored.draft.content, '还没发送');
    assert.equal(restored.draft.editingId, 'n1');

    // Committing the note forgets the draft.
    float.emit({ type: 'create', content: '还没发送', attachments: [] });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(await store.read(), null);
    await bridge.dispose();
  });
});
