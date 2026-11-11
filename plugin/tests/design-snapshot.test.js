import test from 'node:test';
import assert from 'node:assert/strict';

import { createSnapshotBroker, dataUrlBytes } from '../lib/design-snapshot.js';

/** A one-pixel PNG, as the panel would send it back. */
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('the canvas is handed the job an agent asked for', async () => {
  const broker = createSnapshotBroker({ unref: false, waitMs: 500 });
  const asked = broker.request({ boardId: 'board-1', scale: 2 });
  const job = await broker.next(1000);
  assert.equal(job.boardId, 'board-1');
  assert.equal(job.scale, 2);
  assert.equal(broker.pending(), 1);
  broker.fulfill(job.jobId, PIXEL);
  const answer = await asked;
  assert.equal(answer.dataUrl, PIXEL);
  assert.equal(broker.pending(), 0);
});

test('a canvas that is asked twice does not render the same job twice', async () => {
  const broker = createSnapshotBroker({ unref: false, waitMs: 500 });
  const asked = broker.request({ boardId: 'b1' });
  const first = await broker.next(1000);
  const second = await broker.next(50);
  assert.equal(second, null, 'a claimed job is not handed out again');
  broker.fulfill(first.jobId, PIXEL);
  await asked;
});

test('an agent with no open canvas is told so instead of hanging forever', async () => {
  const broker = createSnapshotBroker({ unref: false, waitMs: 60 });
  const started = Date.now();
  const answer = await broker.request({ boardId: 'b1', waitMs: 60 });
  assert.equal(answer, null);
  assert.ok(Date.now() - started >= 50);
  assert.equal(broker.pending(), 0);
});

test('a region is passed through, and nonsense is dropped', async () => {
  const broker = createSnapshotBroker({ unref: false, waitMs: 500 });
  broker.request({ boardId: 'b1', region: { x: 10, y: 20, w: 300, h: 200 } });
  const job = await broker.next(1000);
  assert.deepEqual(job.region, { x: 10, y: 20, w: 300, h: 200 });

  const second = createSnapshotBroker({ unref: false, waitMs: 500 });
  second.request({ boardId: 'b1', region: { x: 0, y: 0, w: 0, h: 0 } });
  const bad = await second.next(1000);
  assert.equal(bad.region, null);
});

test('a scale outside the useful range is clamped', async () => {
  const broker = createSnapshotBroker({ unref: false, waitMs: 500 });
  broker.request({ boardId: 'b1', scale: 99 });
  const job = await broker.next(1000);
  assert.equal(job.scale, 3);
});

test('fulfilling an unknown job is refused, not swallowed', () => {
  const broker = createSnapshotBroker({ unref: false, waitMs: 100 });
  assert.equal(broker.fulfill('nope', PIXEL), false);
  assert.equal(broker.fulfill('nope', 'not an image'), false);
});

test('closing a board releases the agent waiting on it', async () => {
  const broker = createSnapshotBroker({ unref: false, waitMs: 2000 });
  const asked = broker.request({ boardId: 'b1', waitMs: 2000 });
  broker.dropBoard('b1');
  assert.equal(await asked, null);
  assert.equal(broker.pending(), 0);
});

test('a data URL becomes bytes only when it really is an image', () => {
  const png = dataUrlBytes(PIXEL);
  assert.equal(png.type, 'png');
  assert.ok(png.bytes.length > 10);
  assert.equal(dataUrlBytes('data:text/plain;base64,aGk='), null);
  assert.equal(dataUrlBytes('data:image/png,notbase64'), null);
  assert.equal(dataUrlBytes(''), null);
});
