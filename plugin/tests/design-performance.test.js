import test from 'node:test';
import assert from 'node:assert/strict';

import { CANVAS_LIMITS, normalizeCanvasDocument } from '../lib/canvas-domain.js';
import { exportHtml, exportSpec, exportSvg } from '../lib/design-export.js';

/** A board at the node ceiling: one screen frame and 499 children. */
function fullBoard() {
  const members = [];
  const nodes = [];
  for (let index = 0; index < CANVAS_LIMITS.NODE_COUNT_MAX - 1; index += 1) {
    const id = `n${index}`;
    members.push(id);
    nodes.push({
      id,
      type: index % 3 === 0 ? 'text' : 'shape',
      shape: 'rect',
      x: (index % 25) * 56,
      y: Math.floor(index / 25) * 40,
      w: 48,
      h: 32,
      text: index % 3 === 0 ? `Row ${index}` : '',
      fontSize: 12,
      fill: index % 2 === 0 ? '#e2e8f0' : null,
    });
  }
  return normalizeCanvasDocument({
    version: 1,
    id: 'perf-board',
    title: 'Bench',
    createdAt: 1,
    updatedAt: 2,
    camera: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'screen', type: 'frame', x: 0, y: 0, w: 1440, h: 900, fill: '#ffffff', members },
      ...nodes,
    ],
    edges: [],
  });
}

test('a full 500-node board validates, exports and stays inside the budget', () => {
  const started = performance.now();
  const document = fullBoard();
  const svg = exportSvg(document);
  const html = exportHtml(document);
  const spec = exportSpec(document);
  const elapsed = performance.now() - started;

  assert.equal(document.nodes.length, CANVAS_LIMITS.NODE_COUNT_MAX);
  assert.match(svg, /<svg[^>]*width="1440"/);
  assert.match(html, /<!doctype html>/);
  assert.equal(spec.nodeCount, CANVAS_LIMITS.NODE_COUNT_MAX);
  assert.ok(elapsed < 2000, `validate + export took ${Math.round(elapsed)}ms, over the 2s budget`);
  console.log(`500-node board: validate + SVG + HTML + spec in ${Math.round(elapsed)}ms`);
});

test('one node past the ceiling is refused instead of silently trimmed', () => {
  const nodes = [];
  const members = [];
  for (let index = 0; index < CANVAS_LIMITS.NODE_COUNT_MAX; index += 1) {
    members.push(`x${index}`);
    nodes.push({ id: `x${index}`, type: 'shape', shape: 'rect', x: 0, y: 0, w: 20, h: 20 });
  }
  assert.throws(() => normalizeCanvasDocument({
    version: 1,
    id: 'too-big',
    createdAt: 0,
    updatedAt: 0,
    nodes: [{ id: 'screen', type: 'frame', x: 0, y: 0, w: 100, h: 100, members }, ...nodes],
    edges: [],
  }), (error) => error.code === 'INVALID_CANVAS');
});
