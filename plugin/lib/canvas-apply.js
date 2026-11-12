/**
 * Applying edit commands to a document.
 *
 * A command is data; this module turns it into a new document. Every
 * function returns a new list of nodes rather than changing the one it was
 * given, so an undo can be applied to the same document the edit was.
 */

const CONTAINER_TYPES = new Set(['group', 'frame', 'component']);

/** The container that holds a node, and where in its member list. */
function ownerOf(nodes, id) {
  for (const node of nodes) {
    if (!CONTAINER_TYPES.has(node.type)) continue;
    const index = (node.members || []).indexOf(id);
    if (index >= 0) return { parent: node.id, index };
  }
  return { parent: null, index: 0 };
}

/** A container with a new member list. */
function withMembers(nodes, parentId, members) {
  if (!parentId) return nodes;
  return nodes.map((node) => (node.id === parentId ? { ...node, members } : node));
}

/** The subtree under a node, the node first. */
export function subtreeOf(nodes, rootId) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const out = [];
  const walk = (id) => {
    const node = byId.get(id);
    if (!node) return;
    out.push(node);
    for (const memberId of node.members || []) walk(memberId);
  };
  walk(rootId);
  return out;
}

/** The nodes a command adds, without the ones already in the document. */
function withoutExisting(nodes, added) {
  if (!added || !added.length) return nodes;
  const present = new Set(nodes.map((node) => node.id));
  const fresh = added.filter((node) => !present.has(node.id));
  return fresh.length ? [...nodes, ...fresh] : nodes;
}

/**
 * Apply one command.
 *
 * The result is a new list of nodes; the caller keeps the edges and the rest
 * of the document. A command that does not apply (its target is gone) returns
 * the nodes unchanged rather than throwing: the undo stack outlives the
 * document it was built from.
 */
export function applyCommand(nodes, command) {
  if (!command || typeof command !== 'object') return nodes;
  switch (command.type) {
    case 'insert': {
      const parent = command.parent;
      const current = parent ? (nodes.find((node) => node.id === parent)?.members || []) : [];
      const members = [...current];
      const at = Math.max(0, Math.min(members.length, command.index ?? members.length));
      members.splice(at, 0, ...(command.nodes || []).map((node) => node.id));
      // A restore brings back a whole subtree: the root goes under the
      // parent, and the rest of the subtree comes back with its own children.
      const restored = command.restore || command.nodes;
      return withMembers(withoutExisting(nodes, restored), parent, members);
    }
    case 'remove': {
      // The whole subtree goes: leaving a child behind would leave an
      // orphan that the membership rules would then reject.
      const gone = new Set((command.nodes || []).map((node) => node.id));
      const kept = nodes.filter((node) => !gone.has(node.id));
      const parent = command.parent;
      if (!parent) return kept;
      const container = kept.find((node) => node.id === parent);
      if (!container) return kept;
      const members = (container.members || []).filter((id) => !gone.has(id));
      return kept.map((node) => (node.id === parent ? { ...node, members } : node));
    }
    case 'reparent': {
      const fromParent = command.fromParent;
      const toParent = command.parent;
      let next = nodes;
      // The node leaves the container it was in. A node that had no container
      // has nothing to leave, and its place in the tree is its absence.
      if (fromParent) {
        const container = next.find((node) => node.id === fromParent);
        if (container) {
          const members = (container.members || []).filter((id) => id !== command.id);
          next = next.map((node) => (node.id === fromParent ? { ...node, members } : node));
        }
      }
      if (toParent) {
        const container = next.find((node) => node.id === toParent);
        if (container) {
          const members = (container.members || []).filter((id) => id !== command.id);
          const at = Math.max(0, Math.min(members.length, command.index ?? members.length));
          members.splice(at, 0, command.id);
          next = next.map((node) => (node.id === toParent ? { ...node, members } : node));
        }
      }
      return next;
    }
    case 'update': {
      const changes = command.changes || {};
      return nodes.map((node) => {
        if (node.id !== command.id) return node;
        // The children and the parent belong to the tree, not to the node's
        // own properties: a change of a text or a size must not move a node
        // out of its container.
        const { members, ...rest } = node;
        return { ...rest, ...changes, members };
      });
    }
    default:
      return nodes;
  }
}

/**
 * Apply a list of commands in order.
 */
export function applyCommands(nodes, commands) {
  return (commands || []).reduce((current, command) => applyCommand(current, command), nodes);
}

/**
 * The command that records a change to a node's own properties.
 *
 * Only the fields that actually differ are carried, so an update of one text
 * does not make the undo stack carry every property of the node.
 */
export function commandForUpdate(node, changes) {
  const before = {};
  const differing = {};
  for (const [key, value] of Object.entries(changes || {})) {
    if (key === 'members' || key === 'id') continue;
    if (node[key] === value) continue;
    before[key] = node[key];
    differing[key] = value;
  }
  if (!Object.keys(differing).length) return null;
  return { type: 'update', id: node.id, changes: differing, before };
}

/**
 * The command that records a node being added under a parent.
 */
export function commandForInsert(parent, nodes, index) {
  return { type: 'insert', parent: parent?.id ?? null, index, nodes };
}

/**
 * The command that records a node being taken out of the document.
 *
 * The removed subtree travels with the command, so undo puts back exactly
 * what was there rather than a fresh copy.
 */
export function commandForRemove(nodes, id) {
  const removed = subtreeOf(nodes, id);
  const owner = ownerOf(nodes, id);
  return { type: 'remove', id, parent: owner.parent, index: owner.index, nodes: removed };
}

/**
 * The commands that turn one document into another.
 *
 * This is what lets the undo stack hold a change instead of a copy of the
 * whole board: the difference between two states is expressed as commands,
 * and undoing is applying their inverses.
 */
export function diffCommands(beforeNodes, afterNodes) {
  const before = new Map(beforeNodes.map((node) => [node.id, node]));
  const after = new Map(afterNodes.map((node) => [node.id, node]));
  const commands = [];

  // What left the document. A node whose parent also left is part of that
  // parent's subtree: removing the parent takes the child with it, so a
  // separate command for the child would undo it twice.
  const removed = beforeNodes.filter((node) => !after.has(node.id));
  const removedIds = new Set(removed.map((node) => node.id));
  const removedRoots = removed.filter((node) => {
    const owner = ownerOf(beforeNodes, node.id);
    return !owner.parent || !removedIds.has(owner.parent);
  });
  for (const node of removedRoots) {
    commands.push(commandForRemove(beforeNodes, node.id));
  }

  // What arrived, shallowest first, so a parent is in place before its
  // children are added under it.
  const added = afterNodes.filter((node) => !before.has(node.id));
  const addedDepth = (node) => {
    let depth = 0;
    let cursor = node;
    const seen = new Set();
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      const parentId = cursor.id;
      const parent = afterNodes.find((item) => (item.members || []).includes(parentId));
      if (!parent) break;
      depth += 1;
      cursor = parent;
    }
    return depth;
  };
  for (const node of added.sort((a, b) => addedDepth(a) - addedDepth(b))) {
    const owner = ownerOf(afterNodes, node.id);
    commands.push(commandForInsert({ id: owner.parent }, subtreeOf(afterNodes, node.id), owner.index));
  }

  // What stayed but changed. A node that moved to another container is a
  // reparent, not an update: its place in the tree is not its own property.
  for (const node of afterNodes) {
    const old = before.get(node.id);
    if (!old) continue;
    const ownerBefore = ownerOf(beforeNodes, node.id);
    const ownerAfter = ownerOf(afterNodes, node.id);
    if (ownerBefore.parent !== ownerAfter.parent) {
      commands.push({
        type: 'reparent',
        id: node.id,
        parent: ownerAfter.parent,
        index: ownerAfter.index,
        fromParent: ownerBefore.parent,
        fromIndex: ownerBefore.index,
        // A node that had no container is not in the tree; putting it back
        // means taking it out of the one it was put into.
        hadParent: ownerBefore.parent !== null,
      });
    }
    const changes = {};
    for (const key of Object.keys(node)) {
      if (key === 'members' || key === 'id') continue;
      if (old[key] !== node[key]) changes[key] = node[key];
    }
    const command = commandForUpdate(old, changes);
    if (command) commands.push(command);
  }

  return commands;
}
