import test from 'node:test';
import assert from 'node:assert/strict';

import { applyOps, describeOps, diffDocument, invertOps } from '../lib/canvas-ops.js';

function shape(id, x, y, overrides = {}) {
  return { id, type: 'shape', x, y, w: 100, h: 50, text: '', members: [], ...overrides };
}

function frame(id, x, y, members = [], overrides = {}) {
  return { id, type: 'frame', x, y, w: 400, h: 300, text: '', members, ...overrides };
}

const key = (nodes) => nodes
  .map((node) => `${node.id}:${node.x},${node.y},${node.w},${node.h},${node.text},[${(node.members || []).join(' ')}]`)
  .sort()
  .join('|');

test('a moved node is a move, not a delete and a create', () => {
  const before = [frame('f1', 0, 0, ['a']), frame('f2', 500, 0, []), shape('a', 10, 10)];
  const after = [frame('f1', 0, 0, []), frame('f2', 500, 0, ['a']), shape('a', 10, 10)];
  const ops = diffDocument(before, after);
  assert.equal(ops.filter((op) => op.op === 'create').length, 0, 'nothing was created');
  assert.equal(ops.filter((op) => op.op === 'delete').length, 0, 'nothing was deleted');
  assert.equal(ops.filter((op) => op.op === 'move').length, 1, 'the node moved');
});

test('a changed field is a patch', () => {
  const before = [shape('a', 10, 10, { text: 'old' })];
  const after = [shape('a', 10, 10, { text: 'new' })];
  const ops = diffDocument(before, after);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].op, 'patch');
  assert.deepEqual(ops[0].fields, { text: 'new' });
});

test('an unchanged document produces no ops', () => {
  const nodes = [frame('f1', 0, 0, ['a']), shape('a', 10, 10)];
  assert.deepEqual(diffDocument(nodes, nodes), []);
});

test('the ops turn the first document into the second', () => {
  const before = [
    frame('f1', 0, 0, ['a', 'b']),
    shape('a', 10, 10, { text: 'first' }),
    shape('b', 30, 30),
  ];
  const after = [
    frame('f1', 5, 5, ['a', 'b', 'c']),
    shape('a', 15, 15, { text: 'second' }),
    shape('b', 30, 30),
    shape('c', 50, 50),
  ];
  const ops = diffDocument(before, after);
  assert.equal(key(applyOps(before, ops)), key(after), 'the ops describe the change exactly');
});

test('a deleted subtree is deleted once, not once per node', () => {
  const before = [frame('f1', 0, 0, ['g1']), frame('g1', 10, 10, ['leaf']), shape('leaf', 20, 20)];
  const after = [frame('f1', 0, 0, [])];
  const ops = diffDocument(before, after);
  assert.equal(ops.filter((op) => op.op === 'delete').length, 1, 'one delete covers the subtree');
  const applied = applyOps(before, ops);
  assert.equal(key(applied), key(after), 'and the subtree is gone');
});

test('the inverse of the ops turns the second document back into the first', () => {
  const before = [
    frame('f1', 0, 0, ['a', 'g1']),
    shape('a', 10, 10, { text: 'first' }),
    frame('g1', 20, 20, ['leaf']),
    shape('leaf', 30, 30),
  ];
  const after = [
    frame('f1', 0, 0, ['a']),
    shape('a', 15, 15, { text: 'second' }),
  ];
  const ops = diffDocument(before, after);
  const undone = applyOps(after, invertOps(ops));
  assert.equal(key(undone), key(before), 'the document is back where it was');
});

test('an op whose target is gone does not take the rest of the board with it', () => {
  const nodes = [shape('a', 10, 10), shape('b', 20, 20)];
  const applied = applyOps(nodes, [{ op: 'patch', id: 'gone', fields: { x: 1 } }]);
  assert.equal(applied.length, 2, 'the board is intact');
});

test('a patch does not change where a node sits in the tree', () => {
  const nodes = [frame('f1', 0, 0, ['a']), shape('a', 10, 10)];
  const applied = applyOps(nodes, [{ op: 'patch', id: 'a', fields: { text: 'new', members: ['other'] } }]);
  assert.deepEqual(applied.find((node) => node.id === 'a').members, [], 'the membership is not a field');
  assert.deepEqual(applied.find((node) => node.id === 'f1').members, ['a'], 'and the tree is untouched');
});

test('the ops describe what happened, in words a person can read', () => {
  const before = [shape('a', 10, 10, { text: 'old' })];
  const after = [shape('a', 10, 10, { text: 'new' })];
  assert.equal(describeOps(diffDocument(before, after)), '1 patch');
});
