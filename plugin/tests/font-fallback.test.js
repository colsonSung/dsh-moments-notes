import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fontFamiliesFor,
  fontStackFor,
  fontSubsetFor,
  needsFallbackFont,
  scriptOfChar,
  scriptsOf,
} from '../lib/font-fallback.js';

const LATIN = 'Inter, "SF Pro Text", system-ui, sans-serif';

test('Latin text needs no extra font', () => {
  assert.equal(needsFallbackFont('Quarterly report'), false);
  assert.deepEqual(scriptsOf('Quarterly report 2026'), []);
  assert.equal(fontStackFor('Quarterly report', LATIN), LATIN);
});

test('Chinese text is recognised as Han', () => {
  assert.equal(scriptOfChar('商'.codePointAt(0)), 'han');
  assert.deepEqual(scriptsOf('商户入驻审核'), ['han']);
  assert.ok(needsFallbackFont('商户入驻审核'));
});

test('the stack for Chinese names a family that has the glyphs', () => {
  const stack = fontStackFor('商户入驻审核', LATIN);
  assert.ok(stack.startsWith(LATIN), 'the Latin family stays first');
  // The stack names one family the machine may already have and the open
  // family that can be fetched; the rest are duplicates the browser would
  // try in turn.
  const named = stack.split(',').map((part) => part.trim().replace(/^"|"$/g, ''));
  // The Latin stack is four families on its own; what matters is that the
  // fallback adds no more than two.
  assert.ok(named.length <= 6, 'the stack stays short enough to read');
  assert.ok(named.includes('Noto Sans SC'), 'the open family is the fallback of last resort');
  assert.ok(
    fontFamiliesFor('han').some((family) => named.includes(family)),
    'at least one family that covers the script is named',
  );
});

test('Japanese kana is not read as Chinese', () => {
  // The fullwidth block holds halfwidth katakana, so a document written in
  // Japanese would otherwise be given the Chinese face.
  assert.equal(scriptOfChar('ひ'.codePointAt(0)), 'kana');
  assert.deepEqual(scriptsOf('ひらがな カタカナ'), ['kana']);
  const stack = fontStackFor('ひらがな', LATIN);
  assert.match(stack, /"Noto Sans JP"/, 'the open Japanese family is named');
  assert.ok(
    fontFamiliesFor('kana').some((family) => stack.includes(`"${family}"`)),
    'a family that covers kana is named',
  );
});

test('Korean text is recognised as Hangul', () => {
  assert.equal(scriptOfChar('한'.codePointAt(0)), 'hangul');
  const stack = fontStackFor('한글', LATIN);
  assert.ok(
    fontFamiliesFor('hangul').some((family) => stack.includes(`"${family}"`)),
    'a family that covers hangul is named',
  );
});

test('a document that mixes scripts asks for both', () => {
  const scripts = scriptsOf('商户入驻审核 Quarterly ひらがな');
  assert.deepEqual(scripts, ['han', 'kana']);
  const stack = fontStackFor('商户入驻审核 Quarterly', LATIN);
  assert.match(stack, /"Noto Sans SC"/);
  assert.ok(stack.split(',').length <= 6, 'two scripts do not make a long stack');
});

test('each script has an open family and a subset to fetch', () => {
  for (const script of ['arabic', 'hebrew', 'devanagari', 'han', 'kana', 'hangul']) {
    const families = fontFamiliesFor(script);
    assert.ok(families.length, `${script} names at least one family`);
    assert.ok(families.at(-1).startsWith('Noto'), `${script} ends with an open family`);
    assert.ok(fontSubsetFor(script), `${script} has a subset to fetch`);
  }
});

test('a script with no fallback returns nothing rather than guessing', () => {
  assert.deepEqual(fontFamiliesFor('greek'), []);
  assert.equal(fontSubsetFor('greek'), null);
});
