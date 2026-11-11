import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

/**
 * The import reports, kept beside the boards that came from them.
 *
 * A Figma import tells the truth exactly once, in the answer to the import
 * call: how many nodes came through, which pictures are only thumbnails, what
 * was skipped. Then the answer scrolls away, and a week later nobody can say
 * whether a blank area is an empty design or an import that dropped it. This
 * store keeps the last report of each board so that question stays answerable.
 *
 * It is a separate file from the board: an import report is evidence about a
 * board, not part of its design, and a board must never fail to open because
 * its report is malformed.
 */

const STORE_VERSION = 1;
const REPORTS_PER_BOARD = 5;
const BOARDS_KEPT = 100;
const TEXT_MAX = 400;

function failure(message, code = 'IMPORT_REPORTS_ERROR') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value, max = TEXT_MAX) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

/** One report, with the fields a reader needs and nothing that can drift. */
export function normalizeImportReport(input, options = {}) {
  if (!isObject(input)) throw failure('An import report must be an object', 'INVALID_REPORT');
  const imported = {};
  for (const [key, value] of Object.entries(isObject(input.imported) ? input.imported : {})) {
    if (count(value) > 0) imported[text(key, 40)] = count(value);
  }
  const skipped = {};
  for (const [key, value] of Object.entries(isObject(input.skipped) ? input.skipped : {})) {
    if (count(value) > 0) skipped[text(key, 40)] = count(value);
  }
  const samples = {};
  for (const [key, value] of Object.entries(isObject(input.skippedSamples) ? input.skippedSamples : {})) {
    if (!Array.isArray(value) || !value.length) continue;
    samples[text(key, 40)] = value
      .filter((entry) => isObject(entry))
      .slice(0, 20)
      .map((entry) => ({
        id: text(entry.id, 80) || null,
        name: text(entry.name, 80),
        type: text(entry.type, 40),
      }));
  }
  return {
    id: text(input.id, 80) || `report-${Date.now().toString(36)}`,
    boardId: text(input.boardId, 80),
    at: Number.isFinite(Number(input.at)) ? Number(input.at) : Date.now(),
    source: text(input.source, 160) || 'Figma file',
    nodeCount: count(input.nodeCount),
    imported,
    skipped,
    warnings: Array.isArray(input.warnings)
      ? input.warnings.map((entry) => text(entry, 200)).filter(Boolean).slice(0, 20)
      : [],
    pages: Array.isArray(input.pages) ? input.pages.map((entry) => text(entry, 80)).filter(Boolean).slice(0, 20) : [],
    skippedSamples: samples,
  };
}

function validateStore(payload) {
  if (!isObject(payload)) throw failure('The import report store must be an object', 'INVALID_STORE');
  if (payload.version !== STORE_VERSION) {
    throw failure(`Unsupported import report store version: ${payload.version}`, 'UNSUPPORTED_STORE_VERSION');
  }
  if (!isObject(payload.reports)) throw failure('The import report store needs a reports table', 'INVALID_STORE');
  return payload;
}

async function atomicWrite(filePath, state) {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporary = resolve(directory, `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filePath);
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

/**
 * Open the report store.
 *
 * A broken store is not fatal: reports are evidence, and losing evidence must
 * never stop a board from being imported. The caller gets `null` and the import
 * goes ahead, exactly as before this feature existed.
 */
export async function openImportReports(options) {
  // Same shape as the other stores: an options object, so a caller can add
  // settings without changing every call site.
  const filePath = typeof options === 'string' ? options : options?.filePath;
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw failure('openImportReports requires a file path', 'INVALID_OPTIONS');
  }
  let state = { version: STORE_VERSION, reports: {} };
  try {
    const raw = await readFile(filePath, 'utf8');
    state = validateStore(JSON.parse(raw));
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      state = { version: STORE_VERSION, reports: {} };
    }
  }

  let tail = Promise.resolve();
  const mutate = (callback) => {
    const run = tail.then(async () => {
      const draft = structuredClone(state);
      const result = await callback(draft);
      await atomicWrite(filePath, draft);
      state = draft;
      return result;
    });
    tail = run.then(() => undefined, () => undefined);
    return run;
  };

  return {
    filePath,

    /** Keep one report for a board; older ones fall off the end. */
    async record(input) {
      const report = normalizeImportReport(input);
      if (!report.boardId) throw failure('A report needs a boardId', 'INVALID_REPORT');
      return mutate((draft) => {
        const list = Array.isArray(draft.reports[report.boardId]) ? draft.reports[report.boardId] : [];
        draft.reports[report.boardId] = [...list, report].slice(-REPORTS_PER_BOARD);
        const boards = Object.keys(draft.reports);
        if (boards.length > BOARDS_KEPT) {
          const ordered = boards
            .map((id) => ({ id, at: draft.reports[id].at(-1)?.at ?? 0 }))
            .sort((left, right) => left.at - right.at);
          for (const stale of ordered.slice(0, boards.length - BOARDS_KEPT)) delete draft.reports[stale.id];
        }
        return report;
      });
    },

    /** The newest report for a board, or null. */
    async latest(boardId) {
      await tail;
      const list = state.reports[text(boardId, 80)];
      if (!Array.isArray(list) || !list.length) return null;
      return structuredClone(list[list.length - 1]);
    },

    /** Every kept report for a board, newest last. */
    async list(boardId) {
      await tail;
      const list = state.reports[text(boardId, 80)];
      return Array.isArray(list) ? structuredClone(list) : [];
    },
  };
}
