import test from 'node:test';
import assert from 'node:assert/strict';

import { createFetchHandler, ROUTE } from '../lib/http.js';

function request(body) {
  return new Request(`http://127.0.0.1${ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('HTTP boundary dispatches a valid operation and returns its result', async () => {
  const calls = [];
  const handler = createFetchHandler({ call: async (method, payload) => {
    calls.push([method, payload]);
    return { notes: [] };
  } });
  const response = await handler(request({ method: 'snapshot', payload: { includeTrash: true } }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, result: { notes: [] } });
  assert.deepEqual(calls, [['snapshot', { includeTrash: true }]]);
});

test('HTTP boundary rejects malformed JSON, unknown methods and service failures safely', async () => {
  const handler = createFetchHandler({ call: async (method) => {
    if (method === 'explode') throw new Error('disk is full');
    if (method === 'internal-keyword') throw new Error('解析失败：/private/profile/notes.json');
    if (method === 'invalid' || method === 'unknown') {
      const error = new Error(method === 'unknown' ? '不支持的笔记操作' : 'Note content cannot be blank');
      error.code = method === 'unknown' ? 'INVALID_OPERATION' : 'VALIDATION_ERROR';
      throw error;
    }
    throw new Error('unexpected method');
  } });
  const malformed = await handler(request('{broken'));
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, 'bad-request');
  const unknown = await handler(request({ method: 'unknown', payload: {} }));
  assert.equal(unknown.status, 400);
  assert.match((await unknown.json()).error.message, /不支持/);
  const invalid = await handler(request({ method: 'invalid', payload: {} }));
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.message, 'Note content cannot be blank');
  for (const method of ['explode', 'internal-keyword']) {
    const failed = await handler(request({ method, payload: {} }));
    assert.equal(failed.status, 500);
    const body = await failed.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.message, 'The note action failed — try again in a moment');
    assert.equal(/disk is full|private\/profile/.test(JSON.stringify(body)), false);
    assert.equal(body.error.stack, undefined);
  }
});
