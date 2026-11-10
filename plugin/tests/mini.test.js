import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMiniPage } from '../lib/mini.js';

test('the mini window is a self-contained capture surface', () => {
  const page = buildMiniPage();
  assert.match(page, /^<!doctype html>/i);
  assert.match(page, /<title>Moments float<\/title>/);
  assert.match(page, /id="mini-editor"/);
  assert.match(page, /id="mini-list"/);
  assert.match(page, /id="mini-save"/);
  assert.match(page, /\/api\/moments-notes/);
  assert.match(page, /method:\s*['"]POST['"]/);
  assert.match(page, /addEventListener\(['"]paste['"]/);
  assert.match(page, /localStorage/);
  assert.doesNotMatch(page, /innerHTML\s*=/, 'renders note text as text, never as markup');
  assert.doesNotMatch(page, /dangerouslySetInnerHTML/, 'never injects markup');
});

test('the mini window keeps its geometry and never fakes an always-on-top pin', () => {
  const page = buildMiniPage();
  assert.match(page, /'moments-mini:geometry'/, 'persists window geometry');
  assert.match(page, /window\.moveTo\(/, 'restores the window position');
  assert.doesNotMatch(page, /mini-pin/, 'offers no pin control');
  assert.doesNotMatch(page, /window\.focus\(\)/, 'never pretends to stay on top');
});

test('the mini window shares the warm Moments visual system', () => {
  const page = buildMiniPage();
  assert.match(page, /--accent:#b5402a/, 'uses the same light seal accent');
  assert.match(page, /--accent:#e4644a/, 'uses the same dark seal accent');
  assert.doesNotMatch(page, /#4f6bed/i, 'removes the unrelated blue accent');
  assert.match(page, /prefers-reduced-motion/, 'respects reduced motion');
  assert.match(page, /<svg[^>]*aria-hidden="true"/, 'uses a real close icon rather than a text glyph');
});

test('the mini list covers loading, permission, partial failure and retry states', () => {
  const page = buildMiniPage();
  assert.match(page, /Loading recent notes/, 'shows a stable loading state');
  assert.match(page, /Permission required/, 'explains how to recover from an unauthorized session');
  assert.match(page, /className="partial"/, 'reports notes that could not be rendered');
  assert.match(page, /Retry failed items/, 'offers a concrete partial-failure recovery path');
  assert.match(page, /id="mini-retry"/, 'keeps a real retry control in the list heading');
  assert.match(page, /mini-retry.*addEventListener|addEventListener.*loadList/, 'wires retry to an actual reload');
});
