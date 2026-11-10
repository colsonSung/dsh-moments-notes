import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply, inject, MINI_ROUTE, ROUTE } from '../index.js';

test('plugin activation opens durable storage and registers the UI route and agent tool', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'flomo-plugin-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const registrations = [];
  const cleanups = [];
  const ctx = {
    profileContext: { dir },
    tools: { register(definition) { registrations.push(['tool', definition]); return () => {}; } },
    connection: { fetch: { register(route) { registrations.push(['route', route]); return () => {}; } } },
    provide(name, value) { registrations.push(['provide', name, value]); },
    effect(callback) { const cleanup = callback(); if (cleanup) cleanups.push(cleanup); return () => {}; },
  };
  await apply(ctx);
  assert.ok(inject.includes('connection'));
  assert.ok(inject.includes('tools'));
  const routeEntry = registrations.find(([kind]) => kind === 'route');
  assert.equal(routeEntry[1].path, ROUTE);
  assert.deepEqual(routeEntry[1].methods, ['POST']);
  const toolEntry = registrations.find(([kind]) => kind === 'tool');
  assert.equal(toolEntry[1].name, 'moments_memo');
  const response = await routeEntry[1].fetch(new Request(`http://localhost${ROUTE}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'create', payload: { content: '插件集成 #测试', attachments: [] } }),
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.result.content, '插件集成 #测试');
  const found = await toolEntry[1].execute({ action: 'search', query: '插件集成', limit: 5 });
  assert.equal(found.ok, true);
  assert.equal(found.data.notes.length, 1);
  const noMatch = await toolEntry[1].execute({ action: 'search', query: '__no_match__' });
  assert.equal(noMatch.data.notes.length, 0);
  const miniRoute = registrations.find(([kind, route]) => kind === 'route' && route.path === MINI_ROUTE);
  assert.ok(miniRoute, 'registers the standalone mini window route');
  assert.deepEqual(miniRoute[1].methods, ['GET']);
  const miniResponse = await miniRoute[1].fetch(new Request(`http://localhost${MINI_ROUTE}`));
  assert.equal(miniResponse.status, 200);
  assert.match(miniResponse.headers.get('content-type') || '', /text\/html/);
  assert.match(await miniResponse.text(), /id="mini-editor"/);
  for (const cleanup of cleanups.reverse()) await cleanup();
});

test('activation rolls back the registered route when tool registration fails', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'flomo-plugin-rollback-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let routeDisposed = false;
  const ctx = {
    profileContext: { dir },
    tools: { register() { throw new Error('duplicate tool'); } },
    connection: { fetch: { register() { return () => { routeDisposed = true; }; } } },
    provide() {},
    effect(callback) { return callback(); },
  };
  await assert.rejects(apply(ctx), /duplicate tool/);
  assert.equal(routeDisposed, true);
});
