/**
 * Fonts that cover the scripts a document actually uses.
 *
 * The stacks in the canvas are Latin: Inter, SF Pro, Georgia, SF Mono. A
 * document that says 商户入驻审核 has no glyph in any of them, so the text
 * falls back to whatever the system offers — which is tofu on a machine with
 * no CJK font, and a different face on every machine.
 *
 * The fix is the same as desigma's: detect the script the text is written in,
 * and name a font that covers it, preferring one the machine already has and
 * falling back to an open family that can be fetched.
 */

/** The scripts whose glyphs a Latin stack cannot cover. */
export const CANVAS_SCRIPTS = Object.freeze(['arabic', 'hebrew', 'devanagari', 'han', 'kana', 'hangul']);

/** The open family that covers each script. */
const SCRIPT_FAMILY = Object.freeze({
  arabic: 'Noto Sans Arabic',
  hebrew: 'Noto Sans Hebrew',
  devanagari: 'Noto Sans Devanagari',
  han: 'Noto Sans SC',
  kana: 'Noto Sans JP',
  hangul: 'Noto Sans KR',
});

/** The Fontsource subset that holds each script's glyphs. */
const SCRIPT_SUBSET = Object.freeze({
  arabic: 'arabic',
  hebrew: 'hebrew',
  devanagari: 'devanagari',
  han: 'chinese-simplified',
  kana: 'japanese',
  hangul: 'korean',
});

/**
 * Families a machine may already have that cover the script.
 *
 * These are the ones worth naming before anything is fetched: a font that is
 * installed renders without a download, and without a network.
 */
const SYSTEM_ALTERNATIVES = Object.freeze({
  han: [
    'Noto Sans CJK SC', 'Noto Sans CJK JP', 'Source Han Sans SC', 'PingFang SC',
    'Hiragino Sans GB', 'Hiragino Sans', 'Heiti SC', 'Microsoft YaHei', 'SimSun',
    'WenQuanYi Micro Hei', 'WenQuanYi Zen Hei',
  ],
  kana: [
    'Noto Sans CJK JP', 'Hiragino Sans', 'Yu Gothic', 'Meiryo',
    'Microsoft YaHei', 'WenQuanYi Micro Hei', 'WenQuanYi Zen Hei',
  ],
  hangul: [
    'Noto Sans CJK KR', 'Apple SD Gothic Neo', 'Malgun Gothic', 'NanumGothic',
    'WenQuanYi Micro Hei', 'WenQuanYi Zen Hei',
  ],
  arabic: ['Geeza Pro', 'Al Bayan', 'Baghdad', 'Damascus', 'Noto Sans Arabic'],
  hebrew: ['Arial Hebrew', 'Noto Sans Hebrew'],
  devanagari: ['Kohinoor Devanagari', 'Devanagari Sangam MN', 'Noto Sans Devanagari'],
});

/**
 * The families that have to be fetched.
 *
 * A family outside this set is one the machine may already have, which is
 * what the browser should try first.
 */
const OPEN_FAMILIES = new Set([
  'Noto Sans Arabic', 'Noto Sans Hebrew', 'Noto Sans Devanagari',
  'Noto Sans SC', 'Noto Sans JP', 'Noto Sans KR',
]);

/** The characters that decide which script a piece of text is written in. */
const SCRIPT_RANGES = Object.freeze([
  ['arabic', [[0x0600, 0x06ff], [0x0750, 0x077f], [0x08a0, 0x08ff], [0xfb50, 0xfdff], [0xfe70, 0xfeff]]],
  ['hebrew', [[0x0590, 0x05ff], [0xfb1d, 0xfb4f]]],
  ['devanagari', [[0x0900, 0x097f], [0xa8e0, 0xa8ff]]],
  // Kana is checked before Han: the fullwidth block holds the halfwidth
  // katakana, and a document written in Japanese would otherwise look
  // Chinese.
  ['kana', [[0x3040, 0x30ff], [0x31f0, 0x31ff], [0xff65, 0xff9f]]],
  ['hangul', [[0xac00, 0xd7af], [0x1100, 0x11ff], [0x3130, 0x318f], [0xa960, 0xa97f], [0xd7b0, 0xd7ff], [0xffa0, 0xffdc]]],
  ['han', [
    [0x4e00, 0x9fff], [0x3400, 0x4dbf], [0xf900, 0xfaff], [0x20000, 0x3134f],
    [0x2e80, 0x2fdf], [0x3000, 0x303f], [0xfe30, 0xfe4f], [0xff01, 0xff60],
  ]],
]);

/**
 * The script a character belongs to.
 *
 * Returns null for the Latin and other scripts the default stack covers.
 */
export function scriptOfChar(codePoint) {
  for (const [script, ranges] of SCRIPT_RANGES) {
    for (const [from, to] of ranges) {
      if (codePoint >= from && codePoint <= to) return script;
    }
  }
  return null;
}

/**
 * The scripts a piece of text needs.
 *
 * A document can mix scripts: Chinese labels with an English heading. Every
 * script that appears is reported, in the order the range table lists them.
 */
export function scriptsOf(text) {
  const found = new Set();
  for (const character of String(text || '')) {
    const script = scriptOfChar(character.codePointAt(0));
    if (script) found.add(script);
  }
  return CANVAS_SCRIPTS.filter((script) => found.has(script));
}

/**
 * The family names that cover a script, best first.
 *
 * A family the machine already has comes before the one that has to be
 * fetched: the first that exists is the one the renderer will use.
 */
export function fontFamiliesFor(script) {
  const open = SCRIPT_FAMILY[script];
  if (!open) return [];
  const system = SYSTEM_ALTERNATIVES[script] || [];
  return [...new Set([...system, open])];
}

/**
 * The Fontsource subset that holds a script's glyphs.
 */
export function fontSubsetFor(script) {
  return SCRIPT_SUBSET[script] || null;
}

/**
 * The font stack that renders a piece of text.
 *
 * The Latin stack stays first for the characters it covers, and the script
 * that needs more comes after it: a font stack is a list, and the browser
 * uses the first family that has the glyph.
 *
 * The list is kept short on purpose. A stack of fifteen families is a stack
 * nobody can read, and every extra name is a lookup the browser does for
 * every character: two installed fonts and one open family cover the same
 * characters as fifteen names.
 */
export function fontStackFor(text, baseStack) {
  const scripts = scriptsOf(text);
  if (!scripts.length) return baseStack;
  const families = [];
  for (const script of scripts) {
    for (const family of fontFamiliesFor(script)) {
      if (!families.includes(family)) families.push(family);
    }
  }
  // Two families are enough: the first one the machine already has, and the
  // open family that can be fetched. The rest are duplicates that the browser
  // would try in turn, and a stack of fifteen names is a stack nobody reads.
  const installed = families.find((family) => !OPEN_FAMILIES.has(family));
  const open = families.find((family) => OPEN_FAMILIES.has(family));
  const chosen = [...new Set([installed, open].filter(Boolean))];
  return [baseStack, ...chosen.map((family) => `"${family}"`)].join(', ');
}

/**
 * Whether a piece of text needs a font beyond the default stack.
 */
export function needsFallbackFont(text) {
  return scriptsOf(text).length > 0;
}
