import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeCanvasDocument, repairEscapedMembers } from '../lib/canvas-domain.js';

function shape(id, x, y, overrides = {}) {
  return { id, type: 'shape', x, y, w: 176, h: 80, text: '', ...overrides };
}

function frame(id, x, y, w, h, members, overrides = {}) {
  return { id, type: 'frame', x, y, w, h, members, text: '', ...overrides };
}

test('a container whose members were flung away gets them back', () => {
  const nodes = [
    frame('f1', 27270, 3839, 2362, 953, ['m1', 'm2']),
    shape('m1', -37228, 3274),
    shape('m2', -36956, 3274),
  ];
  repairEscapedMembers(nodes);
  const container = nodes[0];
  assert.ok(container.members.every((id) => {
    const member = nodes.find((node) => node.id === id);
    return member.x >= container.x && member.y >= container.y
      && member.x + member.w <= container.x + container.w
      && member.y + member.h <= container.y + container.h;
  }), 'every member is inside the frame again');
});

test('the repair keeps the arrangement the members had with each other', () => {
  const nodes = [
    frame('f1', 27270, 3839, 2362, 953, ['m1', 'm2']),
    shape('m1', -37228, 3274),
    shape('m2', -36956, 3274),
  ];
  const spacingBefore = nodes[2].x - nodes[1].x;
  repairEscapedMembers(nodes);
  assert.equal(nodes[2].x - nodes[1].x, spacingBefore, 'the members keep their spacing');
  assert.equal(nodes[0].x, 27270, 'the frame itself stays where it was');
});

test('a member that merely pokes out of the edge is left where it is', () => {
  const nodes = [
    frame('f1', 0, 0, 400, 300, ['m1']),
    shape('m1', -30, 40),
  ];
  repairEscapedMembers(nodes);
  assert.equal(nodes[1].x, -30, 'a loose child is not dragged back in');
});

test('a container whose members are inside it is not moved at all', () => {
  const nodes = [
    frame('f1', 0, 0, 400, 300, ['m1']),
    shape('m1', 40, 40),
  ];
  repairEscapedMembers(nodes);
  assert.equal(nodes[1].x, 40);
});

test('the repair reaches a saved document', () => {
  const document = normalizeCanvasDocument({
    version: 1,
    title: 'Board',
    nodes: [
      frame('f1', 27270, 3839, 2362, 953, ['m1']),
      shape('m1', -37228, 3274),
    ],
    edges: [],
  }, { id: 'canvas-1' });
  const container = document.nodes.find((node) => node.id === 'f1');
  const member = document.nodes.find((node) => node.id === 'm1');
  assert.ok(member.x >= container.x, 'the member is back inside its frame');
});
