import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Images and SVGs a board holds.
 *
 * A board document is saved as a whole on every change, so a picture cannot
 * live inside it: one screenshot would make every autosave rewrite megabytes.
 * The bytes are kept in files of their own and the node only carries an id.
 */

export const ASSET_ROUTE = '/api/moments-notes/asset';

const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const ASSET_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['image/svg+xml', 'svg'],
]);

/** The extension a stored asset has, from its media type. */
export function assetExtension(type) {
  return TYPES.get(String(type ?? '').toLowerCase()) ?? null;
}

/** The media type of a stored asset, from its extension. */
export function assetContentType(extension) {
  for (const [type, ext] of TYPES) {
    if (ext === extension) return type;
  }
  return 'application/octet-stream';
}

/** An asset id is a generated UUID and nothing else, so it cannot escape the folder. */
export function isAssetId(value) {
  return typeof value === 'string' && ASSET_ID_PATTERN.test(value);
}

function failure(message, code = 'INVALID_ASSET') {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Read a data URL into its bytes.
 *
 * The clipboard hands pictures over as a data URL; everything downstream works
 * on bytes, so the conversion happens once, at the door.
 */
export function dataUrlToBytes(dataUrl) {
  if (typeof dataUrl !== 'string') throw failure('The image must be passed as a data URL');
  const match = /^data:([^;,]+)(?:;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) throw failure('The image is not a data URL');
  const type = match[1].toLowerCase();
  if (!TYPES.has(type)) {
    throw failure('Only PNG, JPEG, WebP, GIF and SVG images are supported');
  }
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length === 0) throw failure('The image is empty');
  if (bytes.length > MAX_ASSET_BYTES) {
    throw failure('An image must be 10 MB or smaller');
  }
  return { bytes, type };
}

/**
 * Open the asset folder.
 *
 * @param {{ directory: string, id?: () => string }} options
 * @returns {{ save: Function, read: Function, remove: Function }}
 */
export async function openAssetStore(options = {}) {
  if (!options || typeof options.directory !== 'string' || !options.directory.trim()) {
    throw failure('openAssetStore requires a directory', 'INVALID_OPTIONS');
  }
  const directory = options.directory;
  const id = options.id ?? randomUUID;
  await mkdir(directory, { recursive: true });

  function pathOf(assetId, extension) {
    if (!isAssetId(assetId)) throw failure('Unknown asset', 'ASSET_NOT_FOUND');
    return join(directory, `${assetId}.${extension}`);
  }

  /** Store the bytes of one image and return the id and media type. */
  async function save(input = {}) {
    const { bytes, type } = dataUrlToBytes(input.dataUrl);
    const assetId = String(id()).toLowerCase();
    if (!isAssetId(assetId)) throw failure('id() must return a UUID', 'INVALID_ID_GENERATOR');
    await writeFile(pathOf(assetId, assetExtension(type)), bytes, { mode: 0o600 });
    return { assetId, type, size: bytes.length, name: typeof input.name === 'string' ? input.name.slice(0, 200) : '' };
  }

  /**
   * Store raw bytes, for callers that already hold them.
   *
   * An import reads pixels and SVG straight out of the source file, so it
   * never needs the data-URL round trip the clipboard path uses.
   */
  async function saveBytes(bytes, type, name) {
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
      throw failure('The image is empty');
    }
    if (!TYPES.has(String(type ?? '').toLowerCase())) {
      throw failure('Only PNG, JPEG, WebP, GIF and SVG images are supported');
    }
    if (bytes.length > MAX_ASSET_BYTES) throw failure('An image must be 10 MB or smaller');
    const assetId = String(id()).toLowerCase();
    if (!isAssetId(assetId)) throw failure('id() must return a UUID', 'INVALID_ID_GENERATOR');
    const extension = assetExtension(type);
    await writeFile(pathOf(assetId, extension), bytes, { mode: 0o600 });
    return { assetId, type, size: bytes.length, name: typeof name === 'string' ? name.slice(0, 200) : '' };
  }

  /** Read one stored image back. */
  async function read(assetId, extension) {
    const wanted = assetExtension(extension) ?? String(extension ?? '');
    if (!wanted) throw failure('Unknown asset', 'ASSET_NOT_FOUND');
    try {
      const bytes = await readFile(pathOf(assetId, wanted));
      return { bytes, type: assetContentType(wanted) };
    } catch (error) {
      if (error.code === 'ENOENT') throw failure('Unknown asset', 'ASSET_NOT_FOUND');
      throw error;
    }
  }

  /** Remove one stored image; a missing file is not an error. */
  async function remove(assetId, extension) {
    const wanted = assetExtension(extension) ?? String(extension ?? '');
    if (!wanted) return;
    await unlink(pathOf(assetId, wanted)).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  /**
   * Remove every file of one asset, whatever extension it was stored under.
   *
   * A node carries only the id, so the cleanup of a deleted board cannot ask
   * the file system for one exact name.
   */
  async function removeAny(assetId) {
    if (!isAssetId(assetId)) return;
    const files = await readdir(directory).catch(() => []);
    await Promise.all(files
      .filter((file) => file.startsWith(`${assetId}.`))
      .map((file) => unlink(join(directory, file)).catch(() => {})));
  }

  return { save, saveBytes, read, remove, removeAny, directory, maxBytes: MAX_ASSET_BYTES };
}

/**
 * Serve one asset over the authenticated route.
 *
 * The media type comes from the extension the caller asks for, so a stored
 * SVG is served as an SVG and a screenshot as a PNG.
 */
export function createAssetHandler(store) {
  return async function handle(request) {
    const url = new URL(request.url);
    const assetId = url.searchParams.get('id') ?? '';
    const extension = url.searchParams.get('ext') ?? '';
    if (!isAssetId(assetId)) {
      return new Response('Unknown asset', { status: 404, headers: { 'cache-control': 'no-store' } });
    }
    try {
      const asset = await store.read(assetId, extension);
      return new Response(asset.bytes, {
        status: 200,
        headers: {
          'content-type': asset.type,
          // An asset id never changes its bytes, so it can be cached hard.
          'cache-control': 'private, max-age=31536000, immutable',
        },
      });
    } catch {
      return new Response('Unknown asset', { status: 404, headers: { 'cache-control': 'no-store' } });
    }
  };
}
