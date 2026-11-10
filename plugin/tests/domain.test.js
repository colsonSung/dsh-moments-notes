import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LIMITS,
  normalizeTag,
  parseTags,
  expandTags,
  normalizeContent,
  normalizeAttachments,
  validateNote,
  sortNotes,
  filterNotes,
  buildTagIndex,
  buildHeatmap,
  computeStats,
  relatedNotes,
  reviewNotes,
} from '../lib/domain.js';

const PNG_1X1 = 'iVBORw0KGgo=';

function attachment(id = 'attachment-1', data = PNG_1X1) {
  return {
    id,
    name: 'pixel.png',
    type: 'image/png',
    size: Buffer.from(data, 'base64').length,
    dataUrl: `data:image/png;base64,${data}`,
  };
}

function note(id, overrides = {}) {
  return {
    id,
    content: `note ${id}`,
    createdAt: Date.UTC(2025, 0, 1),
    updatedAt: Date.UTC(2025, 0, 2),
    pinned: false,
    deletedAt: null,
    attachments: [],
    ...overrides,
  };
}

test('parseTags extracts unique hierarchical tags without treating headings or embedded hashes as tags', () => {
  const content = [
    '#Work/Project #work/project #Work #标签/子项',
    '# Heading email#a #bad//path #solo',
    'parenthesized (#Another/Child) and #123/valid_tag-name',
  ].join('\n');

  assert.deepEqual(parseTags(content), [
    'work/project',
    'work',
    '标签/子项',
    'bad/path',
    'solo',
    'another/child',
    '123/valid_tag-name',
  ]);
  assert.deepEqual(parseTags('###not-a-heading #yes'), ['not-a-heading', 'yes']);
  assert.deepEqual(parseTags(null), []);
  assert.equal(normalizeTag('  #Work//Project/  '), 'work/project');
  assert.throws(() => normalizeTag('#'), /tag/i);
});

test('expandTags includes each ancestor once and preserves first-seen order', () => {
  assert.deepEqual(expandTags(['work/project/ui', 'work/project', 'personal']), [
    'work',
    'work/project',
    'work/project/ui',
    'personal',
  ]);
});

test('content validation rejects blank and excessive content without trimming meaningful text', () => {
  assert.equal(normalizeContent('  first\nsecond  '), '  first\nsecond  ');
  assert.throws(() => normalizeContent(' \n\t '), /blank|empty|content/i);
  assert.throws(() => normalizeContent(null), /content/i);
  assert.throws(() => normalizeContent('x'.repeat(LIMITS.CONTENT_MAX_LENGTH + 1)), /content|long/i);
});

test('normalizeAttachments creates bounded canonical attachments and verifies real base64 byte size', () => {
  const [normalized] = normalizeAttachments([
    { ...attachment(null), name: ' pixel.png ', ignored: 'drop me' },
  ], () => 'generated-attachment');

  assert.deepEqual(normalized, {
    id: 'generated-attachment',
    name: 'pixel.png',
    type: 'image/png',
    size: 8,
    dataUrl: `data:image/png;base64,${PNG_1X1}`,
  });
  assert.equal(Object.hasOwn(normalized, 'ignored'), false);
  assert.deepEqual(normalizeAttachments(undefined), []);

  assert.throws(() => normalizeAttachments([{ ...attachment(), size: 7 }]), /size|bytes/i);
  assert.throws(() => normalizeAttachments([{ ...attachment(), dataUrl: 'data:image/png;base64,%%%' }]), /base64|dataUrl/i);
  assert.throws(() => normalizeAttachments([{ ...attachment(), type: 'text/plain' }]), /type|MIME/i);
  const svg = 'PHN2Zw==';
  assert.throws(() => normalizeAttachments([{
    id: 'svg', name: 'vector.svg', type: 'image/svg+xml', size: 4,
    dataUrl: `data:image/svg+xml;base64,${svg}`,
  }]), /type|MIME|supported/i);
  assert.throws(() => normalizeAttachments([{ ...attachment(), name: ' ' }]), /name/i);
  assert.throws(() => normalizeAttachments([attachment(), attachment()]), /duplicate/i);
  assert.throws(
    () => normalizeAttachments(Array.from({ length: LIMITS.ATTACHMENTS_PER_NOTE + 1 }, (_, i) => attachment(`a-${i}`))),
    /attachment|many/i,
  );
  assert.throws(
    () => normalizeAttachments([{ ...attachment(), size: LIMITS.ATTACHMENT_BYTES + 1 }]),
    /large|limit|size/i,
  );
});

test('validateNote returns only the persisted note shape and rejects invalid timestamps and duplicate attachments', () => {
  const valid = note('valid', { attachments: [attachment()], extra: 'discard' });
  assert.deepEqual(validateNote(valid), note('valid', { attachments: [attachment()] }));
  assert.throws(() => validateNote(note('bad', { updatedAt: 0 })), /updatedAt/i);
  assert.throws(() => validateNote(note('bad-date', {
    createdAt: Number.MAX_SAFE_INTEGER,
    updatedAt: Number.MAX_SAFE_INTEGER,
  })), /timestamp|date/i);
  assert.throws(() => validateNote(note('bad', { deletedAt: -1 })), /deletedAt/i);
  assert.throws(() => validateNote(note('bad', { pinned: 'yes' })), /pinned/i);
  assert.throws(() => validateNote(note('bad', { attachments: [attachment(), attachment()] })), /duplicate/i);
});

test('filterNotes hides trash by default and supports hierarchical tags, search, pin, dates and pagination', () => {
  const notes = [
    note('child', {
      content: 'Alpha milestone #Work/Project',
      createdAt: Date.UTC(2025, 0, 3),
      updatedAt: Date.UTC(2025, 0, 8),
      pinned: true,
    }),
    note('parent', {
      content: 'alpha parent #work',
      createdAt: Date.UTC(2025, 0, 2),
      updatedAt: Date.UTC(2025, 0, 7),
    }),
    note('other', {
      content: 'Beta #personal',
      createdAt: Date.UTC(2025, 0, 1),
      updatedAt: Date.UTC(2025, 0, 6),
    }),
    note('deleted', {
      content: 'Alpha #work/project',
      deletedAt: Date.UTC(2025, 0, 9),
      updatedAt: Date.UTC(2025, 0, 9),
    }),
  ];

  assert.deepEqual(filterNotes(notes).map(({ id }) => id), ['child', 'parent', 'other']);
  assert.deepEqual(filterNotes(notes, { tag: 'work' }).map(({ id }) => id), ['child', 'parent']);
  assert.deepEqual(filterNotes(notes, { tag: 'work/project' }).map(({ id }) => id), ['child']);
  assert.deepEqual(filterNotes(notes, { query: 'ALPHA', tags: ['work'] }).map(({ id }) => id), ['child', 'parent']);
  assert.deepEqual(filterNotes(notes, { deletedOnly: true }).map(({ id }) => id), ['deleted']);
  assert.deepEqual(filterNotes(notes, { includeDeleted: true }).map(({ id }) => id), ['child', 'deleted', 'parent', 'other']);
  assert.deepEqual(filterNotes(notes, { pinned: true }).map(({ id }) => id), ['child']);
  assert.deepEqual(filterNotes(notes, {
    from: Date.UTC(2025, 0, 2),
    to: Date.UTC(2025, 0, 3),
  }).map(({ id }) => id), ['child', 'parent']);
  assert.deepEqual(filterNotes(notes, { limit: 1, offset: 1 }).map(({ id }) => id), ['parent']);
  assert.deepEqual(filterNotes(notes, { limit: 0 }), []);
});

test('sortNotes supports chronological order while optionally keeping pinned notes first', () => {
  const notes = [
    note('old', { createdAt: 1, updatedAt: 5 }),
    note('new', { createdAt: 3, updatedAt: 1 }),
    note('pinned', { createdAt: 2, updatedAt: 3, pinned: true }),
  ];

  assert.deepEqual(sortNotes(notes, { sort: 'createdAt', order: 'asc', pinnedFirst: false }).map(({ id }) => id), [
    'old', 'pinned', 'new',
  ]);
  assert.deepEqual(sortNotes(notes, { sort: 'created', order: 'asc' }).map(({ id }) => id), [
    'pinned', 'old', 'new',
  ]);
  assert.equal(notes[0].id, 'old', 'sorting does not mutate the input');
});

test('tag index counts each active note once per ancestor', () => {
  const notes = [
    note('one', { content: '#work/project #work/project/ui #work' }),
    note('two', { content: '#work/other' }),
    note('trash', { content: '#work/deleted', deletedAt: 10 }),
  ];

  assert.deepEqual(buildTagIndex(notes), [
    { name: 'work', count: 2 },
    { name: 'work/other', count: 1 },
    { name: 'work/project', count: 1 },
    { name: 'work/project/ui', count: 1 },
  ]);
});

test('heatmap contains every local day including zeros and stats summarize active and deleted notes', () => {
  const now = new Date(2025, 0, 4, 12).getTime();
  const notes = [
    note('today', { createdAt: new Date(2025, 0, 4, 9).getTime(), pinned: true }),
    note('yesterday', { createdAt: new Date(2025, 0, 3, 9).getTime(), attachments: [attachment()] }),
    note('old', { createdAt: new Date(2025, 0, 1, 9).getTime() }),
    note('trash', { createdAt: new Date(2025, 0, 4, 10).getTime(), deletedAt: now }),
  ];

  assert.deepEqual(buildHeatmap(notes, { now, days: 4 }), [
    { date: '2025-01-01', count: 1 },
    { date: '2025-01-02', count: 0 },
    { date: '2025-01-03', count: 1 },
    { date: '2025-01-04', count: 1 },
  ]);
  const stats = computeStats(notes, { now });
  assert.equal(stats.total, 4);
  assert.equal(stats.active, 3);
  assert.equal(stats.trashed, 1);
  assert.equal(stats.pinned, 1);
  assert.equal(stats.attachments, 1);
  assert.equal(stats.today, 1);
  assert.equal(stats.currentStreak, 2);
  assert.equal(stats.longestStreak, 2);
  assert.throws(() => buildHeatmap(notes, { now, days: 0 }), /days/i);
});

test('relatedNotes ranks shared hierarchical tags and text, excluding itself and trash', () => {
  const notes = [
    note('source', { content: 'Alpha planning #work/project', updatedAt: 1 }),
    note('best', { content: 'Different #work/project', updatedAt: 2 }),
    note('some', { content: 'Alpha discussion #personal', updatedAt: 3 }),
    note('unrelated', { content: 'Unconnected #elsewhere', updatedAt: 4 }),
    note('trash', { content: '#work/project', deletedAt: 5 }),
  ];

  assert.deepEqual(relatedNotes(notes, 'source', { limit: 5 }).map(({ id }) => id), ['best', 'some']);
  assert.deepEqual(relatedNotes(notes, 'source', { limit: 1 }).map(({ id }) => id), ['best']);
  assert.deepEqual(relatedNotes(notes, 'missing'), []);
  assert.deepEqual(relatedNotes(notes, 'trash'), []);
});

test('reviewNotes supports deterministic random review and previous-year on-this-day review', () => {
  const now = new Date(2025, 5, 15, 12).getTime();
  const notes = [
    note('old-day', { createdAt: new Date(2024, 5, 15, 8).getTime() }),
    note('other-day', { createdAt: new Date(2024, 5, 14, 8).getTime() }),
    note('today', { createdAt: now }),
    note('deleted-day', { createdAt: new Date(2023, 5, 15, 8).getTime(), deletedAt: now }),
  ];

  const random = reviewNotes(notes, { mode: 'random', limit: 2, random: () => 0 });
  assert.equal(random.length, 2);
  assert.equal(new Set(random.map(({ id }) => id)).size, 2);
  assert.equal(random.some(({ id }) => id === 'deleted-day'), false);
  assert.deepEqual(reviewNotes(notes, { mode: 'on-this-day', now }).map(({ id }) => id), ['old-day']);
  assert.deepEqual(reviewNotes(notes, { mode: 'onThisDay', now: new Date(2025, 11, 31).getTime() }), []);
  assert.throws(() => reviewNotes(notes, { mode: 'future' }), /review|mode/i);
});
