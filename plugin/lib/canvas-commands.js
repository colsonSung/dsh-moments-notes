/**
 * Edit commands and their exact inverses.
 *
 * The undo stack used to hold whole documents: one changed field meant a
 * copy of every node and edge. A command is data, and its inverse is data
 * too, so the stack costs what the change costs.
 *
 * Every command here is invertible without knowing the document: the inverse
 * carries the values the command is about to overwrite.
 */

/** The kinds of edit a document can be changed by. */
export const CANVAS_COMMANDS = Object.freeze([
  'insert',
  'remove',
  'reparent',
  'update',
  'insert-page',
  'remove-page',
  'set-variables',
  'set-theme',
]);

/** A new node, placed under a parent at a position among its children. */
export function insertCommand({ parent, index, nodes }) {
  return { type: 'insert', parent, index, nodes };
}

/** A node and its subtree, taken out of the document. */
export function removeCommand({ id, parent, index, nodes }) {
  return { type: 'remove', id, parent, index, nodes };
}

/** A node moved to another parent, or to another place among its siblings. */
export function reparentCommand({ id, parent, index, fromParent, fromIndex }) {
  return { type: 'reparent', id, parent, index, fromParent, fromIndex };
}

/**
 * A node's own properties changed.
 *
 * Only the fields that differ are carried, and only those are restored: the
 * children and the parent of a node are not the node's own properties.
 */
export function updateCommand({ id, changes, before }) {
  return { type: 'update', id, changes, before };
}

/** A page, and the subtree under it, placed among the document's pages. */
export function insertPageCommand({ index, nodes }) {
  return { type: 'insert-page', index, nodes };
}

/** A page and its subtree, taken out of the document. */
export function removePageCommand({ id, index, nodes }) {
  return { type: 'remove-page', id, index, nodes };
}

/** The document's variables and collections replaced. */
export function setVariablesCommand({ variables, collections, before }) {
  return { type: 'set-variables', variables, collections, before };
}

/** The document's theme replaced. */
export function setThemeCommand({ theme, before }) {
  return { type: 'set-theme', theme, before };
}

/**
 * The command that undoes this one.
 *
 * The inverse is built from what the command carries, not from the document:
 * undo must work on a document that has moved on since.
 */
export function invertCommand(command) {
  if (!command || typeof command !== 'object') return null;
  switch (command.type) {
    case 'insert':
      // Undoing an insert means taking the nodes back out.
      return { type: 'remove', id: command.nodes?.[0]?.id, parent: command.parent, index: command.index, nodes: command.nodes };
    case 'remove':
      // Undoing a remove means putting the nodes back where they were. Only
      // the root of the removed subtree goes back under the parent: the rest
      // of the subtree belongs under the root, not beside it.
      return {
        type: 'insert',
        parent: command.parent,
        index: command.index,
        nodes: command.nodes?.slice(0, 1),
        restore: command.nodes,
      };
    case 'reparent':
      return { type: 'reparent', id: command.id, parent: command.fromParent, index: command.fromIndex, fromParent: command.parent, fromIndex: command.index };
    case 'update':
      return { type: 'update', id: command.id, changes: command.before || {}, before: command.changes || {} };
    case 'insert-page':
      return { type: 'remove-page', id: command.nodes?.[0]?.id, index: command.index, nodes: command.nodes };
    case 'remove-page':
      return { type: 'insert-page', index: command.index, nodes: command.nodes };
    case 'set-variables':
      return { type: 'set-variables', variables: command.before?.variables, collections: command.before?.collections, before: { variables: command.variables, collections: command.collections } };
    case 'set-theme':
      return { type: 'set-theme', theme: command.before, before: command.theme };
    default:
      return null;
  }
}

/** A short line saying what the command did, for a history list. */
export function describeCommand(command) {
  if (!command || typeof command !== 'object') return '';
  switch (command.type) {
    case 'insert':
      return `Added ${command.nodes?.length || 1} object${command.nodes?.length === 1 ? '' : 's'}`;
    case 'remove':
      return `Removed ${command.nodes?.length || 1} object${command.nodes?.length === 1 ? '' : 's'}`;
    case 'reparent':
      return 'Moved an object';
    case 'update':
      return `Changed ${Object.keys(command.changes || {}).join(', ') || 'an object'}`;
    case 'insert-page':
      return 'Added a page';
    case 'remove-page':
      return 'Removed a page';
    case 'set-variables':
      return 'Changed the variables';
    case 'set-theme':
      return 'Changed the theme';
    default:
      return 'Changed the board';
  }
}
