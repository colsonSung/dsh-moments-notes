import test from 'node:test';
import assert from 'node:assert/strict';

import { createDesignTools } from '../lib/design-tools.js';
import { createDesignPreviewHandler } from '../lib/design-export.js';
import { normalizeCanvasDocument } from '../lib/canvas-domain.js';

function board() {
  return normalizeCanvasDocument({
    version: 1,
    id: 'board-1',
    title: 'Checkout',
    createdAt: 1,
    updatedAt: 2,
    camera: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'screen', type: 'frame', x: 0, y: 0, w: 800, h: 600, fill: '#ffffff', members: ['title'] },
      { id: 'title', type: 'text', x: 40, y: 40, w: 400, h: 48, text: 'Hello', fontSize: 32 },
    ],
    edges: [],
  });
}

test('every design tool names the board it touched in its card envelope', () => {
  const tools = createDesignTools({ getCanvasStore: () => null });
  const expected = {
    design_begin: 'from-result',
    design_tokens: 'from-args',
    design_nodes: 'from-args',
    design_finish: 'from-args',
    design_inspect: 'from-args',
    design_export: 'from-args',
  };
  for (const tool of tools) {
    assert.equal(typeof tool.output?.presentationMeta, 'function', `${tool.name} carries a card envelope`);
    const fromResult = tool.output.presentationMeta({}, { ok: true, data: { boardId: 'board-1', title: 'Checkout' } });
    assert.equal(fromResult.momentsDesign.boardId, 'board-1', `${tool.name} reads the board id from its result`);
    assert.equal(fromResult.momentsDesign.title, 'Checkout');
    const fromArgs = tool.output.presentationMeta({ boardId: 'board-2' }, { ok: true, data: {} });
    assert.equal(fromArgs.momentsDesign.boardId, 'board-2', `${tool.name} falls back to the call arguments`);
    assert.ok(expected[tool.name], `${tool.name} is one of the design tools`);
  }
});

test('the preview route serves the board as SVG and refuses unusable calls', async () => {
  const store = {
    async load(id) {
      if (id !== 'board-1') {
        const error = new Error('Canvas not found');
        error.code = 'CANVAS_NOT_FOUND';
        throw error;
      }
      return board();
    },
  };
  const handler = createDesignPreviewHandler({ getCanvasStore: () => store });

  const ok = await handler(new Request('http://host/api/moments-notes/design-preview?id=board-1'));
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /image\/svg\+xml/);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  const svg = await ok.text();
  assert.match(svg, /<svg[^>]*width="800"/);
  assert.match(svg, />Hello</);

  const missing = await handler(new Request('http://host/api/moments-notes/design-preview'));
  assert.equal(missing.status, 400);

  const unknown = await handler(new Request('http://host/api/moments-notes/design-preview?id=ghost'));
  assert.equal(unknown.status, 404);

  const unavailable = await createDesignPreviewHandler({ getCanvasStore: () => null })(
    new Request('http://host/api/moments-notes/design-preview?id=board-1'),
  );
  assert.equal(unavailable.status, 503);
});
