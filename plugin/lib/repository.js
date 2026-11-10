import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import {
  buildHeatmap,
  buildTagIndex,
  computeStats,
  filterNotes,
  normalizeAttachments,
  normalizeContent,
  relatedNotes,
  reviewNotes,
  sortNotes,
  validateNote,
} from './domain.js';

const STORE_VERSION = 1;
const MAX_IMPORT_NOTES = 50_000;
const MAX_LIST_LIMIT = 500;
const MAX_REVIEW_LIMIT = 50;
export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

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

function requireId(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw failure('Note id must be a non-empty string', 'INVALID_NOTE_ID');
  }
  return value.trim();
}

function validateStore(payload) {
  if (!isObject(payload)) throw failure('Store payload must be an object', 'INVALID_STORE');
  if (payload.version !== STORE_VERSION) {
    throw failure(`Unsupported store version: ${payload.version}`, 'UNSUPPORTED_STORE_VERSION');
  }
  if (!Array.isArray(payload.notes)) throw failure('Store notes must be an array', 'INVALID_STORE');
  if (payload.notes.length > MAX_IMPORT_NOTES) throw failure('Store contains too many notes', 'INVALID_STORE');
  const ids = new Set();
  const notes = payload.notes.map((note, index) => {
    try {
      const valid = validateNote(note);
      if (ids.has(valid.id)) throw failure(`Duplicate note id: ${valid.id}`, 'DUPLICATE_NOTE_ID');
      ids.add(valid.id);
      return valid;
    } catch (cause) {
      if (cause.code === 'DUPLICATE_NOTE_ID') throw cause;
      throw failure(`Invalid note at index ${index}: ${cause.message}`, 'INVALID_STORE', { cause });
    }
  });
  return { version: STORE_VERSION, notes };
}

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

async function loadStore(filePath) {
  let source;
  try {
    source = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      const empty = { version: STORE_VERSION, notes: [] };
      await atomicWrite(filePath, empty);
      return empty;
    }
    throw failure(`Cannot read note store: ${error.message}`, 'STORE_READ_ERROR', { cause: error });
  }
  let payload;
  try {
    payload = JSON.parse(source);
  } catch (cause) {
    throw failure(`Corrupt note store: invalid JSON (${cause.message})`, 'CORRUPT_STORE', { cause });
  }
  return validateStore(payload);
}

function validateImport(payload) {
  if (!isObject(payload)) throw failure('Import payload must be an object', 'INVALID_IMPORT');
  if (payload.version !== STORE_VERSION) {
    throw failure(`Unsupported import version: ${payload.version}`, 'UNSUPPORTED_IMPORT_VERSION');
  }
  if (!Array.isArray(payload.notes)) throw failure('Import notes must be an array', 'INVALID_IMPORT');
  if (payload.notes.length > MAX_IMPORT_NOTES) throw failure('Import contains too many notes', 'INVALID_IMPORT');
  const ids = new Set();
  return payload.notes.map((note, index) => {
    try {
      const valid = validateNote(note);
      if (ids.has(valid.id)) throw failure(`Duplicate note id in import: ${valid.id}`, 'DUPLICATE_NOTE_ID');
      ids.add(valid.id);
      return valid;
    } catch (cause) {
      if (cause.code === 'DUPLICATE_NOTE_ID') throw cause;
      throw failure(`Invalid imported note at index ${index}: ${cause.message}`, 'INVALID_IMPORT', { cause });
    }
  });
}

function boundedLimit(value, fallback, maximum, label = 'limit') {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw failure(`${label} must be a non-negative integer`, 'INVALID_LIMIT');
  }
  return Math.min(value, maximum);
}

export async function openRepository(options = {}) {
  if (!isObject(options) || typeof options.filePath !== 'string' || !options.filePath.trim()) {
    throw failure('openRepository requires a non-empty filePath', 'INVALID_OPTIONS');
  }
  const now = options.now ?? Date.now;
  const id = options.id ?? randomUUID;
  if (typeof now !== 'function') throw failure('now must be a function', 'INVALID_OPTIONS');
  if (typeof id !== 'function') throw failure('id must be a function', 'INVALID_OPTIONS');
  const filePath = resolve(options.filePath.trim());
  let state = await loadStore(filePath);
  let tail = Promise.resolve();
  let closing = false;
  let closePromise;
  const listeners = new Set();

  function readNow() {
    const value = now();
    const result = value instanceof Date ? value.getTime() : value;
    if (!Number.isSafeInteger(result) || result < 0) {
      throw failure('now() must return a non-negative integer timestamp or Date', 'INVALID_CLOCK');
    }
    return result;
  }

  if (state.notes.some((note) => note.deletedAt !== null)) {
    const initialThreshold = readNow() - TRASH_RETENTION_MS;
    const retainedNotes = state.notes.filter((note) => note.deletedAt === null || note.deletedAt > initialThreshold);
    if (retainedNotes.length !== state.notes.length) {
      state = { ...state, notes: retainedNotes };
      await atomicWrite(filePath, state);
    }
  }

  function createId() {
    const value = id();
    if (typeof value !== 'string' || !value.trim()) {
      throw failure('id() must return a non-empty string', 'INVALID_ID_GENERATOR');
    }
    return value.trim();
  }

  function assertOpen() {
    if (closing) throw failure('Repository is closed', 'REPOSITORY_CLOSED');
  }

  function mutate(callback) {
    assertOpen();
    const run = tail.then(async () => {
      const draft = clone(state);
      const result = await callback(draft);
      await atomicWrite(filePath, draft);
      state = draft;
      notifyChanged();
      return clone(result);
    });
    tail = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Announce every accepted write.
   *
   * The desktop float mirrors the note list, and a note may also be created
   * by the agent tool, so the change has to be announced where it happens
   * rather than only where the UI asks for it.
   */
  function subscribe(listener) {
    if (typeof listener !== 'function') throw failure('listener must be a function', 'INVALID_LISTENER');
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function notifyChanged() {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A broken listener must not fail the write that succeeded.
      }
    }
  }

  async function read(callback) {
    assertOpen();
    await tail;
    return clone(callback(state));
  }

  function findNote(notes, noteId) {
    const note = notes.find(({ id: candidate }) => candidate === noteId);
    if (!note) throw failure(`Note not found: ${noteId}`, 'NOTE_NOT_FOUND');
    return note;
  }

  async function create(input) {
    if (!isObject(input)) throw failure('Create input must be an object', 'INVALID_INPUT');
    return mutate((draft) => {
      const noteId = createId();
      if (draft.notes.some(({ id: candidate }) => candidate === noteId)) {
        throw failure(`Duplicate note id: ${noteId}`, 'DUPLICATE_NOTE_ID');
      }
      const createdAt = readNow();
      const attachments = normalizeAttachments(input.attachments, createId);
      const note = validateNote({
        id: noteId,
        content: normalizeContent(input.content, { allowBlank: attachments.length > 0 }),
        createdAt,
        updatedAt: createdAt,
        pinned: false,
        deletedAt: null,
        attachments,
      });
      draft.notes.push(note);
      return note;
    });
  }

  async function update(noteId, input) {
    const idToUpdate = requireId(noteId);
    if (!isObject(input)) throw failure('Update input must be an object', 'INVALID_INPUT');
    const unsupported = Object.keys(input).filter((key) => key !== 'content' && key !== 'attachments');
    if (unsupported.length) {
      throw failure(`Only content and attachments can be updated; immutable or unsupported fields: ${unsupported.join(', ')}`, 'INVALID_UPDATE');
    }
    return mutate((draft) => {
      const index = draft.notes.findIndex(({ id: candidate }) => candidate === idToUpdate);
      if (index < 0) throw failure(`Note not found: ${idToUpdate}`, 'NOTE_NOT_FOUND');
      const current = draft.notes[index];
      if (!Object.hasOwn(input, 'content') && !Object.hasOwn(input, 'attachments')) return current;
      const attachments = Object.hasOwn(input, 'attachments')
        ? normalizeAttachments(input.attachments, createId)
        : current.attachments;
      const note = validateNote({
        ...current,
        content: Object.hasOwn(input, 'content')
          ? normalizeContent(input.content, { allowBlank: attachments.length > 0 })
          : current.content,
        attachments,
        updatedAt: readNow(),
      });
      draft.notes[index] = note;
      return note;
    });
  }

  async function setPinned(noteId, pinned) {
    const idToUpdate = requireId(noteId);
    if (typeof pinned !== 'boolean') throw failure('pinned must be a boolean', 'INVALID_PIN');
    return mutate((draft) => {
      const current = findNote(draft.notes, idToUpdate);
      if (current.pinned === pinned) return current;
      current.pinned = pinned;
      current.updatedAt = readNow();
      return current;
    });
  }

  async function trash(noteId) {
    const idToUpdate = requireId(noteId);
    return mutate((draft) => {
      const current = findNote(draft.notes, idToUpdate);
      if (current.deletedAt !== null) return current;
      const deletedAt = readNow();
      current.deletedAt = deletedAt;
      current.updatedAt = deletedAt;
      return current;
    });
  }

  async function restore(noteId) {
    const idToUpdate = requireId(noteId);
    return mutate((draft) => {
      const current = findNote(draft.notes, idToUpdate);
      if (current.deletedAt === null) return current;
      current.deletedAt = null;
      current.updatedAt = readNow();
      return current;
    });
  }

  async function purge(noteId) {
    const idToUpdate = requireId(noteId);
    return mutate((draft) => {
      const current = findNote(draft.notes, idToUpdate);
      if (current.deletedAt === null) {
        throw failure('Move a note to trash before purging it', 'NOTE_NOT_TRASHED');
      }
      draft.notes = draft.notes.filter(({ id: candidate }) => candidate !== idToUpdate);
      return { id: idToUpdate, purged: true };
    });
  }

  async function list(filters = {}) {
    if (!isObject(filters)) throw failure('List filters must be an object', 'INVALID_FILTERS');
    const options = { ...filters };
    options.limit = boundedLimit(filters.limit, 200, MAX_LIST_LIMIT);
    if (filters.offset !== undefined && (!Number.isSafeInteger(filters.offset) || filters.offset < 0)) {
      throw failure('offset must be a non-negative integer', 'INVALID_OFFSET');
    }
    if (filters.sort !== undefined && !['created', 'createdAt', 'updated', 'updatedAt'].includes(filters.sort)) {
      throw failure(`Unsupported sort field: ${filters.sort}`, 'INVALID_FILTERS');
    }
    if (filters.order !== undefined && !['asc', 'desc'].includes(filters.order)) {
      throw failure(`Unsupported sort order: ${filters.order}`, 'INVALID_FILTERS');
    }
    return read((current) => filterNotes(current.notes, options));
  }

  async function snapshot(options = {}) {
    if (!isObject(options)) throw failure('Snapshot options must be an object', 'INVALID_OPTIONS');
    const heatmapDays = options.heatmapDays ?? 90;
    return read((current) => {
      const timestamp = readNow();
      const active = current.notes.filter(({ deletedAt }) => deletedAt === null);
      const trash = current.notes.filter(({ deletedAt }) => deletedAt !== null);
      return {
        version: STORE_VERSION,
        notes: sortNotes(active),
        trash: sortNotes(trash, { pinnedFirst: false }),
        tags: buildTagIndex(current.notes),
        stats: computeStats(current.notes, { now: timestamp }),
        heatmap: buildHeatmap(current.notes, { now: timestamp, days: heatmapDays }),
      };
    });
  }

  async function related(noteId, limit = 5) {
    const idToFind = requireId(noteId);
    const bounded = boundedLimit(limit, 5, MAX_REVIEW_LIMIT);
    return read((current) => relatedNotes(current.notes, idToFind, { limit: bounded }));
  }

  async function review(mode = 'random', options = {}) {
    const config = isObject(mode) ? { ...mode } : { ...options, mode };
    const selectedMode = config.mode ?? 'random';
    const limit = boundedLimit(config.limit, 1, MAX_REVIEW_LIMIT);
    return read((current) => reviewNotes(current.notes, {
      mode: selectedMode,
      limit,
      now: readNow(),
    }));
  }

  async function exportData() {
    return read((current) => ({
      version: STORE_VERSION,
      exportedAt: readNow(),
      notes: current.notes,
    }));
  }

  async function importData(data, mode = 'merge') {
    let payload = data;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch (cause) {
        throw failure(`Invalid import JSON: ${cause.message}`, 'INVALID_IMPORT', { cause });
      }
    }
    if (mode !== 'merge' && mode !== 'replace') {
      throw failure(`Unsupported import mode: ${mode}`, 'INVALID_IMPORT_MODE');
    }
    const importedNotes = validateImport(payload);
    return mutate((draft) => {
      let inserted = 0;
      let updated = 0;
      let skipped = 0;
      if (mode === 'replace') {
        draft.notes = clone(importedNotes);
        inserted = importedNotes.length;
      } else {
        for (const note of importedNotes) {
          const index = draft.notes.findIndex(({ id: candidate }) => candidate === note.id);
          if (index < 0) {
            draft.notes.push(clone(note));
            inserted += 1;
          } else if (note.updatedAt > draft.notes[index].updatedAt) {
            draft.notes[index] = clone(note);
            updated += 1;
          } else {
            skipped += 1;
          }
        }
      }
      return {
        imported: inserted + updated,
        inserted,
        updated,
        skipped,
        total: draft.notes.length,
      };
    });
  }

  async function purgeExpired() {
    return mutate((draft) => {
      const threshold = readNow() - TRASH_RETENTION_MS;
      const before = draft.notes.length;
      draft.notes = draft.notes.filter((note) => note.deletedAt === null || note.deletedAt > threshold);
      return { purged: before - draft.notes.length, total: draft.notes.length };
    });
  }

  function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = tail.then(() => undefined);
    return closePromise;
  }

  return {
    snapshot,
    list,
    create,
    update,
    setPinned,
    trash,
    restore,
    purge,
    purgeExpired,
    related,
    review,
    exportData,
    importData,
    subscribe,
    close,
  };
}
