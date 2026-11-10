import test from 'node:test';
import assert from 'node:assert/strict';

import { disposePluginResources } from '../lib/lifecycle.js';

test('plugin disposal attempts every resource and awaits repository close after failures', async () => {
  const calls = [];
  const dispose = disposePluginResources([
    async () => { calls.push('route'); throw new Error('route failed'); },
    () => { calls.push('tool'); throw new Error('tool failed'); },
    async () => { await new Promise((resolve) => setTimeout(resolve, 5)); calls.push('closed'); },
  ]);
  await assert.rejects(dispose, (error) => {
    assert.equal(error.errors.length, 2);
    return true;
  });
  assert.deepEqual(calls, ['route', 'tool', 'closed']);
});
