import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeCanvasDocument } from '../lib/canvas-domain.js';
import { openCanvasRepository } from '../lib/canvas-repository.js';
import { createDesignTools } from '../lib/design-tools.js';
import { exportSpec } from '../lib/design-export.js';

function board(extra = {}) {
  return normalizeCanvasDocument({
    version: 1,
    id: 'board-1',
    title: 'Tokens',
    createdAt: 1,
    updatedAt: 2,
    camera: { x: 0, y: 0, zoom: 1 },
    tokens: {
      colors: { brand: '#635bff', ink: '#0f172a' },
      gradients: { cta: { from: '#635bff', to: '#8b83ff', angle: 135 } },
      type: { title: { fontFamily: 'display', fontSize: 40, fontWeight: 800, lineHeight: 1.05 } },
    },
    nodes: [
      { id: 'screen', type: 'frame', x: 0, y: 0, w: 1440, h: 900, fillToken: 'ink', members: ['headline', 'cta'] },
      { id: 'headline', type: 'text', x: 64, y: 80, w: 600, h: 60, text: 'Hello', typeToken: 'title', textColorToken: 'brand' },
      { id: 'cta', type: 'shape', shape: 'rect', x: 64, y: 200, w: 200, h: 56, gradientToken: 'cta', radius: 12, shadow: { x: 0, y: 10, blur: 24, color: '#000000', opacity: 0.4 }, shadowColorToken: 'brand' },
    ],
    edges: [],
    ...extra,
  });
}

test('a token reference resolves into the literal every renderer reads, and the reference survives', () => {
  const document = board();
  const byId = new Map(document.nodes.map((node) => [node.id, node]));
  assert.equal(byId.get('screen').fill, '#0f172a');
  assert.equal(byId.get('screen').fillToken, 'ink');
  const headline = byId.get('headline');
  assert.equal(headline.textColor, '#635bff');
  assert.equal(headline.textColorToken, 'brand');
  assert.equal(headline.fontSize, 40);
  assert.equal(headline.fontWeight, 800);
  assert.equal(headline.fontFamily, 'display');
  assert.equal(headline.lineHeight, 1.05);
  assert.equal(headline.typeToken, 'title');
  const cta = byId.get('cta');
  assert.deepEqual(cta.gradient, { from: '#635bff', to: '#8b83ff', angle: 135 });
  assert.equal(cta.gradientToken, 'cta');
  assert.equal(cta.shadow.color, '#635bff');
  assert.equal(cta.shadowColorToken, 'brand');
  assert.equal(cta.shadow.opacity, 0.4);
});

test('an unknown token is ignored instead of failing the whole save', () => {
  const document = normalizeCanvasDocument({
    version: 1,
    id: 'board-1',
    createdAt: 0,
    updatedAt: 0,
    tokens: { colors: {}, gradients: {}, type: {} },
    nodes: [{ id: 'n1', type: 'shape', shape: 'rect', x: 0, y: 0, w: 20, h: 20, fill: '#111111', fillToken: 'missing' }],
    edges: [],
  });
  assert.equal(document.nodes[0].fill, '#111111');
  assert.equal(document.nodes[0].fillToken, 'missing');
});

test('tokens reject unusable names and values', () => {
  const cases = [
    [{ colors: { 'Brand Blue': '#635bff' } }, /token name/],
    [{ colors: { brand: 'blue' } }, /must be #rgb or #rrggbb/],
    [{ gradients: { cta: { from: '#635bff', angle: 90 } } }, /both from and to/],
    [{ type: { title: { fontWeight: 450 } } }, /fontWeight/],
  ];
  for (const [tokens, pattern] of cases) {
    assert.throws(() => normalizeCanvasDocument({
      version: 1, id: 'board-1', createdAt: 0, updatedAt: 0, tokens,
      nodes: [{ id: 'n1', type: 'sticky', x: 0, y: 0, w: 20, h: 20 }], edges: [],
    }), pattern);
  }
});

test('editing a token re-resolves every node that references it, and the repository keeps tokens', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'moments-tokens-'));
  const repository = await openCanvasRepository({ filePath: join(directory, 'canvases.json') });
  try {
    const created = await repository.create({ title: 'Tokens' });
    const document = board();
    const saved = await repository.save(created.id, {
      title: 'Tokens',
      nodes: document.nodes,
      edges: document.edges,
      camera: document.camera,
      tokens: document.tokens,
    });
    const before = saved.nodes.find((node) => node.id === 'headline');
    assert.equal(before.textColor, '#635bff');

    const restyled = await repository.save(created.id, {
      title: 'Tokens',
      nodes: saved.nodes,
      edges: saved.edges,
      camera: saved.camera,
      tokens: { ...saved.tokens, colors: { ...saved.tokens.colors, brand: '#e11d48' } },
    });
    const after = restyled.nodes.find((node) => node.id === 'headline');
    assert.equal(after.textColor, '#e11d48');
    assert.equal(after.textColorToken, 'brand');
    // A save that does not mention tokens keeps the board's tokens.
    const untouched = await repository.save(created.id, {
      title: 'Tokens',
      nodes: restyled.nodes,
      edges: restyled.edges,
      camera: restyled.camera,
    });
    assert.equal(untouched.tokens.colors.brand, '#e11d48');
  } finally {
    repository.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('the design_tokens tool merges, cascades and reports what uses tokens', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'moments-tokens-tool-'));
  const repository = await openCanvasRepository({ filePath: join(directory, 'canvases.json') });
  const toolByName = new Map(createDesignTools({ getCanvasStore: () => repository }).map((tool) => [tool.name, tool]));
  const designTokens = toolByName.get('design_tokens');
  const designNodes = toolByName.get('design_nodes');
  try {
    const created = await repository.create({ title: 'Tool' });
    const document = board();
    await repository.save(created.id, {
      title: 'Tool', nodes: document.nodes, edges: document.edges, camera: document.camera, tokens: document.tokens,
    });

    const result = await designTokens.execute({
      boardId: created.id,
      colors: { brand: '#e11d48', muted: '#475569' },
      type: { body: { fontSize: 16, lineHeight: 1.6 } },
    });
    assert.equal(result.ok, true);
    assert.equal(result.data.tokens.colors.brand, '#e11d48');
    assert.equal(result.data.tokens.colors.ink, '#0f172a', 'merge keeps untouched tokens');
    assert.equal(result.data.tokens.type.body.fontSize, 16);
    assert.ok(result.data.tokenedNodes >= 2);

    const stored = await repository.load(created.id);
    assert.equal(stored.nodes.find((node) => node.id === 'headline').textColor, '#e11d48');

    const replaced = await designTokens.execute({ boardId: created.id, mode: 'replace', colors: { brand: '#22c55e' } });
    assert.equal(replaced.ok, true);
    assert.deepEqual(Object.keys(replaced.data.tokens.colors), ['brand']);
    assert.equal(replaced.data.tokens.type.title, undefined);

    const unknown = await designNodes.execute({
      boardId: created.id,
      ops: [{ op: 'insert', node: { id: 'ghost', type: 'shape', x: 0, y: 0, w: 20, h: 20, fillToken: 'nope' } }],
    });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.data.error.code, 'UNKNOWN_TOKEN');
    assert.match(unknown.data.error.message, /Available: brand/);

    const bad = await designTokens.execute({ boardId: created.id, colors: { brand: 'not-a-colour' } });
    assert.equal(bad.ok, false);
    assert.equal(bad.data.error.code, 'INVALID_TOKEN');
  } finally {
    repository.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('the exported spec carries the board tokens', () => {
  const spec = exportSpec(board());
  assert.deepEqual(spec.tokens.colors, { brand: '#635bff', ink: '#0f172a' });
  assert.equal(spec.tokens.type.title.fontSize, 40);
  assert.equal(spec.tokens.gradients.cta.angle, 135);
});
