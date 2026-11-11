/**
 * Asking the open canvas to hand back a picture of itself.
 *
 * The Host can describe a board as geometry, but it cannot rasterise it: there
 * is no font in a Node process, and shipping an image library would put a
 * native addon between the plugin and every machine it installs on. The only
 * place that can draw a board exactly as it looks is the browser that has it
 * open, so the Host asks that browser.
 *
 * The protocol is a long poll, not a timer: a canvas that is open keeps one
 * request parked here, the Host answers it the moment an agent asks for a
 * picture, and the canvas posts the PNG back. A closed canvas costs nothing and
 * an idle one asks nothing.
 */

const DEFAULT_WAIT_MS = 12_000;
const HOLD_MS = 20_000;
const CLAIM_MS = 15_000;
const MAX_JOBS = 4;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function regionOf(value) {
  if (!isObject(value)) return null;
  const x = Number(value.x);
  const y = Number(value.y);
  const w = Number(value.w);
  const h = Number(value.h);
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

export function createSnapshotBroker(options = {}) {
  const defaultWaitMs = Number.isFinite(options.waitMs) ? options.waitMs : DEFAULT_WAIT_MS;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  // The Host must not be held open by a parked poll; a test must be, or the
  // awaited promise never settles once the loop is empty.
  const unref = options.unref !== false;
  const keepAlive = (timer) => {
    if (unref && typeof timer?.unref === 'function') timer.unref();
    return timer;
  };

  /** Jobs waiting for a canvas, oldest first. */
  const queue = [];
  /** Resolvers of parked long polls. */
  const parked = new Set();
  let counter = 0;

  function settleWaiters() {
    if (!queue.length) return;
    for (const wake of [...parked]) wake();
  }

  /** The next job a canvas should render, or null when nothing is waiting. */
  function take() {
    const at = now();
    for (const job of queue) {
      if (job.settled) continue;
      if (job.claimedAt && at - job.claimedAt < CLAIM_MS) continue;
      job.claimedAt = at;
      return {
        jobId: job.id,
        boardId: job.boardId,
        region: job.region,
        scale: job.scale,
      };
    }
    return null;
  }

  /** Park the canvas until a job arrives, or hand back what is already waiting. */
  function next(holdMs = HOLD_MS) {
    const ready = take();
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve) => {
      let timer = null;
      const wake = () => {
        const job = take();
        if (!job) return;
        cleanup();
        resolve(job);
      };
      const cleanup = () => {
        parked.delete(wake);
        if (timer) clearTimeout(timer);
        timer = null;
      };
      parked.add(wake);
      timer = keepAlive(setTimeout(() => {
        cleanup();
        resolve(null);
      }, Math.max(1000, holdMs)));
    });
  }

  /** A canvas answered with a PNG data URL. */
  function fulfill(jobId, dataUrl) {
    if (typeof jobId !== 'string' || !jobId) return false;
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return false;
    const job = queue.find((entry) => entry.id === jobId);
    if (!job || job.settled) return false;
    job.settled = true;
    job.resolve({ dataUrl, at: now() });
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
    return true;
  }

  /** An agent asks for a picture; resolves null when no canvas answers in time. */
  function request(input = {}) {
    const boardId = typeof input.boardId === 'string' ? input.boardId.trim() : '';
    if (!boardId) return Promise.resolve(null);
    if (queue.filter((job) => !job.settled).length >= MAX_JOBS) return Promise.resolve(null);
    counter += 1;
    const id = `snap-${now().toString(36)}-${counter}`;
    const waitMs = Number.isFinite(input.waitMs) ? input.waitMs : defaultWaitMs;
    return new Promise((resolve) => {
      const job = {
        id,
        boardId,
        region: regionOf(input.region),
        scale: Math.min(3, Math.max(0.5, Number(input.scale) || 2)),
        at: now(),
        claimedAt: 0,
        settled: false,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      };
      const timer = keepAlive(setTimeout(() => {
        if (job.settled) return;
        job.settled = true;
        const index = queue.indexOf(job);
        if (index >= 0) queue.splice(index, 1);
        resolve(null);
      }, Math.max(1000, Math.min(waitMs, 30_000))));
      queue.push(job);
      settleWaiters();
    });
  }

  return {
    next,
    fulfill,
    request,
    /** How many jobs are waiting; a canvas uses it to report its own state. */
    pending: () => queue.filter((job) => !job.settled).length,
    /** A canvas saying goodbye: no job should keep waiting on it. */
    dropBoard(boardId) {
      for (const job of [...queue]) {
        if (boardId && job.boardId !== boardId) continue;
        job.settled = true;
        job.resolve(null);
        const index = queue.indexOf(job);
        if (index >= 0) queue.splice(index, 1);
      }
    },
  };
}

/** A data URL as bytes, or null when it is not a plausible image. */
export function dataUrlBytes(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  const header = dataUrl.slice(0, comma);
  const match = /^data:image\/(png|jpeg);base64$/i.exec(header);
  if (!match) return null;
  const base64 = dataUrl.slice(comma + 1);
  if (!base64 || base64.length > 12_000_000) return null;
  try {
    return { type: match[1].toLowerCase(), bytes: Buffer.from(base64, 'base64') };
  } catch {
    return null;
  }
}
