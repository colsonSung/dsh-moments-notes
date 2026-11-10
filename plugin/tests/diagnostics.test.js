import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFetchHandler, ROUTE } from '../lib/http.js';
import { createHostService } from '../lib/host-service.js';
import { openDiagnostics, summarizePayload } from '../lib/diagnostics.js';
import { createDesignTools } from '../lib/design-tools.js';

function request(body) {
  return new Request(`http://127.0.0.1${ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function withDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'moments-diagnostics-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('a failed save is logged with an id and the node that broke the limit', async (t) => {
  const directory = await withDirectory(t);
  const diagnostics = await openDiagnostics({ filePath: join(directory, 'diagnostics.log') });
  const handler = createFetchHandler({
    call: async () => {
      const error = new Error('node.w must be between 16 and 8000');
      error.code = 'INVALID_CANVAS';
      throw error;
    },
  }, { diagnostics });

  const response = await handler(request({
    method: 'canvas-save',
    payload: { id: 'board-1', nodes: [{ id: 'n1', type: 'frame', w: 9000, h: 400 }], edges: [] },
  }));
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.match(body.error.logId, /^E-/);
  assert.equal(body.error.message, 'node.w must be between 16 and 8000');

  const entries = await diagnostics.recent({ limit: 5 });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, body.error.logId);
  assert.equal(entries[0].method, 'canvas-save');
  assert.equal(entries[0].code, 'INVALID_CANVAS');
  assert.equal(entries[0].detail.payload.nodeCount, 1);
  const suspect = entries[0].detail.payload.suspects[0];
  assert.equal(suspect.id, 'n1');
  assert.equal(suspect.type, 'frame');
  assert.equal(suspect.w, 9000);
  assert.equal(suspect.h, 400);
});

test('an unexpected failure is logged in full while the client only sees a safe message', async (t) => {
  const directory = await withDirectory(t);
  const diagnostics = await openDiagnostics({ filePath: join(directory, 'diagnostics.log') });
  const handler = createFetchHandler({
    call: async () => { throw new Error('disk is full: /private/profile/notes.json'); },
  }, { diagnostics });

  const body = await (await handler(request({ method: 'snapshot', payload: {} }))).json();
  assert.equal(body.error.code, 'operation-failed');
  assert.equal(body.error.message, 'The note action failed — try again in a moment');
  assert.match(body.error.logId, /^E-/);

  const [entry] = await diagnostics.recent({ limit: 1 });
  assert.match(entry.message, /disk is full/);
  assert.equal(entry.code, 'unexpected');
});

test('the browser records its own failures and reads the same log back', async (t) => {
  const directory = await withDirectory(t);
  const diagnostics = await openDiagnostics({ filePath: join(directory, 'diagnostics.log') });
  const service = createHostService({ repository: {}, canvasRepository: null, assets: null, diagnostics });

  const recorded = await service.call('client-error', {
    method: 'unhandledrejection',
    code: 'browser',
    message: 'Cannot read properties of undefined',
    stack: 'at draw (client.js:1:1)',
  });
  assert.match(recorded.id, /^E-/);

  const result = await service.call('diagnostics', { limit: 5 });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].scope, 'client');
  assert.equal(result.entries[0].method, 'unhandledrejection');
  assert.match(result.location.filePath, /diagnostics\.log$/);

  const text = await readFile(result.location.filePath, 'utf8');
  assert.match(text, /unhandledrejection/);
});

test('the log keeps the newest entries across a rotation', async (t) => {
  const directory = await withDirectory(t);
  const filePath = join(directory, 'diagnostics.log');
  const diagnostics = await openDiagnostics({ filePath, maxBytes: 400 });
  for (let index = 0; index < 12; index += 1) {
    await diagnostics.record({ scope: 'host', method: 'canvas-save', code: 'x', message: `failure ${index} ${'x'.repeat(60)}` });
  }
  const entries = await diagnostics.recent({ limit: 5 });
  assert.ok(entries.length >= 1, 'the newest entries survive a rotation');
  assert.match(entries[0].message, /failure 11/);
  const times = entries.map((entry) => entry.at);
  assert.deepEqual(times, [...times].sort((left, right) => right - left), 'the newest entry comes first');
});

test('a payload summary names only the nodes outside the limits', () => {
  const summary = summarizePayload('canvas-save', {
    id: 'board-1',
    nodes: [
      { id: 'ok', w: 320, h: 200 },
      { id: 'too-big', w: 8001, h: 200 },
      { id: 'nan', w: Number.NaN, h: 200 },
    ],
  });
  assert.equal(summary.nodes, 3);
  assert.deepEqual(summary.suspects.map((node) => node.id), ['too-big', 'nan']);
});

test('a design tool failure is written to the diagnostic log', async (t) => {
  const directory = await withDirectory(t);
  const diagnostics = await openDiagnostics({ filePath: join(directory, 'diagnostics.log') });
  const brokenStore = {
    async create() {
      const error = new Error('the board could not be written');
      error.code = 'STORE_FAILED';
      throw error;
    },
  };
  const tools = createDesignTools({ getCanvasStore: () => brokenStore, diagnostics });
  const begin = tools.find((tool) => tool.name === 'design_begin');
  const result = await begin.execute({ title: 'Broken', width: 1440, height: 900 });
  assert.equal(result.ok, false);
  assert.equal(result.summary, 'the board could not be written');

  const entries = await diagnostics.recent({ limit: 3 });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].scope, 'tool');
  assert.equal(entries[0].method, 'design_begin');
  assert.equal(entries[0].code, 'STORE_FAILED');
});

