import { randomUUID } from 'node:crypto';

export const LIMITS = Object.freeze({
  CONTENT_MAX_LENGTH: 50_000,
  ID_MAX_LENGTH: 256,
  ATTACHMENT_NAME_MAX_LENGTH: 255,
  ATTACHMENTS_PER_NOTE: 8,
  ATTACHMENT_BYTES: 5 * 1024 * 1024,
  ATTACHMENTS_TOTAL_BYTES: 10 * 1024 * 1024,
});

const TAG_SOURCE = '[\\p{L}\\p{N}_-]+(?:/+[\\p{L}\\p{N}_-]+)*';
const TAG_PATTERN = new RegExp(`#(${TAG_SOURCE})`, 'gu');
const EMBEDDED_BEFORE = /[\p{L}\p{N}_]/u;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function error(message, code = 'VALIDATION_ERROR') {
  const result = new Error(message);
  result.code = code;
  return result;
}

function normalizeId(value, label = 'id') {
  if (typeof value !== 'string' || !value.trim()) {
    throw error(`${label} must be a non-empty string`);
  }
  const id = value.trim();
  if (id.length > LIMITS.ID_MAX_LENGTH) {
    throw error(`${label} exceeds ${LIMITS.ID_MAX_LENGTH} characters`);
  }
  return id;
}

function timestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).getTime())) {
    throw error(`${label} must be a valid non-negative integer timestamp`);
  }
  return value;
}

export function normalizeContent(content, options = {}) {
  if (typeof content !== 'string') {
    throw error('Note content must be a string');
  }
  if (!options.allowBlank && !content.trim()) {
    throw error('Note content cannot be blank');
  }
  if (content.length > LIMITS.CONTENT_MAX_LENGTH) {
    throw error(`Note content exceeds ${LIMITS.CONTENT_MAX_LENGTH} characters`);
  }
  return content;
}

export function normalizeTag(tag) {
  if (typeof tag !== 'string') {
    throw error('Tag must be a string');
  }
  const source = tag.normalize('NFKC').trim().replace(/^#/, '');
  const segments = source.split('/').filter((segment) => segment.trim()).map((segment) => segment.trim());
  if (!segments.length || segments.some((segment) => !/^[\p{L}\p{N}_-]+$/u.test(segment))) {
    throw error(`Invalid tag: ${tag}`);
  }
  const normalized = segments.join('/').toLocaleLowerCase();
  if (normalized.length > 200) {
    throw error('Tag exceeds 200 characters');
  }
  return normalized;
}

export function parseTags(content) {
  if (typeof content !== 'string') return [];
  const tags = [];
  const seen = new Set();
  for (const match of content.matchAll(TAG_PATTERN)) {
    const previous = match.index > 0 ? content[match.index - 1] : '';
    if (EMBEDDED_BEFORE.test(previous)) continue;
    let tag;
    try {
      tag = normalizeTag(match[1]);
    } catch {
      continue;
    }
    if (!seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
  }
  return tags;
}

export function expandTags(tags) {
  const expanded = [];
  const seen = new Set();
  for (const value of tags || []) {
    const tag = normalizeTag(value);
    const segments = tag.split('/');
    for (let index = 1; index <= segments.length; index += 1) {
      const ancestor = segments.slice(0, index).join('/');
      if (!seen.has(ancestor)) {
        seen.add(ancestor);
        expanded.push(ancestor);
      }
    }
  }
  return expanded;
}

function decodeDataUrl(dataUrl, expectedType) {
  if (typeof dataUrl !== 'string') {
    throw error('Attachment dataUrl must be a base64 data URL');
  }
  const match = /^data:([^,]+),([\s\S]*)$/.exec(dataUrl);
  if (!match) throw error('Attachment dataUrl must be a base64 data URL');
  const metadata = match[1].split(';');
  const mime = metadata.shift();
  if (metadata.at(-1)?.toLocaleLowerCase() !== 'base64') {
    throw error('Attachment dataUrl must use base64 encoding');
  }
  if (mime.toLocaleLowerCase() !== expectedType.toLocaleLowerCase()) {
    throw error(`Attachment MIME type ${expectedType} does not match its dataUrl`);
  }
  const payload = match[2];
  if (payload.length % 4 !== 0 || !BASE64_PATTERN.test(payload)) {
    throw error('Attachment dataUrl contains invalid base64 data');
  }
  return Buffer.from(payload, 'base64');
}

export function normalizeAttachments(attachments, createId = randomUUID) {
  if (attachments === undefined) return [];
  if (!Array.isArray(attachments)) {
    throw error('Note attachments must be an array');
  }
  if (attachments.length > LIMITS.ATTACHMENTS_PER_NOTE) {
    throw error(`A note cannot have more than ${LIMITS.ATTACHMENTS_PER_NOTE} attachments`);
  }

  const ids = new Set();
  let totalBytes = 0;
  return attachments.map((input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw error('Each attachment must be an object');
    }
    const id = normalizeId(input.id ?? createId(), 'attachment id');
    if (ids.has(id)) throw error(`Duplicate attachment id: ${id}`);
    ids.add(id);

    if (typeof input.name !== 'string' || !input.name.trim()) {
      throw error('Attachment name must be a non-empty string');
    }
    const name = input.name.trim();
    if (name.length > LIMITS.ATTACHMENT_NAME_MAX_LENGTH || name.includes('\0')) {
      throw error(`Attachment name exceeds ${LIMITS.ATTACHMENT_NAME_MAX_LENGTH} characters or contains NUL`);
    }
    if (typeof input.type !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(input.type)) {
      throw error('Attachment type must be a valid MIME type');
    }
    const type = input.type.toLocaleLowerCase();
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type)) {
      throw error(`Attachment MIME type ${type} is not supported`);
    }
    const size = input.size;
    if (!Number.isSafeInteger(size) || size < 0) {
      throw error('Attachment size must be a non-negative integer');
    }
    if (size > LIMITS.ATTACHMENT_BYTES) {
      throw error(`Attachment exceeds the ${LIMITS.ATTACHMENT_BYTES}-byte size limit`);
    }
    totalBytes += size;
    if (totalBytes > LIMITS.ATTACHMENTS_TOTAL_BYTES) {
      throw error(`Note attachments exceed the ${LIMITS.ATTACHMENTS_TOTAL_BYTES}-byte total limit`);
    }
    const bytes = decodeDataUrl(input.dataUrl, type);
    if (bytes.length !== size) {
      throw error(`Attachment size ${size} does not match its ${bytes.length} decoded bytes`);
    }

    return { id, name, type, size, dataUrl: input.dataUrl };
  });
}

export function validateNote(note) {
  if (!note || typeof note !== 'object' || Array.isArray(note)) {
    throw error('Note must be an object');
  }
  const id = normalizeId(note.id, 'note id');
  const attachments = normalizeAttachments(note.attachments);
  const content = normalizeContent(note.content, { allowBlank: attachments.length > 0 });
  const createdAt = timestamp(note.createdAt, 'createdAt');
  const updatedAt = timestamp(note.updatedAt, 'updatedAt');
  if (updatedAt < createdAt) throw error('updatedAt cannot be earlier than createdAt');
  if (typeof note.pinned !== 'boolean') throw error('pinned must be a boolean');
  let deletedAt = null;
  if (note.deletedAt !== null) {
    deletedAt = timestamp(note.deletedAt, 'deletedAt');
    if (deletedAt < createdAt) throw error('deletedAt cannot be earlier than createdAt');
  }
  return { id, content, createdAt, updatedAt, pinned: note.pinned, deletedAt, attachments };
}

export function sortNotes(notes, options = {}) {
  const {
    sort = 'updatedAt',
    order = 'desc',
    pinnedFirst = true,
  } = options || {};
  const field = sort === 'created' || sort === 'createdAt' ? 'createdAt' : 'updatedAt';
  const direction = order === 'asc' ? 1 : -1;
  return [...notes].sort((left, right) => {
    if (pinnedFirst && left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    const difference = (left[field] - right[field]) * direction;
    if (difference) return difference;
    return left.id.localeCompare(right.id);
  });
}

export function filterNotes(notes, filters = {}) {
  const options = filters || {};
  const includeDeleted = options.includeDeleted === true;
  const deletedOnly = options.deletedOnly === true;
  const query = typeof options.query === 'string'
    ? options.query.normalize('NFKC').trim().toLocaleLowerCase()
    : '';
  const requiredTags = [
    ...(options.tags === undefined ? [] : Array.isArray(options.tags) ? options.tags : [options.tags]),
    ...(options.tag === undefined ? [] : [options.tag]),
  ].map(normalizeTag);
  const from = options.from ?? options.createdFrom;
  const to = options.to ?? options.createdTo;

  const filtered = notes.filter((note) => {
    if (deletedOnly ? note.deletedAt === null : !includeDeleted && note.deletedAt !== null) return false;
    if (typeof options.pinned === 'boolean' && note.pinned !== options.pinned) return false;
    if (from !== undefined && note.createdAt < from) return false;
    if (to !== undefined && note.createdAt > to) return false;
    if (requiredTags.length) {
      const available = new Set(expandTags(parseTags(note.content)));
      if (!requiredTags.every((tag) => available.has(tag))) return false;
    }
    if (query) {
      const haystack = [note.content, ...note.attachments.map(({ name }) => name)]
        .join('\n').normalize('NFKC').toLocaleLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });

  const sorted = sortNotes(filtered, {
    sort: options.sort,
    order: options.order,
    pinnedFirst: options.pinnedFirst !== false,
  });
  const offset = Number.isSafeInteger(options.offset) && options.offset > 0 ? options.offset : 0;
  const limit = Number.isSafeInteger(options.limit) && options.limit >= 0 ? options.limit : undefined;
  return sorted.slice(offset, limit === undefined ? undefined : offset + limit);
}

export function buildTagIndex(notes, options = {}) {
  const includeDeleted = options.includeDeleted === true;
  const counts = new Map();
  for (const note of notes) {
    if (!includeDeleted && note.deletedAt !== null) continue;
    for (const tag of expandTags(parseTags(note.content))) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  return [...counts].sort(([left], [right]) => left.localeCompare(right)).map(([name, count]) => ({ name, count }));
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function dateKey(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw error('Invalid date');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function shiftDateKey(key, amount) {
  const [year, month, day] = key.split('-').map(Number);
  return dateKey(new Date(year, month - 1, day + amount, 12));
}

function dayNumber(key) {
  const [year, month, day] = key.split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

export function buildHeatmap(notes, options = {}) {
  const now = options.now ?? Date.now();
  const days = options.days ?? 90;
  if (!Number.isSafeInteger(days) || days < 1 || days > 3660) {
    throw error('Heatmap days must be an integer from 1 to 3660');
  }
  const today = dateKey(now);
  const counts = new Map();
  for (const note of notes) {
    if (note.deletedAt !== null) continue;
    const key = dateKey(note.createdAt);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const result = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = shiftDateKey(today, -offset);
    result.push({ date, count: counts.get(date) || 0 });
  }
  return result;
}

export function computeStats(notes, options = {}) {
  const now = options.now ?? Date.now();
  const active = notes.filter(({ deletedAt }) => deletedAt === null);
  const days = new Set(active.map(({ createdAt }) => dateKey(createdAt)));
  const today = dateKey(now);
  const todayNumber = dayNumber(today);

  let currentStreak = 0;
  let cursor = days.has(today) ? today : shiftDateKey(today, -1);
  while (days.has(cursor)) {
    currentStreak += 1;
    cursor = shiftDateKey(cursor, -1);
  }

  let longestStreak = 0;
  let runningStreak = 0;
  let previousDay = null;
  for (const key of [...days].sort((left, right) => dayNumber(left) - dayNumber(right))) {
    const currentDay = dayNumber(key);
    runningStreak = previousDay !== null && currentDay === previousDay + 1 ? runningStreak + 1 : 1;
    longestStreak = Math.max(longestStreak, runningStreak);
    previousDay = currentDay;
  }

  return {
    total: notes.length,
    active: active.length,
    trashed: notes.length - active.length,
    pinned: active.filter(({ pinned }) => pinned).length,
    attachments: active.reduce((sum, note) => sum + note.attachments.length, 0),
    tags: buildTagIndex(active).length,
    today: active.filter(({ createdAt }) => dateKey(createdAt) === today).length,
    thisWeek: active.filter(({ createdAt }) => {
      const difference = todayNumber - dayNumber(dateKey(createdAt));
      return difference >= 0 && difference < 7;
    }).length,
    currentStreak,
    longestStreak,
  };
}

function tokenize(content) {
  const withoutTags = content.replace(new RegExp(`#${TAG_SOURCE}`, 'gu'), ' ');
  const words = withoutTags.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return new Set(words.filter((word) => word.length > 1));
}

export function relatedNotes(notes, id, options = {}) {
  const source = notes.find((note) => note.id === id && note.deletedAt === null);
  if (!source) return [];
  const limit = Number.isSafeInteger(options.limit) && options.limit >= 0 ? options.limit : 5;
  if (limit === 0) return [];
  const sourceTags = new Set(expandTags(parseTags(source.content)));
  const sourceTokens = tokenize(source.content);

  return notes
    .filter((note) => note.id !== id && note.deletedAt === null)
    .map((note) => {
      let score = 0;
      for (const tag of expandTags(parseTags(note.content))) {
        if (sourceTags.has(tag)) score += 4;
      }
      for (const token of tokenize(note.content)) {
        if (sourceTokens.has(token)) score += 1;
      }
      return { note, score };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || right.note.updatedAt - left.note.updatedAt || left.note.id.localeCompare(right.note.id))
    .slice(0, limit)
    .map(({ note }) => note);
}

export function reviewNotes(notes, options = {}) {
  const mode = options.mode || 'random';
  const limit = Number.isSafeInteger(options.limit) && options.limit >= 0 ? options.limit : 1;
  const active = notes.filter(({ deletedAt }) => deletedAt === null);
  if (mode === 'random') {
    const pool = [...active];
    const random = options.random || Math.random;
    for (let index = pool.length - 1; index > 0; index -= 1) {
      const value = Number(random());
      const normalized = Number.isFinite(value) ? Math.min(Math.max(value, 0), 1 - Number.EPSILON) : 0;
      const other = Math.floor(normalized * (index + 1));
      [pool[index], pool[other]] = [pool[other], pool[index]];
    }
    return pool.slice(0, limit);
  }
  if (mode === 'on-this-day' || mode === 'onThisDay') {
    const current = new Date(options.now ?? Date.now());
    if (!Number.isFinite(current.getTime())) throw error('Invalid review date');
    const matches = active.filter((note) => {
      const created = new Date(note.createdAt);
      return created.getFullYear() < current.getFullYear()
        && created.getMonth() === current.getMonth()
        && created.getDate() === current.getDate();
    });
    return sortNotes(matches, { sort: 'createdAt', order: 'desc', pinnedFirst: false }).slice(0, limit);
  }
  throw error(`Unsupported review mode: ${mode}`);
}
