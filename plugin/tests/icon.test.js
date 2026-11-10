import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const icon = readFileSync(new URL('../icon.svg', import.meta.url), 'utf8');
const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const swift = readFileSync(new URL('../native/MomentsFloat.swift', import.meta.url), 'utf8');

// One geometry for the whole product: an M whose middle valley carries a
// single ember dot. The path string below is the contract.
const MARK_PATH = 'M19 43V21c0-3.2 3.4-4.5 5.2-1.7L32 30.4l7.8-11.1c1.8-2.8 5.2-1.5 5.2 1.7v22';

test('the plugin icon is the warm Moments mark', () => {
  assert.match(icon, /viewBox="0 0 64 64"/, 'uses one 64 unit grid');
  assert.match(icon, /fill="#b5402a"/, 'uses the house seal instead of the old violet');
  assert.doesNotMatch(icon, /#5865d8/i, 'drops the previous violet palette');
  assert.doesNotMatch(icon, /rotate\(/, 'drops the rotated pen');
  assert.match(icon, new RegExp(MARK_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'draws the shared mark path');
  assert.match(icon, /stroke="#fff9f4"/, 'draws the mark in warm off-white');
  assert.match(icon, /<circle cx="32" cy="43.5" r="3" fill="#f2e2da"\/>/, 'keeps one moment dot');
  assert.match(icon, /aria-label="Moments"/, 'stays labelled for assistive technology');
});

test('the sidebar entry reuses the same mark in the host colour', () => {
  assert.match(client, new RegExp(MARK_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'shares one path with the plugin icon');
  assert.doesNotMatch(client, /rotate\(45 12 12\)/, 'drops the rotated pen');
  assert.match(client, /viewBox: '0 0 64 64'/, 'renders on the same grid');
  assert.match(client, /stroke: 'currentColor'/, 'inherits the host colour');
});

test('the desktop float draws the same mark', () => {
  assert.match(swift, /struct MomentsMark: Shape/, 'has one Swift shape for the mark');
  assert.match(swift, /19, 43/, 'uses the same geometry');
  assert.doesNotMatch(swift, /systemName: "note\.text"/, 'drops the generic note symbol');
});
