import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyCommand,
  applyCommands,
  commandForInsert,
  commandForRemove,
  commandForUpdate,
  diffCommands,
  subtreeOf,
} from '../lib/canvas-apply.js';
import { invertCommand } from '../lib/canvas-commands.js';

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

test('an insert puts the node under its parent at the given place', () => {
  const nodes = [frame('f1', 0, 0, ['a', 'c']), shape('a', 10, 10), shape('c', 30, 30)];
  const next = applyCommand(nodes, commandForInsert({ id: 'f1' }, [shape('b', 20, 20)], 1));
  const container = next.find((node) => node.id === 'f1');
  assert.deepEqual(container.members, ['a', 'b', 'c']);
  assert.ok(next.some((node) => node.id === 'b'));
});

test('a remove takes the whole subtree, not only the node', () => {
  const nodes = [
    frame('f1', 0, 0, ['g1']),
    frame('g1', 10, 10, ['leaf']),
    shape('leaf', 20, 20),
  ];
  const next = applyCommand(nodes, commandForRemove(nodes, 'g1'));
  assert.ok(!next.some((node) => node.id === 'g1'), 'the group is gone');
  assert.ok(!next.some((node) => node.id === 'leaf'), 'its child goes with it');
  assert.deepEqual(next.find((node) => node.id === 'f1').members, [], 'the parent no longer lists it');
});

test('an update changes the fields it names and leaves the tree alone', () => {
  const nodes = [frame('f1', 0, 0, ['a']), shape('a', 10, 10)];
  const target = nodes.find((node) => node.id === 'a');
  const command = commandForUpdate(target, { text: 'new text', x: 99, members: ['other'] });
  const next = applyCommand(nodes, command);
  const changed = next.find((node) => node.id === 'a');
  assert.equal(changed.text, 'new text');
  assert.equal(changed.x, 99);
  assert.deepEqual(changed.members, [], 'the membership is not the node\'s own property');
});

test('an update carries only the fields that differ', () => {
  const node = shape('a', 10, 10);
  const command = commandForUpdate(node, { x: 10, y: 20 });
  assert.deepEqual(Object.keys(command.changes), ['y'], 'a field that did not change is not carried');
  assert.equal(command.before.y, 10);
});

test('the inverse of an update restores the fields it changed', () => {
  const node = shape('a', 10, 10, { text: 'old' });
  const command = commandForUpdate(node, { text: 'new', x: 40 });
  const inverse = invertCommand(command);
  const restored = applyCommand([{ ...node, text: 'new', x: 40 }], inverse);
  assert.equal(restored[0].text, 'old');
  assert.equal(restored[0].x, 10);
});

test('the inverse of an insert removes it again', () => {
  const nodes = [frame('f1', 0, 0, ['a']), shape('a', 10, 10)];
  const command = commandForInsert({ id: 'f1' }, [shape('b', 20, 20)], 1);
  const after = applyCommand(nodes, command);
  const undone = applyCommand(after, invertCommand(command));
  assert.equal(key(undone), key(nodes), 'the document is back where it was');
});

test('the inverse of a remove puts the subtree back where it was', () => {
  const nodes = [frame('f1', 0, 0, ['a', 'g1']), shape('a', 10, 10), frame('g1', 20, 20, ['leaf']), shape('leaf', 30, 30)];
  const command = commandForRemove(nodes, 'g1');
  const after = applyCommand(nodes, command);
  const undone = applyCommand(after, invertCommand(command));
  assert.equal(key(undone), key(nodes), 'the document is back where it was');
});

test('a reparent moves a node between containers', () => {
  const nodes = [frame('f1', 0, 0, ['a']), frame('f2', 100, 0, []), shape('a', 10, 10)];
  const command = { type: 'reparent', id: 'a', parent: 'f2', index: 0, fromParent: 'f1', fromIndex: 0 };
  const next = applyCommand(nodes, command);
  assert.deepEqual(next.find((node) => node.id === 'f1').members, []);
  assert.deepEqual(next.find((node) => node.id === 'f2').members, ['a']);
});

test('the diff between two documents undoes back to the first', () => {
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
  const commands = diffCommands(before, after);
  assert.ok(commands.length >= 3, 'the diff found the edits');
  const changed = applyCommands(before, commands);
  assert.equal(key(changed), key(after), 'the commands turn the first document into the second');
  const undone = applyCommands(after, commands.map(invertCommand).reverse());
  assert.equal(key(undone), key(before), 'and their inverses turn it back');
});

test('the diff between two documents is empty when nothing changed', () => {
  const nodes = [frame('f1', 0, 0, ['a']), shape('a', 10, 10)];
  assert.deepEqual(diffCommands(nodes, nodes), []);
});

test('a diff that removes a whole group leaves nothing behind', () => {
  const before = [frame('f1', 0, 0, ['g1']), frame('g1', 10, 10, ['leaf']), shape('leaf', 20, 20)];
  const after = [frame('f1', 0, 0, [])];
  const commands = diffCommands(before, after);
  const result = applyCommands(before, commands);
  assert.equal(key(result), key(after));
  const undone = applyCommands(after, commands.map(invertCommand).reverse());
  assert.equal(key(undone), key(before), 'undo brings the group and its child back');
});

test('a diff that moves a node between containers is undone as a move', () => {
  const before = [frame('f1', 0, 0, ['a']), frame('f2', 100, 0, []), shape('a', 10, 10)];
  const after = [frame('f1', 0, 0, []), frame('f2', 100, 0, ['a']), shape('a', 10, 10)];
  const commands = diffCommands(before, after);
  const result = applyCommands(before, commands);
  assert.equal(key(result), key(after), 'the node moved');
  const undone = applyCommands(after, commands.map(invertCommand).reverse());
  assert.equal(key(undone), key(before), 'and undo moves it back');
});

test('the subtree of a node is the node and everything under it', () => {
  const nodes = [frame('f1', 0, 0, ['g1']), frame('g1', 10, 10, ['leaf']), shape('leaf', 20, 20)];
  assert.deepEqual(subtreeOf(nodes, 'g1').map((node) => node.id), ['g1', 'leaf']);
});
