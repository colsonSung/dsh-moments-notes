/**
 * The unfinished thought the desktop float keeps between windows.
 *
 * Closing the float is not a way to lose a note. While the person types, the
 * window debounces for three seconds and hands the Host a draft: the text, the
 * attachments, and whether the draft was editing an existing note. The Host
 * writes it beside the notes store, and the next window restores it before the
 * person can start over.
 *
 * The draft is validated with the same attachment rules as a note, so a restored
 * draft can always be saved: a draft is only ever a note that has not been
 * committed yet.
 */

import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

import { LIMITS, normalizeAttachments } from './domain.js';

const DRAFT_VERSION = 1;
const MAX_CONTENT_LENGTH = 200_000;

function failure(message, code = 'INVALID_DRAFT') {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function removeFile(filePath) {
  try {
    await unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

/**
 * Turn whatever the window sent into a draft, or null when there is nothing to
 * keep. Attachments that no longer validate are dropped rather than the whole
 * draft: losing one image must not lose the text.
 */
export function normalizeDraft(input) {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw failure('A draft must be an object');

  const content = typeof input.content === 'string' ? input.content.slice(0, MAX_CONTENT_LENGTH) : '';
  const editingId = typeof input.editingId === 'string' && input.editingId.trim()
    ? input.editingId.trim()
    : null;
  const attachments = draftAttachments(input.attachments);
  if (!content.trim() && attachments.length === 0) return null;
  return {
    version: DRAFT_VERSION,
    content,
    editingId,
    attachments,
    savedAt: Date.now(),
  };
}

/**
 * Keep every attachment that still validates, and drop only the broken one.
 * A corrupted image must not cost the person the text they were writing.
 */
function draftAttachments(input) {
  if (!Array.isArray(input) || input.length === 0) return [];
  try {
    return normalizeAttachments(input);
  } catch {
    const kept = [];
    let total = 0;
    for (const item of input) {
      if (kept.length >= LIMITS.ATTACHMENTS_PER_NOTE) break;
      try {
        const [attachment] = normalizeAttachments([item]);
        if (total + attachment.size > LIMITS.ATTACHMENTS_TOTAL_BYTES) break;
        total += attachment.size;
        kept.push(attachment);
      } catch {
        // This one is unusable; the others are still worth restoring.
      }
    }
    return kept;
  }
}

/** Store the float's draft in one small file next to the notes. */
export function createDraftStore({ filePath, logger } = {}) {
  if (typeof filePath !== 'string' || !filePath) throw new Error('A draft file path is required');

  // Writes arrive from the window's debounce and from a closing window at the
  // same time; one queue keeps them from interleaving.
  let queue = Promise.resolve();
  const enqueue = (task) => {
    const next = queue.then(task, task);
    queue = next.catch(() => {});
    return next;
  };

  return {
    filePath,

    /** Read the last draft, or null when there is nothing worth restoring. */
    async read() {
      let raw;
      try {
        raw = await readFile(filePath, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        logger?.warn?.('Moments draft file is not valid JSON; the draft was dropped');
        await removeFile(filePath).catch(() => {});
        return null;
      }
      try {
        return normalizeDraft(payload);
      } catch (error) {
        logger?.warn?.(`Moments draft file was rejected: ${String(error)}`);
        return null;
      }
    },

    /** Write one draft; an empty draft removes the file instead. */
    async write(draft) {
      return enqueue(async () => {
        const normalized = normalizeDraft(draft);
        if (!normalized) {
          await removeFile(filePath);
          return null;
        }
        await mkdir(dirname(filePath), { recursive: true });
        const temporary = `${filePath}.${process.pid}.tmp`;
        const handle = await open(temporary, 'w');
        try {
          await handle.writeFile(`${JSON.stringify(normalized)}\n`, 'utf8');
        } finally {
          await handle.close();
        }
        try {
          await rename(temporary, filePath);
        } catch (error) {
          await unlink(temporary).catch(() => {});
          throw error;
        }
        return normalized;
      });
    },

    /** Forget the draft because the note it described now exists. */
    async clear() {
      return enqueue(async () => {
        await removeFile(filePath);
        return null;
      });
    },
  };
}
