import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { DesktopFloat } from '../lib/desktop-float.js';
import { createFloatBridge } from '../lib/float-bridge.js';

const binaryPath = fileURLToPath(new URL('../native/bin/moments-float', import.meta.url));
const swiftPath = fileURLToPath(new URL('../native/MomentsFloat.swift', import.meta.url));
const indexPath = fileURLToPath(new URL('../index.js', import.meta.url));

const echoScript = `
  process.stdin.setEncoding('utf8');
  let buffer = '';
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) { index = buffer.indexOf('\\n'); continue; }
      const event = JSON.parse(line);
      if (event.type === 'control' && event.detail === 'close') process.exit(0);
      process.stdout.write(JSON.stringify({ type: 'echo', detail: event.type }) + '\\n');
      index = buffer.indexOf('\\n');
    }
  });
`;

function fakeFloat() {
  const sent = [];
  const listeners = new Set();
  const float = {
    sent,
    command: '/tmp/moments-float',
    failure: '',
    open: false,
    isOpen() { return this.open; },
    async available() { return true; },
    async send(event) { sent.push(event); return true; },
    async stop() { this.open = false; },
    onCommand(handler) { listeners.add(handler); return () => listeners.delete(handler); },
    emit(event) { for (const listener of listeners) listener(event); },
  };
  return float;
}

function repositoryStub(notes = []) {
  const calls = [];
  const listeners = new Set();
  const state = { notes };
  return {
    calls,
    state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    notify() { for (const listener of listeners) listener(); },
    async snapshot() { return { notes: [...state.notes] }; },
    async list(filters) { calls.push(['list', filters]); return [...state.notes]; },
    async create(input) { calls.push(['create', input]); return input; },
    async update(id, input) { calls.push(['update', id, input]); return input; },
    async trash(id) { calls.push(['trash', id]); return { id }; },
    async setPinned(id, pinned) { calls.push(['pin', id, pinned]); return { id, pinned }; },
  };
}

test('the desktop float reads JSONL commands and writes JSONL events', async () => {
  const float = new DesktopFloat({ command: process.execPath, args: ['-e', echoScript] });
  const received = [];
  float.onCommand((event) => received.push(event));
  await float.start();
  assert.equal(float.isOpen(), true);
  await float.send({ type: 'notes', notes: [] });
  await float.send({ type: 'status', detail: 'ready' });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(received.map((event) => event.detail), ['notes', 'status']);
  await float.stop();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(float.isOpen(), false);
});

test('the desktop float ignores malformed lines', async () => {
  const float = new DesktopFloat({ command: process.execPath, args: ['-e', echoScript] });
  const received = [];
  float.onCommand((event) => received.push(event));
  await float.start();
  float.consume('not json\n');
  float.consume('{"type":"ready"}\n');
  assert.deepEqual(received.map((event) => event.type), ['ready']);
  await float.stop();
});

test('the desktop float reports a missing helper instead of throwing', async () => {
  const float = new DesktopFloat({ command: '/nowhere/moments-float' });
  assert.equal(await float.available(), false);
  await assert.rejects(float.start());
  assert.equal(float.isOpen(), false);
});

test('the bridge answers a query with the matching notes', async () => {
  const float = fakeFloat();
  const repository = repositoryStub([
    {
      id: 'n1',
      content: '第一条',
      createdAt: 100,
      pinned: true,
      attachments: [{ id: 'a1', name: 'a.png', type: 'image/png', size: 10, dataUrl: 'data:image/png;base64,AA==' }],
    },
  ]);
  const bridge = createFloatBridge({ repository, desktopFloat: float });
  float.open = true;
  float.emit({ type: 'ready' });
  float.emit({ type: 'query', query: '第一条' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const pushed = float.sent.filter((event) => event.type === 'notes');
  assert.equal(pushed.length, 2, 'one list per query');
  assert.equal(pushed[1].notes.length, 1);
  assert.equal(pushed[1].total, 1);
  assert.equal(pushed[1].notes[0].pinned, true);
  assert.equal(pushed[1].notes[0].attachments[0].dataUrl, undefined, 'the list carries no image bytes');
  const listCalls = repository.calls.filter(([name]) => name === 'list');
  assert.equal(listCalls.at(-1)[1].query, '第一条', 'the search reaches the repository');
  assert.equal(listCalls.at(-1)[1].limit, 200, 'the list is bounded');
});

test('the bridge writes the window commands into the repository', async () => {
  const float = fakeFloat();
  const repository = repositoryStub();
  const bridge = createFloatBridge({ repository, desktopFloat: float });
  float.open = true;

  float.emit({ type: 'create', content: '写一条', attachments: [] });
  float.emit({ type: 'update', id: 'n1', content: '改一条' });
  float.emit({ type: 'trash', id: 'n1' });
  float.emit({ type: 'pin', id: 'n1', pinned: true });
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(repository.calls.map(([name]) => name), ['create', 'update', 'trash', 'pin']);
  assert.equal(repository.calls[0][1].content, '写一条');
  assert.equal(repository.calls[1][1], 'n1');
  assert.equal(repository.calls[3][2], true);
  assert.ok(float.sent.some((event) => event.type === 'saved'));
});

test('the bridge reports a failed write to the window', async () => {
  const float = fakeFloat();
  const repository = repositoryStub();
  repository.create = async () => { throw new Error('内容不能为空'); };
  const bridge = createFloatBridge({ repository, desktopFloat: float });
  float.open = true;
  float.emit({ type: 'create', content: '', attachments: [] });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const failure = float.sent.find((event) => event.type === 'error');
  assert.ok(failure, 'the window is told about the failure');
  assert.match(failure.detail, /内容不能为空/);
});

test('the bridge refreshes the window after any repository write', async () => {
  const float = fakeFloat();
  const repository = repositoryStub([]);
  const bridge = createFloatBridge({ repository, desktopFloat: float });
  float.open = true;
  float.sent.length = 0;
  repository.notify();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(float.sent.some((event) => event.type === 'notes'), 'a write refreshes the mirror');
  await bridge.dispose();
});

test('the native helper passes its own self-test', { skip: existsSync(binaryPath) ? false : 'binary not built' }, () => {
  const output = execFileSync(binaryPath, ['--self-test'], { encoding: 'utf8' });
  assert.match(output, /self-test: \d+ checks passed/);
});

test('the native header is dragged from AppKit\'s own event stream, behind the controls', () => {
  const source = readFileSync(swiftPath, 'utf8');
  const header = source.slice(source.indexOf('private var header'), source.indexOf('private var searchField'));
  assert.ok(header.length > 0, 'the header view exists');
  const dragIndex = header.indexOf('WindowDragArea()');
  const controlsIndex = header.indexOf('HStack(spacing: 10)');
  assert.ok(dragIndex >= 0, 'the empty header hands the mouse-down to the window drag');
  assert.ok(controlsIndex > dragIndex, 'the drag surface is declared first, so it never sits above the controls');
  assert.match(header, /iconButton\("xmark", label: "Close the float", action: onClose\)/, 'the close button is a real button');
  assert.doesNotMatch(header, /\.dragGesture|\.gesture\(\s*DragGesture/, 'no SwiftUI gesture steers the window frame');
  assert.match(source, /NSEvent\.addLocalMonitorForEvents\(matching: \[\.leftMouseDragged, \.leftMouseUp\]/, 'the window follows AppKit\'s drag events one for one');
  assert.match(source, /window\.setFrameOrigin\(NSPoint\(/, 'each event moves the frame');
  assert.doesNotMatch(source, /WindowDragger/, 'the hand-rolled SwiftUI gesture dragging is gone');
});

test('the native composer attaches images from the clipboard, disk and drops', () => {
  const source = readFileSync(swiftPath, 'utf8');
  assert.match(source, /NSOpenPanel\(\)/, 'a file picker can choose an image');
  assert.match(source, /allowedContentTypes = \[\.image\]/, 'the picker only offers images');
  assert.match(source, /Button\("Choose image…"\)/, 'the toolbar menu offers a file');
  assert.match(source, /Button\("Paste image"\)/, 'the toolbar menu offers the clipboard');
  assert.match(source, /\.onDrop\(of: \[UTType\.fileURL, UTType\.image\]/, 'an image can be dropped on the card');
  assert.match(source, /loadItem\(forTypeIdentifier: UTType\.fileURL\.identifier/, 'a dropped file arrives as a file URL');
  assert.match(source, /static func from\(fileAt url: URL\)/, 'image files are normalised like clipboard bytes');
  assert.match(source, /readObjects\(\s*forClasses: \[NSURL\.self\]/, 'a file copied in the Finder is accepted');
  assert.match(source, /NSApplication\.shared\.mainMenu = mainMenu/, 'the edit menu exists so ⌘V can reach the editor');
  assert.match(source, /withTitle: "Paste", action: #selector\(NSText\.paste\(_:\)\), keyEquivalent: "v"/, 'Edit ▸ Paste carries ⌘V');
});

function draftStoreStub(initial = null) {
  const calls = [];
  return {
    calls,
    async read() { return initial; },
    async write(draft) { calls.push(['write', draft]); return draft; },
    async clear() { calls.push(['clear']); return null; },
  };
}

test('the bridge hands the last draft back to a reopened window', async () => {
  const float = fakeFloat();
  const repository = repositoryStub([
    { id: 'n1', content: '旧笔记', createdAt: 1, pinned: false, attachments: [] },
  ]);
  const draftStore = draftStoreStub({
    content: '关窗前的文字',
    editingId: 'n1',
    attachments: [{ id: 'a1', name: 's.png', type: 'image/png', size: 10, dataUrl: 'data:image/png;base64,AA==' }],
  });
  const bridge = createFloatBridge({ repository, desktopFloat: float, draftStore });
  float.open = true;
  float.emit({ type: 'ready' });
  await new Promise((resolve) => setTimeout(resolve, 60));

  const draft = float.sent.find((event) => event.type === 'draft');
  assert.ok(draft, 'the window is handed a draft');
  assert.equal(draft.draft.content, '关窗前的文字');
  assert.equal(draft.draft.editingId, 'n1', 'the edit state is restored while the note exists');
  assert.equal(draft.draft.attachments.length, 1);
  await bridge.dispose();
});

test('a draft that edited a gone note reopens as a new draft', async () => {
  const float = fakeFloat();
  const repository = repositoryStub([]);
  const draftStore = draftStoreStub({ content: '还没写完', editingId: 'deleted-note', attachments: [] });
  const bridge = createFloatBridge({ repository, desktopFloat: float, draftStore });
  float.open = true;
  float.emit({ type: 'ready' });
  await new Promise((resolve) => setTimeout(resolve, 60));

  const draft = float.sent.find((event) => event.type === 'draft');
  assert.ok(draft, 'the text still comes back');
  assert.equal(draft.draft.content, '还没写完');
  assert.equal(draft.draft.editingId, undefined, 'a note that no longer exists is not edited again');
  await bridge.dispose();
});

test('the window writes its draft and a committed note clears it', async () => {
  const float = fakeFloat();
  const repository = repositoryStub();
  const draftStore = draftStoreStub(null);
  const bridge = createFloatBridge({ repository, desktopFloat: float, draftStore });
  float.open = true;

  float.emit({ type: 'draft', draft: { content: '正在写', attachments: [] } });
  float.emit({ type: 'update', id: 'n1', content: '写完了' });
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.deepEqual(draftStore.calls[0], ['write', { content: '正在写', attachments: [] }]);
  assert.ok(draftStore.calls.some(([name]) => name === 'clear'), 'an update clears the draft');
  await bridge.dispose();
});

test('a failing draft write never interrupts typing', async () => {
  const float = fakeFloat();
  const repository = repositoryStub();
  const draftStore = {
    async read() { return null; },
    async write() { throw new Error('disk full'); },
    async clear() {},
  };
  const bridge = createFloatBridge({ repository, desktopFloat: float, draftStore });
  float.open = true;
  float.emit({ type: 'draft', draft: { content: '还在写', attachments: [] } });
  float.emit({ type: 'create', content: '还在写', attachments: [] });
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.ok(float.sent.some((event) => event.type === 'saved'), 'the note still saves');
  assert.equal(float.sent.some((event) => event.type === 'error'), false, 'no error is shown for a draft');
  await bridge.dispose();
});

test('the draft file lives beside the notes store', () => {
  const source = readFileSync(indexPath, 'utf8');
  assert.match(source, /createDraftStore/, 'the Host owns the draft store');
  assert.match(source, /join\(dirname\(dataFile\), 'draft\.json'\)/, 'the draft sits next to notes.json');
  assert.match(source, /createFloatBridge\(\{ repository, desktopFloat, draftStore \}\)/, 'the float bridge receives it');
});

test('the native window keeps a draft while typing and flushes it on close', () => {
  const source = readFileSync(swiftPath, 'utf8');
  assert.match(source, /static let draftDebounce: TimeInterval = 3/, 'typing rests three seconds before the draft is written');
  assert.match(source, /func persistDraft\(force: Bool = false\)/, 'the draft can be flushed on demand');
  assert.match(source, /case "draft":/, 'the window accepts a restored draft');
  assert.match(source, /func restore\(_ draft: FloatDraft\)/, 'the window puts a draft back');
  assert.match(source, /model\.persistDraft\(force: true\)/, 'closing the window flushes the draft first');
  assert.match(source, /onDraft/, 'the draft leaves through one channel');
  assert.match(source, /discardDraft\(\)/, 'a saved note drops its draft');
});
