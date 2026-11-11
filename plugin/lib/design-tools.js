/**
 * Agent-facing design tools for the Moments design canvas.
 *
 * The agent writes the same scene document a person edits: these tools are the
 * authoring half of that contract, not a second storage format. Every write
 * goes through the Host canvas repository, so the board an agent builds is the
 * board the Design panel opens, and `lib/canvas-domain.js` stays the only
 * judge of what may be stored. A rejected batch leaves the board untouched.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { CANVAS_LIMITS, summarizeCanvas } from './canvas-domain.js';
import { exportHtml, exportSpec, exportSvg } from './design-export.js';
import { analyzeDesign } from './design-issues.js';
import { dataUrlBytes } from './design-snapshot.js';

const CONTAINERS = new Set(['group', 'frame', 'component']);
const MAX_OPS = 200;
const MAX_INSPECT_NODES = 200;
const DEFAULT_SCREEN_WIDTH = 1440;
const DEFAULT_SCREEN_HEIGHT = 900;
const MIN_SCREEN = 320;
const MAX_SCREEN = CANVAS_LIMITS.NODE_SIZE_MAX;

function designError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson(value) {
  return structuredClone(value);
}

/** A number inside a range; anything unusable falls back to the default. */
function boundNumber(value, fallback, minimum, maximum, label) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) throw designError('VALIDATION_ERROR', `${label} must be a number`);
  if (number < minimum || number > maximum) {
    throw designError('VALIDATION_ERROR', `${label} must be between ${minimum} and ${maximum}`);
  }
  return number;
}

/** Join a directory and a file name without importing path on the hot path. */
function joinPath(directory, name) {
  return `${String(directory).replace(/[\\/]+$/, '')}/${name}`;
}

/** A board title as a file name stem a shell will not argue with. */
function safeFileStem(title) {
  const stem = String(title || 'board')
    .replace(/[^\w\u4e00-\u9fa5-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return stem || 'board';
}

function boundInteger(value, fallback, minimum, maximum, label) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw designError('INVALID_DIMENSION', `${label} must be an integer`);
  }
  if (value < minimum || value > maximum) {
    throw designError('INVALID_DIMENSION', `${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function optionalText(value, label, maximum = CANVAS_LIMITS.TITLE_MAX_LENGTH) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw designError('INVALID_INPUT', `${label} must be a string`);
  return value.trim().slice(0, maximum);
}

function boardIdOf(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw designError('INVALID_BOARD_ID', 'boardId must be a non-empty string');
  }
  return value.trim().slice(0, CANVAS_LIMITS.ID_MAX_LENGTH);
}

/** Pick a fresh node id for an inserted node that did not carry one. */
function freshNodeId(taken) {
  let index = taken.size + 1;
  for (let attempt = 0; attempt < 5000; attempt += 1) {
    const candidate = `d${index}`;
    if (!taken.has(candidate)) return candidate;
    index += 1;
  }
  throw designError('ID_EXHAUSTED', 'Could not allocate a node id');
}

/**
 * Apply one batch of operations to a scene document in memory.
 *
 * The batch is translated, never partially applied: a throwing operation takes
 * the whole batch down before anything reaches the repository, so the visible
 * board is either the old document or the complete new one.
 */
function applyOperations(document, operations) {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw designError('INVALID_OPS', 'ops must be a non-empty array');
  }
  if (operations.length > MAX_OPS) {
    throw designError('INVALID_OPS', `A batch cannot carry more than ${MAX_OPS} operations`);
  }
  const nodes = document.nodes.map(cloneJson);
  const edges = document.edges.map(cloneJson);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const inserted = [];
  const updated = [];
  const deleted = [];

  operations.forEach((operation, index) => {
    if (!isObject(operation)) {
      throw designError('INVALID_OP', `ops[${index}] must be an object`);
    }
    const verb = operation.op;
    if (verb === 'insert') {
      const input = operation.node;
      if (!isObject(input)) {
        throw designError('INVALID_OP', `ops[${index}].node must be an object`);
      }
      const supplied = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : null;
      const id = supplied ? supplied.slice(0, CANVAS_LIMITS.ID_MAX_LENGTH) : freshNodeId(byId);
      if (byId.has(id)) throw designError('DUPLICATE_NODE_ID', `A node with id ${id} already exists`);
      if (input.type === undefined || input.type === null) {
        throw designError('INVALID_OP', `ops[${index}].node.type is required`);
      }
      const node = { ...cloneJson(input), id };
      if (node.members === undefined) node.members = [];
      byId.set(id, node);
      nodes.push(node);
      inserted.push(id);
      if (operation.parentId !== undefined) {
        const parentId = boardIdOf(operation.parentId);
        const parent = byId.get(parentId);
        if (!parent) throw designError('PARENT_NOT_FOUND', `parentId ${parentId} does not exist`);
        if (!CONTAINERS.has(parent.type)) {
          throw designError('PARENT_NOT_CONTAINER', `parentId ${parentId} is a ${parent.type}, not a frame or group`);
        }
        const members = Array.isArray(parent.members) ? parent.members : [];
        if (!members.includes(id)) parent.members = [...members, id];
      }
      return;
    }
    if (verb === 'update') {
      const id = boardIdOf(operation.id);
      const current = byId.get(id);
      if (!current) throw designError('NODE_NOT_FOUND', `No node with id ${id}`);
      const patch = operation.patch;
      if (!isObject(patch)) throw designError('INVALID_OP', `ops[${index}].patch must be an object`);
      if (patch.type !== undefined && patch.type !== current.type) {
        throw designError('TYPE_IMMUTABLE', `Cannot change node ${id} from ${current.type} to ${String(patch.type)}`);
      }
      const { id: ignoredId, ...rest } = patch;
      const next = { ...current, ...cloneJson(rest), id, type: current.type };
      byId.set(id, next);
      const position = nodes.findIndex((node) => node.id === id);
      nodes[position] = next;
      updated.push(id);
      return;
    }
    if (verb === 'delete') {
      const id = boardIdOf(operation.id);
      const current = byId.get(id);
      if (!current) throw designError('NODE_NOT_FOUND', `No node with id ${id}`);
      byId.delete(id);
      const position = nodes.findIndex((node) => node.id === id);
      nodes.splice(position, 1);
      // A deleted node must not survive as a member or as a connector endpoint.
      for (const node of nodes) {
        if (Array.isArray(node.members) && node.members.includes(id)) {
          node.members = node.members.filter((member) => member !== id);
        }
      }
      for (let cursor = edges.length - 1; cursor >= 0; cursor -= 1) {
        if (edges[cursor].from === id || edges[cursor].to === id) edges.splice(cursor, 1);
      }
      deleted.push(id);
      return;
    }
    throw designError('INVALID_OP', `ops[${index}].op must be insert, update or delete`);
  });

  return { nodes, edges, inserted, updated, deleted };
}

/** Refuse a node that names a token this board does not define. */
/** Refuse edits to a node that an instance expansion owns; edit the master or the overrides instead. */
function assertGeneratedNodes(document, operations) {
  const generated = new Set(document.nodes.filter((node) => node.origin).map((node) => node.id));
  operations.forEach((operation, index) => {
    if (!isObject(operation)) return;
    if (operation.op === 'update' && typeof operation.id === 'string' && generated.has(operation.id)) {
      throw designError('GENERATED_NODE', `ops[${index}] targets a node generated by an instance. Edit the component or the instance overrides instead.`);
    }
    if (operation.op === 'delete' && typeof operation.id === 'string' && generated.has(operation.id)) {
      throw designError('GENERATED_NODE', `ops[${index}] deletes a node generated by an instance. Edit the component or the instance overrides instead.`);
    }
  });
}

/** Refuse an instance that points at something that is not a component on this board. */
function assertInstanceTargets(document, operations) {
  const components = new Set(document.nodes.filter((node) => node.type === 'component' && !node.origin).map((node) => node.id));
  operations.forEach((operation, index) => {
    if (!isObject(operation) || operation.op !== 'insert' || !isObject(operation.node)) return;
    // A component inserted earlier in this same batch is already addressable.
    if (operation.node.type === 'component' && typeof operation.node.id === 'string') {
      components.add(operation.node.id);
      return;
    }
    if (operation.node.type !== 'instance') return;
    const componentId = operation.node.componentId;
    if (typeof componentId !== 'string' || !components.has(componentId)) {
      throw designError('UNKNOWN_COMPONENT', `ops[${index}].node.componentId must name a component on this board. Available: ${[...components].join(', ') || 'none'}.`);
    }
  });
}

function assertTokenReferences(document, operations) {
  const tokens = document.tokens || { colors: {}, gradients: {}, type: {} };
  const tables = {
    fillToken: ['colors', 'colour'],
    strokeToken: ['colors', 'colour'],
    textColorToken: ['colors', 'colour'],
    gradientToken: ['gradients', 'gradient'],
    typeToken: ['type', 'type style'],
    shadowColorToken: ['colors', 'colour'],
  };
  const inspect = (value, label) => {
    if (!isObject(value)) return;
    for (const [field, [table, kind]] of Object.entries(tables)) {
      const name = value[field];
      if (name === undefined || name === null) continue;
      if (!tokens[table] || tokens[table][name] === undefined) {
        const available = Object.keys(tokens[table] || {});
        throw designError(
          'UNKNOWN_TOKEN',
          `${label} names an unknown ${kind} token "${name}". Available: ${available.length ? available.join(', ') : 'none'}. Create it with design_tokens first.`,
        );
      }
    }
  };
  operations.forEach((operation, index) => {
    if (!isObject(operation)) return;
    if (operation.op === 'insert') inspect(operation.node, `ops[${index}].node`);
    if (operation.op === 'update') inspect(operation.patch, `ops[${index}].patch`);
  });
}

function nodeDigest(node) {
  const digest = {
    id: node.id,
    type: node.type,
    x: node.x,
    y: node.y,
    w: node.w,
    h: node.h,
    visible: node.visible,
  };
  if (node.text) digest.text = node.text.length > 80 ? `${node.text.slice(0, 80)}…` : node.text;
  if (node.title) digest.title = node.title;
  if (Array.isArray(node.members) && node.members.length) digest.members = node.members;
  return digest;
}

function boardDigest(canvas) {
  return {
    boardId: canvas.id,
    title: canvas.title,
    nodeCount: canvas.nodes.length,
    edgeCount: canvas.edges.length,
    frameCount: canvas.nodes.filter(({ type }) => type === 'frame').length,
    textCount: canvas.nodes.filter(({ type }) => type === 'text').length,
    shapeCount: canvas.nodes.filter(({ type }) => type === 'shape').length,
  };
}

/** The card envelope: which board a design tool touched, for the tool view. */
function designPresentation(tool) {
  return (args, value) => ({
    momentsDesign: {
      tool,
      boardId: value?.data?.boardId ?? (typeof args?.boardId === 'string' ? args.boardId : null),
      title: value?.data?.title ?? null,
    },
  });
}

function unavailable() {
  return { ok: false, summary: 'The Moments canvas store is unavailable on this Host.', data: { error: { code: 'CANVAS_UNAVAILABLE' } } };
}

function fromFailure(error) {
  const code = typeof error?.code === 'string' ? error.code : 'DESIGN_FAILED';
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, summary: message, data: { error: { code, message } } };
}

const outputSchema = {
  type: 'object',
  additionalProperties: true,
  required: ['ok', 'summary', 'data'],
  properties: {
    ok: { type: 'boolean' },
    summary: { type: 'string' },
    data: { type: 'object', additionalProperties: true },
  },
};

/** Tools that author a design board, one scene operation batch at a time. */
export function createDesignTools({
  getCanvasStore, diagnostics, snapshots, importReports, snapshotDir,
}) {
  // A tool failure is a real failure too: it lands in the same log as the
  // Host route, so the agent and the person read one story.
  const reportFailure = async (tool, error) => {
    await diagnostics?.record({
      scope: 'tool',
      method: tool,
      code: typeof error?.code === 'string' ? error.code : 'DESIGN_FAILED',
      message: error instanceof Error ? error.message : String(error),
      stack: typeof error?.stack === 'string' ? error.stack : '',
    });
    return fromFailure(error);
  };
  const store = () => {
    const canvasStore = getCanvasStore?.();
    return canvasStore ?? null;
  };

  const begin = {
    name: 'design_begin',
    description:
      'Start a design board in the Moments Design canvas: creates the board and one root screen frame (a phone or desktop artboard) to build inside. Follow it with design_nodes, then design_finish. The user sees the same editable document in the Design panel.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: 'Board title; defaults to "Design".' },
        screenTitle: { type: 'string', description: 'Title shown above the root frame; defaults to "Screen 1".' },
        width: { type: 'integer', minimum: MIN_SCREEN, maximum: MAX_SCREEN, description: `Screen width in design px; defaults to ${DEFAULT_SCREEN_WIDTH}.` },
        height: { type: 'integer', minimum: MIN_SCREEN, maximum: MAX_SCREEN, description: `Screen height in design px; defaults to ${DEFAULT_SCREEN_HEIGHT}.` },
        background: { type: 'string', description: 'Screen background as #rrggbb; defaults to #ffffff.' },
      },
    },
    output: { schema: outputSchema, render: (_args, value) => [{ type: 'text', text: value?.summary ?? '' }], presentationMeta: designPresentation('design_begin') },
    async execute(args = {}) {
      const canvasStore = store();
      if (!canvasStore) return unavailable();
      try {
        const title = optionalText(args.title, 'title') || 'Design';
        const screenTitle = optionalText(args.screenTitle, 'screenTitle') || 'Screen 1';
        const width = boundInteger(args.width, DEFAULT_SCREEN_WIDTH, MIN_SCREEN, MAX_SCREEN, 'width');
        const height = boundInteger(args.height, DEFAULT_SCREEN_HEIGHT, MIN_SCREEN, MAX_SCREEN, 'height');
        const background = typeof args.background === 'string' && args.background.trim() ? args.background.trim() : '#ffffff';
        const created = await canvasStore.create({ title });
        const screen = {
          id: 'screen-1',
          type: 'frame',
          x: 0,
          y: 0,
          w: width,
          h: height,
          title: screenTitle,
          fill: background,
          members: [],
        };
        const saved = await canvasStore.save(created.id, {
          title,
          nodes: [screen],
          edges: [],
          camera: { x: 0, y: 0, zoom: 1 },
        });
        return {
          ok: true,
          summary: `Started board "${saved.title}" (${saved.id}) with screen ${width}×${height}. Next: design_nodes.`,
          data: {
            ...boardDigest(saved),
            screenId: 'screen-1',
            width,
            height,
            next: 'Call design_nodes with ops to place text, shapes and images inside the screen, then design_finish.',
          },
        };
      } catch (error) {
        return reportFailure('design_begin', error);
      }
    },
    isConcurrencySafe() { return false; },
  };

  const nodes = {
    name: 'design_nodes',
    description:
      'Transact a batch of design edit operations on one board: insert nodes (text, shape, frame, group, sticky), update their fields, or delete them. Coordinates are absolute design px on the board; parentId puts a node inside a frame or group. The whole batch commits or is rejected together. Node fields: type, x, y, w, h, text, fill, stroke, strokeWidth, radius, opacity, textAlign, fontSize, textColor, fontFamily (sans|serif|mono|display), fontWeight (100-900), lineHeight (0.8-3), letterSpacing (px), shadow {x,y,blur,color}, gradient {from,to,angle}, shape (rect|ellipse|line|arrow|polygon|star), rotation (deg), members, title. Token references: fillToken, strokeToken, textColorToken, gradientToken, typeToken, shadowColorToken (names defined by design_tokens; a reference overrides the matching literal). Components: insert a node of type component (a frame-like container with members) and place instances with { type: "instance", componentId, x, y, overrides } — every save rebuilds each instance from its component, so editing the master updates all instances. Frames and groups also take layout (none|row|column), gap, padding and align (start|center|end|stretch); a flowing container positions its members on save, so do not compute their x/y yourself. A member can carry constraints {horizontal: left|right|center|left-right|scale, vertical: top|bottom|center|top-bottom|scale} to say how it holds its place when the frame is resized.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['boardId', 'ops'],
      properties: {
        boardId: { type: 'string', description: 'Board id returned by design_begin.' },
        ops: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_OPS,
          items: {
            type: 'object',
            additionalProperties: true,
            required: ['op'],
            properties: {
              op: { type: 'string', enum: ['insert', 'update', 'delete'] },
              node: { type: 'object', additionalProperties: true, description: 'Node to insert: type plus x, y, w, h and any style fields.' },
              id: { type: 'string', description: 'Node id for update or delete.' },
              patch: { type: 'object', additionalProperties: true, description: 'Fields to replace on the node for update.' },
              parentId: { type: 'string', description: 'For insert: frame or group that should own the node.' },
            },
          },
        },
      },
    },
    output: { schema: outputSchema, render: (_args, value) => [{ type: 'text', text: value?.summary ?? '' }], presentationMeta: designPresentation('design_tokens') },
    async execute(args = {}) {
      const canvasStore = store();
      if (!canvasStore) return unavailable();
      try {
        const boardId = boardIdOf(args.boardId);
        const document = await canvasStore.load(boardId);
        assertGeneratedNodes(document, args.ops);
        assertInstanceTargets(document, args.ops);
        assertTokenReferences(document, args.ops);
        const { nodes: nextNodes, edges, inserted, updated, deleted } = applyOperations(document, args.ops);
        const saved = await canvasStore.save(boardId, {
          title: document.title,
          nodes: nextNodes,
          edges,
          camera: document.camera,
        });
        return {
          ok: true,
          summary: `Applied ${inserted.length + updated.length + deleted.length} operation(s): +${inserted.length} ~${updated.length} -${deleted.length}. Board now holds ${saved.nodes.length} nodes.`,
          data: { ...boardDigest(saved), inserted, updated, deleted },
        };
      } catch (error) {
        return reportFailure('design_nodes', error);
      }
    },
    isConcurrencySafe() { return false; },
  };

  const finish = {
    name: 'design_finish',
    description:
      'Close a design pass on a board: validates the stored document, optionally renames the board, and reports what it now contains. Does not publish anything: the board is already saved and visible in the Design panel.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['boardId'],
      properties: {
        boardId: { type: 'string', description: 'Board id to finish.' },
        title: { type: 'string', description: 'Optional final board title.' },
      },
    },
    output: { schema: outputSchema, render: (_args, value) => [{ type: 'text', text: value?.summary ?? '' }], presentationMeta: designPresentation('design_nodes') },
    async execute(args = {}) {
      const canvasStore = store();
      if (!canvasStore) return unavailable();
      try {
        const boardId = boardIdOf(args.boardId);
        const document = await canvasStore.load(boardId);
        const title = optionalText(args.title, 'title');
        const saved = title && title !== document.title
          ? await canvasStore.save(boardId, { title, nodes: document.nodes, edges: document.edges, camera: document.camera })
          : document;
        const problems = [];
        if (saved.nodes.length === 0) problems.push('the board is empty');
        if (!saved.nodes.some(({ type }) => type === 'frame')) problems.push('the board has no screen frame');
        return {
          ok: problems.length === 0,
          summary: problems.length === 0
            ? `Board "${saved.title}" is ready: ${saved.nodes.length} nodes, ${saved.edges.length} connectors.`
            : `Board "${saved.title}" needs work: ${problems.join('; ')}.`,
          data: {
            ...boardDigest(saved),
            problems,
            next: 'Open the Design panel to review and refine the board by hand.',
          },
        };
      } catch (error) {
        return reportFailure('design_finish', error);
      }
    },
    isConcurrencySafe() { return true; },
  };

  const inspect = {
    name: 'design_inspect',
    description:
      'Read back design boards: with no boardId it lists the boards in the workspace; with a boardId it returns that board\'s nodes (bounded) so later edits can target exact ids instead of guessing. view:"issues" adds what a reviewer would say about the board (text running past its box, peers on top of each other, a node outside its frame, unreadable ink); view:"image" asks the open Design panel for a PNG of the board and returns its path, so the caller can look at the drawing itself instead of trusting the geometry; view:"import" returns the latest Figma import report for the board.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        boardId: { type: 'string', description: 'Board to read; omit to list boards.' },
        view: {
          type: 'string',
          enum: ['summary', 'issues', 'image', 'import'],
          description: 'summary (default) lists nodes; issues reports what breaks a rule; image writes a PNG of the open board and returns its path; import returns the last Figma import report.',
        },
        nodeIds: { type: 'array', items: { type: 'string' }, maxItems: MAX_INSPECT_NODES, description: 'Only these node ids.' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_INSPECT_NODES, description: 'Maximum nodes to return; defaults to 120.' },
        region: {
          type: 'object',
          additionalProperties: false,
          description: 'For view:"image": the board area to render, in board coordinates.',
          properties: {
            x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' },
          },
        },
        scale: { type: 'number', minimum: 0.5, maximum: 3, description: 'For view:"image": pixels per board unit; defaults to 2.' },
        waitMs: { type: 'integer', minimum: 1000, maximum: 30000, description: 'For view:"image": how long to wait for the Design panel to answer; defaults to 12000.' },
      },
    },
    output: { schema: outputSchema, render: (_args, value) => [{ type: 'text', text: value?.summary ?? '' }], presentationMeta: designPresentation('design_finish') },
    async execute(args = {}) {
      const canvasStore = store();
      if (!canvasStore) return unavailable();
      try {
        if (args.boardId === undefined || args.boardId === null || args.boardId === '') {
          const boards = (await canvasStore.list()).map((canvas) => ({ ...summarizeCanvas(canvas) }));
          return {
            ok: true,
            summary: `The workspace holds ${boards.length} design board(s).`,
            data: { boards },
          };
        }
        const boardId = boardIdOf(args.boardId);
        const document = await canvasStore.load(boardId);
        const view = ['summary', 'issues', 'image', 'import'].includes(args.view) ? args.view : 'summary';

        // The report of what an import left behind belongs to the board, not to
        // the nodes, so it is readable long after the import dialog closed.
        if (view === 'import') {
          if (!importReports) {
            return {
              ok: false,
              summary: 'This build has no import report store.',
              data: { report: null },
            };
          }
          const report = await importReports.latest(boardId);
          const skipped = report ? Object.entries(report.skipped || {}).map(([kind, value]) => `${value} ${kind}`).join(', ') : '';
          return {
            ok: true,
            summary: report
              ? `Last import of "${document.title}": ${report.nodeCount} nodes in the file, ${Object.values(report.imported || {}).reduce((total, value) => total + value, 0)} imported${skipped ? `, skipped ${skipped}` : ''}${report.warnings.length ? `; ${report.warnings[0]}` : ''}.`
              : `"${document.title}" has no recorded Figma import.`,
            data: { report },
          };
        }

        // Everything a person would notice by looking at the board, computed
        // from the document: this is the half of "look at it" that never needs
        // a browser.
        if (view === 'issues') {
          const analysis = analyzeDesign(document);
          const first = analysis.issues[0];
          return {
            ok: true,
            summary: analysis.issues.length
              ? `${analysis.issues.length} problem(s) on "${document.title}": ${first.code} — ${first.message}${analysis.issues.length > 1 ? ` (+${analysis.issues.length - 1} more)` : ''}`
              : `"${document.title}" passes the layout checks: ${analysis.summary.nodes} nodes, no overflow, overlap, stray or unreadable text.`,
            data: { ...boardDigest(document), issues: analysis.issues, checks: analysis.summary },
          };
        }

        // The picture itself: the Host cannot draw a board, so it asks the open
        // Design panel and saves what comes back.
        if (view === 'image') {
          const analysis = analyzeDesign(document);
          if (!snapshots || !snapshotDir) {
            return {
              ok: false,
              summary: 'This build cannot capture the canvas.',
              data: { issues: analysis.issues, checks: analysis.summary },
            };
          }
          const captured = await snapshots.request({
            boardId,
            region: args.region,
            scale: boundNumber(args.scale, 2, 0.5, 3, 'scale'),
            waitMs: boundInteger(args.waitMs, 12000, 1000, 30000, 'waitMs'),
          });
          if (!captured) {
            return {
              ok: false,
              summary: 'No Design panel answered: open Moments → Design on this board, then ask again. The layout checks still apply.',
              data: { issues: analysis.issues, checks: analysis.summary, reason: 'no-canvas' },
            };
          }
          const decoded = dataUrlBytes(captured.dataUrl);
          if (!decoded) {
            return {
              ok: false,
              summary: 'The Design panel answered with something that is not a PNG.',
              data: { issues: analysis.issues, checks: analysis.summary },
            };
          }
          await mkdir(snapshotDir, { recursive: true });
          const filePath = joinPath(snapshotDir, `${safeFileStem(document.title)}-${Date.now()}.${decoded.type === 'jpeg' ? 'jpg' : 'png'}`);
          await writeFile(filePath, decoded.bytes);
          return {
            ok: true,
            summary: `Wrote a ${decoded.type.toUpperCase()} of "${document.title}" to ${filePath} (${Math.round(decoded.bytes.length / 1024)} KB). Look at it before claiming the design is done.`,
            data: {
              ...boardDigest(document),
              image: { path: filePath, bytes: decoded.bytes.length, type: decoded.type },
              issues: analysis.issues,
              checks: analysis.summary,
            },
          };
        }

        const wanted = Array.isArray(args.nodeIds) && args.nodeIds.length
          ? new Set(args.nodeIds.filter((id) => typeof id === 'string').map((id) => id.trim()))
          : null;
        const limit = boundInteger(args.limit, 120, 1, MAX_INSPECT_NODES, 'limit');
        const selected = document.nodes
          .filter((node) => (wanted ? wanted.has(node.id) : true))
          .slice(0, limit)
          .map(nodeDigest);
        return {
          ok: true,
          summary: `Board "${document.title}" (${document.id}): ${document.nodes.length} nodes, ${document.edges.length} connectors; returning ${selected.length}.`,
          data: { ...boardDigest(document), nodes: selected, truncated: document.nodes.length > selected.length },
        };
      } catch (error) {
        return reportFailure('design_inspect', error);
      }
    },
    isConcurrencySafe() { return true; },
  };

  const tokens = {
    name: 'design_tokens',
    description:
      'Define or update the design tokens of one board: named colours, gradients and type styles. Nodes name a token instead of repeating a literal, so changing a token here restyles every node that uses it on the next save. Merge by default; mode "replace" wipes the untouched tables.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['boardId'],
      properties: {
        boardId: { type: 'string', description: 'Board whose tokens to edit.' },
        colors: { type: 'object', additionalProperties: { type: 'string' }, description: 'Named colours, e.g. { "brand": "#635bff" }.' },
        gradients: { type: 'object', additionalProperties: { type: 'object' }, description: 'Named gradients, e.g. { "cta": { "from": "#635bff", "to": "#8b83ff", "angle": 135 } }.' },
        type: { type: 'object', additionalProperties: { type: 'object' }, description: 'Named type styles, e.g. { "title": { "fontFamily": "display", "fontSize": 48, "fontWeight": 800, "lineHeight": 1.1, "letterSpacing": -1.5 } }.' },
        mode: { type: 'string', enum: ['merge', 'replace'], description: 'merge (default) keeps untouched tables; replace starts from empty.' },
      },
    },
    output: { schema: outputSchema, render: (_args, value) => [{ type: 'text', text: value?.summary ?? '' }], presentationMeta: designPresentation('design_inspect') },
    async execute(args = {}) {
      const canvasStore = store();
      if (!canvasStore) return unavailable();
      try {
        const boardId = boardIdOf(args.boardId);
        const document = await canvasStore.load(boardId);
        const current = document.tokens || { colors: {}, gradients: {}, type: {} };
        const replace = args.mode === 'replace';
        const next = {
          colors: { ...(replace ? {} : current.colors), ...(isObject(args.colors) ? args.colors : {}) },
          gradients: { ...(replace ? {} : current.gradients), ...(isObject(args.gradients) ? args.gradients : {}) },
          type: { ...(replace ? {} : current.type), ...(isObject(args.type) ? args.type : {}) },
        };
        const saved = await canvasStore.save(boardId, {
          title: document.title,
          nodes: document.nodes,
          edges: document.edges,
          camera: document.camera,
          tokens: next,
        });
        const used = saved.nodes.filter((node) => node.fillToken || node.strokeToken || node.textColorToken || node.gradientToken || node.typeToken).length;
        return {
          ok: true,
          summary: `Board "${saved.title}" now carries ${Object.keys(saved.tokens.colors).length} colour, ${Object.keys(saved.tokens.gradients).length} gradient and ${Object.keys(saved.tokens.type).length} type token(s); ${used} node(s) reference them and were re-resolved on save.`,
          data: {
            boardId,
            tokens: saved.tokens,
            tokenedNodes: used,
            available: {
              colors: Object.keys(saved.tokens.colors),
              gradients: Object.keys(saved.tokens.gradients),
              type: Object.keys(saved.tokens.type),
            },
          },
        };
      } catch (error) {
        return reportFailure('design_tokens', error);
      }
    },
    isConcurrencySafe() { return false; },
  };

  const exporter = {
    name: 'design_export',
    description:
      'Export one design board into a deliverable: an HTML+CSS page to hand to a developer, a standalone SVG, or a design spec JSON (colours, type scale, radii, shadows, flow containers). With path it writes the file and returns the path; without path it returns the content (spec always returns the object).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['boardId', 'format'],
      properties: {
        boardId: { type: 'string', description: 'Board id to export.' },
        format: { type: 'string', enum: ['html', 'svg', 'spec'], description: 'Deliverable kind.' },
        path: { type: 'string', description: 'Absolute file path to write; required for html.' },
      },
    },
    output: { schema: outputSchema, render: (_args, value) => [{ type: 'text', text: value?.summary ?? '' }], presentationMeta: designPresentation('design_export') },
    async execute(args = {}) {
      const canvasStore = store();
      if (!canvasStore) return unavailable();
      try {
        const boardId = boardIdOf(args.boardId);
        const format = args.format;
        if (!['html', 'svg', 'spec'].includes(format)) {
          throw designError('INVALID_FORMAT', 'format must be html, svg or spec');
        }
        const document = await canvasStore.load(boardId);
        const content = format === 'svg' ? exportSvg(document) : format === 'html' ? exportHtml(document) : null;
        const spec = format === 'spec' ? exportSpec(document) : null;
        const targetPath = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : null;
        if (targetPath && !targetPath.startsWith('/')) {
          throw designError('INVALID_PATH', 'path must be absolute');
        }
        if (!targetPath) {
          if (format === 'html') {
            throw designError('PATH_REQUIRED', 'Exporting HTML writes a file: pass an absolute path.');
          }
          if (format === 'spec') {
            return {
              ok: true,
              summary: `Design spec for "${document.title}": ${spec.nodeCount} nodes, ${spec.colors.length} colours, ${spec.typography.length} type styles.`,
              data: { boardId, format, spec },
            };
          }
          const capped = content.length > 200000 ? `${content.slice(0, 200000)}\n<!-- truncated -->` : content;
          return {
            ok: true,
            summary: `SVG for "${document.title}": ${content.length} characters.`,
            data: { boardId, format, bytes: content.length, truncated: content.length > 200000, content: capped },
          };
        }
        await mkdir(dirname(targetPath), { recursive: true });
        const body = format === 'spec' ? `${JSON.stringify(spec, null, 2)}\n` : content;
        await writeFile(targetPath, body, 'utf8');
        return {
          ok: true,
          summary: `Wrote ${format.toUpperCase()} for "${document.title}" to ${targetPath} (${Buffer.byteLength(body, 'utf8')} bytes).`,
          data: { boardId, format, path: targetPath, bytes: Buffer.byteLength(body, 'utf8') },
        };
      } catch (error) {
        return reportFailure('design_export', error);
      }
    },
    isConcurrencySafe() { return true; },
  };

  return [begin, tokens, nodes, finish, inspect, exporter];
}
