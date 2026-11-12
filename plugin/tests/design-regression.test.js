import test from 'node:test';
import assert from 'node:assert/strict';

import { changedShare, comparePictures, differenceImage, ssim } from '../lib/design-regression.js';

/** A picture of one colour. */
function picture(width, height, value = 128) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = value;
    data[i * 4 + 1] = value;
    data[i * 4 + 2] = value;
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

/** A copy of a picture with a rectangle painted on it. */
function withRect(base, x, y, w, h, value = 255) {
  const data = new Uint8ClampedArray(base.data);
  for (let row = y; row < y + h; row += 1) {
    for (let column = x; column < x + w; column += 1) {
      const index = (row * base.width + column) * 4;
      data[index] = value;
      data[index + 1] = value;
      data[index + 2] = value;
    }
  }
  return { width: base.width, height: base.height, data };
}

test('a picture compared with itself is the same', () => {
  const image = picture(32, 32);
  assert.equal(ssim(image, image), 1, 'the score is exactly one');
  assert.equal(changedShare(image, image), 0, 'nothing changed');
});

test('two pictures of one flat colour are the same', () => {
  const first = picture(32, 32, 100);
  const second = picture(32, 32, 100);
  assert.ok(ssim(first, second) > 0.999, 'the same flat colour scores the same');
});

test('a picture that differs everywhere is different', () => {
  const first = picture(32, 32, 0);
  const second = picture(32, 32, 255);
  const score = ssim(first, second);
  assert.ok(score < 0.5, 'black and white are not alike');
  assert.equal(changedShare(first, second), 1, 'every pixel changed');
});

test('a box that moved shows up as a change where it is', () => {
  const base = picture(64, 64, 240);
  const first = withRect(base, 10, 10, 12, 12);
  const second = withRect(base, 30, 30, 12, 12);
  const changed = changedShare(first, second);
  assert.ok(changed > 0, 'the change is seen');
  assert.ok(changed < 0.2, 'and only the part that moved changed');
});

test('the difference picture marks what changed', () => {
  const base = picture(32, 32, 240);
  const first = withRect(base, 8, 8, 8, 8);
  const second = withRect(base, 20, 20, 8, 8);
  const difference = differenceImage(first, second);
  assert.equal(difference.width, 32);
  assert.equal(difference.height, 32);
  // The corner that only the first picture has is marked.
  const index = (8 * 32 + 8) * 4;
  assert.ok(difference.data[index] < 255, 'the old box is marked');
  // A place neither picture has is not.
  const quiet = (2 * 32 + 2) * 4;
  assert.equal(difference.data[quiet], 255, 'the background is not marked');
});

test('the comparison gives a verdict a person can read', () => {
  const base = picture(48, 48, 240);
  const same = comparePictures(base, picture(48, 48, 240));
  assert.equal(same.verdict, 'the same');
  assert.equal(same.same, true);

  const changed = comparePictures(withRect(base, 5, 5, 10, 10), withRect(base, 25, 25, 10, 10));
  assert.notEqual(changed.verdict, 'the same');
  assert.ok(changed.changed > 0, 'and it says how much changed');
});

test('a real picture tells a moved box from an unchanged one', async () => {
  // The pictures above are made of flat colour, which is the easy case. This
  // one is a picture another tool wrote, with a box that moved.
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { decodePng } = await import('../lib/png.js');
  const fixture = fileURLToPath(new URL('./fixtures/board.png', import.meta.url));
  const base = decodePng(await readFile(fixture));
  const width = base.width;

  const same = comparePictures(base, base);
  assert.equal(same.verdict, 'the same', 'a picture is the same as itself');

  // The accent box in the fixture moves eight pixels to the right.
  const moved = { width: base.width, height: base.height, data: new Uint8ClampedArray(base.data) };
  for (let y = 40; y < 200; y += 1) {
    for (let x = 40; x < 300; x += 1) {
      const index = (y * width + x) * 4;
      moved.data[index] = 248;
      moved.data[index + 1] = 250;
      moved.data[index + 2] = 252;
      moved.data[index + 3] = 255;
    }
  }
  for (let y = 40; y < 200; y += 1) {
    for (let x = 48; x < 308; x += 1) {
      const index = (y * width + x) * 4;
      moved.data[index] = 99;
      moved.data[index + 1] = 91;
      moved.data[index + 2] = 255;
      moved.data[index + 3] = 255;
    }
  }
  const changed = comparePictures(base, moved);
  assert.notEqual(changed.verdict, 'the same', 'a moved box is a change');
  assert.ok(changed.changed > 0.01, 'and a measurable part of the picture changed');
  assert.ok(changed.score < 0.99, 'the structure is no longer the same');
});

test('pictures of different sizes are compared over the part they share', () => {
  const first = picture(32, 32, 128);
  const second = picture(48, 48, 128);
  assert.ok(ssim(first, second) > 0.999, 'the shared part is the same');
});
