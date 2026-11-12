import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { decodePng, encodePng } from '../lib/png.js';

const fixture = fileURLToPath(new URL('./fixtures/board.png', import.meta.url));

test('a picture survives the round trip through the encoder', () => {
  const width = 40;
  const height = 24;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = (index * 7) % 256;
    data[index * 4 + 1] = (index * 13) % 256;
    data[index * 4 + 2] = (index * 29) % 256;
    data[index * 4 + 3] = 255;
  }
  const decoded = decodePng(encodePng({ width, height, data }));
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  assert.deepEqual(Array.from(decoded.data), Array.from(data), 'every pixel comes back');
});

test('a picture written by another tool is read correctly', async () => {
  // The fixtures were written by a tool that is not this one: a decoder that
  // only understands its own pictures would pass the round trip above and
  // fail on every real snapshot.
  const bytes = await readFile(fixture);
  const decoded = decodePng(bytes);
  assert.ok(decoded.width > 100, 'the picture has a width');
  assert.ok(decoded.height > 100, 'the picture has a height');
  assert.equal(decoded.data.length, decoded.width * decoded.height * 4);

  // The picture has to have real content: a decoder that returns one flat
  // colour would pass the size checks and be useless.
  const seen = new Set();
  for (let index = 0; index < decoded.data.length; index += 61) seen.add(decoded.data[index]);
  assert.ok(seen.size > 20, 'the picture has more than a few colours');
});

test('a file that is not a PNG is refused', () => {
  assert.throws(() => decodePng(Buffer.from('not a picture at all')), /not a PNG/);
  assert.throws(() => decodePng(Buffer.alloc(0)), /not a PNG/);
});
