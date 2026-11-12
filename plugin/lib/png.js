/**
 * Reading a PNG into pixels.
 *
 * The comparison of two pictures needs the pixels of both, and the pictures
 * are PNG files on disk. The Host has no canvas to draw on, so the file is
 * read here: the chunks are walked, the image data is inflated, and the
 * filters are undone.
 *
 * Only what a snapshot needs is supported: eight bits per channel, the
 * colour types a canvas produces, and no interlacing. A file that uses
 * anything else is refused rather than read wrongly.
 */

import { deflateSync, inflateSync } from 'node:zlib';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The channels each colour type carries. */
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * Read a PNG into its pixels.
 *
 * Returns the width, the height and the RGBA bytes of every pixel, in the
 * order the picture stores them.
 */
export function decodePng(bytes) {
  if (!bytes || bytes.length < 8) throw new Error('That file is not a PNG');
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) throw new Error('That file is not a PNG');
  }

  let width = 0;
  let height = 0;
  let depth = 0;
  let colourType = 0;
  let interlace = 0;
  const parts = [];
  let palette = null;
  let transparency = null;

  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = readUint32(bytes, offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const start = offset + 8;
    const end = start + length;
    if (end > bytes.length) break;
    if (type === 'IHDR') {
      width = readUint32(bytes, start);
      height = readUint32(bytes, start + 4);
      depth = bytes[start + 8];
      colourType = bytes[start + 9];
      interlace = bytes[start + 12];
    } else if (type === 'PLTE') {
      palette = bytes.subarray(start, end);
    } else if (type === 'tRNS') {
      transparency = bytes.subarray(start, end);
    } else if (type === 'IDAT') {
      parts.push(bytes.subarray(start, end));
    } else if (type === 'IEND') {
      break;
    }
    offset = end + 4;
  }

  if (!width || !height) throw new Error('That PNG has no image in it');
  if (depth !== 8) throw new Error('That PNG is not eight bits per channel');
  if (interlace !== 0) throw new Error('That PNG is interlaced');
  const channels = CHANNELS[colourType];
  if (!channels) throw new Error('That PNG uses a colour type that cannot be read');

  const raw = inflateSync(Buffer.concat(parts.map((part) => Buffer.from(part))));
  const pixels = unfilter(raw, width, height, channels);
  return {
    width,
    height,
    data: toRgba(pixels, width, height, channels, colourType, palette, transparency),
  };
}

/** A four byte big-endian number. */
function readUint32(bytes, offset) {
  return ((bytes[offset] << 24) >>> 0)
    + (bytes[offset + 1] << 16)
    + (bytes[offset + 2] << 8)
    + bytes[offset + 3];
}

/**
 * Undo the filters a PNG stores its rows with.
 *
 * Each row is prefixed with the filter that was used on it, and every row
 * depends on the one above it.
 */
function unfilter(raw, width, height, channels) {
  const stride = width * channels;
  const out = new Uint8Array(stride * height);
  let source = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = raw[source];
    source += 1;
    const line = source;
    source += stride;
    const base = row * stride;
    const above = base - stride;
    for (let index = 0; index < stride; index += 1) {
      const value = raw[line + index];
      const left = index >= channels ? out[base + index - channels] : 0;
      const up = row > 0 ? out[above + index] : 0;
      const upLeft = row > 0 && index >= channels ? out[above + index - channels] : 0;
      let result = value;
      switch (filter) {
        case 0:
          break;
        case 1:
          result = value + left;
          break;
        case 2:
          result = value + up;
          break;
        case 3:
          result = value + ((left + up) >> 1);
          break;
        case 4:
          result = value + paeth(left, up, upLeft);
          break;
        default:
          throw new Error('That PNG uses a filter that cannot be read');
      }
      out[base + index] = result & 0xff;
    }
  }
  return out;
}

/** The predictor of the Paeth filter. */
function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  if (toUp <= toUpLeft) return up;
  return upLeft;
}

/**
 * The pixels as red, green, blue and alpha.
 *
 * A picture that has no alpha is opaque, and a palette is looked up.
 */
function toRgba(pixels, width, height, channels, colourType, palette, transparency) {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const source = index * channels;
    const target = index * 4;
    if (colourType === 0) {
      const grey = pixels[source];
      out[target] = grey;
      out[target + 1] = grey;
      out[target + 2] = grey;
      out[target + 3] = 255;
    } else if (colourType === 2) {
      out[target] = pixels[source];
      out[target + 1] = pixels[source + 1];
      out[target + 2] = pixels[source + 2];
      out[target + 3] = 255;
    } else if (colourType === 3) {
      const entry = pixels[source] * 3;
      out[target] = palette ? palette[entry] : 0;
      out[target + 1] = palette ? palette[entry + 1] : 0;
      out[target + 2] = palette ? palette[entry + 2] : 0;
      out[target + 3] = transparency && pixels[source] < transparency.length
        ? transparency[pixels[source]]
        : 255;
    } else if (colourType === 4) {
      const grey = pixels[source];
      out[target] = grey;
      out[target + 1] = grey;
      out[target + 2] = grey;
      out[target + 3] = pixels[source + 1];
    } else {
      out[target] = pixels[source];
      out[target + 1] = pixels[source + 1];
      out[target + 2] = pixels[source + 2];
      out[target + 3] = pixels[source + 3];
    }
  }
  return out;
}

/**
 * Write a picture as a PNG.
 *
 * The difference picture of two snapshots is written this way, so a person
 * can open it and see what moved.
 */
export function encodePng({ width, height, data }) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let source = 0;
  for (let row = 0; row < height; row += 1) {
    const base = row * (width * 4 + 1);
    raw[base] = 0;
    for (let index = 0; index < width * 4; index += 1) {
      raw[base + 1 + index] = data[source + index] & 0xff;
    }
    source += width * 4;
  }
  const chunks = [Buffer.from(PNG_SIGNATURE)];
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  chunks.push(chunk('IHDR', header));
  chunks.push(chunk('IDAT', deflateSync(raw)));
  chunks.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

/** A PNG chunk: its length, its type and its bytes. */
function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
}

/** The checksum a PNG chunk carries. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** The checksum of a buffer, as the PNG format defines it. */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
