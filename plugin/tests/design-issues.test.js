import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeDesign,
  contrastRatio,
  fillBehind,
  inkOnFill,
  luminance,
  parseHex,
  textLines,
} from '../lib/design-issues.js';

function board(nodes = [], edges = []) {
  return { nodes, edges };
}

test('a hex colour is parsed, including the short form', () => {
  assert.deepEqual(parseHex('#101418'), { r: 16, g: 20, b: 24 });
  assert.deepEqual(parseHex('#fff'), { r: 255, g: 255, b: 255 });
  assert.equal(parseHex('white'), null);
  assert.equal(parseHex('#12345'), null);
});

test('luminance and contrast match the WCAG numbers for black on white', () => {
  assert.equal(luminance('#000000'), 0);
  assert.equal(luminance('#ffffff'), 1);
  assert.equal(contrastRatio('#000000', '#ffffff'), 21);
  assert.equal(contrastRatio('#9aa0a6', '#ffffff'), 2.64);
  assert.equal(contrastRatio('nope', '#ffffff'), null);
});

test('the ink for a fill is dark on paper and light on night', () => {
  assert.equal(inkOnFill('#ffffff'), '#101418');
  assert.equal(inkOnFill('#101418'), '#f4f6f8');
  assert.equal(inkOnFill('none'), null);
});

test('a text box whose copy needs more lines than it holds is reported', () => {
  const result = analyzeDesign(board([
    { id: 'card', type: 'frame', x: 0, y: 0, w: 320, h: 200, fill: '#ffffff' },
    {
      id: 'body',
      type: 'shape',
      shape: 'rect',
      x: 16,
      y: 16,
      w: 160,
      h: 24,
      fill: '#ffffff',
      text: 'This sentence is far too long for a box that is only twenty four pixels tall',
    },
  ]));
  const overflow = result.issues.find((issue) => issue.code === 'text-overflow');
  assert.ok(overflow, 'the overflow is reported');
  assert.equal(overflow.nodeId, 'body');
  assert.equal(overflow.severity, 'error');
  assert.ok(overflow.detail.needed > overflow.detail.height);
});

test('a text box that fits is not reported', () => {
  const result = analyzeDesign(board([
    { id: 'label', type: 'shape', shape: 'rect', x: 0, y: 0, w: 240, h: 64, fill: '#ffffff', text: 'Short label' },
  ]));
  assert.equal(result.issues.filter((issue) => issue.code === 'text-overflow').length, 0);
});

test('two peers on top of each other are reported, a label inside its card is not', () => {
  const peers = analyzeDesign(board([
    { id: 'a', type: 'shape', shape: 'rect', x: 0, y: 0, w: 120, h: 80, fill: '#ffffff' },
    { id: 'b', type: 'shape', shape: 'rect', x: 20, y: 10, w: 120, h: 80, fill: '#ffffff' },
  ]));
  assert.equal(peers.issues.filter((issue) => issue.code === 'overlap').length, 1);

  const nested = analyzeDesign(board([
    { id: 'card', type: 'shape', shape: 'rect', x: 0, y: 0, w: 320, h: 200, fill: '#ffffff' },
    { id: 'title', type: 'text', x: 16, y: 16, w: 120, h: 24, text: 'Inside', textColor: '#101418' },
  ]));
  assert.equal(nested.issues.filter((issue) => issue.code === 'overlap').length, 0);
});

test('a member hanging outside its frame is reported', () => {
  const result = analyzeDesign(board([
    {
      id: 'frame',
      type: 'frame',
      x: 0,
      y: 0,
      w: 400,
      h: 300,
      fill: '#ffffff',
      members: ['badge'],
    },
    { id: 'badge', type: 'shape', shape: 'rect', x: 380, y: 280, w: 80, h: 40, fill: '#ffecbd' },
  ]));
  const outside = result.issues.find((issue) => issue.code === 'outside-frame');
  assert.ok(outside);
  assert.equal(outside.nodeId, 'badge');
  assert.equal(outside.relatedNodeId, 'frame');
});

test('light ink on a light surface is reported with its measured ratio', () => {
  const result = analyzeDesign(board([
    { id: 'card', type: 'shape', shape: 'rect', x: 0, y: 0, w: 320, h: 120, fill: '#ffffff', text: 'Faint', textColor: '#9aa0a6' },
  ]));
  const contrast = result.issues.find((issue) => issue.code === 'low-contrast');
  assert.ok(contrast);
  assert.equal(contrast.detail.ratio, 2.64);
  assert.equal(contrast.detail.floor, 4.5);
});

test('readable ink is not reported', () => {
  const result = analyzeDesign(board([
    { id: 'card', type: 'shape', shape: 'rect', x: 0, y: 0, w: 320, h: 120, fill: '#ffffff', text: 'Clear', textColor: '#101418' },
  ]));
  assert.equal(result.issues.filter((issue) => issue.code === 'low-contrast').length, 0);
});

test('an empty board says so instead of returning nothing', () => {
  const result = analyzeDesign(board());
  assert.deepEqual(result.issues.map((issue) => issue.code), ['empty-board']);
  assert.equal(result.summary.nodes, 0);
});

test('fill behind a node comes from its container before the nearest cover', () => {
  const nodes = [
    { id: 'frame', type: 'frame', x: 0, y: 0, w: 400, h: 300, fill: '#f5fbff', members: ['card'] },
    { id: 'card', type: 'group', x: 20, y: 20, w: 200, h: 100, members: ['label'] },
    { id: 'label', type: 'text', x: 30, y: 30, w: 120, h: 20, text: 'Hi' },
    { id: 'loose', type: 'text', x: 20, y: 20, w: 100, h: 20, text: 'Floating' },
  ];
  const resolved = fillBehind(nodes);
  assert.equal(resolved.get('label'), '#f5fbff');
  assert.equal(resolved.get('loose'), '#f5fbff');
  assert.equal(resolved.get('frame'), '#f5fbff');
});

test('line counting breaks on width, not on how the text was typed', () => {
  const short = textLines({ text: 'One line', w: 400, fontSize: 14 });
  const long = textLines({ text: 'This is a much longer sentence that will need more than one line', w: 160, fontSize: 14 });
  assert.equal(short, 1);
  assert.ok(long > 1);
  assert.equal(textLines({ text: 'a\nb\nc', w: 400, fontSize: 14 }), 3);
});

test('the summary counts issues by code and never exceeds the cap', () => {
  const nodes = [];
  for (let index = 0; index < 60; index += 1) {
    nodes.push({
      id: `n${index}`,
      type: 'shape',
      shape: 'rect',
      x: index * 5,
      y: 0,
      w: 120,
      h: 60,
      fill: '#ffffff',
      text: 'Too long for such a small box, honestly',
    });
  }
  const result = analyzeDesign(board(nodes));
  assert.ok(result.issues.length <= 40);
  assert.ok(result.summary.byCode['text-overflow'] > 0);
  assert.equal(result.summary.issues, result.issues.length);
});

test('a label is measured against the thing painted under it, not the page behind it', () => {
  // A button is a shape with a sibling label: membership says "page", the
  // picture says "button", and the picture is what a reader sees.
  const result = analyzeDesign(board([
    { id: 'screen', type: 'frame', x: 0, y: 0, w: 1440, h: 900, fill: '#f8fafc', members: ['cta', 'cta-label'] },
    { id: 'nav', type: 'shape', shape: 'rect', x: 0, y: 0, w: 1440, h: 72, fill: '#ffffff' },
    { id: 'cta', type: 'shape', shape: 'rect', x: 1200, y: 16, w: 160, h: 40, fill: '#0f172a' },
    { id: 'cta-label', type: 'text', x: 1232, y: 26, w: 96, h: 20, text: 'Talk to sales', textColor: '#ffffff' },
  ]));
  assert.equal(result.issues.filter((issue) => issue.code === 'low-contrast').length, 0, JSON.stringify(result.issues));
});

test('an auto-generated layer name in a tiny box is not reported as clipped copy', () => {
  const result = analyzeDesign(board([
    { id: 'tiny', type: 'shape', shape: 'rect', x: 0, y: 0, w: 16, h: 16, fill: '#000000', text: 'Rectangle 524' },
    { id: 'copy', type: 'shape', shape: 'rect', x: 40, y: 0, w: 60, h: 16, fill: '#000000', text: 'Card or wallet' },
  ]));
  const codes = result.issues.filter((issue) => issue.code === 'text-overflow').map((issue) => issue.nodeId);
  assert.deepEqual(codes, ['copy'], 'only the sentence someone wrote is reported');
});
