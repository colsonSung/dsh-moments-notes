export const ROUTE = '/api/moments-notes';

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

/** The failure codes the client is allowed to read verbatim. */
function isClientFailure(code) {
  return code === 'VALIDATION_ERROR'
    || code === 'NOTE_NOT_FOUND'
    || code === 'NOTE_NOT_TRASHED'
    || code === 'DUPLICATE_NOTE_ID'
    || code === 'UNSUPPORTED_IMPORT_VERSION'
    || code === 'CANVAS_NOT_FOUND'
    || code.startsWith('FIG_')
    || code.startsWith('INVALID_');
}

/**
 * Adapt the authenticated Harness fetch route to the Host operation service.
 *
 * Every failure is written to the diagnostic log and answered with the id of
 * that log entry, so a message on screen can always be traced back to a
 * timestamp and the payload behind it.
 */
export function createFetchHandler(service, { diagnostics } = {}) {
  return async function handle(request) {
    let body;
    try {
      body = await request.json();
    } catch {
      const logged = await diagnostics?.record({
        scope: 'host',
        method: 'unknown',
        code: 'bad-request',
        message: 'The request body must be JSON',
      });
      return json({
        ok: false,
        error: { code: 'bad-request', message: 'The request body must be JSON', logId: logged?.id },
      }, 400);
    }
    const method = typeof body?.method === 'string' ? body.method : '';
    const payload = body?.payload && typeof body.payload === 'object' ? body.payload : {};
    try {
      const result = await service.call(method, payload);
      return json({ ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = typeof error?.code === 'string' ? error.code : '';
      const clientFailure = isClientFailure(code);
      // The log keeps the identity of the request even when the message is
      // hidden from the user, which is the case for unexpected failures.
      const logged = await diagnostics?.record({
        scope: 'host',
        method,
        code: code || 'unexpected',
        message: clientFailure ? message : `${message} :: ${error instanceof Error ? error.stack || '' : ''}`,
        detail: { payload: summarizeForLog(method, payload) },
      });
      return json({
        ok: false,
        error: {
          code: clientFailure ? 'invalid-operation' : 'operation-failed',
          message: clientFailure ? message : 'The note action failed — try again in a moment',
          logId: logged?.id,
          at: logged?.atIso,
        },
      }, clientFailure ? 400 : 500);
    }
  };
}

/** A board cannot be logged whole; keep the fields a failure needs. */
function summarizeForLog(method, payload) {
  if (!payload || typeof payload !== 'object') return null;
  const summary = { method };
  for (const key of ['id', 'noteId', 'format', 'mode']) {
    if (payload[key] !== undefined) summary[key] = payload[key];
  }
  if (Array.isArray(payload.nodes)) {
    summary.nodeCount = payload.nodes.length;
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
  if (Array.isArray(payload.edges)) summary.edgeCount = payload.edges.length;
  return summary;
}
