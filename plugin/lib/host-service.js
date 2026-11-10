import { applyAutoLayout, summarizeCanvas } from './canvas-domain.js';
import { importFigFile } from './fig-import.js';
import { exportHtml, exportSpec, exportSvg } from './design-export.js';

const METHODS = new Set([
  'snapshot', 'create', 'update', 'pin', 'trash', 'restore', 'purge',
  'related', 'review', 'export', 'import',
  'float-open', 'float-close', 'float-status',
  'canvas-list', 'canvas-load', 'canvas-create', 'canvas-save', 'canvas-star', 'canvas-delete',
  'canvas-comment-add', 'canvas-comment-resolve', 'canvas-comment-delete',
  'canvas-asset-save', 'canvas-import-fig', 'canvas-export', 'canvas-arrange',
  'canvas-history', 'canvas-restore',
]);

function operationError(message) {
  const error = new Error(message);
  error.code = 'INVALID_OPERATION';
  return error;
}

function requiredId(payload) {
  const id = typeof payload?.id === 'string' ? payload.id.trim() : '';
  if (!id) throw operationError('Missing note id');
  return id;
}

/** The title a board gets when an import creates it. */
function optionalImportTitle(payload) {
  const title = typeof payload.title === 'string' ? payload.title.trim().slice(0, 120) : '';
  return title || 'Imported board';
}

function requiredCanvasId(payload) {
  const id = typeof payload?.id === 'string' ? payload.id.trim() : '';
  if (!id) {
    const error = new Error('Missing canvas id');
    error.code = 'INVALID_CANVAS_ID';
    throw error;
  }
  return id;
}

/**
 * The camera an import should open on.
 *
 * A Figma file can be tens of thousands of pixels wide. Opening it at the
 * origin shows empty paper, and fitting the whole canvas hides every label in
 * the overview. So: fit everything when it is still readable, otherwise frame
 * the container that holds the most content.
 */
export function cameraForImport(nodes, view = { width: 1200, height: 800 }) {
  if (!Array.isArray(nodes) || !nodes.length) return null;
  const boundsOf = (list) => list.reduce((acc, node) => ({
    minX: Math.min(acc.minX, node.x),
    minY: Math.min(acc.minY, node.y),
    maxX: Math.max(acc.maxX, node.x + node.w),
    maxY: Math.max(acc.maxY, node.y + node.h),
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  const fitOf = (bounds) => {
    const width = Math.max(1, bounds.maxX - bounds.minX);
    const height = Math.max(1, bounds.maxY - bounds.minY);
    const fit = Math.min(view.width / width, view.height / height) * 0.9;
    return Math.max(0.05, Math.min(1, fit));
  };
  const centerOf = (bounds, zoom) => ({
    x: Math.round(view.width / 2 - (bounds.minX + (bounds.maxX - bounds.minX) / 2) * zoom),
    y: Math.round(view.height / 2 - (bounds.minY + (bounds.maxY - bounds.minY) / 2) * zoom),
    zoom,
  });

  const whole = boundsOf(nodes);
  const wholeZoom = fitOf(whole);
  if (wholeZoom >= 0.3) return centerOf(whole, wholeZoom);
  const focus = nodes
    .filter((node) => Array.isArray(node.members) && node.members.length > 1)
    .sort((left, right) => right.members.length - left.members.length)[0];
  if (!focus) return centerOf(whole, wholeZoom);
  const focusBounds = boundsOf([focus]);
  return centerOf(focusBounds, Math.min(1, Math.max(0.3, fitOf(focusBounds))));
}

function boundedLimit(value, fallback = 5, maximum = 20) {
  const number = Number(value ?? fallback);
  return Math.min(Math.max(Number.isFinite(number) ? Math.floor(number) : fallback, 1), maximum);
}

/** Expose the repository through one UI operation contract. */
export function createHostService({ repository, floatBridge, canvasRepository, assets, diagnostics }) {
  if (!repository) throw new Error('The note store is not ready yet');

  function canvasStore() {
    if (!canvasRepository) throw operationError('The canvas store is not ready yet');
    return canvasRepository;
  }

  return {
    async call(method, payload = {}) {
      // Diagnostics are part of the same contract: the UI shows an error id
      // and reads the log back through the route it already talks to.
      if (method === 'diagnostics') {
        if (!diagnostics) return { entries: [], location: null };
        const entries = await diagnostics.recent({ limit: payload.limit });
        return { entries, location: diagnostics.location() };
      }
      if (method === 'client-error') {
        if (!diagnostics) return { id: null };
        const logged = await diagnostics.record({
          scope: 'client',
          method: typeof payload.method === 'string' ? payload.method.slice(0, 120) : 'client',
          code: typeof payload.code === 'string' ? payload.code.slice(0, 120) : '',
          message: typeof payload.message === 'string' ? payload.message : 'The browser reported a failure',
          detail: payload.detail ?? null,
          stack: typeof payload.stack === 'string' ? payload.stack : '',
        });
        return logged;
      }
      if (!METHODS.has(method)) throw operationError(`Unsupported note action: ${String(method)}`);
      switch (method) {
        case 'snapshot': {
          const snapshot = await repository.snapshot(payload);
          return { ...snapshot, notes: [...(snapshot.notes ?? []), ...(snapshot.trash ?? [])] };
        }
        case 'create': return repository.create({ content: payload.content, attachments: payload.attachments });
        case 'update': {
          const input = {};
          if (Object.hasOwn(payload, 'content')) input.content = payload.content;
          if (Object.hasOwn(payload, 'attachments')) input.attachments = payload.attachments;
          return repository.update(requiredId(payload), input);
        }
        case 'pin': return repository.setPinned(requiredId(payload), payload.pinned === true);
        case 'trash': return repository.trash(requiredId(payload));
        case 'restore': return repository.restore(requiredId(payload));
        case 'purge': return repository.purge(requiredId(payload));
        case 'related': return repository.related(requiredId(payload), boundedLimit(payload.limit));
        case 'review': {
          const mode = payload.mode ?? 'random';
          if (!['random', 'on-this-day'].includes(mode)) throw operationError('Unsupported review mode');
          return repository.review(mode);
        }
        case 'export': return repository.exportData();
        case 'import': return repository.importData(payload.data, payload.mode === 'replace' ? 'replace' : 'merge');
        case 'canvas-list': {
          const canvases = await canvasStore().list();
          return {
            canvases: canvases
              .map(summarizeCanvas)
              .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)),
          };
        }
        case 'canvas-load': return { canvas: await canvasStore().load(requiredCanvasId(payload)) };
        case 'canvas-create': return { canvas: await canvasStore().create({ title: payload.title }) };
        case 'canvas-save': {
          const input = {};
          if (payload.title !== undefined) input.title = payload.title;
          if (payload.nodes !== undefined) input.nodes = payload.nodes;
          if (payload.edges !== undefined) input.edges = payload.edges;
          if (payload.camera !== undefined) input.camera = payload.camera;
          if (payload.starred !== undefined) input.starred = payload.starred;
          return { canvas: await canvasStore().save(requiredCanvasId(payload), input) };
        }
        // The handoff formats live on the Host: they must read the saved
        // document, not whatever the browser happens to hold unsaved.
        case 'canvas-export': {
          const board = await canvasStore().load(requiredCanvasId(payload));
          const format = payload.format === 'html' ? 'html' : payload.format === 'spec' ? 'spec' : 'svg';
          const title = (board.title || 'design').replace(/[^\w\u4e00-\u9fa5-]+/g, '-');
          if (format === 'html') {
            return { format, filename: `${title}.html`, mime: 'text/html;charset=utf-8', text: exportHtml(board) };
          }
          if (format === 'spec') {
            return {
              format,
              filename: `${title}.spec.json`,
              mime: 'application/json;charset=utf-8',
              text: JSON.stringify(exportSpec(board), null, 2),
            };
          }
          return { format, filename: `${title}.svg`, mime: 'image/svg+xml;charset=utf-8', text: exportSvg(board) };
        }
        // Auto layout runs on the Host so the client never grows a second
        // layout engine: the panel asks, the judge answers.
        case 'canvas-arrange': {
          if (!Array.isArray(payload.nodes)) throw operationError('canvas-arrange needs the nodes');
          return { nodes: applyAutoLayout(payload.nodes), containerId: payload.containerId ?? null };
        }
        case 'canvas-history': {
          return { versions: await canvasStore().history(requiredCanvasId(payload)) };
        }
        case 'canvas-restore': {
          const versionId = typeof payload.versionId === 'string' ? payload.versionId : '';
          if (!versionId) throw operationError('canvas-restore needs a versionId');
          return { canvas: await canvasStore().restore(requiredCanvasId(payload), versionId) };
        }
        case 'canvas-star': {
          if (typeof payload.starred !== 'boolean') throw operationError('canvas-star needs a boolean starred');
          return { canvas: await canvasStore().setStarred(requiredCanvasId(payload), payload.starred) };
        }
        case 'canvas-asset-save': {
          if (!assets) throw operationError('The picture store is not ready yet');
          const saved = await assets.save({ dataUrl: payload.dataUrl, name: payload.name });
          return { asset: saved };
        }
        case 'canvas-import-fig': {
          // An import may land before any board exists (a fresh profile, or a
          // file dropped on an empty workspace). A missing id means "make the
          // board for me" rather than a client mistake.
          const requested = typeof payload.id === 'string' ? payload.id.trim() : '';
          if (!assets) throw operationError('The picture store is not ready yet');
          const raw = typeof payload.dataBase64 === 'string' ? payload.dataBase64 : '';
          if (!raw) throw operationError('canvas-import-fig needs the file bytes as dataBase64');
          let bytes;
          try {
            bytes = Buffer.from(raw, 'base64');
          } catch {
            throw operationError('The Figma payload is not valid base64');
          }
          if (!bytes.length) throw operationError('The Figma file is empty');

          const current = requested
            ? await canvasStore().load(requested)
            : await canvasStore().create({ title: optionalImportTitle(payload) });
          const imported = await importFigFile(new Uint8Array(bytes), {
            saveAsset: async (assetBytes, type, name) => {
              const saved = await assets.saveBytes(assetBytes, type, name);
              return saved.assetId;
            },
          });

          // The import is appended in one write: a half-imported board is worse
          // than no import at all.
          const nodes = [...current.nodes, ...imported.nodes];
          // Both halves of the import land together: dropping the connectors
          // here would leave a flowchart without its arrows.
          const edges = [...(current.edges ?? []), ...(imported.edges ?? [])];
          const canvas = await canvasStore().save(current.id, {
            nodes,
            edges,
            // An import that lands on empty paper looks like a failed import.
            camera: imported.nodes.length
              ? (cameraForImport(imported.nodes) ?? current.camera)
              : current.camera,
          });
          return { canvas, report: imported.report };
        }
        case 'canvas-comment-add': {
          if (typeof payload.body !== 'string' || !payload.body.trim()) {
            throw operationError('A comment needs a body');
          }
          const input = { body: payload.body };
          if (payload.nodeId !== undefined) input.nodeId = payload.nodeId;
          if (payload.x !== undefined) input.x = payload.x;
          if (payload.y !== undefined) input.y = payload.y;
          const canvas = await canvasStore().addComment(requiredCanvasId(payload), input);
          return { canvas };
        }
        case 'canvas-comment-resolve': {
          if (typeof payload.commentId !== 'string' || !payload.commentId.trim()) {
            throw operationError('Missing comment id');
          }
          if (typeof payload.resolved !== 'boolean') {
            throw operationError('canvas-comment-resolve needs a boolean resolved');
          }
          const canvas = await canvasStore().resolveComment(
            requiredCanvasId(payload),
            payload.commentId.trim(),
            payload.resolved,
          );
          return { canvas };
        }
        case 'canvas-comment-delete': {
          if (typeof payload.commentId !== 'string' || !payload.commentId.trim()) {
            throw operationError('Missing comment id');
          }
          const canvas = await canvasStore().deleteComment(requiredCanvasId(payload), payload.commentId.trim());
          return { canvas };
        }
        case 'canvas-delete': {
          const idToDelete = requiredCanvasId(payload);
          // Read the board first: its pictures may be the last reference to
          // an asset, and the file should not outlive the only board using it.
          const doomed = await canvasStore().load(idToDelete);
          const deleted = await canvasStore().delete(idToDelete);
          if (assets) {
            const referenced = new Set();
            for (const board of await canvasStore().list()) {
              for (const node of board.nodes || []) {
                if (node.assetId) referenced.add(node.assetId);
              }
            }
            for (const node of doomed.nodes || []) {
              if (node.assetId && !referenced.has(node.assetId)) {
                await assets.removeAny(node.assetId).catch(() => {});
              }
            }
          }
          return { deleted: true, id: deleted.id };
        }
        case 'float-open':
          if (!floatBridge) throw operationError('The desktop float is not ready yet');
          return floatBridge.open();
        case 'float-close':
          if (!floatBridge) throw operationError('The desktop float is not ready yet');
          return floatBridge.close();
        case 'float-status':
          if (!floatBridge) throw operationError('The desktop float is not ready yet');
          return floatBridge.status();
        default: throw operationError(`Unsupported note action: ${String(method)}`);
      }
    },
  };
}

function truncated(value, maximum) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

function publicNote(note) {
  return {
    id: truncated(note.id, 200),
    content: truncated(note.content, 2000),
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    pinned: note.pinned === true,
    deletedAt: note.deletedAt ?? null,
    attachments: (note.attachments ?? []).slice(0, 10).map(({ id, name, type, size }) => ({
      id: truncated(id, 200), name: truncated(name, 200), type: truncated(type, 100), size,
    })),
  };
}

/** Build the model tool over the exact same repository used by the UI. */
export function createMemoTool({ repository }) {
  return {
    name: 'moments_memo',
    description: 'Create or search durable local Moments notes. Use create for a new memo and search to find existing notes by text or hierarchical tag.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['create', 'search'], description: 'Whether to create a note or search existing notes.' },
        content: { type: 'string', description: 'Full note text for create. Include #tag/subtag labels in the text when useful.' },
        query: { type: 'string', description: 'Case-insensitive text to find for search.' },
        tag: { type: 'string', description: 'Optional exact tag or parent tag for search, with or without #.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum search results; defaults to 20.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        required: ['action', 'ok', 'summary', 'data'],
        properties: {
          action: { type: 'string' }, ok: { type: 'boolean' }, summary: { type: 'string' },
          data: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value?.summary ?? '' }],
    },
    async execute(args = {}) {
      const action = args.action === 'search' ? 'search' : 'create';
      if (action === 'create') {
        if (typeof args.content !== 'string' || !args.content.trim()) {
          return { action, ok: false, summary: 'Creating a note needs a non-empty content.', data: {} };
        }
        const note = await repository.create({ content: args.content, attachments: [] });
        return {
          action, ok: true,
          summary: `Saved note ${truncated(note.id, 80)}: ${truncated(note.content, 160)}`,
          data: { note: publicNote(note) },
        };
      }
      const limit = boundedLimit(args.limit, 20, 50);
      const query = typeof args.query === 'string' ? args.query : '';
      const tag = typeof args.tag === 'string' ? args.tag.trim() : '';
      const notes = await repository.list({ query, ...(tag ? { tag } : {}), view: 'all', limit });
      return {
        action, ok: true,
        summary: `Found ${notes.length} notes${args.query ? ` for "${truncated(args.query, 60)}"` : ''}.`,
        data: { notes: notes.map(publicNote), count: notes.length },
      };
    },
    isConcurrencySafe(args) { return args?.action === 'search'; },
  };
}
