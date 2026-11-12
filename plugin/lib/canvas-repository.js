import { randomUUID } from 'node:crypto';
import { applyOps, diffDocument } from './canvas-ops.js';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import {
  CANVAS_VERSION,
  createEmptyCanvas,
  normalizeCanvasDocument,
  normalizeCanvasId,
  normalizeCanvasTitle,
} from './canvas-domain.js';

const STORE_VERSION = 1;
// Enough versions to undo a bad afternoon, few enough that a board file does
// not grow without bound: each entry keeps a full copy of the scene.
const HISTORY_LIMIT = 20;

function failure(message, code = 'REPOSITORY_ERROR', options) {
  const error = new Error(message, options);
  error.code = code;
  return error;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Write the canvas store atomically.
 *
 * This intentionally repeats the implementation in `lib/repository.js`
 * instead of sharing it: that helper is private to the note store, and the
 * canvas store is a separate file with its own lifecycle, so coupling the
 * two would drag the note repository's contract along with it.
 */
async function atomicWrite(filePath, state) {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporary = resolve(directory, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filePath);

    let directoryHandle;
    try {
      directoryHandle = await open(directory, 'r');
      await directoryHandle.sync();
    } finally {
      await directoryHandle?.close();
    }
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

function validateStore(payload) {
  if (!isObject(payload)) throw failure('Canvas store payload must be an object', 'INVALID_STORE');
  if (payload.version !== STORE_VERSION) {
    throw failure(`Unsupported canvas store version: ${payload.version}`, 'UNSUPPORTED_STORE_VERSION');
  }
  if (!Array.isArray(payload.canvases)) {
    throw failure('Canvas store canvases must be an array', 'INVALID_STORE');
  }
  const ids = new Set();
  const canvases = payload.canvases.map((canvas, index) => {
    try {
      const valid = normalizeCanvasDocument(canvas);
      if (ids.has(valid.id)) throw failure(`Duplicate canvas id: ${valid.id}`, 'DUPLICATE_CANVAS_ID');
      ids.add(valid.id);
      return valid;
    } catch (cause) {
      if (cause.code === 'DUPLICATE_CANVAS_ID') throw cause;
      throw failure(`Invalid canvas at index ${index}: ${cause.message}`, 'INVALID_STORE', { cause });
    }
  });
  return { version: STORE_VERSION, canvases };
}

async function loadStore(filePath) {
  let source;
  try {
    source = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      const empty = { version: STORE_VERSION, canvases: [] };
      await atomicWrite(filePath, empty);
      return empty;
    }
    throw failure(`Cannot read canvas store: ${error.message}`, 'STORE_READ_ERROR', { cause: error });
  }
  let payload;
  try {
    payload = JSON.parse(source);
  } catch (cause) {
    throw failure(`Corrupt canvas store: invalid JSON (${cause.message})`, 'CORRUPT_STORE', { cause });
  }
  return validateStore(payload);
}

/**
 * Open the canvas store.
 *
 * The store keeps every board in one file, `canvases.json`, and behaves
 * like the note repository: atomic writes, one serial queue for mutations,
 * and reads that wait for the queue tail so they observe the newest
 * committed state.
 *
 * @param {{ filePath: string, now?: () => number|Date, id?: () => string }} options
 * @returns {Promise<{ list: Function, load: Function, create: Function, save: Function, delete: Function, close: Function }>}
 */
export async function openCanvasRepository(options = {}) {
  if (!isObject(options) || typeof options.filePath !== 'string' || !options.filePath.trim()) {
    throw failure('openCanvasRepository requires a non-empty filePath', 'INVALID_OPTIONS');
  }
  const now = options.now ?? Date.now;
  const id = options.id ?? randomUUID;
  if (typeof now !== 'function') throw failure('now must be a function', 'INVALID_OPTIONS');
  if (typeof id !== 'function') throw failure('id must be a function', 'INVALID_OPTIONS');
  const filePath = resolve(options.filePath.trim());
  let state = await loadStore(filePath);
  // Versions live beside the board file: the store itself keeps one current
  // document, and a version is a copy taken just before a save replaced it.
  const historyPath = `${filePath}.history.json`;
  let tail = Promise.resolve();
  let closing = false;
  let closePromise;

  function readNow() {
    const value = now();
    const result = value instanceof Date ? value.getTime() : value;
    if (!Number.isSafeInteger(result) || result < 0) {
      throw failure('now() must return a non-negative integer timestamp or Date', 'INVALID_CLOCK');
    }
    return result;
  }

  function createId() {
    const value = id();
    if (typeof value !== 'string' || !value.trim()) {
      throw failure('id() must return a non-empty string', 'INVALID_ID_GENERATOR');
    }
    return normalizeCanvasId(value);
  }

  function assertOpen() {
    if (closing) throw failure('Canvas repository is closed', 'REPOSITORY_CLOSED');
  }

  /** Read the version table; a missing or broken file is simply empty. */
  async function loadHistory() {
    try {
      const raw = await readFile(historyPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (isObject(parsed) && isObject(parsed.entries)) return { version: 1, entries: parsed.entries };
    } catch {
      // No history yet, or the file is unreadable: versions start empty.
    }
    return { version: 1, entries: {} };
  }

  /**
   * Record a version as the change that produced it.
   *
   * A version used to be a copy of the whole board: forty of them made the
   * history file bigger than the board itself. A version is now the ops that
   * turn the version before it into this one, which is what the board changed
   * by. The first version of a board is still a snapshot, because there is
   * nothing before it to be a difference from.
   */
  function pushVersion(history, canvasId, canvas, previous) {
    const list = Array.isArray(history.entries[canvasId]) ? history.entries[canvasId] : [];
    // The version history is only ever applied forwards, so the ops do not
    // carry the values they replace: on a board that was re-imported whole,
    // that halves what the history file costs.
    const ops = previous
      ? diffDocument(previous.nodes, canvas.nodes, { inverse: false })
      : null;
    const entry = {
      id: createId(),
      at: canvas.updatedAt,
      title: canvas.title,
      nodeCount: canvas.nodes.length,
    };
    if (ops) {
      entry.ops = ops;
      entry.edgeOps = diffDocument(previous.edges, canvas.edges);
      entry.tokens = clone(canvas.tokens);
    } else {
      // The first version has nothing to be a difference from, so it is the
      // whole board. Later versions are differences from it.
      entry.nodes = clone(canvas.nodes);
      entry.edges = clone(canvas.edges);
      entry.tokens = clone(canvas.tokens);
      entry.base = true;
    }
    list.push(entry);
    history.entries[canvasId] = list.slice(-HISTORY_LIMIT);
    return entry;
  }

  /**
   * Push the board as it is now, as the next version.
   *
   * The board that was replaced is the version before this one: the history
   * reads as the sequence of boards the file went through.
   */
  function pushSavedVersion(history, canvasId, canvas, previousNodes) {
    return pushVersion(history, canvasId, canvas, previousNodes ? { nodes: previousNodes } : null);
  }

  /**
   * The board a version holds.
   *
   * A version that carries ops is applied to the version before it; the first
   * version carries the whole board.
   */
  function nodesOfVersion(list, index) {
    const entry = list[index];
    if (!entry) return [];
    if (entry.base || !entry.ops) return entry.nodes ?? [];
    const previous = nodesOfVersion(list, index - 1);
    return applyOps(previous, entry.ops);
  }

  function edgesOfVersion(list, index) {
    const entry = list[index];
    if (!entry) return [];
    if (entry.base || !entry.edgeOps) return entry.edges ?? [];
    const previous = edgesOfVersion(list, index - 1);
    return applyOps(previous, entry.edgeOps);
  }

  function mutate(callback) {
    assertOpen();
    const run = tail.then(async () => {
      const draft = clone(state);
      const result = await callback(draft);
      await atomicWrite(filePath, draft);
      state = draft;
      return clone(result);
    });
    tail = run.then(() => undefined, () => undefined);
    return run;
  }

  async function read(callback) {
    assertOpen();
    await tail;
    return clone(callback(state));
  }

  function findCanvas(canvases, canvasId) {
    const canvas = canvases.find(({ id: candidate }) => candidate === canvasId);
    if (!canvas) throw failure(`Canvas not found: ${canvasId}`, 'CANVAS_NOT_FOUND');
    return canvas;
  }

  /** List every stored board, in store order. */
  async function list() {
    return read((current) => current.canvases);
  }

  /** Load one board, or reject when it does not exist. */
  async function load(canvasId) {
    const idToLoad = normalizeCanvasId(canvasId);
    return read((current) => findCanvas(current.canvases, idToLoad));
  }

  /** Create an empty board with a generated id. */
  async function create(input = {}) {
    if (!isObject(input)) throw failure('Create input must be an object', 'INVALID_INPUT');
    const title = normalizeCanvasTitle(input.title);
    return mutate((draft) => {
      const canvasId = createId();
      if (draft.canvases.some(({ id: candidate }) => candidate === canvasId)) {
        throw failure(`Duplicate canvas id: ${canvasId}`, 'DUPLICATE_CANVAS_ID');
      }
      const createdAt = readNow();
      const canvas = createEmptyCanvas({ id: canvasId, title, now: createdAt });
      draft.canvases.push(canvas);
      return canvas;
    });
  }

  /**
   * Replace one board with the document it is given.
   *
   * Everything the caller omits is kept: a save that only moves a title must
   * not silently empty a board, and a partial writer that forgets `edges`
   * must not delete every connector. `createdAt` is never taken from the
   * client and `updatedAt` follows the clock.
   */
  async function save(canvasId, input = {}) {
    const idToSave = normalizeCanvasId(canvasId);
    if (!isObject(input)) throw failure('Save input must be an object', 'INVALID_INPUT');
    return mutate(async (draft) => {
      const index = draft.canvases.findIndex(({ id: candidate }) => candidate === idToSave);
      if (index < 0) throw failure(`Canvas not found: ${idToSave}`, 'CANVAS_NOT_FOUND');
      const current = draft.canvases[index];
      const canvas = normalizeCanvasDocument({
        version: CANVAS_VERSION,
        id: current.id,
        title: input.title === undefined ? current.title : input.title,
        starred: input.starred === undefined ? current.starred : input.starred,
        createdAt: current.createdAt,
        updatedAt: readNow(),
        camera: input.camera === undefined ? current.camera : input.camera,
        // Tokens outlive a scene write the same way a title does: a save that
        // does not carry them keeps the ones the board already had.
        tokens: input.tokens === undefined ? current.tokens : input.tokens,
        // Omitted lists keep the current ones: dropping a field is a mistake,
        // not a request to delete the board's content.
        nodes: input.nodes === undefined ? current.nodes : input.nodes,
        edges: input.edges === undefined ? current.edges : input.edges,
        // Saving the scene never touches the discussion: comments have their
        // own methods, so a scene write can neither add nor drop one.
        comments: current.comments ?? [],
      });
      // Each save keeps the document it replaced, so the history reads as the
      // sequence of boards the file went through. A version after the first
      // is the difference from the version before it, which is what the
      // previous board looked like.
      const versions = await loadHistory();
      const list = Array.isArray(versions.entries[idToSave]) ? versions.entries[idToSave] : [];
      const previous = list.length ? nodesOfVersion(list, list.length - 1) : null;
      pushVersion(versions, idToSave, current, previous ? { nodes: previous } : null);
      await atomicWrite(historyPath, versions);
      draft.canvases[index] = canvas;
      return canvas;
    });
  }

  /** The versions of one board, newest last, without their node payloads. */
  async function history(canvasId) {
    const idToRead = normalizeCanvasId(canvasId);
    await read((draft) => findCanvas(draft.canvases, idToRead));
    const stored = await loadHistory();
    const list = Array.isArray(stored.entries[idToRead]) ? stored.entries[idToRead] : [];
    return list.map(({ id: versionId, at, title, nodeCount }) => ({ id: versionId, at, title, nodeCount }));
  }

  /** Put one stored version back, keeping the current state as a version too. */
  async function restore(canvasId, versionId) {
    const idToRestore = normalizeCanvasId(canvasId);
    if (typeof versionId !== 'string' || !versionId.trim()) {
      throw failure('restore needs a version id', 'INVALID_INPUT');
    }
    return mutate(async (draft) => {
      const index = draft.canvases.findIndex(({ id: candidate }) => candidate === idToRestore);
      if (index < 0) throw failure(`Canvas not found: ${idToRestore}`, 'CANVAS_NOT_FOUND');
      const current = draft.canvases[index];
      const stored = await loadHistory();
      const list = Array.isArray(stored.entries[idToRestore]) ? stored.entries[idToRestore] : [];
      const snapshot = list.find(({ id: candidate }) => candidate === versionId);
      if (!snapshot) throw failure(`That version is not on this board: ${versionId}`, 'VERSION_NOT_FOUND');
      const currentList = Array.isArray(stored.entries[idToRestore]) ? stored.entries[idToRestore] : [];
      const currentNodes = currentList.length ? nodesOfVersion(currentList, currentList.length - 1) : current.nodes;
      pushVersion(stored, idToRestore, current, { nodes: currentNodes });
      await atomicWrite(historyPath, stored);
      const versionIndex = list.findIndex(({ id: candidate }) => candidate === versionId);
      const canvas = normalizeCanvasDocument({
        version: CANVAS_VERSION,
        id: current.id,
        title: snapshot.title === undefined ? current.title : snapshot.title,
        starred: current.starred,
        createdAt: current.createdAt,
        updatedAt: readNow(),
        camera: current.camera,
        tokens: snapshot.tokens === undefined ? current.tokens : snapshot.tokens,
        nodes: nodesOfVersion(list, versionIndex),
        edges: edgesOfVersion(list, versionIndex),
        comments: current.comments ?? [],
      });
      draft.canvases[index] = canvas;
      return canvas;
    });
  }

  /**
   * Add one comment to a board.
   *
   * Comments have methods of their own so that saving the scene — which is a
   * whole-document replacement — can never delete a discussion by accident.
   */
  async function addComment(canvasId, input = {}) {
    const idToEdit = normalizeCanvasId(canvasId);
    if (!isObject(input)) throw failure('Comment input must be an object', 'INVALID_INPUT');
    return mutate((draft) => {
      const index = draft.canvases.findIndex(({ id: candidate }) => candidate === idToEdit);
      if (index < 0) throw failure(`Canvas not found: ${idToEdit}`, 'CANVAS_NOT_FOUND');
      const current = draft.canvases[index];
      const previous = current.comments ?? [];
      if (previous.length >= 500) {
        throw failure('This board cannot hold more than 500 comments', 'INVALID_COMMENT');
      }
      const commentId = createId();
      if (previous.some(({ id: candidate }) => candidate === commentId)) {
        throw failure(`Duplicate comment id: ${commentId}`, 'INVALID_CANVAS');
      }
      const createdAt = readNow();
      const canvas = normalizeCanvasDocument({
        ...clone(current),
        comments: [...clone(previous), {
          id: commentId,
          nodeId: input.nodeId,
          x: input.x,
          y: input.y,
          body: input.body,
          resolved: false,
          createdAt,
        }],
        updatedAt: createdAt,
      });
      draft.canvases[index] = canvas;
      return canvas;
    });
  }

  /** Mark one comment resolved or open again. */
  async function resolveComment(canvasId, commentId, resolved) {
    const idToEdit = normalizeCanvasId(canvasId);
    if (typeof resolved !== 'boolean') throw failure('resolved must be a boolean', 'INVALID_INPUT');
    return mutate((draft) => {
      const index = draft.canvases.findIndex(({ id: candidate }) => candidate === idToEdit);
      if (index < 0) throw failure(`Canvas not found: ${idToEdit}`, 'CANVAS_NOT_FOUND');
      const current = draft.canvases[index];
      const previous = current.comments ?? [];
      const at = previous.findIndex(({ id: candidate }) => candidate === commentId);
      if (at < 0) throw failure(`Comment not found: ${commentId}`, 'COMMENT_NOT_FOUND');
      if (previous[at].resolved === resolved) return clone(current);
      const comments = [...clone(previous)];
      comments[at] = { ...comments[at], resolved };
      const canvas = normalizeCanvasDocument({ ...clone(current), comments, updatedAt: readNow() });
      draft.canvases[index] = canvas;
      return canvas;
    });
  }

  /** Remove one comment. */
  async function deleteComment(canvasId, commentId) {
    const idToEdit = normalizeCanvasId(canvasId);
    return mutate((draft) => {
      const index = draft.canvases.findIndex(({ id: candidate }) => candidate === idToEdit);
      if (index < 0) throw failure(`Canvas not found: ${idToEdit}`, 'CANVAS_NOT_FOUND');
      const current = draft.canvases[index];
      const previous = current.comments ?? [];
      if (!previous.some(({ id: candidate }) => candidate === commentId)) {
        throw failure(`Comment not found: ${commentId}`, 'COMMENT_NOT_FOUND');
      }
      const canvas = normalizeCanvasDocument({
        ...clone(current),
        comments: previous.filter(({ id: candidate }) => candidate !== commentId).map((comment) => clone(comment)),
        updatedAt: readNow(),
      });
      draft.canvases[index] = canvas;
      return canvas;
    });
  }

  /**
   * Star or unstar one board.
   *
   * This is a metadata write, kept apart from `save` the way `pin` is kept
   * apart from `update` for notes: the scene document must not be replaced
   * to change one flag.
   */
  async function setStarred(canvasId, starred) {
    const idToStar = normalizeCanvasId(canvasId);
    if (typeof starred !== 'boolean') throw failure('starred must be a boolean', 'INVALID_INPUT');
    return mutate((draft) => {
      const index = draft.canvases.findIndex(({ id: candidate }) => candidate === idToStar);
      if (index < 0) throw failure(`Canvas not found: ${idToStar}`, 'CANVAS_NOT_FOUND');
      const current = draft.canvases[index];
      if (current.starred === starred) return current;
      draft.canvases[index] = { ...current, starred, updatedAt: readNow() };
      return draft.canvases[index];
    });
  }

  /** Remove one board, or reject when it does not exist. */
  async function deleteCanvas(canvasId) {
    const idToDelete = normalizeCanvasId(canvasId);
    return mutate((draft) => {
      const index = draft.canvases.findIndex(({ id: candidate }) => candidate === idToDelete);
      if (index < 0) throw failure(`Canvas not found: ${idToDelete}`, 'CANVAS_NOT_FOUND');
      draft.canvases.splice(index, 1);
      return { deleted: true, id: idToDelete };
    });
  }

  function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = tail.then(() => undefined);
    return closePromise;
  }

  return {
    list,
    load,
    create,
    save,
    history,
    restore,
    setStarred,
    addComment,
    resolveComment,
    deleteComment,
    delete: deleteCanvas,
    close,
  };
}
