/**
 * The ops a change is made of.
 *
 * The undo stack already records what changed as commands; these are the
 * same idea in the shape a peer needs: an ordered list of small operations
 * that turn one document into another.
 *
 * The difference from the commands is the audience. A command says what
 * happened to a node ("its text became this"). An op says what a peer has to
 * do ("patch node 42, field text"), so it can be applied on a document that
 * has moved on since the op was made.
 */

/** The kinds of op a document change is made of. */
export const CANVAS_OPS = Object.freeze([
  'create',
  'patch',
  'move',
  'delete',
  'doc-patch',
]);

/** A node was added, under a parent, after a sibling. */
export function createOp({ node, parent, after, subtree }) {
  return { op: 'create', node, parent, after, subtree };
}

/** A node's own fields changed. */
export function patchOp({ id, fields, before }) {
  return { op: 'patch', id, fields, before };
}

/** A node changed place among its siblings, or under another parent. */
export function moveOp({ id, parent, after, fromParent, fromAfter }) {
  return { op: 'move', id, parent, after, fromParent, fromAfter };
}

/** A node and its subtree were removed. */
export function deleteOp({ id, node, parent, after, subtree }) {
  return { op: 'delete', id, node, parent, after, subtree };
}

/** A field of the document itself changed. */
export function docPatchOp({ fields }) {
  return { op: 'doc-patch', fields };
}

/** The subtree under a node, the node first. */
function subtreeOf(nodes, rootId) {
  const byId = new Map((nodes || []).map((node) => [node.id, node]));
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

/** The fields of a node that are its own, rather than the tree's. */
function ownFields(node) {
  const { members, ...rest } = node;
  return rest;
}

/**
 * The ops that turn one document into another.
 *
 * The tree is compared by identity, not by value: a node that stayed the
 * same but changed its place is a move, and a node that changed nothing is
 * not in the list at all.
 */
export function diffDocument(before, after, options = {}) {
  const beforeById = new Map((before || []).map((node) => [node.id, node]));
  const afterById = new Map((after || []).map((node) => [node.id, node]));
  const ops = [];

  const ownerOf = (nodes, id) => {
    for (const node of nodes) {
      if (!Array.isArray(node.members)) continue;
      const index = node.members.indexOf(id);
      if (index >= 0) return { parent: node.id, index };
    }
    return { parent: null, index: 0 };
  };

  // What left the document. A node whose parent also left is part of that
  // parent's subtree, and the parent's delete already covers it.
  const gone = (before || []).filter((node) => !afterById.has(node.id));
  const goneIds = new Set(gone.map((node) => node.id));
  for (const node of gone) {
    const owner = ownerOf(before, node.id);
    // A node whose parent also left is part of that parent's subtree, and the
    // parent's delete already covers it.
    if (owner.parent && goneIds.has(owner.parent)) continue;
    const siblings = owner.parent ? (beforeById.get(owner.parent)?.members || []) : [];
    const previous = siblings[owner.index - 1] || null;
    ops.push(deleteOp({
      id: node.id,
      node,
      parent: owner.parent,
      after: previous,
      subtree: subtreeOf(before, node.id),
    }));
  }

  // What arrived.
  for (const node of after || []) {
    if (beforeById.has(node.id)) continue;
    const owner = ownerOf(after, node.id);
    const siblings = owner.parent
      ? (afterById.get(owner.parent)?.members || [])
      : [];
    const previous = siblings[owner.index - 1] || null;
    ops.push(createOp({ node, parent: owner.parent, after: previous }));
  }

  // What stayed but changed.
  for (const node of after || []) {
    const old = beforeById.get(node.id);
    if (!old) continue;
    const ownerBefore = ownerOf(before, node.id);
    const ownerAfter = ownerOf(after, node.id);
    if (ownerBefore.parent !== ownerAfter.parent || ownerBefore.index !== ownerAfter.index) {
      const siblings = ownerAfter.parent
        ? (afterById.get(ownerAfter.parent)?.members || [])
        : [];
      const previous = siblings[ownerAfter.index - 1] || null;
      const oldSiblings = ownerBefore.parent
        ? (beforeById.get(ownerBefore.parent)?.members || [])
        : [];
      const previousBefore = oldSiblings[ownerBefore.index - 1] || null;
      ops.push(moveOp({
        id: node.id,
        parent: ownerAfter.parent,
        after: previous,
        fromParent: ownerBefore.parent,
        fromAfter: previousBefore,
      }));
    }
    const fields = {};
    const previous = {};
    const oldFields = ownFields(old);
    const newFields = ownFields(node);
    for (const [key, value] of Object.entries(newFields)) {
      if (oldFields[key] === value) continue;
      fields[key] = value;
      previous[key] = oldFields[key];
    }
    if (Object.keys(fields).length) {
      // The values a patch replaces are carried only when the ops have to be
      // undone: a version history is only ever applied forwards, and the old
      // values double what it costs.
      ops.push(options.inverse === false
        ? patchOp({ id: node.id, fields })
        : patchOp({ id: node.id, fields, before: previous }));
    }
  }

  return ops;
}

/**
 * The ops that undo a list of ops.
 *
 * Applied in reverse order: the last thing that happened is the first thing
 * that is undone.
 */
export function invertOps(ops) {
  return [...(ops || [])].reverse().map((op) => {
    switch (op.op) {
      case 'create':
        return deleteOp({ id: op.node?.id });
      case 'delete':
        // The node comes back with the subtree it held: a delete covers the
        // whole branch, and its inverse has to restore the whole branch.
        return createOp({
          node: op.node,
          parent: op.parent,
          after: op.after,
          subtree: op.subtree,
        });
      case 'move':
        // The inverse moves the node back where it came from: into the parent
        // it left, after the sibling it followed.
        return moveOp({
          id: op.id,
          parent: op.fromParent,
          after: op.fromAfter,
          fromParent: op.parent,
          fromAfter: op.after,
        });
      case 'patch':
        return patchOp({ id: op.id, fields: op.before || {} });
      case 'doc-patch':
        return docPatchOp({ fields: op.before || {} });
      default:
        return op;
    }
  });
}

/**
 * Apply a list of ops to a document.
 *
 * The result is a new list of nodes. An op whose target is gone is skipped:
 * a peer that missed an op should not lose the rest of the board.
 */
export function applyOps(nodes, ops) {
  let next = [...(nodes || [])];
  for (const op of ops || []) {
    switch (op.op) {
      case 'create': {
        if (!op.node) break;
        if (next.some((node) => node.id === op.node.id)) break;
        // A restore brings back a whole subtree: the root goes under the
        // parent, and the rest of the branch comes with it.
        next = [...next, ...(op.subtree || [op.node])];
        if (op.parent) {
          next = next.map((node) => {
            if (node.id !== op.parent) return node;
            const members = [...(node.members || [])];
            const at = op.after ? members.indexOf(op.after) + 1 : members.length;
            members.splice(at < 0 ? members.length : at, 0, op.node.id);
            return { ...node, members };
          });
        }
        break;
      }
      case 'patch': {
        next = next.map((node) => {
          if (node.id !== op.id) return node;
          const { members, ...rest } = node;
          return { ...rest, ...(op.fields || {}), members };
        });
        break;
      }
      case 'move': {
        // The node leaves the container it was in. A move to no parent means
        // the node is not in the tree any more, but the node itself stays.
        if (op.fromParent) {
          next = next.map((node) => {
            if (node.id !== op.fromParent) return node;
            const members = (node.members || []).filter((id) => id !== op.id);
            return { ...node, members };
          });
        }
        if (op.parent) {
          next = next.map((node) => {
            if (node.id !== op.parent) return node;
            const members = (node.members || []).filter((id) => id !== op.id);
            const at = op.after ? members.indexOf(op.after) + 1 : members.length;
            members.splice(at < 0 ? members.length : at, 0, op.id);
            return { ...node, members };
          });
        }
        break;
      }
      case 'delete': {
        // The node goes with everything under it: a child left behind would
        // point at a parent that is no longer there.
        const byId = new Map(next.map((node) => [node.id, node]));
        const gone = new Set();
        const walk = (id) => {
          if (gone.has(id)) return;
          gone.add(id);
          const node = byId.get(id);
          for (const memberId of node?.members || []) walk(memberId);
        };
        walk(op.id);
        next = next
          .filter((node) => !gone.has(node.id))
          .map((node) => ({
            ...node,
            members: (node.members || []).filter((id) => !gone.has(id)),
          }));
        break;
      }
      default:
        break;
    }
  }
  return next;
}

/**
 * A short line saying what the ops did, for a log a person can read.
 */
export function describeOps(ops) {
  const counts = new Map();
  for (const op of ops || []) counts.set(op.op, (counts.get(op.op) || 0) + 1);
  return [...counts.entries()].map(([op, count]) => `${count} ${op}`).join(', ');
}
