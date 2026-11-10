import { appendFile, mkdir, readFile, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * The diagnostic log of the plugin.
 *
 * Every failure the Host answers with an error — and every error the browser
 * reports back — is written here as one JSON line, so a user-visible message
 * can be traced to a timestamp, a method and the payload that caused it. The
 * file is append-only and rotates once, which keeps it bounded without losing
 * the most recent incidents.
 */
export const DIAGNOSTICS_MAX_BYTES = 1024 * 1024;
export const DIAGNOSTICS_KEEP = 400;

/** One short id a person can quote when reporting a problem. */
function makeErrorId(at = Date.now()) {
  const stamp = at.toString(36).toUpperCase();
  const salt = Math.random().toString(36).slice(2, 5).toUpperCase();
  return `E-${stamp}-${salt}`;
}

/**
 * A compact, log-safe view of a request payload.
 *
 * A board is far too big to log whole, so the summary keeps the identity of
 * the request plus any node whose size or position is outside the limits —
 * the values that actually make a save fail.
 */
export function summarizePayload(method, payload) {
  if (!payload || typeof payload !== 'object') return null;
  const summary = {};
  for (const key of ['id', 'noteId', 'format', 'mode', 'title']) {
    if (payload[key] !== undefined) summary[key] = payload[key];
  }
  if (Array.isArray(payload.nodes)) {
    summary.nodes = payload.nodes.length;
    const suspects = payload.nodes.filter((node) => (
      !node || typeof node !== 'object'
      || !Number.isFinite(node.w) || !Number.isFinite(node.h)
      || node.w < 16 || node.w > 8000 || node.h < 16 || node.h > 8000
      || Math.abs(node.x) > 1_000_000 || Math.abs(node.y) > 1_000_000
    ));
    if (suspects.length) {
      summary.suspects = suspects.slice(0, 5).map((node) => (node && typeof node === 'object'
        ? { id: node.id, type: node.type, w: node.w, h: node.h, x: node.x, y: node.y, title: node.title || '' }
        : { invalid: String(node) }));
    }
  }
  if (Array.isArray(payload.edges)) summary.edges = payload.edges.length;
  if (payload.camera && typeof payload.camera === 'object') summary.zoom = payload.camera.zoom;
  return summary;
}

function normalizeEntry(input) {
  const at = Number.isFinite(input?.at) ? input.at : Date.now();
  return {
    id: typeof input?.id === 'string' && input.id ? input.id : makeErrorId(at),
    at,
    atIso: new Date(at).toISOString(),
    scope: String(input?.scope || 'host'),
    method: String(input?.method || ''),
    code: String(input?.code || ''),
    message: String(input?.message ?? '').slice(0, 2000),
    detail: input?.detail ?? null,
    stack: typeof input?.stack === 'string' ? input.stack.slice(0, 4000) : '',
  };
}

/**
 * Open the diagnostic log.
 *
 * The store is deliberately tiny: append one line, read the tail, never keep
 * state in memory that a restart could disagree with.
 */
export async function openDiagnostics({ filePath, maxBytes = DIAGNOSTICS_MAX_BYTES } = {}) {
  if (typeof filePath !== 'string' || !filePath) throw new Error('openDiagnostics needs a filePath');
  const rotatedPath = `${filePath}.1`;

  async function rotateIfNeeded() {
    try {
      const info = await stat(filePath);
      if (info.size < maxBytes) return;
      await rename(filePath, rotatedPath).catch(() => {});
    } catch {
      // A missing file is the normal first write.
    }
  }

  return {
    filePath,

    /** Record one failure and return the id it was given. */
    async record(input) {
      const entry = normalizeEntry(input);
      try {
        await mkdir(dirname(filePath), { recursive: true });
        await rotateIfNeeded();
        await appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
      } catch {
        // Diagnostics must never break the operation that failed.
      }
      return { id: entry.id, atIso: entry.atIso };
    },

    /** The newest entries first, at most `limit`. */
    async recent({ limit = 50 } = {}) {
      const wanted = Math.max(1, Math.min(DIAGNOSTICS_KEEP, Math.trunc(Number(limit) || 50)));
      const entries = [];
      for (const path of [filePath, rotatedPath]) {
        let text = '';
        try {
          text = await readFile(path, 'utf8');
        } catch {
          continue;
        }
        const lines = text.split('\n').filter(Boolean);
        for (let index = lines.length - 1; index >= 0 && entries.length < wanted; index -= 1) {
          try {
            entries.push(JSON.parse(lines[index]));
          } catch {
            // A torn last line is not worth failing the whole log over.
          }
        }
        if (entries.length >= wanted) break;
      }
      return entries.sort((left, right) => right.at - left.at).slice(0, wanted);
    },

    /** Where the log lives, so the UI can tell the user. */
    location() {
      return { filePath, rotatedPath, maxBytes };
    },
  };
}

export { join as joinDiagnosticsPath };
