// Shown in the board menu. The contract test keeps it equal to package.json,
// because "which build am I looking at?" is the first question when a fix does
// not seem to have landed.
const PLUGIN_VERSION = '3.7.0';

window.__ModuleLoader__.load({
  id: 'dsh-moments-notes',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const {
      useCallback,
      useEffect,
      useMemo,
      useRef,
      useState,
    } = React;

    const API_ENDPOINT = '/api/moments-notes';
    const PLUGIN_ID = 'dsh-moments-notes';
    const FLOAT_POSITION_KEY = 'moments-notes:float-position';
    const FLOAT_OPEN_KEY = 'moments-notes:float-open';
    const FLOAT_VIEWPORT_KEY = 'moments-notes:float-viewport';
    const FLOAT_SAFE_INSET = 16;
    const FLOAT_MIN_TOP = 56;

    /**
     * Keep the float inside the frame and clear of the window controls.
     *
     * The overlay container is not a reliable coordinate origin, so the
     * target is measured in viewport coordinates and the float is then moved
     * with a transform relative to its resting place.
     */
    function clampFloatPosition(next, element) {
      const rect = element ? element.getBoundingClientRect() : null;
      const width = rect?.width ?? 330;
      const height = rect?.height ?? 260;
      const maxLeft = Math.max(FLOAT_SAFE_INSET, window.innerWidth - width - FLOAT_SAFE_INSET);
      const maxTop = Math.max(FLOAT_MIN_TOP, window.innerHeight - height - FLOAT_SAFE_INSET);
      return {
        left: Math.min(Math.max(FLOAT_SAFE_INSET, next.left), maxLeft),
        top: Math.min(Math.max(FLOAT_MIN_TOP, next.top), maxTop),
      };
    }

    /** Read the viewport-anchored position, or the bottom-right default. */
    function readFloatViewport(element) {
      const stored = readStoredValue(FLOAT_VIEWPORT_KEY, null);
      if (stored && typeof stored.left === 'number' && typeof stored.top === 'number') return stored;
      const rect = element ? element.getBoundingClientRect() : null;
      const width = rect?.width ?? 330;
      const height = rect?.height ?? 260;
      return {
        left: window.innerWidth - width - FLOAT_SAFE_INSET,
        top: window.innerHeight - height - FLOAT_SAFE_INSET,
      };
    }

    const floatBus = (() => {
      const listeners = new Set();
      return {
        open: readStoredValue(FLOAT_OPEN_KEY, false) === true,
        subscribe(listener) {
          listeners.add(listener);
          listener(this.open);
          return () => listeners.delete(listener);
        },
        set(value) {
          this.open = value;
          writeStoredValue(FLOAT_OPEN_KEY, value);
          for (const listener of listeners) listener(value);
        },
      };
    })();

    function readStoredValue(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        if (raw === null) return fallback;
        return JSON.parse(raw);
      } catch {
        return fallback;
      }
    }

    function writeStoredValue(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        // A blocked storage must not break the float.
      }
    }
    const RECENT_SEARCH_KEY = 'moments-notes:recent-searches:v1';
    const LONG_NOTE_LENGTH = 420;
    const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
    const MAX_TOTAL_IMAGE_SIZE = 10 * 1024 * 1024;
    const MAX_ATTACHMENTS = 8;
    const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
    const LOCALE = typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'zh-CN';

    const SHORTCUT_FORMATS = { 'b': 'bold', 'i': 'italic', 'e': 'code', 'k': 'link' };
    const FORMAT_MARKERS = {
      bold: ['**', '**'],
      italic: ['*', '*'],
      strike: ['~~', '~~'],
      code: ['`', '`'],
      link: ['[', '](https://)'],
    };
    const LINE_FORMATS = { bullet: '- ', ordered: '1. ', heading: '## ', quote: '> ' };
    const FORMAT_ACTIONS = [
      { format: 'bold', label: 'Bold', hint: '⌘/Ctrl + B', icon: 'bold' },
      { format: 'italic', label: 'Italic', hint: '⌘/Ctrl + I', icon: 'italic' },
      { format: 'strike', label: 'Strikethrough', hint: '⌘/Ctrl + ⇧ + X', icon: 'strike' },
      { format: 'code', label: 'Inline code', hint: '⌘/Ctrl + E', icon: 'code' },
      { format: 'bullet', label: 'Bullet list', hint: '⌘/Ctrl + ⇧ + 8', icon: 'list' },
      { format: 'ordered', label: 'Numbered list', hint: '⌘/Ctrl + ⇧ + 7', icon: 'ordered' },
      { format: 'heading', label: 'Heading', hint: '⌘/Ctrl + ⇧ + H', icon: 'heading' },
      { format: 'quote', label: 'Quote', hint: '⌘/Ctrl + ⇧ + Q', icon: 'quote' },
      { format: 'link', label: 'Link', hint: '⌘/Ctrl + K', icon: 'link' },
    ];

    function formatSelection(text, start, end, format) {
      const selected = text.slice(start, end);
      const markers = FORMAT_MARKERS[format];
      if (!markers) return { text, caret: start };
      if (selected) {
        const [open, close] = markers;
        return {
          text: `${text.slice(0, start)}${open}${selected}${close}${text.slice(end)}`,
          caret: start + open.length + selected.length,
          select: start + open.length,
        };
      }
      const [open, close] = markers;
      return {
        text: `${text.slice(0, start)}${open}${close}${text.slice(start)}`,
        caret: start + open.length,
        select: start + open.length,
      };
    }

    function formatLines(text, start, end, format) {
      const lineStart = text.lastIndexOf('\n', Math.max(start - 1, 0)) + 1;
      const lineEnd = end > lineStart ? text.indexOf('\n', end) : -1;
      const blockEnd = lineEnd === -1 ? text.length : lineEnd;
      const lines = text.slice(lineStart, blockEnd).split('\n');
      const prefix = LINE_FORMATS[format];
      if (!prefix) return { text, caret: start };
      const updated = lines.map((line, index) => {
        const match = line.match(/^(\s*)(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+|>\s?)?(.*)$/);
        const indent = match ? match[1] : '';
        const body = match ? match[2] : line;
        const marker = format === 'ordered' ? `${index + 1}. ` : prefix;
        return `${indent}${marker}${body}`;
      });
      const inserted = updated.join('\n');
      const next = `${text.slice(0, lineStart)}${inserted}${text.slice(blockEnd)}`;
      return { text: next, caret: start + inserted.length };
    }

    async function api(method, payload = {}) {
      const response = await fetch(API_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, payload }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body || !body.ok) {
        const failure = new Error(body?.error?.message || `Request failed (${response.status})`);
        failure.code = body?.error?.code || `HTTP_${response.status}`;
        // The id points at the Host log line, so the message on screen can be
        // traced back to the payload that failed.
        failure.logId = body?.error?.logId || null;
        failure.method = method;
        throw failure;
      }
      return body.result;
    }

    function cx(...names) {
      return names.filter(Boolean).join(' ');
    }

    function makeId() {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
      return `attachment-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    function validDate(value) {
      const date = value instanceof Date ? value : new Date(value);
      return Number.isNaN(date.getTime()) ? new Date(0) : date;
    }

    function dateKey(value) {
      const date = validDate(value);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }

    function formatTime(value) {
      return new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit' }).format(validDate(value));
    }

    function formatFullDate(value) {
      return new Intl.DateTimeFormat(LOCALE, {
        year: 'numeric', month: 'long', day: 'numeric', weekday: 'short',
      }).format(validDate(value));
    }

    function formatDay(value) {
      const key = dateKey(value);
      const today = dateKey(new Date());
      const yesterdayDate = new Date();
      yesterdayDate.setDate(yesterdayDate.getDate() - 1);
      if (key === today) return 'Today';
      if (key === dateKey(yesterdayDate)) return 'Yesterday';
      return new Intl.DateTimeFormat(LOCALE, {
        day: '2-digit', month: 'short', year: 'numeric',
      }).format(validDate(value));
    }

    function extractTags(content) {
      const tags = new Set();
      const text = String(content || '');
      const pattern = /#([\p{L}\p{N}_-][\p{L}\p{N}_/-]*)/gu;
      let match;
      while ((match = pattern.exec(text))) {
        const previous = match.index > 0 ? text[match.index - 1] : '';
        if (/[\p{L}\p{N}_]/u.test(previous)) continue;
        const tag = normalizeTagName(match[1]);
        if (tag && tag.length <= 200) tags.add(tag);
      }
      return [...tags];
    }

    function normalizeTagName(value) {
      return String(value || '').normalize('NFKC').trim().replace(/^#/, '')
        .split('/').filter((segment) => segment.trim()).map((segment) => segment.trim())
        .join('/').toLocaleLowerCase();
    }

    function normalizeSuppliedTags(tags) {
      if (Array.isArray(tags)) {
        return tags.map((tag) => normalizeTagName(typeof tag === 'string' ? tag : tag?.name || tag?.tag)).filter(Boolean);
      }
      if (tags && typeof tags === 'object') return Object.keys(tags).map(normalizeTagName).filter(Boolean);
      return [];
    }

    function buildTagTree(notes, suppliedTags) {
      const roots = [];
      const nodes = new Map();
      const ensureNode = (path) => {
        if (nodes.has(path)) return nodes.get(path);
        const segments = path.split('/');
        const node = {
          name: segments[segments.length - 1],
          fullName: path,
          children: [],
          noteIds: new Set(),
          count: 0,
        };
        nodes.set(path, node);
        if (segments.length === 1) roots.push(node);
        else {
          const parent = ensureNode(segments.slice(0, -1).join('/'));
          if (!parent.children.includes(node)) parent.children.push(node);
        }
        return node;
      };

      normalizeSuppliedTags(suppliedTags).forEach((tag) => ensureNode(tag));
      notes.filter((note) => !note.deletedAt).forEach((note) => {
        extractTags(note.content).forEach((tag) => {
          const segments = tag.split('/');
          segments.forEach((_, index) => {
            const path = segments.slice(0, index + 1).join('/');
            ensureNode(path).noteIds.add(note.id || `${note.createdAt}:${note.content}`);
          });
        });
      });

      const finalize = (node) => {
        node.children.sort((a, b) => a.name.localeCompare(b.name, LOCALE));
        node.children.forEach(finalize);
        node.count = node.noteIds.size;
      };
      roots.sort((a, b) => a.name.localeCompare(b.name, LOCALE));
      roots.forEach(finalize);
      return roots;
    }

    function readRecentSearches() {
      try {
        const value = JSON.parse(localStorage.getItem(RECENT_SEARCH_KEY) || '[]');
        return Array.isArray(value) ? value.filter((item) => typeof item === 'string').slice(0, 8) : [];
      } catch {
        return [];
      }
    }

    function downloadFile(name, content, type) {
      const blob = new Blob([content], { type });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = name;
      anchor.style.display = 'none';
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }

    function notesToMarkdown(notes) {
      const activeNotes = notes.filter((note) => !note.deletedAt).slice().sort((a, b) => (
        validDate(a.createdAt) - validDate(b.createdAt)
      ));
      const sections = activeNotes.map((note) => {
        const attachments = (note.attachments || []).map((attachment) => `- Attachment: ${attachment.name || 'Image'}`).join('\n');
        return [
          `## ${formatFullDate(note.createdAt)} ${formatTime(note.createdAt)}`,
          '',
          note.content || '（ImageNotes）',
          attachments ? `\n${attachments}` : '',
          note.pinned ? '\n**PinNotes**' : '',
        ].join('\n');
      });
      return [`# Moments notes export`, '', `${activeNotes.length} notes`, '', ...sections].join('\n\n');
    }

    async function copyText(text) {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
      }
      throw new Error('The browser blocked the copy — select the text manually');
    }

    const ICON_PATHS = {
      // A curve with two anchors, not a pencil: the pencil read as "annotate",
      // and nobody could guess that it draws vector paths.
      pen: ['M4 17C7.6 17 9.2 8 13 8s4.8 9 7 9', 'M2.8 15.8h2.4v2.4H2.8z', 'M18.8 4.8h2.4v2.4h-2.4z'],
      folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z'],
      plus: ['M12 5v14', 'M5 12h14'],
      search: ['M21 21l-4.35-4.35', 'M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16z'],
      pin: ['M12 17v5', 'M5 17h14', 'M8 3h8l-1 7 3 3H6l3-3-1-7z'],
      edit: ['M12 20h9', 'M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4L16.5 3.5z'],
      trash: ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 15H6L5 6', 'M10 11v6', 'M14 11v6'],
      restore: ['M3 12a9 9 0 1 0 3-6.7', 'M3 4v6h6'],
      copy: ['M9 9h11v11H9z', 'M4 15V4h11'],
      image: ['M3 5h18v14H3z', 'M8 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'M21 15l-5-5L5 19'],
      close: ['M18 6L6 18', 'M6 6l12 12'],
      chevron: ['M9 18l6-6-6-6'],
      tag: ['M20 13l-7 7L3 10V3h7l10 10z', 'M7.5 7.5h.01'],
      review: ['M20 12a8 8 0 1 1-2.34-5.66', 'M20 4v6h-6', 'M12 8v4l3 2'],
      chart: ['M4 20V10', 'M10 20V4', 'M16 20v-7', 'M22 20H2'],
      download: ['M12 3v12', 'M7 10l5 5 5-5', 'M5 21h14'],
      upload: ['M12 16V4', 'M7 9l5-5 5 5', 'M5 20h14'],
      refresh: ['M20 11a8 8 0 1 0-2 5.3', 'M20 4v7h-7'],
      link: ['M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71', 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'],
      more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
      hash: ['M5 9h14', 'M5 15h14', 'M11 4l-2 16', 'M17 4l-2 16'],
      list: ['M9 6h11', 'M9 12h11', 'M9 18h11', 'M4.5 6h.01', 'M4.5 12h.01', 'M4.5 18h.01'],
      ordered: ['M10 6h10', 'M10 12h10', 'M10 18h10', 'M4 5h2v3', 'M4 11h2l-2 3h2', 'M4 18h2v2H4'],
      send: ['M22 2L11 13', 'M22 2l-7 20-4-9-9-4z'],
      window: ['M3 5h18v14H3z', 'M3 9h18', 'M7 13h5'],
      /* Text format: one outline family, drawn as strokes, never as letters. */
      bold: ['M8 5h4.5a3.25 3.25 0 0 1 0 6.5H8z', 'M8 11.5h5.5a3.25 3.25 0 0 1 0 6.5H8z', 'M8 5v14'],
      italic: ['M19 4h-9', 'M14 20H5', 'M15 4L9 20'],
      strike: ['M16 4H9a3 3 0 0 0-2.83 4', 'M14 12a4 4 0 0 1 0 8H6', 'M4 12h16'],
      code: ['M8.5 8L4.5 12l4 4', 'M15.5 8l4 4-4 4'],
      quote: ['M10 8c-1.7 1-2.7 2.6-2.7 4.4 0 1.6 1 2.8 2.4 2.8 1.3 0 2.2-.9 2.2-2.1 0-1.1-.8-1.9-1.9-1.9-.2 0-.4 0-.6.1.3-1 1-1.9 2-2.6z', 'M19 8c-1.7 1-2.7 2.6-2.7 4.4 0 1.6 1 2.8 2.4 2.8 1.3 0 2.2-.9 2.2-2.1 0-1.1-.8-1.9-1.9-1.9-.2 0-.4 0-.6.1.3-1 1-1.9 2-2.6z'],
      heading: ['M6 5v14', 'M18 5v14', 'M6 12h12'],
      text: ['M4 6h16', 'M4 11h16', 'M4 16h11', 'M4 21h7'],
      markdown: ['M13 3H6v18h12V8z', 'M13 3v5h5', 'M12 11v6', 'M10 15l2 2 2-2'],
      check: ['M4 12.5l5 5L20 6.5'],
      arrowRight: ['M5 12h14', 'M13 6l6 6-6 6'],
      canvas: ['M3.5 5.5h17v13h-17z', 'M7 9h5v4h-5z', 'M14 8.5h4.5v4.5h-4.5z'],
      pointer: ['M6 3.8l12.6 7.2-5.6 1.1-2.2 5.6z'],
      rect: ['M4.5 6.5h15v11h-15z'],
      ellipse: ['M12 5.5c4.7 0 8.5 3.1 8.5 6.5s-3.8 6.5-8.5 6.5-8.5-3.1-8.5-6.5 3.8-6.5 8.5-6.5z'],
      group: ['M3.5 4.5h17v15h-17z', 'M7 8h5v5h-5z', 'M13 11h4v4h-4z'],
      frame: ['M3.5 5.5h17v13h-17z', 'M3.5 5.5h6', 'M6.5 2.5v3'],
      star: ['M12 3.6l2.47 5.01 5.53.8-4 3.9.94 5.5L12 16.3l-4.94 2.51.94-5.5-4-3.9 5.53-.8z'],
      ungroup: ['M3.5 4.5h17v15h-17z', 'M7 8h5v5h-5z'],
      layers: ['M12 3.5l8.5 4.5-8.5 4.5L3.5 8z', 'M3.5 12.5L12 17l8.5-4.5', 'M3.5 16.5L12 21l8.5-4.5'],
      scatter: ['M4.5 5.5h5v4h-5z', 'M14.5 4.5h5v4h-5z', 'M9.5 14.5h6v5h-6z'],
      exportIcon: ['M12 15.5V3.5', 'M7.5 8l4.5-4.5L16.5 8', 'M4.5 14.5v5h15v-5'],
      alignLeft: ['M4 4v16', 'M8 8h8v3H8z', 'M8 14h5v3H8z'],
      alignCenterX: ['M12 4v16', 'M8 8h8v3H8z', 'M9.5 14h5v3h-5z'],
      alignRight: ['M20 4v16', 'M8 8h8v3H8z', 'M11 14h5v3h-5z'],
      alignTop: ['M4 4h16', 'M8 8h3v8H8z', 'M14 8h3v5h-3z'],
      alignCenterY: ['M4 12h16', 'M8 8h3v8H8z', 'M14 9.5h3v5h-3z'],
      alignBottom: ['M4 20h16', 'M8 8h3v8H8z', 'M14 11h3v5h-3z'],
      distributeX: ['M4 4v16', 'M20 4v16', 'M11 8h2v8h-2z'],
      distributeY: ['M4 4h16', 'M4 20h16', 'M8 11h8v2H8z'],
      eye: ['M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12z', 'M12 9.8a2.2 2.2 0 100 4.4 2.2 2.2 0 000-4.4z'],
      eyeOff: ['M4 4l16 16', 'M9.5 6.9A9.6 9.6 0 0112 6.5c6 0 9.5 5.5 9.5 5.5a15 15 0 01-3.3 3.6', 'M6.4 8.2A15.6 15.6 0 002.5 12S6 17.5 12 17.5a9.4 9.4 0 003.2-.6'],
      sticky: ['M4.5 4.5h15v9l-6 6h-9z', 'M19 13.5h-6v6'],
      connector: ['M5 19l5-9 4 5 5-10', 'M16.5 4.5h3v3'],
      hand: ['M8 13.5V6.8a1.4 1.4 0 012.8 0v5', 'M10.8 11.8V5.4a1.4 1.4 0 012.8 0v6.4', 'M13.6 12.2V8.2a1.4 1.4 0 012.8 0v6.4a5.4 5.4 0 01-5.4 5.4h-1.3a3.8 3.8 0 01-2.8-1.2l-3-3.4a1.6 1.6 0 012.3-2.2l1.8 1.7'],
      zoomIn: ['M11 4.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13z', 'M15.8 15.8l4 4', 'M11 8.4v5.2', 'M8.4 11h5.2'],
      zoomOut: ['M11 4.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13z', 'M15.8 15.8l4 4', 'M8.4 11h5.2'],
      fit: ['M4 9.5v-5h5', 'M15 4.5h5v5', 'M20 14.5v5h-5', 'M9 19.5h-5v-5'],
      undo: ['M4.5 10h9.8a4.7 4.7 0 010 9.4H9', 'M4.5 10l4-4', 'M4.5 10l4 4'],
      redo: ['M19.5 10H9.7a4.7 4.7 0 000 9.4H15', 'M19.5 10l-4-4', 'M19.5 10l-4 4'],
    };

    function Icon({ name, size = 16 }) {
      return h('svg', {
        className: 'mm-icon',
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      }, ...(ICON_PATHS[name] || ICON_PATHS.more).map((path, index) => h('path', { d: path, key: index })));
    }

    /**
     * The Moments mark.
     *
     * One geometry for the whole product: an M whose middle valley carries a
     * single ember dot. The plugin icon, this sidebar entry and the desktop
     * float all draw the same shape, so the identity survives every surface.
     */
    const MOMENTS_MARK_PATH = 'M19 43V21c0-3.2 3.4-4.5 5.2-1.7L32 30.4l7.8-11.1c1.8-2.8 5.2-1.5 5.2 1.7v22';

    function PanelIcon({ active }) {
      return h('span', { className: cx('mm-panel-icon', active && 'is-active'), 'aria-hidden': true },
        h('svg', { width: 19, height: 19, viewBox: '0 0 64 64', fill: 'none', stroke: 'currentColor', strokeWidth: 6, strokeLinecap: 'round', strokeLinejoin: 'round' },
          h('path', { d: MOMENTS_MARK_PATH }),
          h('circle', { cx: 32, cy: 43.5, r: 3.4, fill: 'currentColor', stroke: 'none' })));
    }

    function ActionButton({ icon, label, onClick, disabled, className, title, autoFocus }) {
      return h('button', {
        type: 'button',
        className: cx('mm-action', className),
        onClick,
        disabled,
        title: title || label,
        'aria-label': label,
        autoFocus,
      }, icon ? h(Icon, { name: icon, size: 14 }) : null, h('span', null, label));
    }

    function getCaretTag(value, caret) {
      const before = value.slice(0, caret);
      const match = before.match(/#([\p{L}\p{N}_/-]*)$/u);
      if (!match) return null;
      return { query: match[1], start: caret - match[1].length - 1, end: caret };
    }

    function readBlobAsAttachment(blob, name) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve({
          id: makeId(),
          name,
          type: (blob.type || 'image/png').toLocaleLowerCase(),
          size: blob.size,
          dataUrl: String(reader.result || ''),
        });
        reader.onerror = () => reject(new Error(`Cannot read image: ${name}`));
        reader.readAsDataURL(blob);
      });
    }

    function readImage(file) {
      return readBlobAsAttachment(file, file.name || 'Paste an image');
    }

    /** Read every image the clipboard holds, so a pasted screenshot becomes an attachment. */
    async function readClipboardAttachments(event) {
      const items = event?.clipboardData?.items || [];
      const attachments = [];
      for (const item of items) {
        const type = (item.type || '').toLocaleLowerCase();
        if (item.kind === 'file' && type.startsWith('image/')) {
          const blob = item.getAsFile();
          if (!blob) continue;
          const extension = type.split('/')[1] || 'png';
          attachments.push(await readBlobAsAttachment(blob, `clipboard-${attachments.length + 1}.${extension}`));
        }
      }
      return attachments;
    }

    /** Keep pasted images inside the same limits as picked images. */
    function mergeClipboardAttachments(current, pasted, onError) {
      const accepted = [];
      for (const item of pasted) {
        if (!SUPPORTED_IMAGE_TYPES.has(item.type)) {
          onError('Only PNG, JPEG, WebP and GIF images are supported');
          continue;
        }
        if (item.size > MAX_IMAGE_SIZE) {
          onError('Each image must be 5 MB or smaller');
          continue;
        }
        if (current.length + accepted.length >= MAX_ATTACHMENTS) {
          onError(`Each note keeps at most ${MAX_ATTACHMENTS} images`);
          break;
        }
        accepted.push(item);
      }
      const total = [...current, ...accepted].reduce((sum, item) => sum + (item.size || 0), 0);
      if (total > MAX_TOTAL_IMAGE_SIZE) {
        onError('Images in one note must total 10 MB or less');
        return [];
      }
      return accepted;
    }

    function Editor({
      content,
      setContent,
      attachments,
      setAttachments,
      editingId,
      onSave,
      onCancel,
      tags,
      busy,
      editorRef,
      onError,
    }) {
      const fileRef = useRef(null);
      const [caret, setCaret] = useState(0);
      const [selection, setSelection] = useState({ start: 0, end: 0 });
      const [tagMenuClosed, setTagMenuClosed] = useState(false);
      const [suggestionIndex, setSuggestionIndex] = useState(0);
      const [readingImages, setReadingImages] = useState(false);
      const [showFormats, setShowFormats] = useState(false);
      const formatRowVisible = showFormats || selection.end > selection.start;
      const activeTagMatch = getCaretTag(content, caret);
      const tagQuery = activeTagMatch?.query || '';
      const tagSuggestions = useMemo(() => {
        if (!activeTagMatch || tagMenuClosed) return [];
        const query = tagQuery.toLocaleLowerCase(LOCALE);
        return [...new Set(normalizeSuppliedTags(tags))].filter((tag) => (
          tag.toLocaleLowerCase(LOCALE).includes(query) && tag !== tagQuery
        )).slice(0, 6);
      }, [activeTagMatch?.query, tagMenuClosed, tags]);

      useEffect(() => {
        setSuggestionIndex(0);
      }, [tagQuery]);

      useEffect(() => {
        if (editingId && editorRef.current) editorRef.current.focus();
      }, [editingId]);

      useEffect(() => {
        const input = editorRef.current;
        if (!input) return;
        input.style.height = 'auto';
        input.style.height = `${Math.min(input.scrollHeight, 420)}px`;
      }, [content, editingId, editorRef]);

      const insertAtCaret = (text) => {
        const input = editorRef.current;
        const position = input ? input.selectionStart : caret;
        const next = `${content.slice(0, position)}${text}${content.slice(position)}`;
        const nextCaret = position + text.length;
        setContent(next);
        setCaret(nextCaret);
        setSelection({ start: nextCaret, end: nextCaret });
        requestAnimationFrame(() => {
          const field = editorRef.current;
          if (!field) return;
          field.focus();
          field.setSelectionRange(nextCaret, nextCaret);
        });
      };

      const chooseTag = (tag) => {
        if (!activeTagMatch) return;
        const next = `${content.slice(0, activeTagMatch.start)}#${tag} ${content.slice(activeTagMatch.end)}`;
        const nextCaret = activeTagMatch.start + tag.length + 2;
        setContent(next);
        setCaret(nextCaret);
        setTagMenuClosed(true);
        requestAnimationFrame(() => {
          editorRef.current?.focus();
          editorRef.current?.setSelectionRange(nextCaret, nextCaret);
        });
      };

      const save = () => {
        if (busy || readingImages || (!content.trim() && attachments.length === 0)) return;
        void onSave(content, attachments);
      };

      function applyFormat(format) {
        const input = editorRef.current;
        const start = input ? input.selectionStart : selection.start;
        const end = input ? input.selectionEnd : selection.end;
        const result = LINE_FORMATS[format]
          ? formatLines(content, start, end, format)
          : formatSelection(content, start, end, format);
        if (result.text === content) return;
        setContent(result.text);
        setCaret(result.caret);
        setSelection({ start: result.select ?? result.caret, end: result.select ?? result.caret });
        requestAnimationFrame(() => {
          const field = editorRef.current;
          if (!field) return;
          field.focus();
          if (typeof result.select === 'number') field.setSelectionRange(result.select, result.select);
          else field.setSelectionRange(result.caret, result.caret);
        });
      }

      const handleKeyDown = (event) => {
        if (event.metaKey || event.ctrlKey) {
          if (event.key === 'Enter') {
            event.preventDefault();
            save();
            return;
          }
          const key = event.key.toLocaleLowerCase(LOCALE);
          const format = event.shiftKey
            ? (event.key === '7' ? 'ordered' : event.key === '8' ? 'bullet' : event.key === 'x' ? 'strike' : event.key === 'h' ? 'heading' : event.key === 'q' ? 'quote' : '')
            : (SHORTCUT_FORMATS[key] || '');
          if (format) {
            event.preventDefault();
            applyFormat(format);
            return;
          }
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          if (tagSuggestions.length) setTagMenuClosed(true);
          else if (editingId) onCancel();
          return;
        }
        if (!tagSuggestions.length) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const delta = event.key === 'ArrowDown' ? 1 : -1;
          setSuggestionIndex((index) => (index + delta + tagSuggestions.length) % tagSuggestions.length);
        } else if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
          event.preventDefault();
          chooseTag(tagSuggestions[suggestionIndex] || tagSuggestions[0]);
        }
      };

      const handlePaste = async (event) => {
        const pasted = await readClipboardAttachments(event);
        if (!pasted.length) return;
        event.preventDefault();
        const accepted = mergeClipboardAttachments(attachments, pasted, onError);
        if (accepted.length) setAttachments([...attachments, ...accepted]);
      };

      const handleFiles = async (fileList) => {
        const files = [...fileList];
        if (!files.length) return;
        const invalid = files.find((file) => !SUPPORTED_IMAGE_TYPES.has(file.type.toLocaleLowerCase()));
        const oversized = files.find((file) => file.size > MAX_IMAGE_SIZE);
        if (invalid) {
          onError('Only PNG, JPEG, WebP and GIF images are supported');
          return;
        }
        if (oversized) {
          onError('Each image must be 5 MB or smaller');
          return;
        }
        if (attachments.length + files.length > MAX_ATTACHMENTS) {
          onError(`Each note keeps at most ${MAX_ATTACHMENTS} images`);
          return;
        }
        const totalBytes = [...attachments, ...files].reduce((sum, file) => sum + file.size, 0);
        if (totalBytes > MAX_TOTAL_IMAGE_SIZE) {
          onError('Images in one note must total 10 MB or less');
          return;
        }
        setReadingImages(true);
        try {
          const additions = await Promise.all(files.map(readImage));
          setAttachments([...attachments, ...additions]);
        } catch (error) {
          onError(error.message || String(error));
        } finally {
          setReadingImages(false);
          if (fileRef.current) fileRef.current.value = '';
        }
      };

      return h('section', { className: cx('mm-editor', editingId && 'is-editing'), 'aria-label': editingId ? 'Edit note' : 'New note' },
        h('div', { className: 'mm-editor-topline' },
          h('span', { className: 'mm-editor-kicker' }, editingId ? 'Editing a note' : 'Capture a thought right now'),
          editingId ? h('button', { type: 'button', className: 'mm-text-button', onClick: onCancel }, 'Cancel edit') : null),
        h('div', { className: 'mm-editor-input-wrap' },
          h('textarea', {
            ref: editorRef,
            className: 'mm-editor-input',
            value: content,
            onChange: (event) => {
              setContent(event.target.value);
              setCaret(event.target.selectionStart);
              setSelection({ start: event.target.selectionStart, end: event.target.selectionEnd });
              setTagMenuClosed(false);
            },
            onKeyDown: handleKeyDown,
            onPaste: (event) => void handlePaste(event),
            onKeyUp: (event) => {
              setCaret(event.target.selectionStart);
              setSelection({ start: event.target.selectionStart, end: event.target.selectionEnd });
            },
            onClick: (event) => {
              setCaret(event.target.selectionStart);
              setSelection({ start: event.target.selectionStart, end: event.target.selectionEnd });
              setTagMenuClosed(false);
            },
            onSelect: (event) => {
              setCaret(event.target.selectionStart);
              setSelection({ start: event.target.selectionStart, end: event.target.selectionEnd });
            },
            placeholder: 'Write here — use #tags and #tags/subtags to file ideas',
            'aria-label': 'Note content',
            rows: editingId ? 5 : 4,
            disabled: busy,
          }),
          tagSuggestions.length ? h('div', { className: 'mm-tag-suggestions', role: 'listbox', 'aria-label': 'Tag suggestions' },
            h('div', { className: 'mm-suggestion-title' }, 'Pick an existing tag'),
            ...tagSuggestions.map((tag, index) => h('button', {
              type: 'button',
              role: 'option',
              'aria-selected': index === suggestionIndex,
              className: cx('mm-suggestion', index === suggestionIndex && 'is-active'),
              key: tag,
              onMouseDown: (event) => event.preventDefault(),
              onClick: () => chooseTag(tag),
            }, h(Icon, { name: 'tag', size: 13 }), h('span', null, tag)))) : null),
        attachments.length ? h('div', { className: 'mm-attachment-previews', 'aria-label': 'Image preview' }, attachments.map((attachment) => (
          h('div', { className: 'mm-attachment-preview', key: attachment.id },
            h('img', { src: attachment.dataUrl, alt: attachment.name || 'Image attachments' }),
            h('button', {
              type: 'button',
              className: 'mm-remove-image',
              'aria-label': `Remove image ${attachment.name || ''}`,
              title: 'Remove image',
              onClick: () => setAttachments(attachments.filter((item) => item.id !== attachment.id)),
            }, h(Icon, { name: 'close', size: 12 })))
        ))) : null,
        formatRowVisible ? h('div', { className: 'mm-format-toolbar', role: 'group', 'aria-label': 'Paragraph format' },
          ...FORMAT_ACTIONS.map((action) => h('button', {
            type: 'button',
            className: cx('mm-format-button', `is-${action.format}`),
            title: `${action.label} · ${action.hint}`,
            'aria-label': action.label,
            onMouseDown: (event) => event.preventDefault(),
            onClick: () => applyFormat(action.format),
            disabled: busy,
          }, h('span', { className: 'mm-format-glyph', 'aria-hidden': true }, h(Icon, { name: action.icon, size: 15 })))),
          h('span', { className: 'mm-format-hint' }, '⌘/Ctrl shortcuts for formatting')) : null,
        h('div', { className: 'mm-editor-footer' },
          h('div', { className: 'mm-editor-tools' },
            h('input', {
              ref: fileRef,
              className: 'mm-visually-hidden',
              type: 'file',
              accept: 'image/*',
              multiple: true,
              onChange: (event) => void handleFiles(event.target.files),
              tabIndex: -1,
            }),
            h('button', {
              type: 'button',
              className: 'mm-editor-icon-button',
              title: 'Insert tag',
              'aria-label': 'Insert tag',
              onMouseDown: (event) => event.preventDefault(),
              onClick: () => insertAtCaret('# '),
              disabled: busy,
            }, h(Icon, { name: 'hash', size: 17 })),
            h('button', {
              type: 'button',
              className: 'mm-editor-icon-button',
              title: readingImages ? 'Reading image…' : 'Add image',
              'aria-label': 'Add image',
              onMouseDown: (event) => event.preventDefault(),
              onClick: () => fileRef.current?.click(),
              disabled: busy || readingImages,
            }, h(Icon, { name: 'image', size: 17 })),
            h('button', {
              type: 'button',
              className: cx('mm-editor-icon-button', showFormats && 'is-active'),
              title: 'Text format',
              'aria-label': 'Text format',
              onMouseDown: (event) => event.preventDefault(),
              onClick: () => setShowFormats((current) => !current),
              disabled: busy,
            }, h(Icon, { name: 'text', size: 16 })),
            h('button', {
              type: 'button',
              className: 'mm-editor-icon-button',
              title: 'Bullet list',
              'aria-label': 'Bullet list',
              onMouseDown: (event) => event.preventDefault(),
              onClick: () => applyFormat('bullet'),
              disabled: busy,
            }, h(Icon, { name: 'list', size: 17 })),
            h('button', {
              type: 'button',
              className: 'mm-editor-icon-button',
              title: 'Numbered list',
              'aria-label': 'Numbered list',
              onMouseDown: (event) => event.preventDefault(),
              onClick: () => applyFormat('ordered'),
              disabled: busy,
            }, h(Icon, { name: 'ordered', size: 17 })),
            h('span', { className: 'mm-editor-hint' }, '# tags complete automatically · ⌘/Ctrl + Enter to save')),
          h('div', { className: 'mm-editor-actions' },
            h('span', { className: 'mm-editor-count' }, `${content.length} chars`),
            h('button', {
              type: 'button',
              className: 'mm-text-button is-quiet',
              onClick: onCancel,
              disabled: busy,
            }, 'Cancel'),
            h('button', {
              type: 'button',
              className: 'mm-editor-send',
              title: busy ? 'Saving…' : editingId ? 'Save changes' : 'Save note',
              'aria-label': 'Save note',
              onClick: save,
              disabled: busy || readingImages || (!content.trim() && attachments.length === 0),
            }, h(Icon, { name: 'send', size: 16 })))));
    }

    function renderInline(text, onTag) {
      const nodes = [];
      const pattern = /(\*\*[^*\n]+\*\*|~~[^~\n]+~~|\*[^*\n]+\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>()]+|#[\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu;
      let lastIndex = 0;
      let match;
      let key = 0;
      while ((match = pattern.exec(text))) {
        if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
        const token = match[0];
        if (token.startsWith('**')) {
          nodes.push(h('strong', { key: key++ }, token.slice(2, -2)));
        } else if (token.startsWith('~~')) {
          nodes.push(h('s', { className: 'mm-strike', key: key++ }, token.slice(2, -2)));
        } else if (token.startsWith('*')) {
          nodes.push(h('em', { className: 'mm-italic', key: key++ }, token.slice(1, -1)));
        } else if (token.startsWith('`')) {
          nodes.push(h('code', { className: 'mm-inline-code', key: key++ }, token.slice(1, -1)));
        } else if (token.startsWith('[')) {
          const parts = token.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
          nodes.push(h('a', {
            className: 'mm-inline-link',
            href: parts[2],
            target: '_blank',
            rel: 'noreferrer noopener',
            key: key++,
          }, parts[1]));
        } else if (token.startsWith('http')) {
          nodes.push(h('a', {
            className: 'mm-inline-link',
            href: token,
            target: '_blank',
            rel: 'noreferrer noopener',
            key: key++,
          }, token));
        } else {
          const tag = normalizeTagName(token);
          nodes.push(h('button', {
            type: 'button',
            className: 'mm-inline-tag',
            onClick: () => onTag(tag),
            onDoubleClick: (event) => event.stopPropagation(),
            key: key++,
          }, `#${tag}`));
        }
        lastIndex = pattern.lastIndex;
      }
      if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
      return nodes;
    }

    function SafeText({ content, onTag }) {
      const lines = String(content || '').split(/\r?\n/);
      return h('div', { className: 'mm-safe-text' }, lines.map((line, index) => {
        const heading = line.match(/^(#{1,6})\s+(.*)$/);
        if (heading) {
          return h('div', { className: cx('mm-text-line', 'mm-heading', `is-level-${heading[1].length}`), key: index },
            h('span', null, renderInline(heading[2], onTag)));
        }
        const quote = line.match(/^>\s?(.*)$/);
        if (quote) {
          return h('div', { className: cx('mm-text-line', 'mm-quote'), key: index },
            h('span', null, renderInline(quote[1], onTag)));
        }
        const ordered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
        if (ordered) {
          return h('div', { className: cx('mm-text-line', 'is-bullet', 'is-ordered'), key: index },
            h('span', { className: 'mm-bullet', 'aria-hidden': true }, `${ordered[1]}.`),
            h('span', null, renderInline(ordered[2], onTag)));
        }
        const bullet = line.match(/^\s*[-*]\s+(.*)$/);
        if (bullet) {
          return h('div', { className: cx('mm-text-line', 'is-bullet'), key: index },
            h('span', { className: 'mm-bullet', 'aria-hidden': true }, '•'),
            h('span', null, renderInline(bullet[1], onTag)));
        }
        const text = line;
        return h('div', { className: 'mm-text-line', key: index },
          h('span', null, line ? renderInline(text, onTag) : ' '));
      }));
    }

    function InlineEditor({ note, onSave, onCancel, busy, onError }) {
      const [draft, setDraft] = useState(String(note.content || ''));
      const [attachments, setAttachments] = useState(() => [...(note.attachments || [])]);
      const [selection, setSelection] = useState({ start: 0, end: 0 });
      const inputRef = useRef(null);

      const reportError = (message) => {
        if (typeof onError === 'function') onError(message);
      };

      async function handlePaste(event) {
        const pasted = await readClipboardAttachments(event);
        if (!pasted.length) return;
        event.preventDefault();
        const accepted = mergeClipboardAttachments(attachments, pasted, reportError);
        if (accepted.length) setAttachments([...attachments, ...accepted]);
      }

      useEffect(() => {
        const input = inputRef.current;
        if (!input) return;
        input.style.height = 'auto';
        input.style.height = `${Math.min(input.scrollHeight, 420)}px`;
        input.focus();
        const end = input.value.length;
        input.setSelectionRange(end, end);
      }, []);

      useEffect(() => {
        const input = inputRef.current;
        if (!input) return;
        input.style.height = 'auto';
        input.style.height = `${Math.min(input.scrollHeight, 420)}px`;
      }, [draft]);

      function applyFormat(format) {
        const input = inputRef.current;
        const start = input ? input.selectionStart : selection.start;
        const end = input ? input.selectionEnd : selection.end;
        const result = LINE_FORMATS[format]
          ? formatLines(draft, start, end, format)
          : formatSelection(draft, start, end, format);
        if (result.text === draft) return;
        setDraft(result.text);
        requestAnimationFrame(() => {
          const field = inputRef.current;
          if (!field) return;
          field.focus();
          if (typeof result.select === 'number') field.setSelectionRange(result.select, result.select);
          else field.setSelectionRange(result.caret, result.caret);
        });
      }

      function handleKeyDown(event) {
        if (event.metaKey || event.ctrlKey) {
          if (event.key === 'Enter') {
            event.preventDefault();
            onSave(draft, attachments);
            return;
          }
          const key = event.key.toLocaleLowerCase(LOCALE);
          const format = event.shiftKey
            ? (event.key === '7' ? 'ordered' : event.key === '8' ? 'bullet' : event.key === 'x' ? 'strike' : event.key === 'h' ? 'heading' : event.key === 'q' ? 'quote' : '')
            : (SHORTCUT_FORMATS[key] || '');
          if (format) {
            event.preventDefault();
            applyFormat(format);
            return;
          }
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        }
      }

      const trackSelection = (event) => {
        setSelection({ start: event.target.selectionStart, end: event.target.selectionEnd });
      };

      return h('div', { className: 'mm-inline-editor', onDoubleClick: (event) => event.stopPropagation() },
        h('textarea', {
          ref: inputRef,
          className: 'mm-inline-editor-input',
          value: draft,
          onChange: (event) => setDraft(event.target.value),
          onKeyDown: handleKeyDown,
          onPaste: (event) => void handlePaste(event),
          onKeyUp: trackSelection,
          onClick: trackSelection,
          onSelect: trackSelection,
          'aria-label': 'Note content',
          rows: 3,
          disabled: busy,
        }),
        attachments.length ? h('div', { className: 'mm-inline-attachments', 'aria-label': 'Image attachments' }, attachments.map((attachment) => (
          h('div', { className: 'mm-attachment-preview', key: attachment.id },
            h('img', { src: attachment.dataUrl, alt: attachment.name || 'Image attachments' }),
            h('button', {
              type: 'button',
              className: 'mm-remove-image',
              'aria-label': `Remove image ${attachment.name || ''}`,
              title: 'Remove image',
              onClick: () => setAttachments(attachments.filter((item) => item.id !== attachment.id)),
            }, h(Icon, { name: 'close', size: 12 })))
        ))) : null,
        h('div', { className: 'mm-inline-toolbar', role: 'group', 'aria-label': 'Paragraph format' },
          ...FORMAT_ACTIONS.map((action) => h('button', {
            type: 'button',
            className: cx('mm-format-button', `is-${action.format}`),
            title: `${action.label} · ${action.hint}`,
            'aria-label': action.label,
            onMouseDown: (event) => event.preventDefault(),
            onClick: () => applyFormat(action.format),
            disabled: busy,
          }, h('span', { className: 'mm-format-glyph', 'aria-hidden': true }, h(Icon, { name: action.icon, size: 15 }))))),
        h('div', { className: 'mm-inline-actions' },
          h('span', { className: 'mm-inline-count' }, `${draft.length} chars`),
          h('button', {
            type: 'button',
            className: 'mm-text-button is-quiet',
            onClick: onCancel,
            disabled: busy,
          }, 'Cancel'),
          h('button', {
            type: 'button',
            className: 'mm-inline-send',
            title: busy ? 'Saving…' : 'Save changes',
            'aria-label': 'Save changes',
            onClick: () => onSave(draft, attachments),
            disabled: busy,
          }, h(Icon, { name: 'send', size: 15 }))));
    }

    const QUICK_CSS = [
      '.mm-quick{display:inline-flex}',
      '.mm-quick-button{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color 100ms ease,color 100ms ease}',
      '.mm-quick-button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.mm-quick-button:active:not(:disabled){transform:scale(.97)}',
      '.mm-quick-button:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-state-business-primary);outline-offset:2px}',
      '.mm-quick-button.is-busy{opacity:.45}',
      '.mm-quick-button.is-failed{color:var(--dsw-alias-state-error-primary)}',
    ].join('');

    /**
     * Install the plugin stylesheets once, into the document head.
     *
     * A style element rendered inside the React tree is re-created and
     * re-parsed on every render, and the Host cannot collect it when the
     * plugin unloads. The head carries the sheet once; the plugin effect
     * removes it again.
     *
     * @returns {() => void} the cleanup
     */
    function installStyles() {
      const sheet = document.createElement('style');
      sheet.setAttribute('data-plugin', PLUGIN_ID);
      sheet.textContent = CSS;
      document.head.appendChild(sheet);
      const quick = document.createElement('style');
      quick.setAttribute('data-plugin', PLUGIN_ID + ':quick');
      quick.textContent = QUICK_CSS;
      document.head.appendChild(quick);
      return () => {
        sheet.remove();
        quick.remove();
      };
    }

    /**
     * The quick capture button.
     *
     * It sits in the Harness chrome, far away from the Moments panel, so it
     * carries its own style and talks to the Host directly: one click opens
     * the desktop float, a second one closes it again.
     */
    function QuickFloatButton() {
      const [busy, setBusy] = useState(false);
      const [problem, setProblem] = useState('');
      const toggle = useCallback(async () => {
        if (busy) return;
        setBusy(true);
        try {
          const status = await api('float-status', {});
          if (status?.open) await api('float-close', {});
          else await api('float-open', {});
          setProblem('');
        } catch (failure) {
          setProblem(failure.message || String(failure));
        } finally {
          setBusy(false);
        }
      }, [busy]);
      return h('span', { className: 'mm-quick' },
        h('button', {
          type: 'button',
          className: cx('mm-quick-button', busy && 'is-busy', problem && 'is-failed'),
          onClick: () => void toggle(),
          title: problem || 'Open the Moments float',
          'aria-label': 'Open the Moments float',
        }, h(Icon, { name: 'edit', size: 15 })));
    }

    /** The frame-wide float: quick capture that stays above every panel. */
    function MiniFloat() {
      const [open, setOpen] = useState(floatBus.open);
      const [offset, setOffset] = useState({ x: 0, y: 0 });
      const [content, setContent] = useState('');
      const [attachments, setAttachments] = useState([]);
      const [notes, setNotes] = useState([]);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState(false);
      const [editingId, setEditingId] = useState(null);
      const dragRef = useRef(null);
      const floatRef = useRef(null);
      const viewportRef = useRef(null);

      useEffect(() => floatBus.subscribe(setOpen), []);

      const loadNotes = useCallback(async () => {
        try {
          const snapshot = await api('snapshot', {});
          setNotes(Array.isArray(snapshot?.notes) ? snapshot.notes.slice(0, 3) : []);
        } catch (failure) {
          setError(failure.message || String(failure));
        }
      }, []);

      useEffect(() => {
        if (!open) return;
        void loadNotes();
      }, [open, loadNotes]);

      /**
       * Anchor the float to its viewport position.
       *
       * The overlay container is re-created when the user switches panels, so
       * the resting place moves with it. Measuring the live rect and
       * correcting the transform restores the stored viewport position.
       */
      const anchorToViewport = useCallback(() => {
        const element = floatRef.current;
        if (!element) return;
        const rect = element.getBoundingClientRect();
        const target = clampFloatPosition(readFloatViewport(element), element);
        const deltaX = target.left - rect.left;
        const deltaY = target.top - rect.top;
        viewportRef.current = target;
        writeStoredValue(FLOAT_VIEWPORT_KEY, target);
        if (deltaX === 0 && deltaY === 0) return;
        setOffset((current) => ({ x: current.x + deltaX, y: current.y + deltaY }));
      }, []);

      useEffect(() => {
        if (!open) return undefined;
        const frame = requestAnimationFrame(anchorToViewport);
        window.addEventListener('resize', anchorToViewport);
        return () => {
          cancelAnimationFrame(frame);
          window.removeEventListener('resize', anchorToViewport);
        };
      }, [open, anchorToViewport]);

      useEffect(() => {
        if (!open) return undefined;
        const move = (event) => {
          const drag = dragRef.current;
          if (!drag) return;
          const element = floatRef.current;
          // The viewport is the only stable origin, so the target is measured
          // there and then expressed as a transform offset from the resting spot.
          const target = clampFloatPosition({
            left: event.clientX - drag.offsetX,
            top: event.clientY - drag.offsetY,
          }, element);
          const base = drag.resting;
          viewportRef.current = target;
          writeStoredValue(FLOAT_VIEWPORT_KEY, target);
          setOffset({
            x: base.x + (target.left - base.left),
            y: base.y + (target.top - base.top),
          });
        };
        const stop = () => {
          if (!dragRef.current) return;
          dragRef.current = null;
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', stop);
        return () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', stop);
        };
      }, [open]);

      useEffect(() => {
        if (!open) return undefined;
        const keepInside = () => {
          const element = floatRef.current;
          if (!element) return;
          const rect = element.getBoundingClientRect();
          const clamped = clampFloatPosition({ left: rect.left, top: rect.top }, element);
          const deltaX = clamped.left - rect.left;
          const deltaY = clamped.top - rect.top;
          viewportRef.current = clamped;
          writeStoredValue(FLOAT_VIEWPORT_KEY, clamped);
          if (deltaX === 0 && deltaY === 0) return;
          setOffset((current) => ({ x: current.x + deltaX, y: current.y + deltaY }));
        };
        keepInside();
        window.addEventListener('resize', keepInside);
        return () => window.removeEventListener('resize', keepInside);
      }, [open]);

      const save = async () => {
        if (busy) return;
        if (!content.trim() && attachments.length === 0) return;
        setBusy(true);
        setError('');
        try {
          if (editingId) {
            await api('update', { id: editingId, content, attachments });
          } else {
            await api('create', { content, attachments });
          }
          setContent('');
          setAttachments([]);
          setEditingId(null);
          await loadNotes();
        } catch (failure) {
          setError(failure.message || String(failure));
        } finally {
          setBusy(false);
        }
      };

      const handlePaste = async (event) => {
        const pasted = await readClipboardAttachments(event);
        if (!pasted.length) return;
        event.preventDefault();
        const accepted = mergeClipboardAttachments(attachments, pasted, setError);
        if (accepted.length) setAttachments([...attachments, ...accepted]);
      };

      /**
       * Open the desktop float.
       *
       * The in-page float cannot leave the Harness window, so the window that
       * stays on the desktop is a separate native window the Host starts.
       */
      const openDesktopFloat = useCallback(async () => {
        try {
          await api('float-open', {});
          setError('');
        } catch (failure) {
          setError(failure.message || String(failure));
        }
      }, []);

      if (!open) return null;

      const style = { transform: `translate3d(${offset.x}px, ${offset.y}px, 0)` };

      return h('section', {
        ref: floatRef,
        className: cx('mm-float'),
        style,
        'aria-label': 'Moments float',
      },
        h('header', {
          className: 'mm-float-header',
          onPointerDown: (event) => {
            const element = floatRef.current;
            if (!element) return;
            const rect = element.getBoundingClientRect();
            dragRef.current = {
              offsetX: event.clientX - rect.left,
              offsetY: event.clientY - rect.top,
              resting: { x: offset.x, y: offset.y, left: rect.left, top: rect.top },
            };
            event.preventDefault();
            event.stopPropagation();
          },
        },
          h('span', { className: 'mm-float-title' }, 'Moments'),
          h('div', { className: 'mm-float-actions' },
            h('button', {
              type: 'button',
              className: 'mm-float-button',
              title: 'Open the desktop float',
              'aria-label': 'Open the desktop float',
              onClick: () => void openDesktopFloat(),
            }, 'Desktop'),
            h('button', {
              type: 'button',
              className: 'mm-float-button',
              title: 'Close the float',
              'aria-label': 'Close the float',
              onClick: () => floatBus.set(false),
            }, h(Icon, { name: 'close', size: 14 })))),
        h('div', { className: 'mm-float-body' },
          h('textarea', {
            className: 'mm-float-input',
            value: content,
            placeholder: 'Capture a thought, file it with #tags',
            'aria-label': 'Float note content',
            rows: 3,
            onChange: (event) => setContent(event.target.value),
            onPaste: (event) => void handlePaste(event),
            onKeyDown: (event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                void save();
              }
            },
          }),
          error ? h('div', { className: 'mm-float-error', role: 'alert' }, error) : null,
          h('div', { className: 'mm-float-footer' },
            h('span', { className: 'mm-float-count' }, `${content.length} chars`),
            editingId ? h('button', {
              type: 'button',
              className: 'mm-text-button is-quiet',
              onClick: () => { setEditingId(null); setContent(''); },
            }, 'Cancel') : null,
            h('button', {
              type: 'button',
              className: 'mm-float-save',
              onClick: () => void save(),
              disabled: busy || (!content.trim() && attachments.length === 0),
            }, busy ? 'Saving…' : 'Save')),
          notes.length ? h('ul', { className: 'mm-float-list' }, notes.map((note) => h('li', { key: note.id },
            h('button', {
              type: 'button',
              className: 'mm-float-note',
              onClick: () => { setEditingId(note.id); setContent(note.content || ''); setAttachments(note.attachments || []); },
            }, h('time', null, formatFullDate(note.createdAt)), h('span', null, (note.content || 'ImageNotes').slice(0, 40)))))) : null));
    }

    function NoteCard({
      note,
      onEdit,
      onCopy,
      onAction,
      onRelated,
      onTag,
      onAddToCanvas,
      expandedNotes,
      onToggleExpand,
      busy,
      compact,
      editingId,
      onSaveInline,
      onCancelInline,
      onError,
    }) {
      const content = String(note.content || '');
      const isLong = content.length > LONG_NOTE_LENGTH || content.split(/\r?\n/).length > 8;
      const expanded = expandedNotes.has(note.id);
      const deleted = Boolean(note.deletedAt);
      const editing = editingId === note.id;
      return h('article', {
        className: cx('mm-note-card', note.pinned && !deleted && 'is-pinned', compact && 'is-compact', editing && 'is-editing'),
        onDoubleClick: () => onEdit(note),
        title: 'Double-click to edit',
      },
        h('header', { className: 'mm-note-header' },
          h('div', { className: 'mm-note-time' },
            h('time', { dateTime: validDate(note.createdAt).toISOString() }, `${formatFullDate(note.createdAt)} · ${formatTime(note.createdAt)}`),
            note.updatedAt && note.updatedAt !== note.createdAt ? h('span', null, 'Edited') : null),
          note.pinned && !deleted ? h('span', { className: 'mm-pinned-badge' }, h(Icon, { name: 'pin', size: 12 }), 'Pin') : null),
        editing
          ? h(InlineEditor, {
            note,
            onSave: (content, attachments) => onSaveInline(note, content, attachments),
            onCancel: onCancelInline,
            busy,
            onError,
          })
          : h(React.Fragment, null,
            h('div', { className: cx('mm-note-content', isLong && !expanded && 'is-collapsed') },
              content ? h(SafeText, { content, onTag }) : h('span', { className: 'mm-muted' }, 'ImageNotes')),
            isLong ? h('button', {
              type: 'button',
              className: 'mm-expand-button',
              onClick: () => onToggleExpand(note.id),
              onDoubleClick: (event) => event.stopPropagation(),
              'aria-expanded': expanded,
            }, expanded ? 'Collapse' : 'Expand') : null,
            note.attachments?.length ? h('div', { className: 'mm-note-images' }, note.attachments.map((attachment) => (
              h('a', {
                href: attachment.dataUrl,
                target: '_blank',
                rel: 'noreferrer noopener',
                className: 'mm-note-image-link',
                'aria-label': `View image ${attachment.name || ''}`,
                onDoubleClick: (event) => event.stopPropagation(),
                key: attachment.id,
              }, h('img', { src: attachment.dataUrl, alt: attachment.name || 'NotesImage', loading: 'lazy' }))
            ))) : null),
        deleted ? h('div', { className: 'mm-deleted-hint' }, `Deleted on ${formatFullDate(note.deletedAt)}`) : null,
        editing ? null : h('footer', {
          className: 'mm-note-actions',
          onDoubleClick: (event) => event.stopPropagation(),
        },
          !deleted ? h(ActionButton, { icon: 'edit', label: 'Edit', onClick: () => onEdit(note), disabled: busy }) : null,
          h(ActionButton, { icon: 'copy', label: 'Copy', onClick: () => void onCopy(note), disabled: busy }),
          !deleted ? h(ActionButton, {
            icon: 'pin', label: note.pinned ? 'CancelPin' : 'Pin', onClick: () => void onAction('pin', note), disabled: busy,
          }) : null,
          h(ActionButton, { icon: 'link', label: 'Related notes', onClick: () => onRelated(note), disabled: busy }),
          !deleted ? h(ActionButton, { icon: 'canvas', label: 'Add to design', onClick: () => onAddToCanvas(note), disabled: busy }) : null,
          deleted ? h(ActionButton, { icon: 'restore', label: 'Restore', onClick: () => void onAction('restore', note), disabled: busy }) : null,
          h(ActionButton, {
            icon: 'trash',
            label: deleted ? 'Delete permanently' : 'Delete',
            className: 'is-danger',
            onClick: () => void onAction(deleted ? 'purge' : 'trash', note),
            disabled: busy,
          })));
    }

    function SearchBar({ query, onChange, onSearch, recentSearches, searchRef }) {
      const [open, setOpen] = useState(false);
      return h('div', {
        className: 'mm-search-wrap',
        onBlur: (event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
        },
      },
        h('form', {
          className: 'mm-search',
          role: 'search',
          onSubmit: (event) => {
            event.preventDefault();
            onSearch(query);
            setOpen(false);
          },
        },
          h(Icon, { name: 'search', size: 17 }),
          h('input', {
            ref: searchRef,
            value: query,
            onChange: (event) => onChange(event.target.value),
            onFocus: () => setOpen(true),
            placeholder: 'Search notes, tags or attachments…',
            'aria-label': 'Search notes',
          }),
          query ? h('button', {
            type: 'button', className: 'mm-search-clear', onClick: () => onChange(''), 'aria-label': 'Clear search',
          }, h(Icon, { name: 'close', size: 14 })) : h('kbd', null, '/')),
        open && recentSearches.length ? h('div', { className: 'mm-recent-searches' },
          h('div', { className: 'mm-recent-title' }, 'Recent searches'),
          recentSearches.map((term) => h('button', {
            type: 'button',
            key: term,
            onClick: () => {
              onChange(term);
              onSearch(term);
              setOpen(false);
            },
          }, h(Icon, { name: 'search', size: 12 }), term))) : null);
    }

    function TagTree({ nodes, activeTag, onTag }) {
      const [collapsed, setCollapsed] = useState(() => new Set());
      const toggle = (path) => {
        setCollapsed((current) => {
          const next = new Set(current);
          if (next.has(path)) next.delete(path);
          else next.add(path);
          return next;
        });
      };
      const renderNodes = (items, depth) => items.map((node) => {
        const isCollapsed = collapsed.has(node.fullName);
        return h('div', { className: 'mm-tag-node', key: node.fullName },
          h('div', { className: 'mm-tag-row', style: { '--mm-depth': depth } },
            node.children.length ? h('button', {
              type: 'button',
              className: cx('mm-tag-chevron', !isCollapsed && 'is-open'),
              onClick: () => toggle(node.fullName),
              'aria-label': `${isCollapsed ? 'Expand' : 'Collapse'}Tags ${node.fullName}`,
              'aria-expanded': !isCollapsed,
            }, h(Icon, { name: 'chevron', size: 11 })) : h('span', { className: 'mm-tag-spacer' }),
            h('button', {
              type: 'button',
              className: cx('mm-tag-button', activeTag === node.fullName && 'is-active'),
              onClick: () => onTag(node.fullName),
              title: `#${node.fullName}`,
            }, h('span', { className: 'mm-tag-name' }, node.name), h('span', { className: 'mm-tag-count' }, node.count))),
          node.children.length && !isCollapsed ? h('div', { className: 'mm-tag-children' }, renderNodes(node.children, depth + 1)) : null);
      });
      if (!nodes.length) return h('p', { className: 'mm-sidebar-empty' }, 'Notes with #tags show up here');
      return h('div', { className: 'mm-tag-tree' }, renderNodes(nodes, 0));
    }

    function deriveStats(notes) {
      const active = notes.filter((note) => !note.deletedAt);
      const days = new Set(active.map((note) => dateKey(note.createdAt)));
      const today = dateKey(new Date());
      let streak = 0;
      const cursor = new Date();
      if (!days.has(today)) cursor.setDate(cursor.getDate() - 1);
      while (days.has(dateKey(cursor))) {
        streak += 1;
        cursor.setDate(cursor.getDate() - 1);
      }
      return {
        total: active.length,
        today: active.filter((note) => dateKey(note.createdAt) === today).length,
        pinned: active.filter((note) => note.pinned).length,
        tags: new Set(active.flatMap((note) => extractTags(note.content))).size,
        images: active.reduce((sum, note) => sum + (note.attachments?.length || 0), 0),
        streak,
        activeDays: days.size,
      };
    }

    function Heatmap({ notes, dateFilter, onSelect }) {
      const counts = useMemo(() => {
        const map = new Map();
        notes.filter((note) => !note.deletedAt).forEach((note) => {
          const key = dateKey(note.createdAt);
          map.set(key, (map.get(key) || 0) + 1);
        });
        return map;
      }, [notes]);
      const days = useMemo(() => {
        const result = [];
        const today = new Date();
        for (let offset = 83; offset >= 0; offset -= 1) {
          const date = new Date(today);
          date.setDate(today.getDate() - offset);
          const key = dateKey(date);
          result.push({ key, date, count: counts.get(key) || 0 });
        }
        return result;
      }, [counts]);
      const max = Math.max(1, ...days.map((day) => day.count));
      return h('section', { className: 'mm-heatmap', 'aria-label': 'Note heatmap, last twelve weeks' },
        h('div', { className: 'mm-section-heading' },
          h('h3', null, 'Writing trail'),
          h('span', null, 'Last 12 weeks')),
        h('div', { className: 'mm-heatmap-grid' }, days.map((day) => {
          const level = day.count === 0 ? 0 : Math.max(1, Math.ceil((day.count / max) * 4));
          return h('button', {
            type: 'button',
            key: day.key,
            className: cx('mm-heat-cell', `level-${level}`, dateFilter === `day:${day.key}` && 'is-selected'),
            title: `${day.key}: ${day.count} notes`,
            'aria-label': `${day.key}, ${day.count} notes`,
            onClick: () => onSelect(dateFilter === `day:${day.key}` ? 'all' : `day:${day.key}`),
          });
        })),
        h('div', { className: 'mm-heatmap-legend' }, h('span', null, 'Less'), [0, 1, 2, 3, 4].map((level) => h('i', { className: `level-${level}`, key: level })), h('span', null, 'More')));
    }

    function StatsPanel({ notes, tags, snapshotStats, dateFilter, onSelectDate }) {
      const stats = deriveStats(notes);
      const tree = useMemo(() => buildTagTree(notes, tags), [notes, tags]);
      const treeCount = tree.reduce((sum, node) => sum + node.count, 0);
      return h('div', { className: 'mm-stats-panel' },
        h('section', null,
          h('div', { className: 'mm-section-heading' }, h('h3', null, 'Note statistics'), snapshotStats?.version ? h('span', null, `v${snapshotStats.version}`) : null),
          h('div', { className: 'mm-stat-grid' },
            h('div', { className: 'mm-stat-card is-primary' }, h('strong', null, stats.total), h('span', null, 'Total notes')),
            h('div', { className: 'mm-stat-card' }, h('strong', null, stats.today), h('span', null, 'Added today')),
            h('div', { className: 'mm-stat-card' }, h('strong', null, stats.streak), h('span', null, 'Day streak')),
            h('div', { className: 'mm-stat-card' }, h('strong', null, stats.activeDays), h('span', null, 'Days recorded'))),
          h('div', { className: 'mm-stat-details' },
            h('span', null, `${stats.pinned} pinned`),
            h('span', null, `${stats.tags || treeCount} tags`),
            h('span', null, `${stats.images} images`))),
        h(Heatmap, { notes, dateFilter, onSelect: onSelectDate }));
    }

    function EmptyState({ filtered, onClear, onCreate }) {
      return h('div', { className: 'mm-empty-state' },
        h('div', { className: 'mm-empty-illustration', 'aria-hidden': true }, h(Icon, { name: filtered ? 'search' : 'edit', size: 28 })),
        h('h2', null, filtered ? 'No notes match these filters' : 'This workspace is empty so far'),
        h('p', null, filtered
          ? 'The keyword, the date range and the tag all narrow the same timeline — drop one and the rest comes back.'
          : 'Everything you write is saved in this workspace. Add #tags as you type to file a note, and #tags/subtags to nest it.'),
        h('button', { type: 'button', className: 'mm-primary-button', onClick: filtered ? onClear : onCreate }, filtered ? 'Clear filters' : 'Write the first note'));
    }

    function LoadingState({ label = 'Loading notes…' }) {
      return h('div', { className: 'mm-loading', role: 'status' },
        h('span', { className: 'mm-spinner', 'aria-hidden': true }),
        h('span', null, label));
    }

    function Timeline({ notes, loading, filtered, onClear, onCreate, noteProps }) {
      if (loading) return h(LoadingState);
      if (!notes.length) return h(EmptyState, { filtered, onClear, onCreate });
      const groups = new Map();
      notes.forEach((note) => {
        const key = dateKey(note.createdAt);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(note);
      });
      return h('div', { className: 'mm-timeline' }, [...groups.entries()].map(([day, dayNotes]) => (
        h('section', { className: 'mm-day-group', key: day },
          h('div', { className: 'mm-day-marker' },
            h('h2', null, formatDay(dayNotes[0].createdAt)),
            h('span', null, `${dayNotes.length} notes`)),
          h('div', { className: 'mm-day-notes' }, dayNotes.map((note) => h(NoteCard, { ...noteProps, note, key: note.id }))))
      )));
    }

    function ReviewPanel({ noteProps, onError, notes }) {
      const [mode, setMode] = useState('random');
      const [reviewNotes, setReviewNotes] = useState([]);
      const [reviewLoading, setReviewLoading] = useState(true);
      const [reviewError, setReviewError] = useState('');
      const mounted = useRef(true);
      useEffect(() => () => { mounted.current = false; }, []);

      useEffect(() => {
        setReviewNotes((current) => current
          .map((reviewNote) => notes.find((note) => note.id === reviewNote.id))
          .filter((note) => note && !note.deletedAt));
      }, [notes]);

      const loadReview = useCallback(async (nextMode) => {
        const mode = nextMode;
        setMode(mode);
        setReviewLoading(true);
        setReviewError('');
        try {
          const result = await api('review', { mode });
          if (mounted.current) setReviewNotes(Array.isArray(result) ? result : []);
        } catch (error) {
          if (mounted.current) {
            setReviewError(error.message || String(error));
            onError(error.message || String(error));
          }
        } finally {
          if (mounted.current) setReviewLoading(false);
        }
      }, [onError]);

      useEffect(() => {
        void loadReview('random');
      }, [loadReview]);

      return h('section', { className: 'mm-review-panel', 'aria-label': 'Daily review' },
        h('div', { className: 'mm-review-heading' },
          h('h1', null, 'Daily review'),
          h('p', null, 'Pick a memory at random, or revisit what you wrote on this day in past years.')),
        h('div', { className: 'mm-review-controls', role: 'group', 'aria-label': 'Review mode' },
          h('button', {
            type: 'button', className: cx(mode === 'random' && 'is-active'), onClick: () => void loadReview('random'), disabled: reviewLoading,
          }, h(Icon, { name: 'review' }), mode === 'random' ? 'Random review · Another batch' : 'Random review'),
          h('button', {
            type: 'button', className: cx(mode === 'on-this-day' && 'is-active'), onClick: () => void loadReview('on-this-day'), disabled: reviewLoading,
          }, mode === 'on-this-day' ? 'On this day' : 'On this day in past years')),
        reviewError ? h('div', { className: 'mm-inline-error', role: 'alert' }, reviewError, h('button', { type: 'button', onClick: () => void loadReview(mode) }, 'Retry')) : null,
        reviewLoading ? h(LoadingState, { label: 'Looking for a note worth revisiting…' }) : null,
        !reviewLoading && !reviewNotes.length ? h('div', { className: 'mm-empty-state' },
          h('div', { className: 'mm-empty-illustration' }, h(Icon, { name: 'review', size: 28 })),
          h('h2', null, mode === 'random' ? 'Nothing to review yet' : 'No notes from this day in past years'),
          h('p', null, mode === 'random'
            ? 'A review draws from notes you have already written. Add a few and they will come back at random.'
            : 'Nothing was written on this date in an earlier year — keep writing, and next year this day will bring a surprise.')) : null,
        !reviewLoading && reviewNotes.length ? h('div', { className: 'mm-review-notes' },
          h('div', { className: 'mm-review-count' }, `Found ${reviewNotes.length} notes for you`),
          reviewNotes.map((note) => h(NoteCard, { ...noteProps, note, compact: true, key: note.id }))) : null);
    }

    function DialogShell({ title, onClose, children, className }) {
      return h('div', {
        className: 'mm-overlay',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) onClose();
        },
      }, h('section', {
        className: cx('mm-dialog', className),
        role: 'dialog',
        'aria-modal': true,
        'aria-label': title,
      },
        h('header', { className: 'mm-dialog-header' },
          h('h2', null, title),
          h('button', { type: 'button', className: 'mm-icon-button', onClick: onClose, 'aria-label': 'Close the dialog' }, h(Icon, { name: 'close' }))),
        children));
    }

    function RelatedDialog({ note, onClose, onSelect, onTag }) {
      const [relatedNotes, setRelatedNotes] = useState([]);
      const [relatedLoading, setRelatedLoading] = useState(true);
      const [error, setError] = useState('');
      useEffect(() => {
        let active = true;
        const id = note.id;
        const limit = 6;
        setRelatedLoading(true);
        setError('');
        api('related', { id, limit }).then((result) => {
          if (active) setRelatedNotes(Array.isArray(result) ? result : []);
        }).catch((failure) => {
          if (active) setError(failure.message || String(failure));
        }).finally(() => {
          if (active) setRelatedLoading(false);
        });
        return () => { active = false; };
      }, [note.id]);
      return h(DialogShell, { title: 'Related notes', onClose, className: 'mm-related-dialog' },
        h('div', { className: 'mm-related-source' },
          h('span', null, 'Current note'),
          h(SafeText, { content: note.content || 'ImageNotes', onTag })),
        h('div', { className: 'mm-related-body' },
          relatedLoading ? h(LoadingState, { label: 'Looking for related notes…' }) : null,
          error ? h('div', { className: 'mm-inline-error', role: 'alert' }, error) : null,
          !relatedLoading && !error && !relatedNotes.length ? h('p', { className: 'mm-dialog-empty' }, 'Nothing related yet — try giving both notes a shared tag.') : null,
          !relatedLoading ? relatedNotes.map((related) => h('article', { className: 'mm-related-card', key: related.id },
            h('time', null, formatFullDate(related.createdAt)),
            h(SafeText, { content: related.content || 'ImageNotes', onTag }),
            h('button', { type: 'button', className: 'mm-text-button', onClick: () => onSelect(related) }, 'See what relates to this note', h(Icon, { name: 'arrowRight', size: 13 })))) : null));
    }

    function ConfirmDialog({ config, busy, onCancel, onConfirm }) {
      return h(DialogShell, { title: config.title, onClose: onCancel, className: 'mm-confirm-dialog' },
        h('p', { className: 'mm-confirm-body' }, config.body),
        config.warning ? h('p', { className: 'mm-confirm-warning' }, config.warning) : null,
        h('div', { className: 'mm-dialog-actions' },
          h('button', { type: 'button', className: 'mm-secondary-button', onClick: onCancel, disabled: busy, autoFocus: true }, 'Cancel'),
          h('button', { type: 'button', className: 'mm-danger-button', onClick: () => void onConfirm(), disabled: busy }, busy ? 'Working…' : config.confirmLabel)));
    }

    function ImportDialog({ data, fileName, busy, onClose, onImport }) {
      const notes = Array.isArray(data) ? data : Array.isArray(data?.notes) ? data.notes : [];
      return h(DialogShell, { title: 'Import a note backup', onClose, className: 'mm-import-dialog' },
        h('div', { className: 'mm-import-file' }, h(Icon, { name: 'upload', size: 22 }),
          h('div', null, h('strong', null, fileName), h('span', null, `Imported ${notes.length} notes`))),
        h('p', { className: 'mm-dialog-description' }, 'Merging keeps your current notes; replacing clears them first, so choose carefully.'),
        h('div', { className: 'mm-import-options' },
          h('button', { type: 'button', className: 'mm-primary-button', onClick: () => void onImport(data, 'merge'), disabled: busy }, busy ? 'Importing…' : 'Merge import'),
          h('button', { type: 'button', className: 'mm-danger-button', onClick: () => void onImport(data, 'replace'), disabled: busy }, 'Replace import')));
    }

    /* ================================================================
     * The infinite canvas
     *
     * A canvas is a scene graph: typed nodes that own a rectangle in
     * world space, and edges between them. The Host owns the format
     * (lib/canvas-domain.js); this half owns the camera, the tools and
     * the gestures. A new kind of object is a new renderer and a new
     * tool — never a new document format.
     * ================================================================ */

    const CANVAS_ACTIVE_KEY = 'moments-notes:canvas-active';
    /** Host route that serves one board as the SVG a chat card previews. */
    const DESIGN_PREVIEW_ROUTE = '/api/moments-notes/design-preview';
    /** Tools whose result card shows the board they touched. */
    const DESIGN_TOOL_NAMES = Object.freeze([
      'design_begin', 'design_tokens', 'design_nodes', 'design_finish', 'design_inspect', 'design_export',
    ]);
    const CANVAS_LAYERS_COLLAPSED_KEY = 'moments-notes:canvas-layers-collapsed';
    const CANVAS_ASSET_ROUTE = '/api/moments-notes/asset';
    const CANVAS_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
    const CANVAS_IMAGE_MAX_WIDTH = 480;
    const CANVAS_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']);
    const CANVAS_FIG_MAX_BYTES = 50 * 1024 * 1024;
    const CANVAS_GRID_SIZE = 24;
    // The same limits as the document format, so a save never surprises.
    const CANVAS_ZOOM_MIN = 0.05;
    const CANVAS_ZOOM_MAX = 4;
    const CANVAS_SAVE_DELAY = 600;
    const CANVAS_HISTORY_LIMIT = 40;
    const CANVAS_NODE_MIN_SIZE = 16;
    // The Host refuses a node outside this range; a gesture must never be able
    // to produce a value the save will reject.
    const CANVAS_NODE_MAX_SIZE = 8000;
    // A container's box is derived from its members, and a real section can be
    // far wider than one object: clamping it to the leaf limit would shrink the
    // frame until its own contents hang outside it.
    const CANVAS_CONTAINER_MAX_SIZE = 100000;
    const CANVAS_TEXT_LIMIT = 4000;
    const CANVAS_STICKY_SIZE = { w: 220, h: 150 };
    const CANVAS_LABEL_SIZE = { w: 200, h: 40 };
    const CANVAS_SHAPE_SIZE = { w: 180, h: 120 };
    const CANVAS_FRAME_SIZE = { w: 480, h: 320 };
    const CANVAS_NOTE_SIZE = { w: 240, h: 150 };
    // `hint` is the keyboard shortcut, `hintText` says what the tool does. The
    // bar shows the hovered tool's sentence in the space next to the icons, so
    // an icon never has to carry a whole idea on its own.
    const CANVAS_TOOLS = [
      { id: 'select', icon: 'pointer', label: 'Select', hint: 'V', hintText: 'click to select, drag to move' },
      { id: 'hand', icon: 'hand', label: 'Pan', hint: 'H', hintText: 'drag the board around' },
      { id: 'sticky', icon: 'sticky', label: 'Sticky note', hint: 'N', hintText: 'click to drop a note' },
      { id: 'text', icon: 'text', label: 'Text', hint: 'T', hintText: 'click to type' },
      { id: 'frame', icon: 'frame', label: 'Frame', hint: 'F', hintText: 'click to make a frame' },
      { id: 'rect', icon: 'rect', label: 'Rectangle', hint: 'R', hintText: 'click to draw a rectangle' },
      { id: 'ellipse', icon: 'ellipse', label: 'Ellipse', hint: 'O', hintText: 'click to draw an ellipse' },
      { id: 'path', icon: 'pen', label: 'Pen', hint: 'P', hintText: 'click anchors, Enter to finish' },
      { id: 'image', icon: 'image', label: 'Place a picture', hint: 'I', hintText: 'pick an image file' },
      { id: 'connector', icon: 'connector', label: 'Connector', hint: 'C', hintText: 'drag between two objects' },
    ];
    const CANVAS_UNDO_HINT = { label: 'Undo', hint: '⌘Z', hintText: 'step back one change' };
    const CANVAS_REDO_HINT = { label: 'Redo', hint: '⌘⇧Z', hintText: 'step forward again' };
    const CANVAS_NODE_LABELS = { note: 'Note', sticky: 'Sticky note', text: 'Text', shape: 'Shape', group: 'Group', frame: 'Frame', component: 'Component', instance: 'Instance' };
    const CANVAS_GROUP_PADDING = 12;
    const CANVAS_OVERVIEW_ZOOM = 0.35;
    const CANVAS_POUR_GAP = 32;
    const CANVAS_POUR_MIN_COLUMNS = 3;
    const CANVAS_POUR_MAX_COLUMNS = 8;
    const CANVAS_PALETTE_TOKENS = [
      { id: 'none', value: null, label: 'No fill' },
      { id: 'ember', token: '--mm-palette-ember', label: 'Ember' },
      { id: 'amber', token: '--mm-palette-amber', label: 'Amber' },
      { id: 'rose', token: '--mm-palette-rose', label: 'Rose' },
      { id: 'sage', token: '--mm-palette-sage', label: 'Sage' },
      { id: 'sky', token: '--mm-palette-sky', label: 'Sky' },
      { id: 'violet', token: '--mm-palette-violet', label: 'Violet' },
      { id: 'slate', token: '--mm-palette-slate', label: 'Slate' },
    ];
    const CANVAS_STROKE_WIDTHS = [0, 1, 2, 4];
    const CANVAS_RADII = [0, 8, 24];
    const CANVAS_OPACITIES = [0.25, 0.5, 0.75, 1];
    // Above this many nodes the board only draws what the viewport can show.
    const CANVAS_CULL_MIN_NODES = 120;
    const CANVAS_CULL_MARGIN = 320;
    const BLEND_MODE_OPTIONS = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'soft-light', 'hard-light', 'difference', 'exclusion'];
    const CANVAS_PINS_H = ['left', 'center', 'right', 'left-right', 'scale'];
    const CANVAS_PINS_V = ['top', 'center', 'bottom', 'top-bottom', 'scale'];
    const CANVAS_TEXT_ALIGNS = [
      { id: 'left', label: 'Left' },
      { id: 'center', label: 'Center' },
      { id: 'right', label: 'Right' },
    ];
    const CANVAS_ALIGNMENTS = [
      { id: 'left', icon: 'alignLeft', label: 'Align left' },
      { id: 'center-x', icon: 'alignCenterX', label: 'Align horizontal centers' },
      { id: 'right', icon: 'alignRight', label: 'Align right' },
      { id: 'top', icon: 'alignTop', label: 'Align top' },
      { id: 'center-y', icon: 'alignCenterY', label: 'Align vertical centers' },
      { id: 'bottom', icon: 'alignBottom', label: 'Align bottom' },
      { id: 'distribute-x', icon: 'distributeX', label: 'Distribute horizontally' },
      { id: 'distribute-y', icon: 'distributeY', label: 'Distribute vertically' },
    ];

    function clampCanvasZoom(zoom) {
      if (!Number.isFinite(zoom)) return 1;
      return Math.min(CANVAS_ZOOM_MAX, Math.max(CANVAS_ZOOM_MIN, zoom));
    }

    /** Screen point to world point. The camera offset is a screen-space translation. */
    function canvasScreenToWorld(point, camera) {
      const zoom = camera.zoom || 1;
      return { x: (point.x - camera.x) / zoom, y: (point.y - camera.y) / zoom };
    }

    /** World point to screen point. */
    function canvasWorldToScreen(point, camera) {
      const zoom = camera.zoom || 1;
      return { x: point.x * zoom + camera.x, y: point.y * zoom + camera.y };
    }

    /** Zoom while the world point under the pointer stays where it is. */
    function canvasZoomAt(camera, screenPoint, nextZoom) {
      const zoom = clampCanvasZoom(nextZoom);
      const anchor = canvasScreenToWorld(screenPoint, camera);
      return { x: screenPoint.x - anchor.x * zoom, y: screenPoint.y - anchor.y * zoom, zoom };
    }

    function canvasNodeBounds(node) {
      return { x: node.x, y: node.y, w: node.w, h: node.h };
    }

    /** The rectangle that holds every node, or null when there is none. */
    /** How close, in screen pixels, an edge must be before it snaps. */
    const CANVAS_SNAP_PIXELS = 6;

    /**
     * Snap one box to the boxes around it.
     *
     * Only the three alignments a designer actually names are candidates:
     * left/centre/right for the x axis and top/middle/bottom for the y axis.
     * The nearest candidate wins; a snapped axis reports the line to draw.
     */
    function canvasSnapBox(box, others, threshold) {
      const xs = [box.x, box.x + box.w / 2, box.x + box.w];
      const ys = [box.y, box.y + box.h / 2, box.y + box.h];
      let bestX = null;
      let bestY = null;
      for (const other of others) {
        const otherXs = [other.x, other.x + other.w / 2, other.x + other.w];
        const otherYs = [other.y, other.y + other.h / 2, other.y + other.h];
        for (const from of xs) {
          for (const to of otherXs) {
            const delta = to - from;
            if (Math.abs(delta) <= threshold && (!bestX || Math.abs(delta) < Math.abs(bestX.delta))) {
              bestX = { delta, position: to };
            }
          }
        }
        for (const from of ys) {
          for (const to of otherYs) {
            const delta = to - from;
            if (Math.abs(delta) <= threshold && (!bestY || Math.abs(delta) < Math.abs(bestY.delta))) {
              bestY = { delta, position: to };
            }
          }
        }
      }
      const guides = [];
      if (bestX && bestX.delta !== 0) guides.push({ axis: 'x', position: bestX.position });
      if (bestY && bestY.delta !== 0) guides.push({ axis: 'y', position: bestY.position });
      return {
        dx: bestX ? bestX.delta : 0,
        dy: bestY ? bestY.delta : 0,
        guides,
      };
    }

    /**
     * Re-place a container's children after the container was resized.
     *
     * Constraints are the difference between "the frame got wider" and "the
     * things inside it stayed put while the frame grew past them": a child
     * pinned to the right keeps its distance to the right edge, a stretched
     * child takes the width delta, a scaled child keeps its proportion. A
     * child that is itself a container carries its own members with it.
     */
    function canvasApplyConstraints(nodes, containerId, previous, next) {
      const byId = new Map(nodes.map((node) => [node.id, node]));
      const container = byId.get(containerId);
      if (!container) return nodes;
      const deltaWidth = next.w - previous.w;
      const deltaHeight = next.h - previous.h;
      const scaleX = next.w / (previous.w || 1);
      const scaleY = next.h / (previous.h || 1);
      const translate = (node, dx, dy) => {
        if (!dx && !dy) return;
        node.x += dx;
        node.y += dy;
        if (!canvasIsContainer(node)) return;
        for (const memberId of node.members || []) {
          const member = byId.get(memberId);
          if (member) translate(member, dx, dy);
        }
      };
      for (const memberId of container.members || []) {
        const member = byId.get(memberId);
        if (!member) continue;
        const pins = member.constraints || { horizontal: 'left', vertical: 'top' };
        const before = { x: member.x, y: member.y, w: member.w, h: member.h };
        let x = before.x;
        let w = before.w;
        if (pins.horizontal === 'right') x = next.x + next.w - (previous.x + previous.w - before.x);
        else if (pins.horizontal === 'center') x = next.x + next.w / 2 + (before.x - (previous.x + previous.w / 2));
        else if (pins.horizontal === 'left-right') {
          x = next.x + (before.x - previous.x);
          w = Math.min(CANVAS_NODE_MAX_SIZE, Math.max(CANVAS_NODE_MIN_SIZE, before.w + deltaWidth));
        } else if (pins.horizontal === 'scale') {
          x = next.x + (before.x - previous.x) * scaleX;
          w = Math.min(CANVAS_NODE_MAX_SIZE, Math.max(CANVAS_NODE_MIN_SIZE, before.w * scaleX));
        } else x = next.x + (before.x - previous.x);
        let y = before.y;
        let h = before.h;
        if (pins.vertical === 'bottom') y = next.y + next.h - (previous.y + previous.h - before.y);
        else if (pins.vertical === 'center') y = next.y + next.h / 2 + (before.y - (previous.y + previous.h / 2));
        else if (pins.vertical === 'top-bottom') {
          y = next.y + (before.y - previous.y);
          h = Math.min(CANVAS_NODE_MAX_SIZE, Math.max(CANVAS_NODE_MIN_SIZE, before.h + deltaHeight));
        } else if (pins.vertical === 'scale') {
          y = next.y + (before.y - previous.y) * scaleY;
          h = Math.min(CANVAS_NODE_MAX_SIZE, Math.max(CANVAS_NODE_MIN_SIZE, before.h * scaleY));
        } else y = next.y + (before.y - previous.y);
        const roundedX = Math.round(x);
        const roundedY = Math.round(y);
        translate(member, roundedX - before.x, roundedY - before.y);
        const memberLimit = canvasIsContainer(member) ? CANVAS_CONTAINER_MAX_SIZE : CANVAS_NODE_MAX_SIZE;
        member.w = Math.min(memberLimit, Math.max(CANVAS_NODE_MIN_SIZE, Math.round(w)));
        member.h = Math.min(memberLimit, Math.max(CANVAS_NODE_MIN_SIZE, Math.round(h)));
      }
      return nodes;
    }

    /** Move a container's members, and what they hold, by the same amount. */
    function canvasMoveMembers(nodes, containerId, dx, dy) {
      if (!dx && !dy) return nodes;
      const byId = new Map(nodes.map((node) => [node.id, node]));
      const moved = new Set();
      const move = (nodeId) => {
        if (moved.has(nodeId)) return;
        const node = byId.get(nodeId);
        if (!node) return;
        moved.add(nodeId);
        node.x = Math.round(node.x + dx);
        node.y = Math.round(node.y + dy);
        for (const memberId of node.members || []) move(memberId);
      };
      const container = byId.get(containerId);
      if (!container) return nodes;
      for (const memberId of container.members || []) move(memberId);
      return nodes;
    }

    /* ---------------------------------------------------------- commands
     *
     * The undo stack holds what changed, not a copy of the board: an edit
     * is a command and its inverse is a command too. These are the same
     * functions as lib/canvas-apply.js and lib/canvas-commands.js, which the
     * contract test keeps in step.
     */

    /** The node types that can hold other nodes. */
    const CANVAS_COMMAND_CONTAINERS = new Set(['group', 'frame', 'component']);

/**
 * Edit commands and their exact inverses.
 *
 * The undo stack used to hold whole documents: one changed field meant a
 * copy of every node and edge. A command is data, and its inverse is data
 * too, so the stack costs what the change costs.
 *
 * Every command here is invertible without knowing the document: the inverse
 * carries the values the command is about to overwrite.
 */

/** The kinds of edit a document can be changed by. */
const CANVAS_COMMANDS = Object.freeze([
  'insert',
  'remove',
  'reparent',
  'update',
  'insert-page',
  'remove-page',
  'set-variables',
  'set-theme',
]);

/** A new node, placed under a parent at a position among its children. */
function insertCommand({ parent, index, nodes }) {
  return { type: 'insert', parent, index, nodes };
}

/** A node and its subtree, taken out of the document. */
function removeCommand({ id, parent, index, nodes }) {
  return { type: 'remove', id, parent, index, nodes };
}

/** A node moved to another parent, or to another place among its siblings. */
function reparentCommand({ id, parent, index, fromParent, fromIndex }) {
  return { type: 'reparent', id, parent, index, fromParent, fromIndex };
}

/**
 * A node's own properties changed.
 *
 * Only the fields that differ are carried, and only those are restored: the
 * children and the parent of a node are not the node's own properties.
 */
function updateCommand({ id, changes, before }) {
  return { type: 'update', id, changes, before };
}

/** A page, and the subtree under it, placed among the document's pages. */
function insertPageCommand({ index, nodes }) {
  return { type: 'insert-page', index, nodes };
}

/** A page and its subtree, taken out of the document. */
function removePageCommand({ id, index, nodes }) {
  return { type: 'remove-page', id, index, nodes };
}

/** The document's variables and collections replaced. */
function setVariablesCommand({ variables, collections, before }) {
  return { type: 'set-variables', variables, collections, before };
}

/** The document's theme replaced. */
function setThemeCommand({ theme, before }) {
  return { type: 'set-theme', theme, before };
}

/**
 * The command that undoes this one.
 *
 * The inverse is built from what the command carries, not from the document:
 * undo must work on a document that has moved on since.
 */
function canvasInvertCommand(command) {
  if (!command || typeof command !== 'object') return null;
  switch (command.type) {
    case 'insert':
      // Undoing an insert means taking the nodes back out.
      return { type: 'remove', id: command.nodes?.[0]?.id, parent: command.parent, index: command.index, nodes: command.nodes };
    case 'remove':
      // Undoing a remove means putting the nodes back where they were. Only
      // the root of the removed subtree goes back under the parent: the rest
      // of the subtree belongs under the root, not beside it.
      return {
        type: 'insert',
        parent: command.parent,
        index: command.index,
        nodes: command.nodes?.slice(0, 1),
        restore: command.nodes,
      };
    case 'reparent':
      return { type: 'reparent', id: command.id, parent: command.fromParent, index: command.fromIndex, fromParent: command.parent, fromIndex: command.index };
    case 'update':
      return { type: 'update', id: command.id, changes: command.before || {}, before: command.changes || {} };
    case 'insert-page':
      return { type: 'remove-page', id: command.nodes?.[0]?.id, index: command.index, nodes: command.nodes };
    case 'remove-page':
      return { type: 'insert-page', index: command.index, nodes: command.nodes };
    case 'set-variables':
      return { type: 'set-variables', variables: command.before?.variables, collections: command.before?.collections, before: { variables: command.variables, collections: command.collections } };
    case 'set-theme':
      return { type: 'set-theme', theme: command.before, before: command.theme };
    default:
      return null;
  }
}

/** A short line saying what the command did, for a history list. */
function canvasDescribeCommand(command) {
  if (!command || typeof command !== 'object') return '';
  switch (command.type) {
    case 'insert':
      return `Added ${command.nodes?.length || 1} object${command.nodes?.length === 1 ? '' : 's'}`;
    case 'remove':
      return `Removed ${command.nodes?.length || 1} object${command.nodes?.length === 1 ? '' : 's'}`;
    case 'reparent':
      return 'Moved an object';
    case 'update':
      return `Changed ${Object.keys(command.changes || {}).join(', ') || 'an object'}`;
    case 'insert-page':
      return 'Added a page';
    case 'remove-page':
      return 'Removed a page';
    case 'set-variables':
      return 'Changed the variables';
    case 'set-theme':
      return 'Changed the theme';
    default:
      return 'Changed the board';
  }
}

/**
 * Applying edit commands to a document.
 *
 * A command is data; this module turns it into a new document. Every
 * function returns a new list of nodes rather than changing the one it was
 * given, so an undo can be applied to the same document the edit was.
 */

/** The container that holds a node, and where in its member list. */
function canvasOwnerOf(nodes, id) {
  for (const node of nodes) {
    if (!CANVAS_COMMAND_CONTAINERS.has(node.type)) continue;
    const index = (node.members || []).indexOf(id);
    if (index >= 0) return { parent: node.id, index };
  }
  return { parent: null, index: 0 };
}

/** A container with a new member list. */
function canvasWithMembers(nodes, parentId, members) {
  if (!parentId) return nodes;
  return nodes.map((node) => (node.id === parentId ? { ...node, members } : node));
}

/** The subtree under a node, the node first. */
function canvasSubtreeOf(nodes, rootId) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const out = [];
  const walk = (id) => {
    const node = byId.get(id);
    if (!node) return;
    out.push(node);
    for (const memberId of node.members || []) walk(memberId);
  };
  walk(rootId);
  return out;
}

/** The nodes a command adds, without the ones already in the document. */
function canvasWithoutExisting(nodes, added) {
  if (!added || !added.length) return nodes;
  const present = new Set(nodes.map((node) => node.id));
  const fresh = added.filter((node) => !present.has(node.id));
  return fresh.length ? [...nodes, ...fresh] : nodes;
}

/**
 * Apply one command.
 *
 * The result is a new list of nodes; the caller keeps the edges and the rest
 * of the document. A command that does not apply (its target is gone) returns
 * the nodes unchanged rather than throwing: the undo stack outlives the
 * document it was built from.
 */
function canvasApplyCommand(nodes, command) {
  if (!command || typeof command !== 'object') return nodes;
  switch (command.type) {
    case 'insert': {
      const parent = command.parent;
      const current = parent ? (nodes.find((node) => node.id === parent)?.members || []) : [];
      const members = [...current];
      const at = Math.max(0, Math.min(members.length, command.index ?? members.length));
      members.splice(at, 0, ...(command.nodes || []).map((node) => node.id));
      // A restore brings back a whole subtree: the root goes under the
      // parent, and the rest of the subtree comes back with its own children.
      const restored = command.restore || command.nodes;
      return canvasWithMembers(canvasWithoutExisting(nodes, restored), parent, members);
    }
    case 'remove': {
      // The whole subtree goes: leaving a child behind would leave an
      // orphan that the membership rules would then reject.
      const gone = new Set((command.nodes || []).map((node) => node.id));
      const kept = nodes.filter((node) => !gone.has(node.id));
      const parent = command.parent;
      if (!parent) return kept;
      const container = kept.find((node) => node.id === parent);
      if (!container) return kept;
      const members = (container.members || []).filter((id) => !gone.has(id));
      return kept.map((node) => (node.id === parent ? { ...node, members } : node));
    }
    case 'reparent': {
      const fromParent = command.fromParent;
      const toParent = command.parent;
      let next = nodes;
      // The node leaves the container it was in. A node that had no container
      // has nothing to leave, and its place in the tree is its absence.
      if (fromParent) {
        const container = next.find((node) => node.id === fromParent);
        if (container) {
          const members = (container.members || []).filter((id) => id !== command.id);
          next = next.map((node) => (node.id === fromParent ? { ...node, members } : node));
        }
      }
      if (toParent) {
        const container = next.find((node) => node.id === toParent);
        if (container) {
          const members = (container.members || []).filter((id) => id !== command.id);
          const at = Math.max(0, Math.min(members.length, command.index ?? members.length));
          members.splice(at, 0, command.id);
          next = next.map((node) => (node.id === toParent ? { ...node, members } : node));
        }
      }
      return next;
    }
    case 'update': {
      const changes = command.changes || {};
      return nodes.map((node) => {
        if (node.id !== command.id) return node;
        // The children and the parent belong to the tree, not to the node's
        // own properties: a change of a text or a size must not move a node
        // out of its container.
        const { members, ...rest } = node;
        return { ...rest, ...changes, members };
      });
    }
    default:
      return nodes;
  }
}

/**
 * Apply a list of commands in order.
 */
function canvasApplyCommands(nodes, commands) {
  return (commands || []).reduce((current, command) => canvasApplyCommand(current, command), nodes);
}

/**
 * The command that records a change to a node's own properties.
 *
 * Only the fields that actually differ are carried, so an update of one text
 * does not make the undo stack carry every property of the node.
 */
function canvasCommandForUpdate(node, changes) {
  const before = {};
  const differing = {};
  for (const [key, value] of Object.entries(changes || {})) {
    if (key === 'members' || key === 'id') continue;
    if (node[key] === value) continue;
    before[key] = node[key];
    differing[key] = value;
  }
  if (!Object.keys(differing).length) return null;
  return { type: 'update', id: node.id, changes: differing, before };
}

/**
 * The command that records a node being added under a parent.
 */
function canvasCommandForInsert(parent, nodes, index) {
  return { type: 'insert', parent: parent?.id ?? null, index, nodes };
}

/**
 * The command that records a node being taken out of the document.
 *
 * The removed subtree travels with the command, so undo puts back exactly
 * what was there rather than a fresh copy.
 */
function canvasCommandForRemove(nodes, id) {
  const removed = canvasSubtreeOf(nodes, id);
  const owner = canvasOwnerOf(nodes, id);
  return { type: 'remove', id, parent: owner.parent, index: owner.index, nodes: removed };
}

/**
 * The commands that turn one document into another.
 *
 * This is what lets the undo stack hold a change instead of a copy of the
 * whole board: the difference between two states is expressed as commands,
 * and undoing is applying their inverses.
 */
function canvasDiffCommands(beforeNodes, afterNodes) {
  const before = new Map(beforeNodes.map((node) => [node.id, node]));
  const after = new Map(afterNodes.map((node) => [node.id, node]));
  const commands = [];

  // What left the document. A node whose parent also left is part of that
  // parent's subtree: removing the parent takes the child with it, so a
  // separate command for the child would undo it twice.
  const removed = beforeNodes.filter((node) => !after.has(node.id));
  const removedIds = new Set(removed.map((node) => node.id));
  const removedRoots = removed.filter((node) => {
    const owner = canvasOwnerOf(beforeNodes, node.id);
    return !owner.parent || !removedIds.has(owner.parent);
  });
  for (const node of removedRoots) {
    commands.push(canvasCommandForRemove(beforeNodes, node.id));
  }

  // What arrived, shallowest first, so a parent is in place before its
  // children are added under it.
  const added = afterNodes.filter((node) => !before.has(node.id));
  const addedDepth = (node) => {
    let depth = 0;
    let cursor = node;
    const seen = new Set();
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      const parentId = cursor.id;
      const parent = afterNodes.find((item) => (item.members || []).includes(parentId));
      if (!parent) break;
      depth += 1;
      cursor = parent;
    }
    return depth;
  };
  for (const node of added.sort((a, b) => addedDepth(a) - addedDepth(b))) {
    const owner = canvasOwnerOf(afterNodes, node.id);
    commands.push(canvasCommandForInsert({ id: owner.parent }, canvasSubtreeOf(afterNodes, node.id), owner.index));
  }

  // What stayed but changed. A node that moved to another container is a
  // reparent, not an update: its place in the tree is not its own property.
  for (const node of afterNodes) {
    const old = before.get(node.id);
    if (!old) continue;
    const ownerBefore = canvasOwnerOf(beforeNodes, node.id);
    const ownerAfter = canvasOwnerOf(afterNodes, node.id);
    if (ownerBefore.parent !== ownerAfter.parent) {
      commands.push({
        type: 'reparent',
        id: node.id,
        parent: ownerAfter.parent,
        index: ownerAfter.index,
        fromParent: ownerBefore.parent,
        fromIndex: ownerBefore.index,
        // A node that had no container is not in the tree; putting it back
        // means taking it out of the one it was put into.
        hadParent: ownerBefore.parent !== null,
      });
    }
    const changes = {};
    for (const key of Object.keys(node)) {
      if (key === 'members' || key === 'id') continue;
      if (old[key] !== node[key]) changes[key] = node[key];
    }
    const command = canvasCommandForUpdate(old, changes);
    if (command) commands.push(command);
  }

  return commands;
}

    /** The text of a node, whether it is plain or styled runs. */
    function canvasNodeTextOf(node) {
      if (Array.isArray(node.spans) && node.spans.length) {
        return node.spans.map((span) => String(span.text || '')).join('');
      }
      return String(node.text || '');
    }

    /* ------------------------------------------------------------- fonts
     *
     * The stacks in the canvas are Latin. Text in a script they do not
     * cover needs a family that does, or it renders as tofu. These are
     * the same functions as lib/font-fallback.js, which the contract test
     * keeps in step.
     */

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
const CANVAS_SCRIPTS = Object.freeze(['arabic', 'hebrew', 'devanagari', 'han', 'kana', 'hangul']);

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
function canvasScriptOfChar(codePoint) {
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
function canvasScriptsOf(text) {
  const found = new Set();
  for (const character of String(text || '')) {
    const script = canvasScriptOfChar(character.codePointAt(0));
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
function canvasFontFamiliesFor(script) {
  const open = SCRIPT_FAMILY[script];
  if (!open) return [];
  const system = SYSTEM_ALTERNATIVES[script] || [];
  return [...new Set([...system, open])];
}

/**
 * The Fontsource subset that holds a script's glyphs.
 */
function canvasFontSubsetFor(script) {
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
function canvasFontStackFor(text, baseStack) {
  const scripts = canvasScriptsOf(text);
  if (!scripts.length) return baseStack;
  const families = [];
  for (const script of scripts) {
    for (const family of canvasFontFamiliesFor(script)) {
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
function canvasNeedsFallbackFont(text) {
  return canvasScriptsOf(text).length > 0;
}

    function canvasBoundsOf(nodes) {
      if (!nodes.length) return null;
      let left = Infinity;
      let top = Infinity;
      let right = -Infinity;
      let bottom = -Infinity;
      for (const node of nodes) {
        left = Math.min(left, node.x);
        top = Math.min(top, node.y);
        right = Math.max(right, node.x + node.w);
        bottom = Math.max(bottom, node.y + node.h);
      }
      return { x: left, y: top, w: right - left, h: bottom - top };
    }

    function canvasPointInRect(point, rect) {
      return point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h;
    }

    function canvasRectsOverlap(first, second) {
      return first.x < second.x + second.w && first.x + first.w > second.x
        && first.y < second.y + second.h && first.y + first.h > second.y;
    }

    /**
     * The side an automatic connector uses.
     *
     * A connector leaves and enters an edge, not a corner: the direction is
     * picked by which side faces the other end, weighted by the node's own
     * proportions, so a wide box prefers left/right and a tall box top/bottom.
     */
    function canvasAutoAnchor(node, toward) {
      const rect = canvasNodeBounds(node);
      const center = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
      const other = { x: toward.x + toward.w / 2, y: toward.y + toward.h / 2 };
      const dx = other.x - center.x;
      const dy = other.y - center.y;
      if (dx === 0 && dy === 0) return 'right';
      const horizontal = Math.abs(dx) / Math.max(1, rect.w / 2);
      const vertical = Math.abs(dy) / Math.max(1, rect.h / 2);
      if (horizontal >= vertical) return dx >= 0 ? 'right' : 'left';
      return dy >= 0 ? 'bottom' : 'top';
    }

    /** The point on a node's border that faces the other end of an edge. */
    function canvasAnchorPoint(node, toward, anchor) {
      const rect = canvasNodeBounds(node);
      const side = anchor === 'auto' ? canvasAutoAnchor(node, toward) : anchor;
      if (side === 'top') return { x: rect.x + rect.w / 2, y: rect.y };
      if (side === 'bottom') return { x: rect.x + rect.w / 2, y: rect.y + rect.h };
      if (side === 'left') return { x: rect.x, y: rect.y + rect.h / 2 };
      if (side === 'right') return { x: rect.x + rect.w, y: rect.y + rect.h / 2 };
      return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
    }

    /** The outward normal of the side an edge is pinned to. */
    function canvasAnchorNormal(node, toward, anchor) {
      const side = anchor === 'auto' ? canvasAutoAnchor(node, toward) : anchor;
      if (side === 'left') return { x: -1, y: 0 };
      if (side === 'right') return { x: 1, y: 0 };
      if (side === 'top') return { x: 0, y: -1 };
      if (side === 'bottom') return { x: 0, y: 1 };
      return { x: 0, y: 0 };
    }

    /**
     * The anchor of a node closest to a point.
     *
     * This is the magnet: a connector ends on a handle, not wherever the
     * pointer happened to be.
     */
    function canvasNearestAnchor(node, point) {
      const rect = canvasNodeBounds(node);
      const anchors = [
        { anchor: 'top', x: rect.x + rect.w / 2, y: rect.y },
        { anchor: 'right', x: rect.x + rect.w, y: rect.y + rect.h / 2 },
        { anchor: 'bottom', x: rect.x + rect.w / 2, y: rect.y + rect.h },
        { anchor: 'left', x: rect.x, y: rect.y + rect.h / 2 },
      ];
      let best = anchors[0];
      let bestDistance = Infinity;
      for (const candidate of anchors) {
        const distance = Math.hypot(candidate.x - point.x, candidate.y - point.y);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = candidate;
        }
      }
      return best.anchor;
    }

    /** The unit vector an edge leaves or enters an anchor along. */
    function canvasAnchorDirection(anchor, dx, dy) {
      if (anchor === 'left') return { x: -1, y: 0 };
      if (anchor === 'right') return { x: 1, y: 0 };
      if (anchor === 'top') return { x: 0, y: -1 };
      if (anchor === 'bottom') return { x: 0, y: 1 };
      return Math.abs(dx) >= Math.abs(dy) ? { x: Math.sign(dx) || 1, y: 0 } : { x: 0, y: Math.sign(dy) || 1 };
    }

    /**
     * The cubic bezier of an edge.
     *
     * Both control points leave their anchor along the anchor's direction, so
     * the curve reads as a flow instead of a straight wire.
     */
    function canvasEdgePath(edge, from, to) {
      const toBounds = canvasNodeBounds(to);
      const fromBounds = canvasNodeBounds(from);
      const start = canvasAnchorPoint(from, toBounds, edge.fromAnchor);
      const end = canvasAnchorPoint(to, fromBounds, edge.toAnchor);
      // A snapped end leaves and enters along the edge normal: the line meets
      // the border at a right angle instead of grazing past the corner.
      const startNormal = canvasAnchorNormal(from, toBounds, edge.fromAnchor);
      const endNormal = canvasAnchorNormal(to, fromBounds, edge.toAnchor);
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const curve = canvasEdgeCurve(edge);

      // A straight edge is a line between the two anchors.
      if (curve === 'straight') {
        return {
          d: `M ${start.x} ${start.y} L ${end.x} ${end.y}`,
          start,
          end,
          endAngle: Math.atan2(dy, dx),
          startAngle: Math.atan2(dy, dx),
          middle: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
        };
      }

      // Both curves leave a stub along the normal first, so the visible end of
      // the line is perpendicular to the border whatever the anchors are.
      const distance = Math.hypot(dx, dy);
      const stub = Math.max(16, Math.min(40, distance / 3));

      if (curve === 'elbow') {
        const first = { x: start.x + startNormal.x * stub, y: start.y + startNormal.y * stub };
        const last = { x: end.x + endNormal.x * stub, y: end.y + endNormal.y * stub };
        const points = [start, first];
        const horizontalLeave = Math.abs(startNormal.x) >= Math.abs(startNormal.y);
        if (Math.abs(first.x - last.x) > 0.5 && Math.abs(first.y - last.y) > 0.5) {
          if (horizontalLeave) {
            const middle = (first.x + last.x) / 2;
            points.push({ x: middle, y: first.y }, { x: middle, y: last.y });
          } else {
            const middle = (first.y + last.y) / 2;
            points.push({ x: first.x, y: middle }, { x: last.x, y: middle });
          }
        }
        points.push(last, end);
        const cleaned = points.filter((point, index) => (
          index === 0 || Math.hypot(point.x - points[index - 1].x, point.y - points[index - 1].y) > 0.5
        ));
        const d = cleaned.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
        const middleIndex = Math.max(0, cleaned.length - 2);
        return {
          d,
          start,
          end,
          startAngle: Math.atan2(cleaned[1].y - start.y, cleaned[1].x - start.x),
          endAngle: Math.atan2(end.y - cleaned[middleIndex].y, end.x - cleaned[middleIndex].x),
          middle: {
            x: (cleaned[middleIndex].x + end.x) / 2,
            y: (cleaned[middleIndex].y + end.y) / 2,
          },
        };
      }

      const bend = Math.max(24, Math.min(80, distance / 3));
      const c1 = { x: start.x + startNormal.x * bend, y: start.y + startNormal.y * bend };
      const c2 = { x: end.x + endNormal.x * bend, y: end.y + endNormal.y * bend };
      return {
        d: `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`,
        start,
        end,
        // The tangent at each end points out of its border, so the curve meets
        // the edge square on and the head aims straight at it.
        startAngle: Math.atan2(startNormal.y, startNormal.x),
        endAngle: Math.atan2(-endNormal.y, -endNormal.x),
        // The middle of the curve, where the label sits (t = 0.5).
        middle: {
          x: (start.x + 3 * c1.x + 3 * c2.x + end.x) / 8,
          y: (start.y + 3 * c1.y + 3 * c2.y + end.y) / 8,
        },
      };
    }

    /** The pen of one arrow head, aimed along the line it belongs to. */
    function canvasEdgeHeads(edge, geometry, zoom = 1) {
      const heads = [];
      const color = edge.stroke || 'currentColor';
      const width = Math.max(1, Number(edge.strokeWidth) || 2);
      // The line keeps a constant screen width (`non-scaling-stroke`), so the
      // head is sized in screen pixels and converted back to board units.
      const scale = 1 / Math.max(0.05, Number(zoom) || 1);
      const length = Math.min(8.5, 5 + width * 1.25) * scale;
      const spread = 0.58;
      const draw = (kind, point, angle, key) => {
        if (!kind || kind === 'none') return;
        if (kind === 'circle') {
          const radius = Math.max(3, width * 2.4) * scale;
          heads.push(h('circle', {
            key, cx: point.x, cy: point.y, r: radius,
            className: 'mm-canvas-edge-head is-circle',
            fill: color,
          }));
          return;
        }
        const size = length;
        const left = { x: point.x - Math.cos(angle - spread) * size, y: point.y - Math.sin(angle - spread) * size };
        const right = { x: point.x - Math.cos(angle + spread) * size, y: point.y - Math.sin(angle + spread) * size };
        if (kind === 'triangle') {
          heads.push(h('path', {
            key,
            className: 'mm-canvas-edge-head is-triangle',
            d: `M ${left.x} ${left.y} L ${point.x} ${point.y} L ${right.x} ${right.y} Z`,
            fill: color,
          }));
          return;
        }
        heads.push(h('path', {
          key,
          className: 'mm-canvas-edge-head is-arrow',
          d: `M ${left.x} ${left.y} L ${point.x} ${point.y} L ${right.x} ${right.y}`,
          fill: 'none',
          stroke: color,
          'stroke-width': Math.max(1.2, Math.min(2.25, width * 0.6)) * scale,
        }));
      };
      draw(edge.startArrow ?? 'none', geometry.start, geometry.startAngle + Math.PI, `${edge.id}-start`);
      draw(edge.endArrow ?? 'arrow', geometry.end, geometry.endAngle, `${edge.id}-end`);
      return heads;
    }

    /** The dash pattern of a connector, or null when it is solid. */
    function canvasEdgeDash(edge) {
      if (edge.dash === 'dashed') return '9 5';
      if (edge.dash === 'dotted') return '1 5';
      return null;
    }

    /** The curve of a connector, with the default of the format. */
    function canvasEdgeCurve(edge) {
      return edge.curve || 'bezier';
    }

    /** The camera that puts every node in view, with the given breathing room. */
    function canvasFitCamera(nodes, viewport, padding = 64) {
      const bounds = canvasBoundsOf(nodes);
      if (!bounds || bounds.w <= 0 || bounds.h <= 0) {
        return { x: viewport.width / 2, y: viewport.height / 2, zoom: 1 };
      }
      const usableWidth = Math.max(120, viewport.width - padding * 2);
      const usableHeight = Math.max(120, viewport.height - padding * 2);
      const zoom = clampCanvasZoom(Math.min(usableWidth / bounds.w, usableHeight / bounds.h, 1));
      return {
        x: viewport.width / 2 - (bounds.x + bounds.w / 2) * zoom,
        y: viewport.height / 2 - (bounds.y + bounds.h / 2) * zoom,
        zoom,
      };
    }

    function canvasSummary(text) {
      const clean = String(text || '').replace(/\s+/g, ' ').trim();
      if (!clean) return 'empty';
      return clean.length > 60 ? `${clean.slice(0, 59)}…` : clean;
    }

    /**
     * Recompute every group's rectangle from the members it holds.
     *
     * The rectangle is a derived value: the members are the truth, so the
     * frame follows them whenever they move.
     */
    /** Whether a container's box is derived from its members (a group's is). */
    function canvasContainerAutoSizes(node) {
      if (typeof node.autoSize === 'boolean') return node.autoSize;
      return node.type === 'group';
    }

    function canvasIsContainer(node) {
      return node.type === 'group' || node.type === 'frame' || node.type === 'component';
    }

    function canvasSyncGroups(nodes) {
      const groups = nodes.filter((node) => canvasIsContainer(node));
      if (!groups.length) return nodes;
      const next = [...nodes];
      // A container whose members are not inside it was flattened by an
      // import: its own box and its children's boxes describe different places.
      // Re-measuring it from those children would teleport the frame, so a
      // container that no longer holds its members keeps the box it has.

      /** How deep a container sits: a container inside three others is depth 3. */
      const depthOf = (node) => {
        let depth = 0;
        let cursor = node;
        const seen = new Set([node.id]);
        for (;;) {
          const parent = groups.find((group) => (group.members || []).includes(cursor.id));
          if (!parent || seen.has(parent.id)) return depth;
          seen.add(parent.id);
          depth += 1;
          cursor = parent;
        }
      };

      // Deepest first: a parent's box is only right once its children are.
      const ordered = [...groups].sort((a, b) => depthOf(b) - depthOf(a));
      for (const group of ordered) {
        const index = next.findIndex((node) => node.id === group.id);
        if (index < 0) continue;
        // Explicitly sized containers keep the box the person gave them; only
        // derived ones (a group, by default) are re-measured from members.
        if (!canvasContainerAutoSizes(next[index])) continue;
        const byId = new Map(next.map((node) => [node.id, node]));
        const members = (next[index].members || []).map((id) => byId.get(id)).filter(Boolean);
        if (!members.length) continue;
        const bounds = canvasBoundsOf(members);
        if (!bounds) continue;
        // The members have to be inside the container for a measurement of them
        // to describe the container. When they are not, the container's own box
        // is the only geometry that means anything.
        const own = canvasBoundsOf([next[index]]);
        if (own && (bounds.x < own.x - 1 || bounds.y < own.y - 1
          || bounds.x + bounds.w > own.x + own.w + 1 || bounds.y + bounds.h > own.y + own.h + 1)) continue;
        next[index] = {
          ...next[index],
          x: Math.round(bounds.x - CANVAS_GROUP_PADDING),
          y: Math.round(bounds.y - CANVAS_GROUP_PADDING),
          w: Math.round(bounds.w + CANVAS_GROUP_PADDING * 2),
          h: Math.round(bounds.h + CANVAS_GROUP_PADDING * 2),
        };
      }
      return next;
    }

    /** The name a node gets in the layers list. */
    function canvasNodeName(node, index, text) {
      if (node.type === 'group') {
        const title = canvasSummary(text).slice(0, 24);
        return title && title !== 'empty' ? title : `Group ${index + 1}`;
      }
      if (node.type === 'frame') return node.title || `Frame ${index + 1}`;
      if (node.type === 'image') return `Image ${index + 1}`;
      if (node.type === 'note') return `Note ${index + 1}`;
      if (node.type === 'sticky') return `Sticky ${index + 1}`;
      if (node.type === 'text') return `Text ${index + 1}`;
      return `Shape ${index + 1}`;
    }

    /** Move the selection so every node sits on one edge of the selection box. */
    function canvasAlignNodes(nodes, ids, mode) {
      const chosen = nodes.filter((node) => ids.includes(node.id));
      if (!chosen.length) return nodes;
      const bounds = canvasBoundsOf(chosen);
      const map = new Map();
      for (const node of chosen) {
        let dx = 0;
        let dy = 0;
        if (mode === 'left') dx = bounds.x - node.x;
        else if (mode === 'right') dx = (bounds.x + bounds.w) - (node.x + node.w);
        else if (mode === 'center-x') dx = (bounds.x + bounds.w / 2) - (node.x + node.w / 2);
        else if (mode === 'top') dy = bounds.y - node.y;
        else if (mode === 'bottom') dy = (bounds.y + bounds.h) - (node.y + node.h);
        else if (mode === 'center-y') dy = (bounds.y + bounds.h / 2) - (node.y + node.h / 2);
        map.set(node.id, { ...node, x: Math.round(node.x + dx), y: Math.round(node.y + dy) });
      }
      return nodes.map((node) => map.get(node.id) || node);
    }

    /** Spread the selection so the gaps between the nodes are the same. */
    function canvasDistributeNodes(nodes, ids, axis) {
      const chosen = nodes
        .filter((node) => ids.includes(node.id))
        .sort((left, right) => (axis === 'x' ? left.x - right.x : left.y - right.y));
      if (chosen.length < 3) return nodes;
      const bounds = canvasBoundsOf(chosen);
      const used = chosen.reduce((sum, node) => sum + (axis === 'x' ? node.w : node.h), 0);
      const gap = ((axis === 'x' ? bounds.w : bounds.h) - used) / (chosen.length - 1);
      let cursor = axis === 'x' ? bounds.x : bounds.y;
      const map = new Map();
      for (const node of chosen) {
        const size = axis === 'x' ? node.w : node.h;
        map.set(node.id, axis === 'x'
          ? { ...node, x: Math.round(cursor) }
          : { ...node, y: Math.round(cursor) });
        cursor += size + gap;
      }
      return nodes.map((node) => map.get(node.id) || node);
    }

    /**
     * Read one colour token of the plugin and turn it into a hex value.
     *
     * The palette lives in the stylesheet, not in the script: the plugin owns
     * its colours, and the Host stores what the stylesheet says. The element
     * may be missing in a non-browser harness, in which case the computed
     * style of nothing is asked and a failure quietly means "no colour".
     */
    function canvasReadToken(element, name) {
      if (typeof getComputedStyle !== 'function') return null;
      try {
        const raw = getComputedStyle(element).getPropertyValue(name).trim();
        if (!raw) return null;
        if (raw.startsWith('#')) return raw.toLocaleLowerCase();
        const numbers = raw.match(/-?\d+(\.\d+)?/g);
        if (!numbers || numbers.length < 3) return raw;
        const channels = numbers.slice(0, 3).map((value) => Math.max(0, Math.min(255, Math.round(Number(value)))));
        return `#${channels.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
      } catch {
        return null;
      }
    }

    /** The palette as the stylesheet defines it right now. */
    /** Hex to HSL, so a theme can flip lightness without losing hue. */
    function canvasHexToHsl(hex) {
      const value = String(hex || '').replace('#', '');
      if (!/^[0-9a-f]{6}$/i.test(value)) return null;
      const r = parseInt(value.slice(0, 2), 16) / 255;
      const g = parseInt(value.slice(2, 4), 16) / 255;
      const b = parseInt(value.slice(4, 6), 16) / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const l = (max + min) / 2;
      let h = 0;
      let s = 0;
      if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        else if (max === g) h = ((b - r) / d + 2) / 6;
        else h = ((r - g) / d + 4) / 6;
      }
      return { h, s, l };
    }

    function canvasHslToHex({ h, s, l }) {
      const channel = (p, q, t) => {
        let value = t;
        if (value < 0) value += 1;
        if (value > 1) value -= 1;
        if (value < 1 / 6) return p + (q - p) * 6 * value;
        if (value < 1 / 2) return q;
        if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
        return p;
      };
      let red;
      let green;
      let blue;
      if (s === 0) {
        red = l; green = l; blue = l;
      } else {
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        red = channel(p, q, h + 1 / 3);
        green = channel(p, q, h);
        blue = channel(p, q, h - 1 / 3);
      }
      const to = (value) => Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16).padStart(2, '0');
      return `#${to(red)}${to(green)}${to(blue)}`;
    }

    /** The dark mode of a colour table: same hue, mirrored lightness. */
    function canvasDarkColors(colors) {
      const next = {};
      for (const [name, value] of Object.entries(colors || {})) {
        const hsl = canvasHexToHsl(value);
        next[name] = hsl ? canvasHslToHex({ h: hsl.h, s: hsl.s, l: 1 - hsl.l }) : value;
      }
      return next;
    }

    function canvasPalette(element) {
      return CANVAS_PALETTE_TOKENS.map((entry) => ({
        id: entry.id,
        label: entry.label,
        value: entry.value === null ? null : canvasReadToken(element, entry.token),
      }));
    }

    /**
     * The vertices of a polygon or a star, inscribed in the node's rectangle.
     *
     * Stars alternate between the outer radius and a fixed inner ratio, which
     * is what makes the shape read as a star instead of a jagged polygon.
     */
    function canvasShapePoints(w, h, count, star) {
      const cx = w / 2;
      const cy = h / 2;
      const rx = w / 2;
      const ry = h / 2;
      const inner = star ? 0.42 : 1;
      const steps = star ? count * 2 : count;
      const points = [];
      for (let index = 0; index < steps; index += 1) {
        const ratio = star && index % 2 === 1 ? inner : 1;
        const angle = (Math.PI * 2 * index) / steps - Math.PI / 2;
        points.push(`${(cx + Math.cos(angle) * rx * ratio).toFixed(2)},${(cy + Math.sin(angle) * ry * ratio).toFixed(2)}`);
      }
      return points.join(' ');
    }

    /** One cubic segment of a vector path, or a straight line when it has no handles. */
    function canvasPathSegment(from, to) {
      const out = from.out;
      const incoming = to.in;
      if (!out && !incoming) return ` L ${Math.round(to.x)} ${Math.round(to.y)}`;
      const control1 = out
        ? `${Math.round(from.x + out.x)} ${Math.round(from.y + out.y)}`
        : `${Math.round(from.x)} ${Math.round(from.y)}`;
      const control2 = incoming
        ? `${Math.round(to.x + incoming.x)} ${Math.round(to.y + incoming.y)}`
        : `${Math.round(to.x)} ${Math.round(to.y)}`;
      return ` C ${control1} ${control2} ${Math.round(to.x)} ${Math.round(to.y)}`;
    }

    /** The `d` of a vector path, in the node's own box coordinates. */
    function canvasPathD(node) {
      const path = node.path;
      if (!path || !Array.isArray(path.points) || path.points.length < 2) return '';
      const [first] = path.points;
      let d = `M ${Math.round(first.x)} ${Math.round(first.y)}`;
      for (let index = 0; index < path.points.length - 1; index += 1) {
        d += canvasPathSegment(path.points[index], path.points[index + 1]);
      }
      if (path.closed) {
        d += canvasPathSegment(path.points[path.points.length - 1], first);
        d += ' Z';
      }
      return d;
    }

    /** The SVG that draws one shape node inside its own rectangle. */
    // Design typography names a family token, never a raw CSS string: the
    // board must look the same on every machine that has the base fonts.
    const CANVAS_FONT_STACKS = Object.freeze({
      sans: 'Inter, "SF Pro Text", "Helvetica Neue", system-ui, sans-serif',
      serif: 'Georgia, "Times New Roman", Times, serif',
      mono: '"SF Mono", Menlo, Consolas, monospace',
      display: '"SF Pro Display", Inter, "Helvetica Neue", system-ui, sans-serif',
    })

    /**
     * The ink a filled node can carry.
     *
     * Text with no stored colour used to inherit the theme's label colour, so a
     * white frame imported from FigJam got white text in the dark theme: the
     * fill said "paper", the ink said "night". A fill that is set decides its
     * own ink; only a node with no fill at all follows the theme.
     */
    function canvasInkOnFill(fill) {
      if (typeof fill !== 'string') return null;
      const hex = fill.trim().replace(/^#/, '');
      const full = hex.length === 3 ? hex.split('').map((part) => part + part).join('') : hex;
      if (!/^[0-9a-f]{6}$/i.test(full)) return null;
      const channel = (offset) => {
        const value = parseInt(full.slice(offset, offset + 2), 16) / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      };
      const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
      return luminance > 0.45 ? 'var(--mm-ink-on-light)' : 'var(--mm-ink-on-dark)';
    }

    /** A stored shadow colour as an rgba() literal the browser can paint. */
    function canvasShadowColor(shadow) {
      const alpha = shadow?.opacity === undefined || shadow?.opacity === null ? 1 : shadow.opacity
      const hex = String(shadow?.color || '').replace('#', '')
      if (!/^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(hex)) return `rgba(0, 0, 0, ${alpha})`
      const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex
      const r = parseInt(full.slice(0, 2), 16)
      const g = parseInt(full.slice(2, 4), 16)
      const b = parseInt(full.slice(4, 6), 16)
      return `rgba(${r}, ${g}, ${b}, ${alpha})`
    }

    /** The stable id of the gradient a shape paints itself with. */
    function canvasGradientId(node) {
      return 'canvas-grad-' + String(node.id).replace(/[^a-zA-Z0-9_-]/g, '')
    }

    /** A two-stop gradient as SVG stops, so a shape can carry it. */
    function canvasGradientStops(node) {
      const gradient = node.gradient
      if (!gradient) return null
      const rad = (gradient.angle * Math.PI) / 180
      const dx = Math.sin(rad)
      const dy = -Math.cos(rad)
      return h('linearGradient', {
        id: canvasGradientId(node),
        x1: `${50 - dx * 50}%`,
        y1: `${50 - dy * 50}%`,
        x2: `${50 + dx * 50}%`,
        y2: `${50 + dy * 50}%`,
      },
        h('stop', { offset: '0%', stopColor: gradient.from }),
        h('stop', { offset: '100%', stopColor: gradient.to }))
    }

    function canvasShapeSvg(node) {
      // `h` is the element factory at module scope, so the box is boxW/boxH.
      const boxW = Math.max(1, node.w);
      const boxH = Math.max(1, node.h);
      const lineWidth = node.strokeWidth || 0;
      const inset = lineWidth > 0 ? lineWidth / 2 : 0;
      const fill = node.gradient ? `url(#${canvasGradientId(node)})` : node.fill || 'none';
      const stroke = node.stroke || 'none';
      const radius = Math.min(node.radius || 0, boxW / 2, boxH / 2);
      const common = { fill, stroke, strokeWidth: lineWidth || 0 };
      if (node.shape === 'ellipse') {
        return h('ellipse', {
          key: 'shape',
          cx: boxW / 2, cy: boxH / 2,
          rx: Math.max(0, boxW / 2 - inset), ry: Math.max(0, boxH / 2 - inset),
          ...common,
        });
      }
      if (node.shape === 'line' || node.shape === 'arrow') {
        return h('g', { key: 'shape' },
          h('line', { x1: inset, y1: boxH / 2, x2: boxW - inset, y2: boxH / 2, ...common, fill: 'none', stroke: node.stroke || 'currentColor' }),
          node.shape === 'arrow'
            ? h('path', {
              d: `M ${boxW - inset} ${boxH / 2} L ${boxW - inset - 10} ${boxH / 2 - 6} L ${boxW - inset - 10} ${boxH / 2 + 6} z`,
              fill: node.stroke || 'currentColor',
              stroke: 'none',
            })
            : null);
      }
      if (node.shape === 'path') {
        return h('path', { key: 'shape', d: canvasPathD(node), ...common, fill: node.fill ? common.fill : 'none' });
      }
      if (node.shape === 'polygon') {
        return h('polygon', {
          key: 'shape',
          points: canvasShapePoints(Math.max(1, boxW - inset * 2), Math.max(1, boxH - inset * 2), node.sides || 5, false),
          transform: `translate(${inset} ${inset})`,
          ...common,
        });
      }
      if (node.shape === 'star') {
        return h('polygon', {
          key: 'shape',
          points: canvasShapePoints(Math.max(1, boxW - inset * 2), Math.max(1, boxH - inset * 2), node.points || 5, true),
          transform: `translate(${inset} ${inset})`,
          ...common,
        });
      }
      return h('rect', {
        key: 'shape',
        x: inset, y: inset,
        width: Math.max(0, boxW - inset * 2), height: Math.max(0, boxH - inset * 2),
        rx: radius, ry: radius,
        ...common,
      });
    }

    /** Shapes are drawn as SVG, so the stylesheet does not need one class per kind. */
    function canvasIsSvgShape(node) {
      return node.type === 'shape';
    }

    /** The URL an uploaded picture is served from. */
    function canvasAssetUrl(assetId, type) {
      const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' }[type] || 'png';
      return `${CANVAS_ASSET_ROUTE}?id=${encodeURIComponent(assetId)}&ext=${extension}`;
    }

    /** Read a browser file into a data URL. */
    function canvasReadFile(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error(`Cannot read ${file.name || 'the file'}`));
        reader.readAsDataURL(file);
      });
    }

    /** The natural size of a picture, scaled down to fit a board node. */
    function canvasMeasureImage(source) {
      return new Promise((resolve) => {
        const image = new Image();
        image.onload = () => {
          const width = image.naturalWidth || image.width || CANVAS_IMAGE_MAX_WIDTH;
          const height = image.naturalHeight || image.height || 320;
          const scale = width > CANVAS_IMAGE_MAX_WIDTH ? CANVAS_IMAGE_MAX_WIDTH / width : 1;
          resolve({ w: Math.round(width * scale), h: Math.round(height * scale) });
        };
        image.onerror = () => resolve({ w: CANVAS_IMAGE_MAX_WIDTH, h: 320 });
        image.src = source;
      });
    }

    /** Whether a file name is a Figma document rather than an export. */
    function canvasIsFigmaFile(file) {
      // .fig is Design, .jam is FigJam, .deck is Slides — all three share the
      // same container format, and the Host reads every one of them.
      return /\.(fig|jam|deck)$/i.test(String(file?.name ?? ''));
    }

    function canvasEscapeXml(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    /**
     * The scene as one SVG document, ready to be saved or rasterised.
     *
     * This is not a schematic: it draws the board the way the canvas draws it —
     * the authored type sizes and weights, imported pictures, shadows, gradients
     * and vector paths. A PNG of a board is what a person shows someone else, and
     * the same file is what an agent looks at when it checks its own work, so a
     * renderer that quietly dropped images and shrank text to 13px would make
     * both of them wrong.
     *
     * Async because pictures are fetched and embedded: the saved picture must
     * not depend on the canvas being on screen or on the asset route staying alive.
     *
     * @param {object[]} nodes
     * @param {object[]} edges
     * @param {{region?: {x,y,w,h}, padding?: number, background?: string,
     *   ink?: string, line?: string, title?: string,
     *   resolveAsset?: (assetId: string, kind?: string) => Promise<string|null>}} options
     */
    async function canvasSceneSvg(nodes, edges, options = {}) {
      const whole = canvasBoundsOf(nodes);
      if (!whole) return '';
      const region = options.region && options.region.w > 0 && options.region.h > 0
        ? {
          x: options.region.x,
          y: options.region.y,
          w: options.region.w,
          h: options.region.h,
        }
        : null;
      const bounds = region || whole;
      const padding = region ? 0 : (options.padding ?? 24);
      const width = Math.max(1, Math.ceil(bounds.w + padding * 2));
      const height = Math.max(1, Math.ceil(bounds.h + padding * 2));
      const offset = { x: padding - bounds.x, y: padding - bounds.y };
      const defs = [];
      const containerBody = [];
      const edgeBody = [];
      const leafBody = [];
      const shadowIds = new Map();
      const gradientIds = new Map();
      const assetCache = new Map();

      const esc = canvasEscapeXml;
      const num = (value) => Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
      const hexWithAlpha = (color) => {
        const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(String(color || ''));
        if (!match) return { color: color || 'rgba(0,0,0,0.18)', alpha: null };
        return { color: `#${match[1]}`, alpha: match[2] ? parseInt(match[2], 16) / 255 : null };
      };
      const shadowFilter = (shadow) => {
        if (!shadow) return null;
        const key = `${shadow.x}|${shadow.y}|${shadow.blur}|${shadow.color}`;
        if (shadowIds.has(key)) return shadowIds.get(key);
        const id = `sh-${shadowIds.size}`;
        const { color, alpha } = hexWithAlpha(shadow.color);
        defs.push(`<filter id="${id}" x="-60%" y="-60%" width="220%" height="220%">`
          + `<feDropShadow dx="${num(shadow.x || 0)}" dy="${num(shadow.y || 0)}" `
          + `stdDeviation="${num(Math.max(0, (shadow.blur || 0) / 2))}" flood-color="${color}"`
          + `${alpha === null ? '' : ` flood-opacity="${num(alpha)}"`}/></filter>`);
        shadowIds.set(key, id);
        return id;
      };
      const gradientRef = (gradient) => {
        if (!gradient || !gradient.from || !gradient.to) return null;
        const key = `${gradient.from}|${gradient.to}|${gradient.angle || 0}`;
        if (gradientIds.has(key)) return gradientIds.get(key);
        const id = `gr-${gradientIds.size}`;
        const angle = ((Number(gradient.angle) || 0) * Math.PI) / 180;
        const dx = Math.cos(angle) / 2;
        const dy = Math.sin(angle) / 2;
        defs.push(`<linearGradient id="${id}" x1="${num(0.5 - dx)}" y1="${num(0.5 - dy)}" x2="${num(0.5 + dx)}" y2="${num(0.5 + dy)}">`
          + `<stop offset="0" stop-color="${esc(gradient.from)}"/><stop offset="1" stop-color="${esc(gradient.to)}"/></linearGradient>`);
        gradientIds.set(key, id);
        return id;
      };

      // Pictures are bytes, not URLs: a file that points at the Host route
      // renders blank the moment it leaves this machine.
      const assetHref = async (node) => {
        const assetId = node.assetId;
        if (!assetId) return null;
        if (assetCache.has(assetId)) return assetCache.get(assetId);
        let href = null;
        try {
          if (typeof options.resolveAsset === 'function') {
            href = await options.resolveAsset(assetId, node.kind);
          } else {
            const response = await fetch(canvasAssetUrl(assetId, node.kind), { credentials: 'same-origin' });
            if (response.ok) {
              const blob = await response.blob();
              href = await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result || ''));
                reader.onerror = () => resolve(null);
                reader.readAsDataURL(blob);
              });
            }
          }
        } catch {
          href = null;
        }
        assetCache.set(assetId, href);
        return href;
      };

      // Text is measured, not guessed: the width a sentence needs decides where
      // its lines break, and a broken line is what the box height must hold.
      // Measuring needs a real 2D context; a test renderer or an odd browser may
      // not have one, and an export must never fail because it could not measure.
      const measure = (() => {
        try {
          const context = document.createElement('canvas').getContext('2d');
          return context && typeof context.measureText === 'function' ? context : null;
        } catch {
          return null;
        }
      })();
      const fontOf = (node) => {
        const size = Number(node.fontSize) > 0 ? Number(node.fontSize) : 14;
        const weight = Number(node.fontWeight) > 0 ? Number(node.fontWeight) : 400;
        const family = canvasFontStackFor(
          canvasNodeTextOf(node),
          CANVAS_FONT_STACKS[node.fontFamily] || CANVAS_FONT_STACKS.sans,
        );
        return { size, weight, family, css: `${weight} ${size}px ${family}` };
      };
      const wrapLines = (node, text) => {
        const font = fontOf(node);
        const tracking = Number(node.letterSpacing) || 0;
        const inner = Math.max(8, (Number(node.w) || 0) - canvasTextInset(node) * 2);
        // Without a measuring context, assume the same average glyph width the
        // issue analysis uses, so the picture stays close instead of absent.
        const widthOf = measure
          ? (value) => {
            measure.font = font.css;
            return measure.measureText(value).width + tracking * value.length;
          }
          : (value) => value.length * font.size * 0.58 + tracking * value.length;
        const lines = [];
        for (const paragraph of String(text).split('\n')) {
          if (!paragraph) {
            lines.push('');
            continue;
          }
          // CJK has no spaces to break on, so a long run falls back to glyphs.
          const units = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/.test(paragraph)
            ? Array.from(paragraph)
            : paragraph.split(/(\s+)/);
          let line = '';
          for (const unit of units) {
            const candidate = line + unit;
            if (line && widthOf(candidate) > inner) {
              lines.push(line.trimEnd());
              line = unit.trimStart();
            } else {
              line = candidate;
            }
          }
          if (line.trim() || !lines.length) lines.push(line.trimEnd());
        }
        return lines;
      };

      const paintOf = (node, kind = 'fill') => {
        const gradient = kind === 'fill' ? gradientRef(node.gradient) : null;
        if (gradient) return `url(#${gradient})`;
        const value = kind === 'fill' ? node.fill : node.stroke;
        return value || 'none';
      };

      for (const edge of edges) {
        const from = nodes.find((node) => node.id === edge.from);
        const to = nodes.find((node) => node.id === edge.to);
        if (!from || !to) continue;
        const curve = canvasEdgePath(edge, from, to);
        const dash = edge.dash === 'dashed' ? ' stroke-dasharray="8 6"' : '';
        edgeBody.push(`<path d="${curve.d}" fill="none" stroke="${esc(edge.stroke || options.line || 'rgb(139 145 153)')}" `
          + `stroke-width="${num(edge.strokeWidth || 2)}"${dash} transform="translate(${num(offset.x)} ${num(offset.y)})"/>`);
        if (edge.label) {
          edgeBody.push(`<text x="${num(curve.middle.x + offset.x)}" y="${num(curve.middle.y + offset.y - 6)}" `
            + `font-family="${esc(CANVAS_FONT_STACKS.sans)}" font-size="12" fill="${esc(options.ink || 'rgb(16 20 24)')}" `
            + `text-anchor="middle">${esc(edge.label)}</text>`);
        }
        for (const head of canvasEdgeHeads(edge, curve, 1)) {
          edgeBody.push(`<path d="${head.d}" fill="none" stroke="${esc(head.stroke || edge.stroke || 'rgb(139 145 153)')}" `
            + `stroke-width="${num(head.strokeWidth || 2)}" stroke-linecap="round" transform="translate(${num(offset.x)} ${num(offset.y)})"/>`);
        }
      }

      // Containers paint their own surface before their members sit on it.
      const depthOf = new Map();
      const depth = (node, seen = new Set()) => {
        if (depthOf.has(node.id)) return depthOf.get(node.id);
        if (seen.has(node.id)) return 0;
        seen.add(node.id);
        const parent = nodes.find((candidate) => (candidate.members || []).includes(node.id));
        const value = parent ? depth(parent, seen) + 1 : 0;
        depthOf.set(node.id, value);
        return value;
      };
      const ordered = [...nodes].sort((left, right) => depth(left) - depth(right));

      for (const node of ordered) {
        const target = CANVAS_COMMAND_CONTAINERS.has(node.type) ? containerBody : leafBody;
        if (node.visible === false) continue;
        const x = num(node.x + offset.x);
        const y = num(node.y + offset.y);
        const w = num(node.w);
        const h = num(node.h);
        const filter = shadowFilter(node.shadow);
        const filterAttr = filter ? ` filter="url(#${filter})"` : '';
        if (node.type === 'group') {
          target.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none"${node.stroke ? ` stroke="${esc(node.stroke)}" stroke-width="${num(node.strokeWidth || 1)}" stroke-dasharray="4 4"` : ''}/>`);
          continue;
        }
        if (node.type === 'image') {
          const href = await assetHref(node);
          target.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${num(Math.min(node.radius || 0, node.w / 2, node.h / 2))}" fill="${esc(node.fill || 'none')}"/>`);
          if (href) {
            target.push(`<image x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice" href="${esc(href)}"/>`);
          }
          continue;
        }
        if (node.type === 'shape' && node.shape === 'path' && node.path) {
          const inset = num(node.strokeWidth ? node.strokeWidth / 2 : 0);
          target.push(`<path d="${canvasPathD(node)}" fill="${esc(node.fill || 'none')}" stroke="${esc(node.stroke || 'none')}" `
            + `stroke-width="${num(node.strokeWidth || 0)}" stroke-linejoin="round" stroke-linecap="round" `
            + `transform="translate(${num(x + inset)} ${num(y + inset)})"${filterAttr}/>`);
          continue;
        }
        const fill = paintOf(node, 'fill') || (node.type === 'sticky' ? (options.sticky || 'rgb(255 243 191)') : node.type === 'note' ? 'white' : 'none');
        const stroke = node.stroke ? node.stroke : 'none';
        const radius = num(Math.min(node.radius || 0, (node.w || 0) / 2, (node.h || 0) / 2));
        if (node.type === 'shape' && node.shape === 'ellipse') {
          target.push(`<ellipse cx="${num(node.x + node.w / 2 + offset.x)}" cy="${num(node.y + node.h / 2 + offset.y)}" `
            + `rx="${num(node.w / 2)}" ry="${num(node.h / 2)}" fill="${esc(fill)}" stroke="${esc(stroke)}" `
            + `stroke-width="${num(node.strokeWidth || 0)}"${filterAttr}/>`);
        } else {
          target.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" ry="${radius}" `
            + `fill="${esc(fill)}" stroke="${esc(stroke)}" stroke-width="${num(node.strokeWidth || 0)}"${filterAttr}/>`);
        }
        const text = typeof node.text === 'string' ? node.text : '';
        if (text.trim()) {
          const font = fontOf(node);
          const lines = wrapLines(node, text);
          const lineHeight = Number(node.lineHeight) > 0 ? Number(node.lineHeight) : 1.25;
          const inset = canvasTextInset(node);
          const ink = node.textColor || canvasInkOnFill(node.fill) || options.ink || 'rgb(16 20 24)';
          const align = node.textAlign === 'center' ? 'middle' : node.textAlign === 'right' ? 'end' : 'start';
          const textX = node.textAlign === 'center'
            ? num(node.x + node.w / 2 + offset.x)
            : node.textAlign === 'right'
              ? num(node.x + node.w - inset + offset.x)
              : num(node.x + inset + offset.x);
          lines.forEach((line, index) => {
            if (!line) return;
            const baseline = num(node.y + inset + font.size * (lineHeight * index + 0.82) + offset.y);
            target.push(`<text x="${textX}" y="${baseline}" font-family="${esc(font.family)}" `
              + `font-size="${num(font.size)}" font-weight="${font.weight}" `
              + `${node.letterSpacing ? `letter-spacing="${num(node.letterSpacing)}" ` : ''}`
              + `fill="${esc(ink)}" text-anchor="${align}">${esc(line)}</text>`);
          });
        }
      }

      return [
        `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
        defs.length ? `<defs>${defs.join('')}</defs>` : '',
        `<rect width="${width}" height="${height}" fill="${esc(options.background || 'white')}"/>`,
        ...containerBody,
        ...edgeBody,
        ...leafBody,
        '</svg>',
      ].join('');
    }

    /** The container types whose box is a surface for what they hold. */

    /** How far the text sits from the edge of its box, as the canvas pads it. */
    function canvasTextInset(node) {
      if (node.type === 'sticky') return 16;
      if (node.type === 'text') return 0;
      return 12;
    }

    /** Save a file from the browser. */
    function canvasDownload(filename, content, type) {
      const blob = new Blob([content], { type });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.rel = 'noopener';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }

    /** A blob as a data URL, for the channel that carries it to the Host. */
    function canvasBlobDataUrl(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('The picture could not be read back'));
        reader.readAsDataURL(blob);
      });
    }

    /** Rasterise an SVG document into a PNG blob. */
    function canvasExportPng(svg, scale = 2) {
      return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = image.width * scale;
          canvas.height = image.height * scale;
          const context = canvas.getContext('2d');
          context.scale(scale, scale);
          context.drawImage(image, 0, 0);
          canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The PNG could not be built'))), 'image/png');
        };
        image.onerror = () => reject(new Error('The SVG could not be drawn'));
        image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      });
    }

    function CanvasPanel({
      notes,
      pendingNoteIds,
      pourSources,
      onPendingConsumed,
      onError,
      onNotice,
      onNoteUpdated,
      onStateChange,
      onApiReady,
    }) {
      const [canvasMenu, setCanvasMenu] = useState(null);
      const [selectedEdgeId, setSelectedEdgeId] = useState(null);
      const [barMoreOpen, setBarMoreOpen] = useState(false);
      // The report of a file import outlives it: it answers "what did this file
      // not bring in?" days later, so it is a panel, not a toast.
      const [importReport, setImportReport] = useState(null);
      const [importReportOpen, setImportReportOpen] = useState(false);
      // The alignment lines a drag is currently riding, in world coordinates.
      const [snapGuides, setSnapGuides] = useState([]);
      // The pen builds its path in world coordinates until the person commits.
      const [pathDraft, setPathDraft] = useState(null);
      // The tool the pointer is over, so the bar can say what the icon means.
      const [hoveredTool, setHoveredTool] = useState(null);
      // Point editing is its own mode, entered on purpose. A selected vector
      // path shows only its box handles: otherwise a press near the stroke
      // grabs an anchor and a few pixels of drift deform the curve.
      const [pointEditId, setPointEditId] = useState(null);
      // The performance HUD is opt-in: it exists so a big board can be judged
      // by numbers instead of a feeling.
      const [perfHud, setPerfHud] = useState(
        () => readStoredValue('moments-notes:canvas-perf', false) === true,
      );
      const [frameRate, setFrameRate] = useState(null);
      // The AI request field parks a prompt on the board and copies it. It
      // stays folded behind a button in the bottom-left corner: the canvas has
      // its own bottom-centre panels (connector styles, connect hint) and a
      // permanent full-width bar sat underneath them.
      const [aiPrompt, setAiPrompt] = useState('');
      const [aiOpen, setAiOpen] = useState(false);
      const aiInputRef = useRef(null);
      useEffect(() => {
        if (aiOpen) aiInputRef.current?.focus?.();
      }, [aiOpen]);
      // Version history: the Host keeps the copies, the panel lists them.
      const figmaRef = useRef(null);
      const [versionsOpen, setVersionsOpen] = useState(false);
      const [versions, setVersions] = useState([]);
      // Design-token editing: the draft row for a new colour token.
      const [tokenName, setTokenName] = useState('');
      const [tokenColor, setTokenColor] = useState('');
      // The docked inspector is the main property surface, like a design tool's
      // right rail: layout numbers, appearance, effects and typography.
      const [inspectorOpen, setInspectorOpen] = useState(
        () => readStoredValue('moments-notes:canvas-inspector', true) !== false,
      );
      const [boards, setBoards] = useState([]);
      const [activeId, setActiveId] = useState('');
      const [doc, setDoc] = useState(null);
      const [tool, setTool] = useState('select');
      // Click-to-connect: the first click picks the source and the second one
      // finishes the line, so connecting does not require a perfect drag.
      const [connectFrom, setConnectFrom] = useState(null);
      const [connectPreview, setConnectPreview] = useState(null);
      // The connector colour popover hangs off the style bar.
      const [edgeColorOpen, setEdgeColorOpen] = useState(false);
      const [selected, setSelected] = useState(() => new Set());
      const [editingId, setEditingId] = useState(null);
      const [editDraft, setEditDraft] = useState('');
      // Mirrors editingId so a pointer handler can read it without a re-bind.
      const editingIdRef = useRef(null);
      const [status, setStatus] = useState('idle');
      const [savedAt, setSavedAt] = useState(0);
      const [marquee, setMarquee] = useState(null);
      /** Where a connector will snap to, while the pointer is still down. */
      const [magnet, setMagnet] = useState(null);
      const [loading, setLoading] = useState(true);
      const [viewport, setViewport] = useState({ width: 800, height: 600 });
      const [history, setHistory] = useState([]);
      const [future, setFuture] = useState([]);
      const [pourSource, setPourSource] = useState('current');
      const [boardsOpen, setBoardsOpen] = useState(false);
      const [boardQuery, setBoardQuery] = useState('');
      const [editingEdgeId, setEditingEdgeId] = useState(null);
      const [edgeDraft, setEdgeDraft] = useState('');
      const [editingFrameId, setEditingFrameId] = useState(null);
      const [frameDraft, setFrameDraft] = useState('');
      const [collapsed, setCollapsed] = useState(() => new Set());
      const surfaceRef = useRef(null);
      const stageRef = useRef(null);
      const pictureRef = useRef(null);
      const gestureRef = useRef(null);
      /** The last node tapped, and when: pointer capture eats `dblclick`. */
      const lastTapRef = useRef(null);
      /** A node whose second tap landed; the release decides whether to edit. */
      const pendingEditRef = useRef(null);
      const startEditingRef = useRef(null);
      const docRef = useRef(null);
      const saveTimerRef = useRef(null);
      const scheduleSaveRef = useRef(null);
      const consumedRef = useRef(new Set());
      const mountedRef = useRef(true);

      const noteMap = useMemo(() => {
        const map = new Map();
        for (const note of notes || []) map.set(note.id, note);
        return map;
      }, [notes]);

      useEffect(() => { docRef.current = doc; }, [doc]);

      useEffect(() => () => { mountedRef.current = false; clearTimeout(saveTimerRef.current); }, []);

      /** Measure the drawing area so nodes can land in the middle of what the person sees. */
      const viewportRef = useRef({ width: 0, height: 0 });
      const measureViewport = useCallback(() => {
        const element = surfaceRef.current;
        if (!element || typeof element.getBoundingClientRect !== 'function') return;
        const rect = element.getBoundingClientRect();
        if (!rect || !rect.width || !rect.height) return;
        viewportRef.current = { width: rect.width, height: rect.height };
        setViewport((current) => (
          Math.abs(current.width - rect.width) < 1 && Math.abs(current.height - rect.height) < 1
            ? current
            : { width: rect.width, height: rect.height }
        ));
      }, []);

      useEffect(() => {
        measureViewport();
        window.addEventListener?.('resize', measureViewport);
        return () => window.removeEventListener?.('resize', measureViewport);
      }, [measureViewport]);

      const loadBoards = useCallback(async () => {
        const result = await api('canvas-list', {});
        const list = Array.isArray(result?.canvases) ? result.canvases : [];
        setBoards(list);
        return list;
      }, []);

      const loadCanvas = useCallback(async (canvasId) => {
        const result = await api('canvas-load', { id: canvasId });
        const canvas = result?.canvas;
        if (!canvas) throw new Error('The canvas is empty');
        const nodes = Array.isArray(canvas.nodes) ? canvas.nodes : [];
        let camera = { x: canvas.camera?.x || 0, y: canvas.camera?.y || 0, zoom: clampCanvasZoom(canvas.camera?.zoom || 1) };
        // A board imported from Figma can be tens of thousands of pixels wide.
        // If the saved view does not contain a single node, frame the content
        // instead of opening on blank paper.
        const viewSize = {
          width: viewportRef.current?.width || 1200,
          height: viewportRef.current?.height || 800,
        };
        if (nodes.length) {
          const anyVisible = nodes.some((node) => {
            const middle = canvasWorldToScreen({ x: node.x + node.w / 2, y: node.y + node.h / 2 }, camera);
            return middle.x > -240 && middle.x < viewSize.width + 240
              && middle.y > -240 && middle.y < viewSize.height + 240;
          });
          if (!anyVisible) camera = canvasFitCamera(nodes, viewSize);
        }
        const tokens = canvas.tokens && typeof canvas.tokens === 'object' ? canvas.tokens : {};
        const themes = canvas.themes && typeof canvas.themes === 'object' ? canvas.themes : null;
        const next = {
          title: canvas.title || 'Board',
          nodes,
          edges: Array.isArray(canvas.edges) ? canvas.edges : [],
          camera,
          // The board's design tokens ride along: the inspector offers them as
          // chips, and a save must not silently drop them.
          tokens: {
            colors: tokens.colors && typeof tokens.colors === 'object' ? tokens.colors : {},
            gradients: tokens.gradients && typeof tokens.gradients === 'object' ? tokens.gradients : {},
            type: tokens.type && typeof tokens.type === 'object' ? tokens.type : {},
          },
          theme: canvas.theme === 'dark' ? 'dark' : 'light',
          themes,
        };
        docRef.current = next;
        setDoc(next);
        setActiveId(canvas.id);
        setSelected(new Set());
        setEditingId(null);
        setHistory([]);
        setFuture([]);
        setCollapsed(new Set(readStoredValue(`${CANVAS_LAYERS_COLLAPSED_KEY}:${canvas.id}`, [])));
        writeStoredValue(CANVAS_ACTIVE_KEY, canvas.id);
        return canvas;
      }, []);

      // One animation frame per screen refresh: the HUD reports what the page
      // actually managed, not what the code hoped for.
      useEffect(() => {
        if (!perfHud) {
          setFrameRate(null);
          return undefined;
        }
        const raf = globalThis.requestAnimationFrame;
        if (typeof raf !== 'function') return undefined;
        let frames = 0;
        let startedAt = 0;
        let handle = 0;
        const tick = (now) => {
          const time = Number(now) || 0;
          if (!startedAt) startedAt = time;
          frames += 1;
          const elapsed = time - startedAt;
          if (elapsed >= 500) {
            if (mountedRef.current) setFrameRate(Math.round((frames * 1000) / elapsed));
            frames = 0;
            startedAt = time;
          }
          handle = raf(tick);
        };
        handle = raf(tick);
        return () => globalThis.cancelAnimationFrame?.(handle);
      }, [perfHud]);

      // A tool card can ask for its board after this panel is already open;
      // the mount effect above only covers the first open.
      useEffect(() => {
        const onDesignActive = (event) => {
          const boardId = event?.detail?.boardId;
          if (typeof boardId !== 'string' || !boardId || boardId === activeId) return;
          void loadCanvas(boardId).catch(() => {});
        };
        window.addEventListener('moments:design-active', onDesignActive);
        return () => window.removeEventListener('moments:design-active', onDesignActive);
      }, [activeId, loadCanvas]);

      useEffect(() => {
        mountedRef.current = true;
        void (async () => {
          setLoading(true);
          try {
            let list = await loadBoards();
            // A workspace with no board yet still needs somewhere to draw: the
            // panel used to render a phantom board and reject every write.
            if (!list.length) {
              const created = await api('canvas-create', { title: 'Board' });
              if (created?.canvas?.id) {
                list = await loadBoards();
                await loadCanvas(created.canvas.id);
              }
            } else {
              const stored = readStoredValue(CANVAS_ACTIVE_KEY, '');
              const target = list.find((board) => board.id === stored) || list[0];
              if (target) await loadCanvas(target.id);
            }
          } catch (failure) {
            // The failure object keeps the Host log id; a bare message loses it.
            if (mountedRef.current) onError(failure);
          } finally {
            if (mountedRef.current) setLoading(false);
          }
        })();
        return () => { mountedRef.current = false; };
      }, [loadBoards, loadCanvas, onError]);

      /**
       * Replace the document.
       *
       * The content snapshot goes to the history only when the change is a
       * real edit; panning the camera is a view change and must not eat an
       * undo step.
       */
      const applyDoc = useCallback((updater, options = {}) => {
        const current = docRef.current;
        if (!current) return;
        const next = typeof updater === 'function' ? updater(current) : updater;
        if (!next) return;
        if (options.history) {
          // The change is the difference between the two states, expressed as
          // commands: undoing it applies their inverses.
          const commands = canvasDiffCommands(current.nodes, next.nodes || []);
          if (commands.length) {
            setHistory((items) => [...items, { nodes: current.nodes, edges: current.edges, commands }].slice(-CANVAS_HISTORY_LIMIT));
            setFuture([]);
          }
        }
        docRef.current = next;
        setDoc(next);
        // The change asks for its own save. Watching `doc` from an effect
        // would depend on how the renderer batches updates, and two changes
        // batched into one render would only ever arm the timer once.
        if (options.save !== false) scheduleSaveRef.current?.();
      }, []);

      const saveNow = useCallback(async () => {
        const current = docRef.current;
        if (!current || !activeId) return;
        setStatus('saving');
        try {
          const result = await api('canvas-save', {
            id: activeId,
            title: current.title,
            nodes: current.nodes,
            edges: current.edges,
            camera: current.camera,
            tokens: current.tokens,
            theme: current.theme,
            themes: current.themes,
          });
          if (!mountedRef.current) return;
          setStatus('saved');
          setSavedAt(result?.canvas?.updatedAt || Date.now());
          await loadBoards();
        } catch (failure) {
          if (!mountedRef.current) return;
          setStatus('error');
          // Log the board that failed with the browser's own account of it, so
          // the Host line and the screen message can be read together.
          void api('client-error', {
            method: 'canvas-save',
            code: typeof failure?.code === 'string' ? failure.code : 'save-failed',
            message: failure?.message || String(failure),
            stack: typeof failure?.stack === 'string' ? failure.stack : '',
            detail: {
              boardId: activeId,
              logId: failure?.logId ?? null,
              nodes: (docRef.current?.nodes || []).length,
              suspects: (docRef.current?.nodes || [])
                .filter((node) => !Number.isFinite(node.w) || !Number.isFinite(node.h)
                  || node.w < 16 || node.w > 8000 || node.h < 16 || node.h > 8000)
                .slice(0, 5)
                .map((node) => ({ id: node.id, type: node.type, w: node.w, h: node.h })),
            },
          }).catch(() => {});
          onError(failure);
        }
      }, [activeId, loadBoards, onError]);

      /**
       * Save the whole document a moment after the last change.
       *
       * The timer belongs to the change rather than to the render: every
       * mutation asks for a save, and the last request in a burst wins.
       */
      scheduleSaveRef.current = useCallback(() => {
        if (!activeId) return;
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => { void saveNow(); }, CANVAS_SAVE_DELAY);
      }, [activeId, saveNow]);

      // The stack holds what changed, not a copy of the board: an edit is a
      // command, and undoing it applies the inverse of that command. A board
      // of any size costs the same to undo.
      const undo = useCallback(() => {
        const current = docRef.current;
        if (!current || !history.length) return;
        const previous = history[history.length - 1];
        setHistory(history.slice(0, -1));
        setFuture((items) => [...items, { nodes: current.nodes, edges: current.edges, commands: previous.commands }].slice(-CANVAS_HISTORY_LIMIT));
        const restored = {
          ...current,
          nodes: canvasApplyCommands(current.nodes, previous.commands.map(canvasInvertCommand).reverse()),
        };
        docRef.current = restored;
        setDoc(restored);
        // The board on disk has to follow the board on screen: an undo that
        // only changes the picture leaves the file holding the change that was
        // just taken back.
        scheduleSaveRef.current?.();
      }, [history]);

      const redo = useCallback(() => {
        const current = docRef.current;
        if (!current || !future.length) return;
        const next = future[future.length - 1];
        setFuture(future.slice(0, -1));
        // The redo entry carries the commands that were undone, so the stack
        // stays a stack of changes rather than a stack of board copies.
        setHistory((items) => [...items, { nodes: current.nodes, edges: current.edges, commands: next.commands }].slice(-CANVAS_HISTORY_LIMIT));
        const restored = {
          ...current,
          nodes: canvasApplyCommands(current.nodes, next.commands),
        };
        docRef.current = restored;
        setDoc(restored);
        scheduleSaveRef.current?.();
      }, [future]);

      const selectNodes = useCallback((ids, additive = false) => {
        setSelected((current) => {
          const next = additive ? new Set(current) : new Set();
          for (const id of ids) {
            if (additive && next.has(id)) next.delete(id);
            else next.add(id);
          }
          return next;
        });
      }, []);

      /** The pointer position inside the drawing area. */
      const pointerInSurface = useCallback((event) => {
        const element = surfaceRef.current;
        const rect = element && typeof element.getBoundingClientRect === 'function'
          ? element.getBoundingClientRect()
          : null;
        return {
          x: (event.clientX || 0) - (rect?.left || 0),
          y: (event.clientY || 0) - (rect?.top || 0),
        };
      }, []);

      const camera = doc?.camera || { x: 0, y: 0, zoom: 1 };

      const startPan = useCallback((event) => {
        gestureRef.current = {
          mode: 'pan',
          originClient: { x: event.clientX || 0, y: event.clientY || 0 },
          camera: { ...camera },
        };
      }, [camera]);

      /**
       * Start dragging the selection.
       *
       * A plain press keeps a multi-selection together, so a group can be
       * dragged by any of its members. A modified press toggles the node in
       * the selection, and the drag then carries whatever is selected.
       */
      const startMove = useCallback((event, node, additive = false) => {
        let ids;
        if (additive) {
          const next = new Set(selected);
          if (next.has(node.id)) next.delete(node.id);
          else next.add(node.id);
          ids = [...next];
        } else {
          ids = selected.has(node.id) ? [...selected] : [node.id];
        }
        selectNodes(ids, false);
        // Dragging an instance drags the nodes its expansion generated: they
        // are derived from the instance position, so leaving them behind would
        // only make the next save snap them back.
        const followers = (docRef.current?.nodes || [])
          .filter((item) => item.origin && ids.includes(item.origin.instance))
          .map((item) => item.id);
        const moved = followers.length ? [...new Set([...ids, ...followers])] : ids;
        gestureRef.current = {
          mode: 'move',
          originClient: { x: event.clientX || 0, y: event.clientY || 0 },
          snapshot: (docRef.current?.nodes || []).filter((item) => moved.includes(item.id)).map((item) => ({ ...item })),
          // The whole board before the drag, for the undo stack: the snapshot
          // alone only knows about the nodes that were moved.
          before: docRef.current?.nodes || [],
          moved: false,
        };
      }, [selected, selectNodes]);

      /**
       * Press a group's frame.
       *
       * The press selects the group — a group is one object for selection,
       * the way it is in Figma — and the drag that may follow moves the
       * members, whose rectangle the frame is derived from.
       */
      const startGroupDrag = useCallback((event, group) => {
        const current = docRef.current;
        if (!current) return;
        // A container drags everything beneath it, not only its children.
        // The container itself comes along too: an empty frame has no members
        // to carry it, and its box is not recomputed from anything.
        const byId = new Map(current.nodes.map((node) => [node.id, node]));
        const ids = [];
        const visit = (nodeId) => {
          const node = byId.get(nodeId);
          if (!node) return;
          ids.push(nodeId);
          for (const memberId of node.members || []) visit(memberId);
        };
        visit(group.id);
        if (!ids.length) return;
        selectNodes([group.id], Boolean(event.shiftKey || event.metaKey || event.ctrlKey));
        gestureRef.current = {
          mode: 'move',
          originClient: { x: event.clientX || 0, y: event.clientY || 0 },
          snapshot: current.nodes.filter((node) => ids.includes(node.id)).map((node) => ({ ...node })),
          before: current.nodes,
          moved: false,
        };
      }, [selectNodes]);

      const startResize = useCallback((event, handle) => {
        const nodes = docRef.current?.nodes || [];
        const byId = new Map(nodes.map((node) => [node.id, node]));
        const ids = new Set(selected);
        // A group is defined by its members, so dragging its handle has to
        // scale the members: scaling only the group's own box would be undone
        // by the next measurement, which is what made the box drift.
        const scaleMembers = (nodeId) => {
          const node = byId.get(nodeId);
          if (!node || !canvasIsContainer(node) || !canvasContainerAutoSizes(node)) return;
          for (const memberId of node.members || []) {
            if (ids.has(memberId)) continue;
            ids.add(memberId);
            scaleMembers(memberId);
          }
        };
        for (const id of [...ids]) scaleMembers(id);
        const bounds = canvasBoundsOf(nodes.filter((item) => ids.has(item.id)));
        if (!bounds) return;
        gestureRef.current = {
          mode: 'resize',
          handle,
          originClient: { x: event.clientX || 0, y: event.clientY || 0 },
          bounds,
          snapshot: nodes.filter((item) => ids.has(item.id)).map((item) => ({ ...item })),
          // Which nodes the person actually grabbed: only those get their box
          // pinned, the rest are being carried along by the scale.
          selectedIds: [...selected],
          before: nodes,
          moved: false,
        };
      }, [selected]);

      /**
       * The node under a board point.
       *
       * Pointer capture retargets pointer events to the canvas, so the DOM
       * cannot answer "which node is under the pointer" during a drag. The
       * geometry can, and it keeps working whatever the DOM does.
       */
      const nodeAtWorldPoint = useCallback((point, excludeId) => {
        const nodes = docRef.current?.nodes || [];
        for (let index = nodes.length - 1; index >= 0; index -= 1) {
          const node = nodes[index];
          if (!node || node.id === excludeId || node.visible === false) continue;
          const bounds = canvasNodeBounds(node);
          if (point.x >= bounds.x && point.x <= bounds.x + bounds.w
            && point.y >= bounds.y && point.y <= bounds.y + bounds.h) return node;
        }
        return null;
      }, []);

      /** Add the connector between two nodes, unless it already exists. */
      const connectNodes = useCallback((fromId, toId, point) => {
        const nodes = docRef.current?.nodes || [];
        const from = nodes.find((node) => node.id === fromId);
        const to = nodes.find((node) => node.id === toId);
        if (!from || !to || from.id === to.id) return false;
        const end = point || { x: to.x + to.w / 2, y: to.y + to.h / 2 };
        const edge = {
          id: makeId(),
          from: from.id,
          to: to.id,
          fromAnchor: canvasNearestAnchor(from, end),
          toAnchor: canvasNearestAnchor(to, end),
          label: '',
        };
        const edges = docRef.current?.edges || [];
        if (edges.some((item) => item.from === edge.from && item.to === edge.to)) return false;
        applyDoc((current) => ({ ...current, edges: [...current.edges, edge] }), { history: true });
        return true;
      }, [applyDoc]);

      const startConnector = useCallback((event, node) => {
        gestureRef.current = {
          mode: 'connector',
          from: node.id,
          origin: { x: event.clientX || 0, y: event.clientY || 0 },
          point: canvasScreenToWorld(pointerInSurface(event), camera),
        };
      }, [camera, pointerInSurface]);

      /**
       * Keep a gesture alive when the pointer leaves the drawing area.
       *
       * Without the capture the drag would stop the moment the pointer
       * crossed the edge of the canvas, which is exactly where people drag
       * to.
       */
      const capturePointer = useCallback((event) => {
        const element = surfaceRef.current;
        if (!element || typeof element.setPointerCapture !== 'function') return;
        try {
          element.setPointerCapture(event.pointerId);
        } catch {
          // A pointer that is already gone cannot be captured.
        }
      }, []);

      const releasePointer = useCallback((event) => {
        const element = surfaceRef.current;
        if (!element || typeof element.releasePointerCapture !== 'function') return;
        try {
          element.releasePointerCapture(event.pointerId);
        } catch {
          // The pointer was never captured.
        }
      }, []);

      /** Turn the pen's draft into a real path node, in node-local coordinates. */
      const commitPathDraft = useCallback((points, closed = false) => {
        setPathDraft(null);
        if (!Array.isArray(points) || points.length < 2) return;
        const xs = points.map((point) => point.x);
        const ys = points.map((point) => point.y);
        const left = Math.round(Math.min(...xs));
        const top = Math.round(Math.min(...ys));
        const width = Math.max(24, Math.round(Math.max(...xs) - left));
        const height = Math.max(24, Math.round(Math.max(...ys) - top));
        const node = {
          id: makeId(),
          type: 'shape',
          shape: 'path',
          x: left,
          y: top,
          w: width,
          h: height,
          rotation: 0,
          text: '',
          noteId: null,
          noteUpdatedAt: null,
          color: 'none',
          locked: false,
          visible: true,
          fill: null,
          stroke: canvasPalette(stageRef.current).find((entry) => entry.id === 'slate')?.value || null,
          strokeWidth: 2,
          opacity: 1,
          radius: 0,
          textAlign: 'left',
          members: [],
          title: '',
          sides: 5,
          points: 5,
          flipX: false,
          flipY: false,
          assetId: null,
          fontSize: 14,
          textColor: null,
          path: {
            closed,
            points: points.map((point) => ({
              x: Math.round(point.x - left),
              y: Math.round(point.y - top),
              in: null,
              out: null,
            })),
          },
        };
        applyDoc((current) => ({ ...current, nodes: [...current.nodes, node] }), { history: true });
        setSelected(new Set([node.id]));
        setTool('select');
      }, [applyDoc]);

      const startHandleDrag = useCallback((event, node, index, side) => {
        gestureRef.current = {
          mode: 'handle',
          nodeId: node.id,
          index,
          side,
          originClient: { x: event.clientX || 0, y: event.clientY || 0 },
          before: docRef.current?.nodes || [],
          moved: false,
        };
      }, []);

      const startAnchorDrag = useCallback((event, node, index) => {
        gestureRef.current = {
          mode: 'anchor',
          nodeId: node.id,
          index,
          originClient: { x: event.clientX || 0, y: event.clientY || 0 },
          before: docRef.current?.nodes || [],
          moved: false,
        };
      }, []);

      const onSurfacePointerDown = useCallback((event) => {
        setSelectedEdgeId(null);
        if (event.button === 1 || tool === 'hand') {
          startPan(event);
          capturePointer(event);
          return;
        }
        if (event.button !== 0) return;
        const point = canvasScreenToWorld(pointerInSurface(event), camera);
        // The pen: each press adds an anchor, and pressing the first anchor
        // again closes the path. Enter or a double click ends it open.
        if (tool === 'path') {
          if (!pathDraft) {
            setPathDraft({ points: [point] });
            capturePointer(event);
            return;
          }
          const [first] = pathDraft.points;
          const zoom = docRef.current?.camera?.zoom || 1;
          const closing = pathDraft.points.length >= 2
            && Math.hypot(point.x - first.x, point.y - first.y) <= 12 / zoom;
          if (closing) {
            commitPathDraft(pathDraft.points, true);
            return;
          }
          setPathDraft({ points: [...pathDraft.points, point] });
          capturePointer(event);
          return;
        }
        if (tool === 'sticky' || tool === 'text' || tool === 'rect' || tool === 'ellipse' || tool === 'frame') {
          const isText = tool === 'text';
          const isShape = tool === 'rect' || tool === 'ellipse';
          const isFrame = tool === 'frame';
          const size = isText ? CANVAS_LABEL_SIZE : isFrame ? CANVAS_FRAME_SIZE : isShape ? CANVAS_SHAPE_SIZE : CANVAS_STICKY_SIZE;
          const node = {
            id: makeId(),
            type: isFrame ? 'frame' : isShape ? 'shape' : isText ? 'text' : 'sticky',
            x: Math.round(point.x - size.w / 2),
            y: Math.round(point.y - size.h / 2),
            w: size.w,
            h: size.h,
            rotation: 0,
            text: '',
            noteId: null,
            noteUpdatedAt: null,
            color: 'none',
            locked: false,
            visible: true,
            ...(isShape
              ? {
                shape: tool,
                fill: null,
                stroke: canvasPalette(stageRef.current).find((entry) => entry.id === 'slate')?.value || null,
                strokeWidth: 1,
                opacity: 1,
                radius: tool === 'ellipse' ? 0 : 8,
              }
              : {}),
            ...(isFrame ? { title: 'Frame', members: [] } : {}),
          };
          applyDoc((current) => ({ ...current, nodes: [...current.nodes, node] }), { history: true });
          setTool('select');
          if (isFrame) {
            setEditingFrameId(node.id);
            setFrameDraft('Frame');
          } else {
            setEditingId(node.id);
            setEditDraft('');
          }
          setSelected(new Set([node.id]));
          return;
        }
        capturePointer(event);
        gestureRef.current = {
          mode: 'marquee',
          originClient: { x: event.clientX || 0, y: event.clientY || 0 },
          origin: point,
          additive: Boolean(event.shiftKey),
          rect: { x: point.x, y: point.y, w: 0, h: 0 },
        };
        setMarquee({ x: point.x, y: point.y, w: 0, h: 0 });
      }, [applyDoc, camera, capturePointer, commitPathDraft, pathDraft, pointerInSurface, startPan, tool]);

      const onNodePointerDown = useCallback((event, node) => {
        if (event.button === 1) {
          startPan(event);
          capturePointer(event);
          return;
        }
        if (event.button !== 0) return;
        event.stopPropagation?.();
        capturePointer(event);
        if (tool === 'connector') {
          // Second click of a click-to-connect: the line lands now.
          if (connectFrom && connectFrom !== node.id) {
            const point = canvasScreenToWorld(pointerInSurface(event), camera);
            connectNodes(connectFrom, node.id, point);
            setConnectFrom(null);
            setMagnet(null);
            selectNodes([], false);
            return;
          }
          // The source is visibly selected before the drag starts.
          selectNodes([node.id], false);
          setConnectFrom(node.id);
          startConnector(event, node);
          return;
        }
        if (node.locked) return;
        // A member of a flowing container is positioned by the layout pass on
        // save, so dragging it would be undone by the next autosave. Selecting
        // stays allowed; the movement does not.
        const managed = (docRef.current?.nodes || []).some((container) => (
          (container.type === 'frame' || container.type === 'group')
          && container.layout && container.layout !== 'none'
          && Array.isArray(container.members) && container.members.includes(node.id)
        ));
        if (managed) {
          selectNodes([node.id], Boolean(event.shiftKey || event.metaKey || event.ctrlKey));
          return;
        }
        startMove(event, node, Boolean(event.shiftKey || event.metaKey || event.ctrlKey));
      }, [capturePointer, selectNodes, startConnector, startMove, startPan, tool]);

      const onSurfacePointerMove = useCallback((event) => {
        const gesture = gestureRef.current;
        if (!gesture) return;
        const zoom = docRef.current?.camera?.zoom || 1;
        if (gesture.mode === 'pan') {
          const dx = (event.clientX || 0) - gesture.originClient.x;
          const dy = (event.clientY || 0) - gesture.originClient.y;
          applyDoc((current) => ({
            ...current,
            camera: { ...current.camera, x: gesture.camera.x + dx, y: gesture.camera.y + dy },
          }));
          return;
        }
        if (gesture.mode === 'move') {
          const dx = (event.clientX || 0) - gesture.originClient.x;
          const dy = (event.clientY || 0) - gesture.originClient.y;
          if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
          gesture.moved = true;
          let worldX = dx / zoom;
          let worldY = dy / zoom;
          const origins = new Map(gesture.snapshot.map((item) => [item.id, item]));
          // Alt is the escape hatch: hold it and the node goes where the hand
          // put it, with no magnetic edges.
          if (!event.altKey) {
            const moving = new Set(gesture.snapshot.map((item) => item.id));
            const dragged = gesture.snapshot.map((item) => ({
              ...item,
              x: item.x + worldX,
              y: item.y + worldY,
            }));
            const box = canvasBoundsOf(dragged);
            const others = (docRef.current?.nodes || [])
              .filter((item) => !moving.has(item.id) && item.visible !== false)
              .map((item) => ({ x: item.x, y: item.y, w: item.w, h: item.h }));
            if (box) {
              const snap = canvasSnapBox(box, others, CANVAS_SNAP_PIXELS / zoom);
              worldX += snap.dx;
              worldY += snap.dy;
              setSnapGuides(snap.guides);
            }
          } else {
            setSnapGuides([]);
          }
          const nodes = canvasSyncGroups((docRef.current?.nodes || []).map((item) => {
            const origin = origins.get(item.id);
            if (!origin) return item;
            return { ...item, x: Math.round(origin.x + worldX), y: Math.round(origin.y + worldY) };
          }));
          const current = docRef.current;
          const next = { ...current, nodes };
          docRef.current = next;
          setDoc(next);
          return;
        }
        if (gesture.mode === 'resize') {
          // A drag is measured in screen pixels, but the board lives in world
          // units: at 21% zoom one pixel is about five world units. The delta
          // has to be scaled by the camera, or a small drag inflates the node
          // several times over.
          const zoom = docRef.current?.camera?.zoom || 1;
          const dx = ((event.clientX || 0) - gesture.originClient.x) / zoom;
          const dy = ((event.clientY || 0) - gesture.originClient.y) / zoom;
          if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
          gesture.moved = true;
          const bounds = gesture.bounds;
          let left = bounds.x;
          let top = bounds.y;
          let width = bounds.w;
          let height = bounds.h;
          if (gesture.handle.includes('w')) { left += dx; width -= dx; }
          if (gesture.handle.includes('e')) { width += dx; }
          if (gesture.handle.includes('n')) { top += dy; height -= dy; }
          if (gesture.handle.includes('s')) { height += dy; }
          if (event.shiftKey && bounds.w > 0 && bounds.h > 0) {
            const ratio = bounds.h / bounds.w;
            const wanted = Math.max(width, height * (bounds.w / bounds.h));
            if (gesture.handle.includes('w')) left = bounds.x + bounds.w - wanted;
            if (gesture.handle.includes('n')) top = bounds.y + bounds.h - wanted * ratio;
            width = wanted;
            height = wanted * ratio;
          }
          // The Host rejects a node outside this range, so the gesture stops
          // at the same values the save accepts.
          // A selection of containers may grow past the leaf limit.
          const boxLimit = gesture.snapshot.some((item) => canvasIsContainer(item))
            ? CANVAS_CONTAINER_MAX_SIZE
            : CANVAS_NODE_MAX_SIZE;
          width = Math.min(boxLimit, Math.max(CANVAS_NODE_MIN_SIZE, width));
          height = Math.min(boxLimit, Math.max(CANVAS_NODE_MIN_SIZE, height));
          const scaleX = width / (bounds.w || 1);
          const scaleY = height / (bounds.h || 1);
          // Scale the sizes the nodes had when the press started, never the
          // sizes a previous move already produced: a drag arrives as dozens of
          // events, and multiplying the current size again on every one of them
          // grows the node exponentially.
          const origins = new Map(gesture.snapshot.map((item) => [item.id, item]));
          const grabbed = new Set(gesture.selectedIds || gesture.snapshot.map((item) => item.id));
          let nodes = (docRef.current?.nodes || []).map((item) => {
            const origin = origins.get(item.id);
            if (!origin) return item;
            const scaled = {
              ...item,
              x: Math.round(left + (origin.x - bounds.x) * scaleX),
              y: Math.round(top + (origin.y - bounds.y) * scaleY),
              w: Math.max(CANVAS_NODE_MIN_SIZE, Math.round(origin.w * scaleX)),
              h: Math.max(CANVAS_NODE_MIN_SIZE, Math.round(origin.h * scaleY)),
            };
            // The box of a container the person grabbed is now their decision:
            // it stops following its members, or the next measurement would
            // snap it back and the drag would appear to drift.
            if (grabbed.has(item.id) && canvasIsContainer(item)) scaled.autoSize = false;
            return scaled;
          });
          // An explicitly sized container re-places its members by their pins
          // instead of stretching them with the box.
          const sole = gesture.snapshot.length === 1 ? gesture.snapshot[0] : null;
          if (sole && canvasIsContainer(sole)) {
            // Pins only describe a relationship when the members are inside
            // the container. A flattened import leaves them outside, and
            // re-placing them by their pins then throws them thousands of
            // units away: the box follows the pointer while its contents
            // teleport, which reads as "it ran off to the right".
            const own = canvasBoundsOf([sole]);
            const inside = own && sole.members && sole.members.length
              ? (() => {
                const byId = new Map(nodes.map((node) => [node.id, node]));
                const kids = sole.members.map((id) => byId.get(id)).filter(Boolean);
                if (!kids.length) return false;
                const union = canvasBoundsOf(kids);
                return !union || (union.x >= own.x - 1 && union.y >= own.y - 1
                  && union.x + union.w <= own.x + own.w + 1
                  && union.y + union.h <= own.y + own.h + 1);
              })()
              : false;
            if (inside) {
              nodes = canvasApplyConstraints(nodes, sole.id, bounds, {
                x: left, y: top, w: width, h: height,
              });
            } else {
              // The members keep their place relative to the container.
              nodes = canvasMoveMembers(nodes, sole.id, left - bounds.x, top - bounds.y);
            }
          }
          nodes = canvasSyncGroups(nodes);
          const current = docRef.current;
          const next = { ...current, nodes };
          docRef.current = next;
          setDoc(next);
          // A resize writes the document directly, so it has to ask for its own
          // save: without this the box followed the pointer on screen and then
          // reverted on the next load, which looks exactly like drift.
          scheduleSaveRef.current?.();
          return;
        }
        if (gesture.mode === 'anchor') {
          const zoom = docRef.current?.camera?.zoom || 1;
          const rawX = (event.clientX || 0) - gesture.originClient.x;
          const rawY = (event.clientY || 0) - gesture.originClient.y;
          // Three screen pixels of slack: a click must never nudge the curve.
          if (Math.hypot(rawX, rawY) < 3) return;
          const dx = rawX / zoom;
          const dy = rawY / zoom;
          gesture.moved = true;
          const original = (gesture.before || []).find((node) => node.id === gesture.nodeId);
          if (!original?.path) return;
          const nodes = (docRef.current?.nodes || []).map((node) => {
            if (node.id !== gesture.nodeId) return node;
            const points = node.path.points.map((point, index) => (
              index === gesture.index
                ? { ...point, x: Math.round(point.x + dx), y: Math.round(point.y + dy) }
                : point
            ));
            return { ...node, path: { ...node.path, points } };
          });
          const current = docRef.current;
          const next = { ...current, nodes };
          docRef.current = next;
          setDoc(next);
          return;
        }
        if (gesture.mode === 'handle') {
          const zoom = docRef.current?.camera?.zoom || 1;
          const rawX = (event.clientX || 0) - gesture.originClient.x;
          const rawY = (event.clientY || 0) - gesture.originClient.y;
          if (Math.hypot(rawX, rawY) < 3) return;
          const dx = rawX / zoom;
          const dy = rawY / zoom;
          gesture.moved = true;
          const original = (gesture.before || []).find((node) => node.id === gesture.nodeId);
          const handle = original?.path?.points?.[gesture.index]?.[gesture.side];
          if (!handle) return;
          const nodes = (docRef.current?.nodes || []).map((node) => {
            if (node.id !== gesture.nodeId) return node;
            const points = node.path.points.map((point, index) => (
              index === gesture.index
                ? { ...point, [gesture.side]: { x: Math.round(handle.x + dx), y: Math.round(handle.y + dy) } }
                : point
            ));
            return { ...node, path: { ...node.path, points } };
          });
          const current = docRef.current;
          const next = { ...current, nodes };
          docRef.current = next;
          setDoc(next);
          return;
        }
        if (gesture.mode === 'marquee') {
          const point = canvasScreenToWorld(pointerInSurface(event), camera);
          const rect = {
            x: Math.min(gesture.origin.x, point.x),
            y: Math.min(gesture.origin.y, point.y),
            w: Math.abs(point.x - gesture.origin.x),
            h: Math.abs(point.y - gesture.origin.y),
          };
          // The gesture owns the rectangle: the release must read the same
          // shape the person drew, whatever the render did in between.
          gesture.rect = rect;
          setMarquee(rect);
          return;
        }
        if (gesture.mode === 'connector') {
          const point = canvasScreenToWorld(pointerInSurface(event), camera);
          gesture.point = point;
          // The magnet reads the board geometry, not the DOM: pointer capture
          // makes every event target the canvas during the drag.
          const over = nodeAtWorldPoint(point, gesture.from);
          const anchor = over ? canvasNearestAnchor(over, point) : null;
          gesture.magnet = anchor;
          gesture.targetId = over?.id ?? null;
          setMagnet(over && anchor ? { nodeId: over.id, anchor } : null);
          const from = (docRef.current?.nodes || []).find((node) => node.id === gesture.from);
          if (from) {
            const start = canvasAnchorPoint(from, canvasNodeBounds(from), anchor
              ? canvasNearestAnchor(from, over ? canvasAnchorPoint(over, canvasNodeBounds(over), anchor) : point)
              : canvasNearestAnchor(from, point));
            setConnectPreview({ from: start, to: point });
          }
        }
      }, [applyDoc, camera, pointerInSurface, releasePointer]);

      const onSurfacePointerUp = useCallback((event) => {
        const gesture = gestureRef.current;
        gestureRef.current = null;
        setSnapGuides([]);
        releasePointer(event);
        setMagnet(null);
        if (!gesture) return;
        if (gesture.mode === 'marquee') {
          setMarquee(null);
          const rect = gesture.rect;
          if (!rect || rect.w < 2 || rect.h < 2) {
            if (!gesture.additive) selectNodes([], false);
            return;
          }
          const hits = (docRef.current?.nodes || [])
            .filter((node) => canvasRectsOverlap(rect, canvasNodeBounds(node)))
            .map((node) => node.id);
          selectNodes(hits, gesture.additive);
          return;
        }
        if (gesture.mode === 'move' || gesture.mode === 'resize') {
          // The last frame of the drag is the one worth storing; a burst of
          // pointer moves arms the timer many times and only the last one runs.
          if (gesture.moved) scheduleSaveRef.current?.();
          if (gesture.moved) {
            // The snapshot only holds the nodes that moved, which is what a
            // drag needs. The undo stack needs the whole board: restoring a
            // selection would drop every other node from the document.
            const before = new Map(gesture.snapshot.map((item) => [item.id, item]));
            const nodes = (gesture.before || docRef.current?.nodes || []).map((node) => before.get(node.id) || node);
            const commands = canvasDiffCommands(nodes, docRef.current?.nodes || []);
            if (commands.length) {
              setHistory((items) => [...items, { nodes, edges: docRef.current?.edges || [], commands }].slice(-CANVAS_HISTORY_LIMIT));
              setFuture([]);
            }
          }
          // A second tap that did not turn into a drag opens the text.
          const pending = pendingEditRef.current;
          pendingEditRef.current = null;
          if (!gesture.moved && pending) startEditingRef.current?.(pending);
          return;
        }
        if (gesture.mode === 'anchor' || gesture.mode === 'handle') {
          if (gesture.moved) {
            const nodes = gesture.before || docRef.current?.nodes || [];
            const commands = canvasDiffCommands(nodes, docRef.current?.nodes || []);
            if (commands.length) {
              setHistory((items) => [...items, {
                nodes,
                edges: docRef.current?.edges || [],
                commands,
              }].slice(-CANVAS_HISTORY_LIMIT));
              setFuture([]);
            }
          }
          return;
        }
        if (gesture.mode === 'connector') {
          setConnectPreview(null);
          const point = gesture.point || canvasScreenToWorld(pointerInSurface(event), camera);
          const over = nodeAtWorldPoint(point, gesture.from);
          const targetId = over?.id ?? gesture.targetId ?? null;
          if (targetId && targetId !== gesture.from) {
            connectNodes(gesture.from, targetId, point);
            setConnectFrom(null);
            return;
          }
          // Released on empty board: keep the source armed so the next click
          // on another object finishes the line.
          setConnectFrom(gesture.from);
        }
      }, [applyDoc, selectNodes]);

      /**
       * Zoom or pan with the wheel.
       *
       * This is bound natively (see the effect below) rather than through
       * `onWheel`: React attaches wheel listeners passively, so `preventDefault`
       * inside a React handler is ignored and the browser zooms the whole page
       * instead of the board. That is what made a pinch feel like the page
       * jumping rather than the canvas following the pointer.
       */
      const onSurfaceWheel = useCallback((event) => {
        // The native listener below runs first and marks the event; this entry
        // point then only serves the case where it was not bound.
        if (event.__mmWheelHandled) return;
        event.preventDefault();
        const current = docRef.current;
        if (!current) return;
        const point = pointerInSurface(event);
        if (event.ctrlKey || event.metaKey) {
          // Wheel deltas arrive in pixels, lines or pages depending on the
          // device, so they are normalised before they reach the zoom curve.
          const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
          const delta = (event.deltaY || 0) * unit;
          // The zoom itself is clamped by `canvasZoomAt`, so the curve only has
          // to be smooth: one event moves the zoom by a few percent, and a
          // trackpad pinch stays under the pointer because every event is
          // anchored where the pointer is.
          // About 13% per wheel notch — the pace Figma uses. A trackpad pinch
          // sends many small deltas, so the same curve feels smooth there.
          const factor = Math.exp(-delta * 0.0012);
          const next = canvasZoomAt(current.camera, point, current.camera.zoom * factor);
          applyDoc((draft) => ({ ...draft, camera: next }));
        } else {
          applyDoc((draft) => ({
            ...draft,
            camera: { ...draft.camera, x: draft.camera.x - (event.deltaX || 0), y: draft.camera.y - (event.deltaY || 0) },
          }));
        }
      }, [applyDoc, pointerInSurface]);

      // Keep the native listener pointed at the newest handler without
      // re-registering it on every render.
      const wheelHandlerRef = useRef(null);
      useEffect(() => {
        wheelHandlerRef.current = onSurfaceWheel;
      }, [onSurfaceWheel]);

      /** The element the native wheel listener is attached to. */
      const wheelElementRef = useRef(null);

      // A callback ref, so the listener is bound the moment the surface exists
      // and unbound when it goes away.
      const attachSurface = useCallback((element) => {
        const previous = wheelElementRef.current;
        if (previous) {
          previous.removeEventListener('wheel', previous.__mmWheel);
          wheelElementRef.current = null;
        }
        surfaceRef.current = element;
        if (!element) return;
        const listener = (event) => {
          event.__mmWheelHandled = true;
          event.preventDefault();
          wheelHandlerRef.current?.(event);
        };
        element.__mmWheel = listener;
        element.addEventListener('wheel', listener, { passive: false });
        wheelElementRef.current = element;
      }, []);

      const zoomBy = useCallback((factor) => {
        const current = docRef.current;
        if (!current) return;
        const point = { x: viewport.width / 2, y: viewport.height / 2 };
        applyDoc((draft) => ({ ...draft, camera: canvasZoomAt(draft.camera, point, draft.camera.zoom * factor) }));
      }, [applyDoc, viewport]);

      const fitToContent = useCallback(() => {
        applyDoc((draft) => ({ ...draft, camera: canvasFitCamera(draft.nodes, viewport) }));
      }, [applyDoc, viewport]);

      const resetZoom = useCallback(() => {
        applyDoc((draft) => ({ ...draft, camera: { ...draft.camera, zoom: 1 } }));
      }, [applyDoc]);

      /** Delete the selection and every edge that touched it. */
      const deleteSelection = useCallback(() => {
        if (!selected.size) return;
        const ids = new Set(selected);
        applyDoc((current) => ({
          ...current,
          nodes: current.nodes.filter((node) => !ids.has(node.id)),
          edges: current.edges.filter((edge) => !ids.has(edge.from) && !ids.has(edge.to)),
        }), { history: true });
        setSelected(new Set());
        setEditingId(null);
      }, [applyDoc, selected]);

      const duplicateSelection = useCallback(() => {
        if (!selected.size || !docRef.current) return;
        const ids = new Set(selected);
        const copies = (docRef.current.nodes || [])
          .filter((node) => ids.has(node.id))
          .map((node) => ({ ...node, id: makeId(), x: node.x + 24, y: node.y + 24 }));
        const idMap = new Map(copies.map((node, index) => [node.id, node.id]));
        void idMap;
        const originals = (docRef.current.nodes || []).filter((node) => ids.has(node.id));
        const extraEdges = (docRef.current.edges || [])
          .filter((edge) => ids.has(edge.from) && ids.has(edge.to))
          .map((edge, index) => ({
            ...edge,
            id: makeId(),
            from: copies[index]?.id || edge.from,
            to: copies[index + 1]?.id || edge.to,
          }))
          .filter((edge) => copies.some((node) => node.id === edge.from) && copies.some((node) => node.id === edge.to));
        applyDoc((current) => ({
          ...current,
          nodes: [...current.nodes, ...copies],
          edges: [...current.edges, ...extraEdges],
        }), { history: true });
        setSelected(new Set(copies.map((node) => node.id)));
        void originals;
      }, [applyDoc, selected]);

      const nudgeSelection = useCallback((dx, dy) => {
        if (!selected.size) return;
        const ids = new Set(selected);
        applyDoc((current) => ({
          ...current,
          nodes: current.nodes.map((node) => (ids.has(node.id) ? { ...node, x: node.x + dx, y: node.y + dy } : node)),
        }), { history: true });
      }, [applyDoc, selected]);

      /**
       * Lay a set of notes out on the board.
       *
       * A note that is already on the board is moved instead of duplicated,
       * so the action can be repeated without piling up copies.
       */
      const pourNotes = useCallback((sourceId) => {
        const source = (pourSources || []).find((item) => item.id === sourceId);
        if (!source || !source.noteIds.length) {
          onNotice?.('There is nothing to lay out');
          return;
        }
        const current = docRef.current;
        if (!current) return;
        const visibleWorld = viewport.width / (current.camera.zoom || 1);
        const columns = Math.max(
          CANVAS_POUR_MIN_COLUMNS,
          Math.min(CANVAS_POUR_MAX_COLUMNS, Math.floor(visibleWorld / (CANVAS_NOTE_SIZE.w + CANVAS_POUR_GAP))),
        );
        const rows = Math.ceil(source.noteIds.length / columns);
        const gridWidth = columns * CANVAS_NOTE_SIZE.w + (columns - 1) * CANVAS_POUR_GAP;
        const gridHeight = rows * CANVAS_NOTE_SIZE.h + (rows - 1) * CANVAS_POUR_GAP;
        const center = canvasScreenToWorld({ x: viewport.width / 2, y: viewport.height / 2 }, current.camera);
        const startX = Math.round(center.x - gridWidth / 2);
        const startY = Math.round(center.y - gridHeight / 2);
        const existing = new Map(current.nodes.filter((node) => node.type === 'note' && node.noteId).map((node) => [node.noteId, node]));
        const next = [...current.nodes];
        source.noteIds.forEach((noteId, index) => {
          const x = startX + (index % columns) * (CANVAS_NOTE_SIZE.w + CANVAS_POUR_GAP);
          const y = startY + Math.floor(index / columns) * (CANVAS_NOTE_SIZE.h + CANVAS_POUR_GAP);
          const found = existing.get(noteId);
          if (found) {
            const at = next.findIndex((node) => node.id === found.id);
            if (at >= 0) next[at] = { ...found, x, y, w: CANVAS_NOTE_SIZE.w, h: CANVAS_NOTE_SIZE.h };
            return;
          }
          next.push({
            id: makeId(),
            type: 'note',
            x,
            y,
            w: CANVAS_NOTE_SIZE.w,
            h: CANVAS_NOTE_SIZE.h,
            rotation: 0,
            text: '',
            noteId,
            noteUpdatedAt: null,
            color: 'none',
            locked: false,
            visible: true,
          });
        });
        applyDoc((draft) => ({ ...draft, nodes: canvasSyncGroups(next) }), { history: true });
        onNotice?.(`${source.noteIds.length} notes laid out`);
      }, [applyDoc, onNotice, pourSources, viewport]);

      /** Put the selected nodes into one group. */
      const groupSelection = useCallback(() => {
        const nodes = docRef.current?.nodes || [];
        const ids = new Set(selected);
        const parentOf = new Map();
        for (const node of nodes) {
          for (const memberId of node.members || []) parentOf.set(memberId, node.id);
        }
        // A node already inside another selected container must not be pulled
        // into the new one: that would make the tree a cycle.
        const underSelection = (nodeId) => {
          let cursor = parentOf.get(nodeId);
          let hops = 0;
          while (cursor && hops <= nodes.length) {
            if (ids.has(cursor)) return true;
            cursor = parentOf.get(cursor);
            hops += 1;
          }
          return false;
        };
        const members = nodes.filter((node) => ids.has(node.id) && !underSelection(node.id));
        if (!members.length) return;
        const group = {
          id: makeId(),
          type: 'group',
          x: 0,
          y: 0,
          w: 0,
          h: 0,
          rotation: 0,
          text: '',
          noteId: null,
          noteUpdatedAt: null,
          color: 'none',
          locked: false,
          visible: true,
          members: members.map((node) => node.id),
        };
        applyDoc((current) => ({ ...current, nodes: canvasSyncGroups([...current.nodes, group]) }), { history: true });
        setSelected(new Set([group.id]));
        onNotice?.('Grouped');
      }, [applyDoc, onNotice, selected]);

      /** Let the members of the selected groups go free. */
      const ungroupSelection = useCallback(() => {
        const ids = new Set(selected);
        const groups = (docRef.current?.nodes || []).filter((node) => ids.has(node.id) && canvasIsContainer(node));
        if (!groups.length) return;
        applyDoc((current) => ({
          ...current,
          nodes: current.nodes.filter((node) => !ids.has(node.id)),
        }), { history: true });
        setSelected(new Set());
        onNotice?.('Group released');
      }, [applyDoc, onNotice, selected]);

      /** Change the look of one connector. */
      const applyEdgeStyle = useCallback((patch) => {
        if (!selectedEdgeId) return;
        const id = selectedEdgeId;
        applyDoc((current) => ({
          ...current,
          edges: current.edges.map((edge) => (edge.id === id ? { ...edge, ...patch } : edge)),
        }), { history: true });
      }, [applyDoc, selectedEdgeId]);

      /** Delete the selected connector. */
      const deleteSelectedEdge = useCallback(() => {
        if (!selectedEdgeId) return;
        const id = selectedEdgeId;
        applyDoc((current) => ({
          ...current,
          edges: current.edges.filter((edge) => edge.id !== id),
        }), { history: true });
        setSelectedEdgeId(null);
      }, [applyDoc, selectedEdgeId]);

      /** Change the look of every selected node at once. */
      const applyStyle = useCallback((patch) => {
        if (!selected.size) return;
        const ids = new Set(selected);
        applyDoc((current) => ({
          ...current,
          nodes: current.nodes.map((node) => (ids.has(node.id) ? { ...node, ...patch } : node)),
        }), { history: true });
      }, [applyDoc, selected]);

      /** Switch the board to one of its two colour modes. */
      const applyTheme = useCallback((mode) => {
        const current = docRef.current;
        if (!current?.themes) return;
        const colors = { ...current.tokens.colors, ...(current.themes[mode]?.colors || {}) };
        const next = {
          ...current,
          theme: mode === 'dark' ? 'dark' : 'light',
          tokens: { ...current.tokens, colors },
        };
        docRef.current = next;
        setDoc(next);
        scheduleSaveRef.current?.();
      }, []);

      /** Build a light/dark pair from the colours the board has today. */
      const createThemes = useCallback(() => {
        const current = docRef.current;
        if (!current) return;
        const light = { ...current.tokens.colors };
        const dark = canvasDarkColors(light);
        const themes = { light: { colors: light }, dark: { colors: dark } };
        const next = {
          ...current,
          themes,
          theme: 'dark',
          tokens: { ...current.tokens, colors: { ...light, ...dark } },
        };
        docRef.current = next;
        setDoc(next);
        scheduleSaveRef.current?.();
        onNotice?.('Light and dark themes created');
      }, [onNotice]);

      /** Replace the board's token tables, keeping the other tables intact. */
      const updateTokens = useCallback((updater) => {
        const current = docRef.current;
        if (!current) return;
        const tokens = current.tokens || { colors: {}, gradients: {}, type: {} };
        const next = { ...current, tokens: updater(tokens) };
        docRef.current = next;
        setDoc(next);
        scheduleSaveRef.current?.();
      }, []);

      /**
       * Change a container's auto layout, then ask the Host to re-place the
       * members. The panel never computes the layout itself: the Host is the
       * only judge, and the canvas simply adopts its answer.
       */
      const applyLayoutNow = useCallback((patch) => {
        applyStyle(patch);
        void (async () => {
          try {
            const result = await api('canvas-arrange', {
              nodes: docRef.current?.nodes || [],
              containerId: [...selected][0] || null,
            });
            if (!Array.isArray(result?.nodes) || !docRef.current) return;
            const next = { ...docRef.current, nodes: result.nodes };
            docRef.current = next;
            setDoc(next);
          } catch {
            // The save path applies the same layout; a failed preview is not fatal.
          }
        })();
      }, [applyStyle, api, selected]);

      /** Line the selection up, or spread it out. */
      const alignSelection = useCallback((mode) => {
        const ids = [...selected];
        if (!ids.length) return;
        applyDoc((current) => {
          const moved = mode === 'distribute-x'
            ? canvasDistributeNodes(current.nodes, ids, 'x')
            : mode === 'distribute-y'
              ? canvasDistributeNodes(current.nodes, ids, 'y')
              : canvasAlignNodes(current.nodes, ids, mode);
          return { ...current, nodes: canvasSyncGroups(moved) };
        }, { history: true });
      }, [applyDoc, selected]);

      /** Wrap the selected nodes in a frame with a name. */
      const frameSelection = useCallback(() => {
        const ids = new Set(selected);
        const members = (docRef.current?.nodes || []).filter((node) => ids.has(node.id) && !canvasIsContainer(node));
        if (!members.length) return;
        const frame = {
          id: makeId(),
          type: 'frame',
          x: 0,
          y: 0,
          w: 0,
          h: 0,
          rotation: 0,
          text: '',
          noteId: null,
          noteUpdatedAt: null,
          color: 'none',
          locked: false,
          visible: true,
          title: 'Frame',
          members: members.map((node) => node.id),
        };
        applyDoc((current) => ({ ...current, nodes: canvasSyncGroups([...current.nodes, frame]) }), { history: true });
        setSelected(new Set([frame.id]));
        onNotice?.('Framed');
      }, [applyDoc, onNotice, selected]);

      /**
       * Put one picture on the board.
       *
       * The bytes go to the Host and the node only keeps the id, so a board
       * stays small enough to save whole on every change.
       */
      const addPicture = useCallback(async (file, point) => {
        if (!file) return;
        if (canvasIsFigmaFile(file)) {
          await importFigmaFile(file);
          return;
        }
        if (!CANVAS_IMAGE_TYPES.has(file.type)) {
          onError?.('Only PNG, JPEG, WebP, GIF and SVG files can be placed on the board');
          return;
        }
        if (file.size > CANVAS_IMAGE_MAX_BYTES) {
          onError?.('An image must be 10 MB or smaller');
          return;
        }
        const current = docRef.current;
        if (!current) return;
        try {
          const dataUrl = await canvasReadFile(file);
          const size = await canvasMeasureImage(dataUrl);
          const result = await api('canvas-asset-save', { dataUrl, name: file.name || '' });
          const asset = result?.asset;
          if (!asset?.assetId) throw new Error('The picture could not be stored');
          const center = point || canvasScreenToWorld({ x: viewport.width / 2, y: viewport.height / 2 }, current.camera);
          const node = {
            id: makeId(),
            type: 'image',
            x: Math.round(center.x - size.w / 2),
            y: Math.round(center.y - size.h / 2),
            w: size.w,
            h: size.h,
            rotation: 0,
            text: '',
            noteId: null,
            noteUpdatedAt: null,
            color: 'none',
            locked: false,
            visible: true,
            assetId: asset.assetId,
            kind: asset.type,
            name: file.name || '',
          };
          applyDoc((draft) => ({ ...draft, nodes: [...draft.nodes, node] }), { history: true });
          setSelected(new Set([node.id]));
          onNotice?.('Picture added');
        } catch (failure) {
          onError?.(failure.message || String(failure));
        }
      }, [applyDoc, onError, onNotice, viewport]);

      /**
       * Bring a Figma document onto the board.
       *
       * The Host parses it — the client cannot carry the binary readers — and
       * answers with the finished nodes plus a report of everything that was
       * skipped or downgraded, so nothing is lost quietly.
       */
      const importFigmaFile = useCallback(async (file) => {
        const current = docRef.current;
        if (!current) return;
        if (file.size > CANVAS_FIG_MAX_BYTES) {
          onError?.('A Figma file must be 50 MB or smaller');
          return;
        }
        try {
          onNotice?.('Reading the Figma file…');
          const dataUrl = await canvasReadFile(file);
          const comma = dataUrl.indexOf(',');
          const dataBase64 = comma >= 0 ? dataUrl.slice(comma + 1) : '';
          if (!dataBase64) throw new Error('The file could not be read');
          // The Host creates the board when the workspace has none, so a file
          // dropped on an empty profile still lands somewhere.
          const result = await api('canvas-import-fig', {
            id: activeId || undefined,
            title: String(file.name || '').replace(/\.(fig|jam|deck)$/i, '').slice(0, 120) || undefined,
            dataBase64,
          });
          const canvas = result?.canvas;
          if (!canvas) throw new Error('Nothing could be added from this file');
          // The Host already saved it; adopt the answer instead of writing it back.
          docRef.current = canvas;
          setDoc(canvas);
          // A file drop that created the board also owns its id: without it
          // the very next save would be rejected as "missing canvas id".
          if (canvas.id) setActiveId(canvas.id);
          setBoards((current) => (current.some((board) => board.id === canvas.id)
            ? current
            : [{ id: canvas.id, title: canvas.title || 'Imported board', nodeCount: canvas.nodes.length }, ...current]));
          // Frame the new content: a Figma board can be tens of thousands of
          // pixels wide, so the default camera would show nothing at all.
          applyDoc((draft) => ({ ...draft, camera: canvasFitCamera(canvas.nodes, viewport) }), { history: false });
          const importedIds = new Set(
            canvas.nodes
              .filter((node) => !current.nodes.some((existing) => existing.id === node.id))
              .map((node) => node.id),
          );
          setSelected(importedIds);
          setHistory([]);
          setFuture([]);
          const report = result.report || {};
          const counts = report.imported || {};
          const summary = ['frame', 'group', 'sticky', 'text', 'shape', 'image', 'vector', 'edge']
            .filter((kind) => counts[kind] > 0)
            .map((kind) => `${counts[kind]} ${kind}${counts[kind] === 1 ? '' : 's'}`)
            .join(', ');
          // A picture that only arrived as a thumbnail is still imported, but
          // the person should know why it looks soft.
          const thumbnails = counts.imageThumbnail > 0
            ? `${counts.imageThumbnail} of those pictures are thumbnails`
            : '';
          const skipped = Object.entries(report.skipped || {})
            .filter(([, value]) => value > 0)
            .map(([kind, value]) => `${value} ${kind}`)
            .join(', ');
          const parts = [summary ? `Imported ${summary}` : 'Imported the Figma file'];
          if (thumbnails) parts.push(thumbnails);
          if (skipped) parts.push(`${skipped} skipped`);
          if (Array.isArray(report.warnings) && report.warnings.length) {
            parts.push(report.warnings[0]);
          }
          onNotice?.(parts.join(' · '));
        } catch (failure) {
          onError?.(failure.message || String(failure));
        }
      }, [activeId, api, applyDoc, onError, onNotice, setDoc, setFuture, setHistory, setSelected, viewport]);

      /** Place every file the person handed over, one after another. */
      const addPictures = useCallback(async (files, point) => {
        for (const file of files || []) {
          await addPicture(file, point);
        }
      }, [addPicture]);

      /** A paste of a screenshot or a copied image file lands on the board. */
      /**
       * Right click opens the same menu Figma puts on a node.
       *
       * Right clicking an unselected node selects it first, so the commands in
       * the menu always act on what the person pointed at.
       */
      const onSurfaceContextMenu = useCallback((event) => {
        event.preventDefault?.();
        const target = event?.target;
        const nodeId = typeof target?.closest === 'function'
          ? target.closest('[data-node-id]')?.getAttribute?.('data-node-id') || null
          : null;
        if (nodeId && !selected.has(nodeId)) selectNodes([nodeId]);
        const point = pointerInSurface(event);
        setCanvasMenu({ x: point.x, y: point.y, nodeId });
      }, [pointerInSurface, selectNodes, selected]);

      const onSurfacePaste = useCallback((event) => {
        const items = event?.clipboardData?.items || [];
        const files = [];
        for (const item of items) {
          if (item.kind === 'file') {
            const file = item.getAsFile();
            if (file) files.push(file);
          }
        }
        if (!files.length) return;
        event.preventDefault?.();
        void addPictures(files);
      }, [addPictures]);

      /** A drop of picture files lands where the pointer is. */
      const onSurfaceDrop = useCallback((event) => {
        event.preventDefault?.();
        const files = Array.from(event?.dataTransfer?.files || []);
        if (!files.length) return;
        const point = canvasScreenToWorld(pointerInSurface(event), docRef.current?.camera || { x: 0, y: 0, zoom: 1 });
        void addPictures(files, point);
      }, [addPictures, pointerInSurface]);

      const onSurfaceDragOver = useCallback((event) => {
        event.preventDefault?.();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      }, []);

      /** Star or unstar a board; a metadata write, not a document edit. */
      const toggleStarBoard = useCallback(async (board) => {
        try {
          await api('canvas-star', { id: board.id, starred: !board.starred });
          await loadBoards();
        } catch (failure) {
          onError(failure.message || String(failure));
        }
      }, [loadBoards, onError]);

      /** Write the frame title back into the document. */
      const commitFrameTitle = useCallback(() => {
        const current = docRef.current;
        const frame = current?.nodes?.find((item) => item.id === editingFrameId);
        setEditingFrameId(null);
        if (!frame) return;
        const title = frameDraft.trim().slice(0, 120);
        if ((frame.title || '') === title) return;
        applyDoc((draft) => ({
          ...draft,
          nodes: draft.nodes.map((item) => (item.id === frame.id ? { ...item, title } : item)),
        }), { history: true });
      }, [applyDoc, editingFrameId, frameDraft]);

      /** Fold or unfold a container's subtree in the layers list. */
      const toggleCollapsed = useCallback((nodeId) => {
        setCollapsed((current) => {
          const next = new Set(current);
          if (next.has(nodeId)) next.delete(nodeId);
          else next.add(nodeId);
          if (activeId) writeStoredValue(`${CANVAS_LAYERS_COLLAPSED_KEY}:${activeId}`, [...next]);
          return next;
        });
      }, [activeId]);

      /** Show or hide one node. */
      const toggleVisibility = useCallback((nodeId) => {
        applyDoc((current) => ({
          ...current,
          nodes: current.nodes.map((node) => (node.id === nodeId
            ? { ...node, visible: node.visible === false }
            : node)),
        }), { history: true });
      }, [applyDoc]);

      /** Move one node to the top or to the bottom of the stack. */
      /** Lock or unlock one node; a locked node is still selectable, only immovable. */
      const toggleLock = useCallback((nodeId) => {
        applyDoc((current) => ({
          ...current,
          nodes: current.nodes.map((node) => (node.id === nodeId
            ? { ...node, locked: node.locked !== true }
            : node)),
        }), { history: true });
      }, [applyDoc]);

      const reorderNode = useCallback((nodeId, where) => {
        applyDoc((current) => {
          const index = current.nodes.findIndex((node) => node.id === nodeId);
          if (index < 0) return current;
          const node = current.nodes[index];
          const rest = current.nodes.filter((item) => item.id !== nodeId);
          const next = where === 'front' ? [...rest, node] : [node, ...rest];
          return { ...current, nodes: next };
        }, { history: true });
      }, [applyDoc]);

      /** Write the board to a file. */
      const exportBoard = useCallback(async (format) => {
        const current = docRef.current;
        if (!current || !current.nodes.length) {
          onNotice?.('There is nothing to export');
          return;
        }
        const title = (current.title || 'Board').replace(/[^\w一-龥-]+/g, '-');
        const svg = await canvasSceneSvg(current.nodes, current.edges, {
          background: canvasReadToken(stageRef.current, '--mm-export-background'),
          ink: canvasReadToken(stageRef.current, '--mm-export-ink'),
          line: canvasReadToken(stageRef.current, '--mm-export-line'),
          sticky: canvasReadToken(stageRef.current, '--mm-note-fill'),
        });
        if (format === 'svg') {
          canvasDownload(`${title}.svg`, svg, 'image/svg+xml');
          onNotice?.('SVG exported');
          return;
        }
        try {
          const blob = await canvasExportPng(svg, 2);
          canvasDownload(`${title}.png`, blob, 'image/png');
          onNotice?.('PNG exported');
        } catch (failure) {
          onError(failure.message || String(failure));
        }
      }, [onError, onNotice]);

      /** Read the last Figma import report for this board. */
      const openImportReport = useCallback(async () => {
        if (!activeId) return;
        try {
          const result = await api('canvas-import-report', { id: activeId });
          setImportReport(result?.report ?? null);
          setImportReportOpen(true);
        } catch (failure) {
          onError?.(failure.message || String(failure));
        }
      }, [activeId, api, onError]);

      /**
       * Download one handoff format.
       *
       * HTML+CSS and the spec JSON are built on the Host from the saved
       * document, so the file always matches what a tool would read back.
       */
      const exportHandoff = useCallback(async (format) => {
        const current = docRef.current;
        if (!current || !current.nodes.length) {
          onNotice?.('There is nothing to export');
          return;
        }
        try {
          const result = await api('canvas-export', { id: activeId, format });
          if (!result?.text) throw new Error('The exporter returned nothing');
          const name = result.filename || `design.${format === 'spec' ? 'spec.json' : format}`;
          const type = result.mime || 'text/plain;charset=utf-8';
          canvasDownload(name, result.text, type);
          onNotice?.(`${format === 'spec' ? 'Spec' : format.toUpperCase()} exported`);
        } catch (failure) {
          onError(failure.message || String(failure));
        }
      }, [activeId, onError, onNotice]);

      /**
       * Park an AI request on the board.
       *
       * The plugin cannot start an agent turn on its own, so the request is
       * written where a person and the agent both look — a board note — and
       * copied so it can be pasted straight into the conversation.
       */
      const submitDesignRequest = useCallback(() => {
        const prompt = aiPrompt.trim();
        const current = docRef.current;
        if (!prompt || !current) return;
        const center = canvasScreenToWorld(
          { x: (viewport.width || 800) / 2, y: (viewport.height || 600) / 2 },
          current.camera,
        );
        const node = {
          id: makeId(),
          type: 'text',
          x: Math.round(center.x - 200),
          y: Math.round(center.y - 40),
          w: 400,
          h: 96,
          rotation: 0,
          text: prompt,
          fontSize: 18,
          lineHeight: 1.4,
          noteId: null,
          noteUpdatedAt: null,
          color: 'none',
          locked: false,
          visible: true,
          shape: 'rect',
          fill: null,
          stroke: null,
          strokeWidth: 0,
          opacity: 1,
          radius: 0,
          textAlign: 'left',
          members: [],
          title: 'AI request',
          sides: 5,
          points: 5,
          flipX: false,
          flipY: false,
          assetId: null,
          textColor: null,
        };
        applyDoc((draft) => ({ ...draft, nodes: [...draft.nodes, node] }), { history: true });
        setSelected(new Set([node.id]));
        setAiPrompt('');
        setAiOpen(false);
        globalThis.navigator?.clipboard?.writeText?.(prompt)?.catch?.(() => {});
        onNotice?.('Request placed on the board and copied — paste it in the chat to run it');
      }, [aiPrompt, applyDoc, onNotice, viewport]);

      /** Ask the Host for the stored versions of this board. */
      const openVersionHistory = useCallback(async () => {
        try {
          const result = await api('canvas-history', { id: activeId });
          setVersions(Array.isArray(result?.versions) ? result.versions : []);
          setVersionsOpen(true);
        } catch (failure) {
          onError(failure.message || String(failure));
        }
      }, [activeId, api, onError]);

      /** Put one version back, then reload the board from the Host. */
      const restoreVersion = useCallback(async (versionId) => {
        try {
          await api('canvas-restore', { id: activeId, versionId });
          setVersionsOpen(false);
          await loadCanvas(activeId);
          onNotice?.('Version restored');
        } catch (failure) {
          onError(failure.message || String(failure));
        }
      }, [activeId, api, loadCanvas, onError, onNotice]);

      /** Start editing the label of one edge. */
      const startEditingEdge = useCallback((edge) => {
        setEditingEdgeId(edge.id);
        setEdgeDraft(String(edge.label || ''));
      }, []);

      const commitEdgeLabel = useCallback(() => {
        const current = docRef.current;
        const edge = current?.edges?.find((item) => item.id === editingEdgeId);
        setEditingEdgeId(null);
        if (!edge) return;
        const label = edgeDraft.slice(0, 200);
        if ((edge.label || '') === label) return;
        applyDoc((draft) => ({
          ...draft,
          edges: draft.edges.map((item) => (item.id === edge.id ? { ...item, label } : item)),
        }), { history: true });
      }, [applyDoc, edgeDraft, editingEdgeId]);

      /**
       * The layer tree the sidebar shows.
       *
       * The panel owns the scene, so it owns the tree: the sidebar only
       * draws what it is handed.
       */
      const layerTree = useMemo(() => {
        const list = doc?.nodes || [];
        const groups = list.filter((node) => canvasIsContainer(node));
        const memberOf = new Map();
        for (const group of groups) {
          for (const id of group.members || []) memberOf.set(id, group.id);
        }
        const counters = {};
        const describe = (node) => {
          counters[node.type] = (counters[node.type] || 0) + 1;
          const note = node.type === 'note' ? noteMap.get(node.noteId) : null;
          const text = node.type === 'note' ? String(note?.content || '') : String(node.text || '');
          return {
            id: node.id,
            type: node.type,
            shape: node.shape || null,
            name: canvasNodeName(node, counters[node.type] - 1, text),
            hidden: node.visible === false,
            selected: selected.has(node.id),
            members: (node.members || []).length,
            collapsible: canvasIsContainer(node) && (node.members || []).length > 0,
            collapsed: collapsed.has(node.id),
          };
        };
        const described = new Map(list.map((node) => [node.id, describe(node)]));
        // Ids of the children of every container, then one recursive pass so a
        // container nested inside another keeps its own subtree.
        const childIds = new Map(groups.map((group) => [group.id, []]));
        const roots = [];
        for (const node of [...list].reverse()) {
          const parent = memberOf.get(node.id);
          if (parent && childIds.has(parent)) childIds.get(parent).push(node.id);
          else roots.push(node.id);
        }
        const build = (id) => {
          const entry = described.get(id);
          if (!entry) return null;
          const kids = (childIds.get(id) || []).map(build).filter(Boolean);
          return kids.length ? { ...entry, children: kids } : entry;
        };
        return roots.map(build).filter(Boolean);
      }, [doc, noteMap, selected, collapsed]);

      useEffect(() => {
        onStateChange?.(layerTree);
      }, [layerTree, onStateChange]);

      useEffect(() => {
        onApiReady?.({
          selectNode: (nodeId) => selectNodes([nodeId], false),
          toggleCollapsed,
          toggleVisibility,
          bringToFront: (nodeId) => reorderNode(nodeId, 'front'),
          sendToBack: (nodeId) => reorderNode(nodeId, 'back'),
        });
      }, [onApiReady, reorderNode, selectNodes, toggleVisibility]);

      const startEditing = useCallback((node) => {
        if (node.locked) return;
        // A vector path has no text to edit: a second tap is the request to
        // shape its points.
        if (node.type === 'shape' && node.shape === 'path' && node.path) {
          setEditingId(null);
          setPointEditId(node.id);
          return;
        }
        // Re-entering would throw away what has been typed.
        if (editingIdRef.current === node.id) return;
        const note = node.type === 'note' ? noteMap.get(node.noteId) : null;
        setEditingId(node.id);
        setEditDraft(node.type === 'note' ? String(note?.content || '') : String(node.text || ''));
      }, [noteMap]);

      useEffect(() => {
        editingIdRef.current = editingId;
      }, [editingId]);

      /**
       * Whether this pointer down is the second half of a double click.
       *
       * The canvas captures the pointer on pointer down so a drag keeps working
       * outside the surface — and that capture retargets the follow-up `click`
       * and `dblclick` to the surface, so a handler on the node never fires.
       * Double clicks are therefore recognised here, from the taps themselves.
       * @param {string} nodeId - the node being pressed.
       * @param {object} [event] - the pointer event, for the modifier keys.
       * @returns {boolean} whether it is a double click.
       */
      const isDoubleTap = useCallback((nodeId, event) => {
        // A modified press is a selection gesture, never an edit.
        if (event?.shiftKey || event?.metaKey || event?.ctrlKey) {
          lastTapRef.current = null;
          return false;
        }
        // The clock is the one the events were stamped with, not the one after
        // the handler ran: a heavy board can spend longer than a double click
        // rendering, and a tap is dated when it happened, not when it landed.
        const now = typeof event?.timeStamp === 'number' && event.timeStamp > 0
          ? event.timeStamp
          : Date.now();
        const last = lastTapRef.current;
        lastTapRef.current = { id: nodeId, at: now };
        // Generous, because the second tap is dated when the browser gets to
        // it: a busy board can delay it well past the platform's own double
        // click time. Same node, no modifiers, and the first tap must not have
        // dragged, so a slow double click is still the only way in.
        return Boolean(last && last.id === nodeId && now - last.at < 1200);
      }, []);

      // The release decides: a second tap that turns into a drag is a drag.
      useEffect(() => {
        startEditingRef.current = startEditing;
      }, [startEditing]);

      const commitEditing = useCallback(async () => {
        const current = docRef.current;
        const node = current?.nodes?.find((item) => item.id === editingId);
        if (!node) { setEditingId(null); return; }
        const text = editDraft.slice(0, CANVAS_TEXT_LIMIT);
        setEditingId(null);
        if (node.type === 'note') {
          const note = noteMap.get(node.noteId);
          if (!note || note.content === text) return;
          try {
            await api('update', { id: node.noteId, content: text });
            applyDoc((draft) => ({
              ...draft,
              nodes: draft.nodes.map((item) => (item.id === node.id ? { ...item, noteUpdatedAt: Date.now() } : item)),
            }));
            await onNoteUpdated?.();
            onNotice?.('Note updated');
          } catch (failure) {
            onError(failure.message || String(failure));
          }
          return;
        }
        if ((node.text || '') === text) return;
        applyDoc((draft) => ({
          ...draft,
          // Typing replaces the styled runs: the editor writes plain text, so
          // keeping the old runs would paint styles over the new characters.
          nodes: draft.nodes.map((item) => (item.id === node.id ? { ...item, text, spans: null } : item)),
        }), { history: true });
      }, [applyDoc, editDraft, editingId, noteMap, onError, onNotice, onNoteUpdated]);

      /** The board picker and the tools that shape the board live here. */
      const createBoard = useCallback(async () => {
        try {
          const result = await api('canvas-create', { title: 'Board' });
          const canvas = result?.canvas;
          if (!canvas) return;
          await loadBoards();
          await loadCanvas(canvas.id);
          onNotice?.('Board created');
        } catch (failure) {
          onError(failure.message || String(failure));
        }
      }, [loadBoards, loadCanvas, onError, onNotice]);

      const switchBoard = useCallback(async (canvasId) => {
        if (!canvasId || canvasId === activeId) return;
        try {
          await loadCanvas(canvasId);
        } catch (failure) {
          onError(failure.message || String(failure));
        }
      }, [activeId, loadCanvas, onError]);

      const renameBoard = useCallback(async (title) => {
        const clean = String(title || '').trim().slice(0, 120);
        if (!clean || !activeId) return;
        applyDoc((current) => ({ ...current, title: clean }), { history: false });
        try {
          await saveNow();
          await loadBoards();
        } catch (failure) {
          onError(failure.message || String(failure));
        }
      }, [activeId, applyDoc, loadBoards, onError, saveNow]);

      const deleteBoard = useCallback(async () => {
        if (!activeId) return;
        try {
          await api('canvas-delete', { id: activeId });
          writeStoredValue(CANVAS_ACTIVE_KEY, '');
          const list = await loadBoards();
          setActiveId('');
          docRef.current = null;
          setDoc(null);
          setSelected(new Set());
          if (list[0]) await loadCanvas(list[0].id);
          onNotice?.('Board deleted');
        } catch (failure) {
          onError(failure.message || String(failure));
        }
      }, [activeId, loadBoards, loadCanvas, onError, onNotice]);

      /** Notes the person sent to the board while the timeline was open. */
      useEffect(() => {
        const pending = (pendingNoteIds || []).filter((id) => !consumedRef.current.has(id));
        if (!pending.length || !doc) return;
        const center = canvasScreenToWorld({ x: viewport.width / 2, y: viewport.height / 2 }, doc.camera);
        const created = pending.map((noteId, index) => {
          consumedRef.current.add(noteId);
          return {
            id: makeId(),
            type: 'note',
            x: Math.round(center.x - CANVAS_NOTE_SIZE.w / 2 + index * 24),
            y: Math.round(center.y - CANVAS_NOTE_SIZE.h / 2 + index * 24),
            w: CANVAS_NOTE_SIZE.w,
            h: CANVAS_NOTE_SIZE.h,
            rotation: 0,
            text: '',
            noteId,
            noteUpdatedAt: null,
            color: 'none',
            locked: false,
            visible: true,
          };
        });
        applyDoc((current) => ({ ...current, nodes: [...current.nodes, ...created] }), { history: true });
        setSelected(new Set(created.map((node) => node.id)));
        onPendingConsumed?.(pending);
      }, [applyDoc, doc, onPendingConsumed, pendingNoteIds, viewport]);

      const onSurfaceKeyDown = useCallback((event) => {
        const key = event.key;
        const command = event.metaKey || event.ctrlKey;
        // The board takes a paste from the clipboard itself: a screenshot
        // copied anywhere becomes a node where the person is looking.
        if (command && key.toLocaleLowerCase() === 'v') {
          const items = globalThis.navigator?.clipboard?.items;
          if (items && typeof items.then === 'function') {
            event.preventDefault?.();
            items.then((list) => {
              const files = [];
              for (const item of list ?? []) {
                if (String(item.type || '').startsWith('image/')) {
                  const file = item.getAsFile?.();
                  if (file) files.push(file);
                }
              }
              if (files.length) void addPictures(files);
            }).catch(() => {});
            return;
          }
        }
        const target = event.target;
        const editing = target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable);
        if (editing) return;
        // A pen draft owns Enter and Escape before any other shortcut.
        if (pathDraft) {
          if (key === 'Escape') {
            event.preventDefault?.();
            setPathDraft(null);
            return;
          }
          if (key === 'Enter') {
            event.preventDefault?.();
            commitPathDraft(pathDraft.points, false);
            return;
          }
        }
        if (!command && key.length === 1) {
          const shortcut = key.toLocaleLowerCase();
          const tool = CANVAS_TOOLS.find((item) => item.hint.toLocaleLowerCase() === shortcut);
          if (tool) {
            event.preventDefault?.();
            // Leaving the pen commits what is drawn; a one-point sketch is
            // discarded rather than becoming an invisible node.
            if (pathDraft && tool.id !== 'path') commitPathDraft(pathDraft.points, false);
            else if (pathDraft && tool.id === 'path') setPathDraft(null);
            setTool(tool.id);
            return;
          }
        }
        if (command && key.toLocaleLowerCase() === 'z') {
          event.preventDefault?.();
          if (event.shiftKey) redo(); else undo();
          return;
        }
        if (command && key.toLocaleLowerCase() === 'a') {
          event.preventDefault?.();
          selectNodes((docRef.current?.nodes || []).map((node) => node.id), false);
          return;
        }
        if (command && key.toLocaleLowerCase() === 'd') {
          event.preventDefault?.();
          duplicateSelection();
          return;
        }
        if (command && key === '0') {
          event.preventDefault?.();
          fitToContent();
          return;
        }
        if (command && key === '1') {
          event.preventDefault?.();
          resetZoom();
          return;
        }
        if (key === 'Delete' || key === 'Backspace') {
          event.preventDefault?.();
          deleteSelection();
          return;
        }
        if (key === 'Escape' && pointEditId) {
          event.preventDefault?.();
          setPointEditId(null);
          return;
        }
        if (key === 'Escape') {
          setSelected(new Set());
          setEditingId(null);
          setConnectFrom(null);
          setConnectPreview(null);
          setMagnet(null);
          setTool('select');
          return;
        }
        const step = event.shiftKey ? 8 : 1;
        if (key === 'ArrowLeft') { event.preventDefault?.(); nudgeSelection(-step, 0); }
        else if (key === 'ArrowRight') { event.preventDefault?.(); nudgeSelection(step, 0); }
        else if (key === 'ArrowUp') { event.preventDefault?.(); nudgeSelection(0, -step); }
        else if (key === 'ArrowDown') { event.preventDefault?.(); nudgeSelection(0, step); }
      }, [addPictures, commitPathDraft, deleteSelection, duplicateSelection, fitToContent, nudgeSelection, pathDraft, pointEditId, redo, resetZoom, selectNodes, undo]);

      useEffect(() => {
        if (tool === 'connector') return;
        setConnectFrom(null);
        setConnectPreview(null);
      }, [tool]);

      // Point editing belongs to one path and one moment: leaving the path, or
      // switching tools, must give the anchors back to the shape's own drag.
      useEffect(() => {
        if (!pointEditId) return;
        if (tool !== 'select' || !selected.has(pointEditId)) setPointEditId(null);
      }, [pointEditId, selected, tool]);

      const onNodeKeyDown = useCallback((event, node) => {
        // The editor that lives inside the node sends its own keys; they
        // bubble here and must not be taken for shortcuts on the node.
        const target = event.target;
        if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable)) return;
        if (event.key === 'Enter') {
          event.preventDefault?.();
          startEditing(node);
          return;
        }
        if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault?.();
          selectNodes([node.id], false);
          deleteSelection();
        }
      }, [deleteSelection, selectNodes, startEditing]);

      const selectedNodes = useMemo(
        () => (doc?.nodes || []).filter((node) => selected.has(node.id)),
        [doc, selected],
      );
      const selectionFrame = useMemo(() => {
        const bounds = canvasBoundsOf(selectedNodes);
        if (!bounds) return null;
        const topLeft = canvasWorldToScreen({ x: bounds.x, y: bounds.y }, camera);
        const bottomRight = canvasWorldToScreen({ x: bounds.x + bounds.w, y: bounds.y + bounds.h }, camera);
        return {
          left: topLeft.x,
          top: topLeft.y,
          width: bottomRight.x - topLeft.x,
          height: bottomRight.y - topLeft.y,
        };
      }, [camera, selectedNodes]);

      const edges = doc?.edges || [];
      const nodes = doc?.nodes || [];

      /** One band of a container's layout grid, in the container box. */
    function canvasGridBand(node, index) {
      const grid = node.grid || {};
      const count = grid.count || 12;
      const gutter = grid.gutter || 0;
      const margin = grid.margin || 0;
      if (grid.kind === 'rows') {
        const usable = Math.max(0, node.h - margin * 2 - gutter * (count - 1));
        const size = usable / count;
        return {
          top: `${margin + index * (size + gutter)}px`,
          height: `${size}px`,
          left: '0px',
          width: '100%',
        };
      }
      const usable = Math.max(0, node.w - margin * 2 - gutter * (count - 1));
      const size = usable / count;
      return {
        left: `${margin + index * (size + gutter)}px`,
        width: `${size}px`,
        top: '0px',
        height: '100%',
      };
    }

    /** The size of a resize handle on screen, in pixels. */
    const HANDLE_SIZE = 8;
    /** The widest a handle's hit area may reach. */
    const HANDLE_HIT_MAX = 9;
    /** The narrowest a handle's hit area may be. */
    const HANDLE_HIT_MIN = 1;

    /**
     * Which corner of the selection a press meant, in screen pixels.
     *
     * Four 8px handles sit on a box that can be 25px wide at 37% zoom: their
     * hit halos overlap and the DOM hands the press to whichever element is
     * painted last, which is how dragging the left corner once grew a box to
     * the right. Distance decides instead.
     */
    /** Whether four handle halos share pixels on this selection. */
    function canvasHandleHalosOverlap(frame, hit) {
      if (!frame) return false;
      const shortest = Math.min(frame.width, frame.height);
      return HANDLE_SIZE + hit * 2 > shortest / 2;
    }

    function canvasNearestHandle(event, frame, stage) {
      if (!frame) return null;
      // A test renderer has no stage offset; page and selection then share one
      // coordinate space, which is what subtracting zero does.
      const rect = stage?.getBoundingClientRect?.() || { left: 0, top: 0 };
      const x = (event.clientX || 0) - rect.left - frame.left;
      const y = (event.clientY || 0) - (rect.top || 0) - frame.top;
      const corners = [
        { id: 'nw', x: 0, y: 0 },
        { id: 'ne', x: frame.width, y: 0 },
        { id: 'sw', x: 0, y: frame.height },
        { id: 'se', x: frame.width, y: frame.height },
      ];
      return corners
        .map((corner) => ({ id: corner.id, distance: Math.hypot(corner.x - x, corner.y - y) }))
        .sort((left, right) => left.distance - right.distance)[0].id;
    }

    /**
     * How far a resize handle's hit area may reach.
     *
     * Four handles sit on a box that can be 25 screen pixels wide at 37% zoom.
     * A fixed 9px halo makes all four zones overlap, and then the last one in
     * the DOM wins every press: dragging the left corner grew the box to the
     * right. The halo shrinks with the box so a corner is always the corner
     * nearest the pointer.
     */
    function canvasHandleHitRadius(width, height) {
      const shortest = Math.min(Number(width) || 0, Number(height) || 0);
      if (!Number.isFinite(shortest) || shortest <= HANDLE_SIZE) return HANDLE_HIT_MIN;
      const room = (shortest / 2 - HANDLE_SIZE / 2) / 2;
      return Math.max(HANDLE_HIT_MIN, Math.min(HANDLE_HIT_MAX, room));
    }

    /** The typography of one node, applied to the text itself. */
      const textStyle = (node) => {
        const style = {};
        if (node.fontSize) style.fontSize = `${node.fontSize}px`;
        if (node.textColor) style.color = node.textColor;
        else {
          const ink = canvasInkOnFill(fillBehind.get(node.id) || node.fill);
          if (ink) style.color = ink;
        }
        if (node.fontFamily && CANVAS_FONT_STACKS[node.fontFamily]) {
          style.fontFamily = canvasFontStackFor(canvasNodeTextOf(node), CANVAS_FONT_STACKS[node.fontFamily]);
        }
        if (node.fontWeight) style.fontWeight = String(node.fontWeight);
        // 1.25 is the same default the SVG and HTML exporters use, so the
        // canvas and the handoff file break their lines at the same place.
        style.lineHeight = String(node.lineHeight || 1.25);
        if (node.letterSpacing !== undefined && node.letterSpacing !== null) style.letterSpacing = `${node.letterSpacing}px`;
        return style;
      };

      /** The styling of one rich-text run, layered over the node's own. */
      const spanStyle = (span) => {
        const style = {};
        if (span.fontWeight) style.fontWeight = String(span.fontWeight);
        if (span.textColor) style.color = span.textColor;
        if (span.italic) style.fontStyle = 'italic';
        if (span.underline) style.textDecoration = 'underline';
        return style;
      };

      const nodeBody = (node) => {
        // An instance is a handle, not a box of its own: the expansion beside
        // it carries the pixels, so the marker only says what it points at.
        if (node.type === 'instance') {
          return h('span', { className: 'mm-canvas-instance-label' }, 'Instance');
        }
        if (node.type === 'note') {
          const note = noteMap.get(node.noteId);
          if (!note) return h('span', { className: 'mm-canvas-node-empty' }, 'Note unavailable');
          if (note.deletedAt) return h('span', { className: 'mm-canvas-node-empty' }, 'This note is in the trash');
          return h('span', { className: 'mm-canvas-node-text', style: textStyle(node) }, note.content || 'Empty note');
        }
        if (node.type === 'text') {
          const runs = Array.isArray(node.spans) && node.spans.length
            ? node.spans.map((span, index) => h('span', { key: `run-${index}`, style: spanStyle(span) }, span.text))
            : (node.text || 'Text');
          return h('span', { className: 'mm-canvas-node-text', style: textStyle(node) }, runs);
        }
        if (node.type === 'image') {
          if (!node.assetId) return h('span', { className: 'mm-canvas-node-empty' }, 'Picture missing');
          return h('img', {
            className: 'mm-canvas-image',
            src: canvasAssetUrl(node.assetId, node.kind),
            alt: node.name || 'Picture on the board',
            draggable: false,
            // A board is a transform-heavy page, so a lazy image may never be
            // considered close enough to the viewport to load at all.
            loading: 'eager',
            decoding: 'async',
          });
        }
        if (node.type === 'shape') {
          return h(React.Fragment, null,
            h('svg', {
              className: 'mm-canvas-shape',
              viewBox: `0 0 ${Math.max(1, node.w)} ${Math.max(1, node.h)}`,
              preserveAspectRatio: 'none',
              'aria-hidden': true,
            }, node.gradient
              ? [h('defs', { key: 'gradient' }, canvasGradientStops(node)), canvasShapeSvg(node)]
              : canvasShapeSvg(node)),
            node.text ? h('span', { className: 'mm-canvas-shape-label', style: textStyle(node) }, node.text) : null);
        }
        return h('span', { className: 'mm-canvas-node-text', style: textStyle(node) }, node.text || 'Sticky note');
      };

      const groups = useMemo(() => (doc?.nodes || []).filter((node) => canvasIsContainer(node)), [doc]);
      const styleTarget = useMemo(
        () => (doc?.nodes || []).find((node) => selected.has(node.id)) || null,
        [doc, selected],
      );
      /** Turn a straight path into a curve (or back) by giving every anchor handles. */
      const togglePathCurve = (node) => {
        const hasHandles = node.path.points.some((point) => point.in || point.out);
        applyDoc((current) => ({
          ...current,
          nodes: current.nodes.map((item) => (item.id === node.id
            ? {
              ...item,
              path: {
                ...item.path,
                points: item.path.points.map((point) => (hasHandles
                  ? { ...point, in: null, out: null }
                  : { ...point, in: { x: -40, y: 0 }, out: { x: 40, y: 0 } })),
              },
            }
            : item)),
        }), { history: true });
      };

      // The board's design tokens, offered as chips when a node is selected.
      const tokenColors = doc?.tokens?.colors || {};
      const tokenTypes = doc?.tokens?.type || {};
      const tokenStops = doc?.tokens?.gradients || {};
      const parentOfSelected = useMemo(() => {
        if (!styleTarget) return null;
        for (const node of doc?.nodes || []) {
          if (node.id === styleTarget.id) continue;
          if (Array.isArray(node.members) && node.members.includes(styleTarget.id)) return node.id;
        }
        return null;
      }, [doc, styleTarget]);

      // A lone selected vector path can be hand-edited, but only once the
      // person asks for it.
      const selectedPathNode = useMemo(() => {
        if (selected.size !== 1) return null;
        const [onlyId] = selected;
        const node = (doc?.nodes || []).find((item) => item.id === onlyId);
        return node && node.type === 'shape' && node.shape === 'path' && node.path ? node : null;
      }, [doc, selected]);
      // What each node is drawn on: its own fill, or the first filled frame or
      // group above it. A text node on a white frame has no fill of its own, and
      // in the dark theme its inherited ink would vanish into that frame.
      const fillBehind = useMemo(() => {
        const nodes = doc?.nodes || [];
        const byId = new Map(nodes.map((node) => [node.id, node]));
        const parent = new Map();
        for (const node of nodes) {
          if (!canvasIsContainer(node)) continue;
          for (const member of node.members || []) parent.set(member, node.id);
        }
        // An imported file does not always keep its text inside the frame it
        // was drawn on: fall back to the innermost filled container whose box
        // covers the node.
        const covering = nodes
          .filter((node) => canvasIsContainer(node) && node.fill)
          .sort((left, right) => left.w * left.h - right.w * right.h);
        const resolved = new Map();
        for (const node of nodes) {
          let fill = node.fill || null;
          let cursor = byId.get(parent.get(node.id));
          const seen = new Set([node.id]);
          while (!fill && cursor && !seen.has(cursor.id)) {
            seen.add(cursor.id);
            fill = cursor.fill || null;
            cursor = byId.get(parent.get(cursor.id));
          }
          if (!fill) {
            const centerX = node.x + node.w / 2;
            const centerY = node.y + node.h / 2;
            const host = covering.find((container) => (
              centerX >= container.x && centerX <= container.x + container.w
              && centerY >= container.y && centerY <= container.y + container.h
            ));
            fill = host?.fill || null;
          }
          resolved.set(node.id, fill);
        }
        return resolved;
      }, [doc]);

      // Anchors and their handles exist only in point-editing mode.
      const editingPoints = Boolean(selectedPathNode && pointEditId === selectedPathNode.id);
      const palette = useMemo(() => canvasPalette(stageRef.current), [doc, selected]);
      const handleHit = selectionFrame
        ? canvasHandleHitRadius(selectionFrame.width, selectionFrame.height)
        : HANDLE_HIT_MAX;
      const handles = selectionFrame
        ? [
          { id: 'nw', left: selectionFrame.left, top: selectionFrame.top },
          { id: 'ne', left: selectionFrame.left + selectionFrame.width, top: selectionFrame.top },
          { id: 'sw', left: selectionFrame.left, top: selectionFrame.top + selectionFrame.height },
          { id: 'se', left: selectionFrame.left + selectionFrame.width, top: selectionFrame.top + selectionFrame.height },
        ]
          .map((handle) => {
          // While the anchors are shown, a path's endpoints sit on the box
          // corners and a corner handle would cover an anchor. Step the box
          // handles out only in that mode; otherwise they sit on the box.
          if (!(editingPoints && selectedPathNode)) return handle;
          const step = 8;
          return {
            ...handle,
            left: handle.left + (handle.id.includes('w') ? -step : step),
            top: handle.top + (handle.id.includes('n') ? -step : step),
          };
        })
        : [];


      const overview = camera.zoom < CANVAS_OVERVIEW_ZOOM;
      /**
       * Whether a node needs DOM this frame.
       *
       * A 500-node board is fine as data and heavy as DOM, so a big board only
       * draws the nodes the viewport can reach. A selected or edited node is
       * always kept: it is what every keyboard command acts on.
       */
      const culling = nodes.length > CANVAS_CULL_MIN_NODES;
      const visibleWorld = (() => {
        if (!culling) return null;
        const width = viewport.width || 1200;
        const height = viewport.height || 800;
        const margin = CANVAS_CULL_MARGIN / (camera.zoom || 1);
        const topLeft = canvasScreenToWorld({ x: 0, y: 0 }, camera);
        const bottomRight = canvasScreenToWorld({ x: width, y: height }, camera);
        return {
          x: topLeft.x - margin,
          y: topLeft.y - margin,
          w: bottomRight.x - topLeft.x + margin * 2,
          h: bottomRight.y - topLeft.y + margin * 2,
        };
      })();
      const isNodeOnScreen = (node) => {
        if (!culling || overview) return true;
        if (selected.has(node.id) || editingId === node.id) return true;
        return canvasRectsOverlap(visibleWorld, canvasNodeBounds(node));
      };
      const drawnNodes = nodes.filter((node) => node.visible !== false && isNodeOnScreen(node));
      const drawnGroups = drawnNodes.filter((node) => canvasIsContainer(node));
      const drawnLeaves = drawnNodes.filter((node) => !canvasIsContainer(node));



      /** The name a group carries on its frame. */
      const groupTitle = (group) => {
        const member = (group.members || [])
          .map((id) => nodes.find((node) => node.id === id))
          .filter(Boolean)[0];
        if (!member) return '';
        const note = member.type === 'note' ? noteMap.get(member.noteId) : null;
        const text = member.type === 'note' ? String(note?.content || '') : String(member.text || '');
        const summary = canvasSummary(text);
        return summary === 'empty' ? '' : summary.slice(0, 24);
      };

      /** The look of one node: fill, stroke, radius, opacity and alignment. */
      const nodeStyle = (node) => {
        const style = {
          left: `${node.x}px`,
          top: `${node.y}px`,
          width: `${node.w}px`,
          height: `${node.h}px`,
        };
        if (node.opacity !== undefined && node.opacity !== null) style.opacity = node.opacity;
        if (node.textAlign) style.textAlign = node.textAlign;
        // A text box is a frame for measuring and resizing, never a clipping
        // window: a 48px line in a 48px box must still show its ascenders, and
        // the box must not pad the glyphs away from their stored coordinates.
        if (node.type === 'text') {
          style.padding = '0';
          style.overflow = 'visible';
          style.justifyContent = 'flex-start';
        }
        // Text size and ink come from the import; they only apply to text.
        if (node.fontSize && node.type !== 'image') style.fontSize = `${node.fontSize}px`;
        if (node.textColor && node.type !== 'image') style.color = node.textColor;
        else if (node.type !== 'image') {
          // A light fill carries dark ink whatever the theme is doing, and a
          // node with no fill inherits the surface of the frame it sits on.
          const ink = canvasInkOnFill(fillBehind.get(node.id) || node.fill);
          if (ink) style.color = ink;
        }
        if (node.type === 'shape') {
          // A shape paints itself through its own SVG, so the box stays bare at
          // readable zoom. In the overview the body is not drawn at all, so the
          // box has to carry the colour instead of vanishing.
          if (overview) {
            style.background = node.fill || 'var(--mm-canvas-shape-blank)';
            if (node.stroke) style.border = `1px solid ${node.stroke}`;
            if (node.shape === 'ellipse') style.borderRadius = '50%';
          } else {
            style.background = 'transparent';
            style.border = '0';
          }
        } else if (node.fill) {
          style.background = node.fill;
        }
        // A drop shadow is painted either by the box or, for a shape, by the
        // vector body inside it, so the shadow follows the silhouette.
        if (node.shadow) {
          const shadow = `${node.shadow.x}px ${node.shadow.y}px ${node.shadow.blur}px ${canvasShadowColor(node.shadow)}`;
          if (node.type === 'shape') style.filter = `drop-shadow(${shadow})`;
          else style.boxShadow = shadow;
        }
        // A flat fill on a plain box can be a gradient instead; shapes paint
        // their own gradient through the SVG so the silhouette stays exact.
        if (node.gradient && node.type !== 'shape') {
          style.background = `linear-gradient(${node.gradient.angle}deg, ${node.gradient.from}, ${node.gradient.to})`;
        }
        // Blur composes with a shadow filter when the node has both.
        if (node.blur) {
          style.filter = [style.filter, `blur(${node.blur}px)`].filter(Boolean).join(' ');
        }
        if (node.blend && node.blend !== 'normal') style.mixBlendMode = node.blend;
        // Rotation and flipping are one transform: a node can be turned and
        // mirrored at the same time, and the order is rotation first.
        const rotation = node.rotation ? `rotate(${node.rotation}deg)` : '';
        const flip = (node.flipX || node.flipY)
          ? `scale(${node.flipX ? -1 : 1}, ${node.flipY ? -1 : 1})`
          : '';
        if (rotation || flip) style.transform = [rotation, flip].filter(Boolean).join(' ');
        return style;
      };

      /** The middle of an edge, in screen space, where its label sits. */
      const edgeLabelPoint = (edge) => {
        const from = nodes.find((node) => node.id === edge.from);
        const to = nodes.find((node) => node.id === edge.to);
        if (!from || !to) return null;
        return canvasWorldToScreen(canvasEdgePath(edge, from, to).middle, camera);
      };

      // The bar menu and the right-click menu both close on an outside press.
      useEffect(() => {
        if (!barMoreOpen) return undefined;
        const close = () => setBarMoreOpen(false);
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault?.();
            setBarMoreOpen(false);
          }
        };
        window.addEventListener('pointerdown', close);
        window.addEventListener('keydown', onKey);
        return () => {
          window.removeEventListener('pointerdown', close);
          window.removeEventListener('keydown', onKey);
        };
      }, [barMoreOpen]);

      // A press anywhere else, or Escape, puts the menu away.
      useEffect(() => {
        if (!canvasMenu) return undefined;
        const close = () => setCanvasMenu(null);
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault?.();
            setCanvasMenu(null);
          }
        };
        window.addEventListener('pointerdown', close);
        window.addEventListener('keydown', onKey);
        return () => {
          window.removeEventListener('pointerdown', close);
          window.removeEventListener('keydown', onKey);
        };
      }, [canvasMenu]);

      /** The menu the right click opened, as a list of rows. */
      const canvasMenuView = (() => {
        if (!canvasMenu) return null;
        const target = canvasMenu.nodeId ? nodes.find((node) => node.id === canvasMenu.nodeId) : null;
        const count = selected.size;
        const rows = [];
        const run = (action) => () => { setCanvasMenu(null); action(); };
        const row = (key, label, hint, action, disabled) => rows.push({ key, label, hint, action: run(action), disabled });
        const rule = (key) => rows.push({ key, rule: true });

        if (target) {
          const hasContainer = Array.from(selected).some((id) => canvasIsContainer(nodes.find((node) => node.id === id)));
          row('duplicate', 'Duplicate', '⌘D', () => duplicateSelection());
          row('delete', 'Delete', '⌫', () => deleteSelection());
          rule('r1');
          row('front', 'Bring to front', ']', () => reorderNode(target.id, 'front'));
          row('back', 'Send to back', '[', () => reorderNode(target.id, 'back'));
          rule('r2');
          row('group', 'Group selection', '⌘G', () => groupSelection(), count < 2);
          row('frame', 'Frame selection', '⌥⌘G', () => frameSelection());
          if (hasContainer) row('ungroup', 'Ungroup', '', () => ungroupSelection());
          rule('r3');
          row('visible', target.visible === false ? 'Show' : 'Hide', '⇧H', () => toggleVisibility(target.id));
          row('lock', target.locked ? 'Unlock' : 'Lock', '⇧L', () => toggleLock(target.id));
          row('flipx', 'Flip horizontal', '', () => applyStyle({ flipX: !target.flipX }));
          row('flipy', 'Flip vertical', '', () => applyStyle({ flipY: !target.flipY }));
        } else {
          row('selectall', 'Select all', '⌘A', () => selectNodes(nodes.map((node) => node.id)));
          rule('r1');
          row('fit', 'Zoom to fit', '⇧1', () => fitToContent());
          row('zoom100', 'Zoom to 100%', '⌘0', () => resetZoom());
        }

        return h('div', {
          className: 'mm-canvas-menu',
          role: 'menu',
          style: {
            left: `${Math.max(4, Math.min(canvasMenu.x, (viewport.width || 800) - 224))}px`,
            top: `${Math.max(4, Math.min(canvasMenu.y, (viewport.height || 600) - 300))}px`,
          },
          onPointerDown: (event) => event.stopPropagation?.(),
          onContextMenu: (event) => event.preventDefault?.(),
        },
          rows.map((entry) => (entry.rule
            ? h('div', { key: entry.key, className: 'mm-canvas-menu-rule', role: 'separator' })
            : h('button', {
              key: entry.key,
              type: 'button',
              role: 'menuitem',
              className: 'mm-canvas-menu-item',
              disabled: entry.disabled === true,
              onClick: entry.action,
            },
              entry.label,
              entry.hint ? h('kbd', null, entry.hint) : null))));
      })();

      // Colour inputs only accept hex, so the rail borrows the board's own ink
      // and surface colours instead of inventing literals.
      const isHexColor = (value) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
      const inspectorFillFallback = (target) => (isHexColor(target?.fill)
        ? target.fill
        : isHexColor(doc?.tokens?.colors?.surface) ? doc.tokens.colors.surface : '');
      const inspectorInkFallback = (target) => (isHexColor(target?.textColor)
        ? target.textColor
        : isHexColor(doc?.tokens?.colors?.ink) ? doc.tokens.colors.ink : '');

      /** One labelled number field of the docked inspector. */
      const inspectorField = (label, value, commit, options = {}) => h('label', {
        key: `field-${label}-${options.ariaLabel || ''}`,
        className: 'mm-inspector-field',
      },
        h('span', { className: 'mm-inspector-label' }, label),
        h('input', {
          className: 'mm-inspector-input',
          type: 'number',
          value: value === null || value === undefined ? '' : String(value),
          min: options.min,
          max: options.max,
          step: options.step ?? 1,
          'aria-label': options.ariaLabel || `${label} of the selection`,
          onChange: (event) => {
            const raw = Number(event.target.value);
            if (!Number.isFinite(raw)) return;
            let next = raw;
            if (options.min !== undefined) next = Math.max(options.min, next);
            if (options.max !== undefined) next = Math.min(options.max, next);
            commit(next);
          },
        }),
      );

      /**
       * The right rail: layout numbers, appearance, effects and typography.
       *
       * It edits the same document as the tools and the agent: every change is
       * one `applyStyle` call, so undo and autosave treat it like any edit.
       */
      const canvasInspectorView = () => {
        const target = styleTarget;
        const section = (key, title, ...children) => h('section', { key, className: 'mm-inspector-section' },
          h('h3', { className: 'mm-inspector-title' }, title),
          ...children.filter(Boolean));
        const row = (key, label, ...children) => h('div', { key, className: 'mm-inspector-row' },
          h('span', { className: 'mm-inspector-label' }, label),
          ...children);
        return h('aside', {
          className: 'mm-canvas-inspector',
          'aria-label': 'Inspector',
          onPointerDown: (event) => event.stopPropagation?.(),
        },
          h('div', { className: 'mm-inspector-header' },
            h('button', {
              type: 'button', className: 'mm-inspector-collapse',
              title: 'Collapse the inspector',
              'aria-label': 'Collapse the inspector',
              onClick: () => {
                setInspectorOpen(false);
                writeStoredValue('moments-notes:canvas-inspector', false);
              },
            }, h(Icon, { name: 'chevron', size: 14 })),
            h('strong', { className: 'mm-inspector-object' },
              target
                ? (selected.size > 1
                  ? `${selected.size} objects`
                  : (CANVAS_NODE_LABELS[target.type] || 'Object'))
                : (doc?.title || 'Board')),
            h('span', { className: 'mm-inspector-meta' },
              target
                ? (selected.size > 1
                  ? 'Mixed selection — fields start from the first object'
                  : `${Math.round(target.w)} × ${Math.round(target.h)} · ${target.type}`)
                : `${nodes.length} nodes · ${Object.keys(tokenColors).length} colour tokens`)),
          target
            ? [
              section('layout', 'Layout',
                h('div', { className: 'mm-inspector-grid' },
                  inspectorField('X', Math.round(target.x), (value) => applyStyle({ x: Math.round(value) })),
                  inspectorField('Y', Math.round(target.y), (value) => applyStyle({ y: Math.round(value) })),
                  inspectorField('W', Math.round(target.w), (value) => applyStyle({ w: Math.max(16, Math.round(value)) }), { min: 16 }),
                  inspectorField('H', Math.round(target.h), (value) => applyStyle({ h: Math.max(16, Math.round(value)) }), { min: 16 }),
                  inspectorField('R', Math.round(target.rotation || 0), (value) => applyStyle({ rotation: Math.round(value) }), { min: -360, max: 360 }),
                ),
                target.locked ? h('p', { className: 'mm-inspector-hint' }, 'Locked: unlock to move it.') : null),
              section('appearance', 'Appearance',
                row('fill', 'Fill',
                  h('input', {
                    className: 'mm-inspector-color',
                    type: 'color',
                    value: inspectorFillFallback(target),
                    'aria-label': 'Fill colour of the selection',
                    onChange: (event) => applyStyle({ fill: event.target.value }),
                  }),
                  h('button', {
                    type: 'button', className: 'mm-inspector-chip',
                    onClick: () => applyStyle({ fill: null }),
                    'aria-label': 'Clear the fill',
                  }, 'None')),
                row('stroke', 'Line',
                  h('input', {
                    className: 'mm-inspector-color',
                    type: 'color',
                    value: isHexColor(target.stroke) ? target.stroke : inspectorInkFallback(target),
                    'aria-label': 'Line colour of the selection',
                    onChange: (event) => applyStyle({ stroke: event.target.value }),
                  }),
                  inspectorField('W', target.strokeWidth || 0, (value) => applyStyle({ strokeWidth: Math.max(0, Math.min(64, Math.round(value))) }), { ariaLabel: 'Line width of the selection', min: 0, max: 64 })),
                h('div', { className: 'mm-inspector-grid' },
                  inspectorField('Radius', target.radius || 0, (value) => applyStyle({ radius: Math.max(0, Math.min(999, Math.round(value))) }), { ariaLabel: 'Corner radius of the selection', min: 0 }),
                  inspectorField('Opacity', Math.round((target.opacity ?? 1) * 100), (value) => applyStyle({ opacity: Math.max(0, Math.min(1, value / 100)) }), { ariaLabel: 'Opacity of the selection', min: 0, max: 100 })),
                row('blend', 'Blend',
                  h('select', {
                    className: 'mm-inspector-select',
                    value: target.blend || 'normal',
                    'aria-label': 'Blend mode of the selection',
                    onChange: (event) => applyStyle({ blend: event.target.value }),
                  }, BLEND_MODE_OPTIONS.map((mode) => h('option', { key: mode, value: mode }, mode))))),
              section('theme', 'Theme',
                doc?.themes
                  ? h('div', { className: 'mm-inspector-row' },
                    ['light', 'dark'].map((mode) => h('button', {
                      key: `theme-${mode}`,
                      type: 'button',
                      className: cx('mm-inspector-chip', (doc.theme || 'light') === mode && 'is-active'),
                      onClick: () => applyTheme(mode),
                      'aria-label': `Use the ${mode} theme`,
                    }, mode)))
                  : h('div', { className: 'mm-inspector-row' },
                    h('button', {
                      type: 'button',
                      className: 'mm-inspector-chip',
                      onClick: () => createThemes(),
                      'aria-label': 'Create light and dark themes',
                    }, 'Create themes'))),
              Object.keys(tokenColors).length
                ? section('tokens', 'Design tokens',
                  h('div', { className: 'mm-inspector-row' },
                    h('span', { className: 'mm-inspector-label' }, target.type === 'text' ? 'Ink' : 'Fill'),
                    Object.keys(tokenColors).sort().map((name) => {
                      const key = target.type === 'text' ? 'textColorToken' : 'fillToken';
                      const active = (target[key] || null) === name;
                      return h('button', {
                        key: `ins-token-${name}`,
                        type: 'button',
                        className: cx('mm-inspector-swatch', active && 'is-active'),
                        style: { background: tokenColors[name] },
                        title: name,
                        'aria-label': `Token ${name}`,
                        onClick: () => applyStyle(target.type === 'text'
                          ? { textColorToken: active ? null : name, textColor: tokenColors[name] }
                          : { fillToken: active ? null : name, fill: tokenColors[name] }),
                      });
                    })),
                  // A token is only useful if it can be created and removed
                  // without the agent; the row below does exactly that.
                  h('div', { className: 'mm-inspector-row' },
                    h('input', {
                      className: 'mm-inspector-input mm-inspector-grow',
                      type: 'text',
                      value: tokenName,
                      placeholder: 'token-name',
                      'aria-label': 'New token name',
                      onChange: (event) => setTokenName(event.target.value),
                    }),
                    h('input', {
                      className: 'mm-inspector-color',
                      type: 'color',
                      value: tokenColor || inspectorInkFallback(target) || '',
                      'aria-label': 'New token colour',
                      onChange: (event) => setTokenColor(event.target.value),
                    }),
                    h('button', {
                      type: 'button',
                      className: 'mm-inspector-chip',
                      'aria-label': 'Add the colour token',
                      onClick: () => {
                        const name = tokenName.trim().toLowerCase();
                        if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) {
                          onError?.('A token name must be lowercase letters, digits and dashes');
                          return;
                        }
                        const color = tokenColor || inspectorInkFallback(target);
                        if (!isHexColor(color)) {
                          onError?.('Pick a colour before adding the token');
                          return;
                        }
                        updateTokens((tokens) => ({ ...tokens, colors: { ...tokens.colors, [name]: color } }));
                        setTokenName('');
                        setTokenColor('');
                        onNotice?.(`Token ${name} added`);
                      },
                    }, 'Add')),
                  target[target.type === 'text' ? 'textColorToken' : 'fillToken']
                    ? h('div', { className: 'mm-inspector-row' },
                      h('button', {
                        type: 'button',
                        className: 'mm-inspector-chip',
                        'aria-label': 'Remove the bound token',
                        onClick: () => {
                          const key = target.type === 'text' ? 'textColorToken' : 'fillToken';
                          const bound = target[key];
                          applyStyle({ [key]: null });
                          updateTokens((tokens) => {
                            const colors = { ...tokens.colors };
                            delete colors[bound];
                            return { ...tokens, colors };
                          });
                          onNotice?.(`Token ${bound} removed`);
                        },
                      }, 'Remove bound token'))
                    : null)
                : h('div', { className: 'mm-inspector-row' },
                  h('span', { className: 'mm-inspector-label' }, 'No tokens yet'),
                  h('input', {
                    className: 'mm-inspector-input mm-inspector-grow',
                    type: 'text',
                    value: tokenName,
                    placeholder: 'token-name',
                    'aria-label': 'New token name',
                    onChange: (event) => setTokenName(event.target.value),
                  }),
                  h('input', {
                    className: 'mm-inspector-color',
                    type: 'color',
                    value: tokenColor || inspectorInkFallback(target) || '',
                    'aria-label': 'New token colour',
                    onChange: (event) => setTokenColor(event.target.value),
                  }),
                  h('button', {
                    type: 'button',
                    className: 'mm-inspector-chip',
                    'aria-label': 'Add the colour token',
                    onClick: () => {
                      const name = tokenName.trim().toLowerCase();
                      const color = tokenColor || inspectorInkFallback(target);
                      if (!/^[a-z][a-z0-9-]{0,39}$/.test(name) || !isHexColor(color)) return;
                      updateTokens((tokens) => ({ ...tokens, colors: { ...tokens.colors, [name]: color } }));
                      setTokenName('');
                    },
                  }, 'Add')),
              canvasIsContainer(target)
                ? section('auto-layout', 'Auto layout',
                  h('div', { className: 'mm-inspector-row' },
                    h('span', { className: 'mm-inspector-label' }, 'Flow'),
                    h('select', {
                      className: 'mm-inspector-select',
                      value: target.layout || 'none',
                      'aria-label': 'Auto layout direction',
                      onChange: (event) => applyLayoutNow({ layout: event.target.value }),
                    }, ['none', 'row', 'column'].map((mode) => h('option', { key: mode, value: mode }, mode)))),
                  h('div', { className: 'mm-inspector-grid' },
                    inspectorField('Gap', target.gap || 0, (value) => applyLayoutNow({ gap: Math.max(0, Math.round(value)) }), { ariaLabel: 'Auto layout gap', min: 0, max: 400 }),
                    inspectorField('Pad', target.padding || 0, (value) => applyLayoutNow({ padding: Math.max(0, Math.round(value)) }), { ariaLabel: 'Auto layout padding', min: 0, max: 400 })),
                  h('div', { className: 'mm-inspector-row' },
                    h('span', { className: 'mm-inspector-label' }, 'Align'),
                    h('select', {
                      className: 'mm-inspector-select',
                      value: target.align || 'start',
                      'aria-label': 'Auto layout align',
                      onChange: (event) => applyLayoutNow({ align: event.target.value }),
                    }, ['start', 'center', 'end', 'stretch'].map((mode) => h('option', { key: mode, value: mode }, mode)))))
                : null,
              canvasIsContainer(target)
                ? section('grid', 'Layout grid',
                  h('div', { className: 'mm-inspector-row' },
                    h('select', {
                      className: 'mm-inspector-select',
                      value: target.grid?.kind || 'none',
                      'aria-label': 'Layout grid kind',
                      onChange: (event) => applyStyle({
                        grid: event.target.value === 'none'
                          ? null
                          : {
                            kind: event.target.value,
                            count: target.grid?.count ?? 12,
                            gutter: target.grid?.gutter ?? 16,
                            margin: target.grid?.margin ?? 24,
                            visible: true,
                          },
                      }),
                    }, ['none', 'columns', 'rows'].map((kind) => h('option', { key: kind, value: kind }, kind)))),
                  target.grid
                    ? h('div', { className: 'mm-inspector-grid' },
                      inspectorField('Cols', target.grid.count, (value) => applyStyle({
                        grid: { ...target.grid, count: Math.max(1, Math.min(24, Math.round(value))) },
                      }), { ariaLabel: 'Layout grid count', min: 1, max: 24 }),
                      inspectorField('Gut', target.grid.gutter, (value) => applyStyle({
                        grid: { ...target.grid, gutter: Math.max(0, Math.min(200, Math.round(value))) },
                      }), { ariaLabel: 'Layout grid gutter', min: 0, max: 200 }),
                      inspectorField('Mar', target.grid.margin, (value) => applyStyle({
                        grid: { ...target.grid, margin: Math.max(0, Math.min(400, Math.round(value))) },
                      }), { ariaLabel: 'Layout grid margin', min: 0, max: 400 }),
                      h('button', {
                        type: 'button',
                        className: cx('mm-inspector-chip', target.grid.visible && 'is-active'),
                        onClick: () => applyStyle({ grid: { ...target.grid, visible: !target.grid.visible } }),
                        'aria-label': 'Toggle the layout grid',
                      }, target.grid.visible ? 'On' : 'Off'))
                    : null)
                : null,
              parentOfSelected
                ? section('pins', 'Pins',
                  h('div', { className: 'mm-inspector-row' },
                    h('select', {
                      className: 'mm-inspector-select',
                      value: target.constraints?.horizontal || 'left',
                      'aria-label': 'Horizontal pin (inspector)',
                      onChange: (event) => applyStyle({
                        constraints: { ...(target.constraints || { horizontal: 'left', vertical: 'top' }), horizontal: event.target.value },
                      }),
                    }, CANVAS_PINS_H.map((value) => h('option', { key: value, value }, value))),
                    h('select', {
                      className: 'mm-inspector-select',
                      value: target.constraints?.vertical || 'top',
                      'aria-label': 'Vertical pin (inspector)',
                      onChange: (event) => applyStyle({
                        constraints: { ...(target.constraints || { horizontal: 'left', vertical: 'top' }), vertical: event.target.value },
                      }),
                    }, CANVAS_PINS_V.map((value) => h('option', { key: value, value }, value)))))
                : null,
              target.type === 'shape' && target.shape === 'path'
                ? section('path', 'Path',
                  h('button', {
                    type: 'button',
                    className: cx('mm-inspector-chip', editingPoints && 'is-active'),
                    onClick: () => setPointEditId(editingPoints ? null : target.id),
                    'aria-label': editingPoints ? 'Finish editing the path points' : 'Edit the path points',
                  }, editingPoints ? 'Done editing' : 'Edit points'),
                  h('button', {
                    type: 'button',
                    className: 'mm-inspector-chip',
                    onClick: () => togglePathCurve(target),
                    'aria-label': 'Curve or straighten the path (inspector)',
                  }, target.path.points.some((point) => point.in || point.out) ? 'Straighten' : 'Curve'))
                : null,
              section('effects', 'Effects',
                h('div', { className: 'mm-inspector-grid' },
                  inspectorField('Blur', target.blur || 0, (value) => applyStyle({ blur: Math.max(0, Math.min(200, Math.round(value))) }), { ariaLabel: 'Blur of the selection', min: 0, max: 200 })),
                target.shadow
                  ? h('div', { className: 'mm-inspector-grid' },
                    inspectorField('X', target.shadow.x, (value) => applyStyle({ shadow: { ...target.shadow, x: Math.round(value) } }), { ariaLabel: 'Shadow x of the selection' }),
                    inspectorField('Y', target.shadow.y, (value) => applyStyle({ shadow: { ...target.shadow, y: Math.round(value) } }), { ariaLabel: 'Shadow y of the selection' }),
                    inspectorField('Blur', target.shadow.blur, (value) => applyStyle({ shadow: { ...target.shadow, blur: Math.max(0, Math.round(value)) } }), { ariaLabel: 'Shadow blur of the selection', min: 0 }),
                    inspectorField('Alpha', Math.round((target.shadow.opacity ?? 1) * 100), (value) => applyStyle({ shadow: { ...target.shadow, opacity: Math.max(0, Math.min(1, value / 100)) } }), { ariaLabel: 'Shadow alpha of the selection', min: 0, max: 100 }),
                  h('div', { className: 'mm-inspector-row' },
                    h('input', {
                      className: 'mm-inspector-color',
                      type: 'color',
                      value: target.shadow.color,
                      'aria-label': 'Shadow colour of the selection',
                      onChange: (event) => applyStyle({ shadow: { ...target.shadow, color: event.target.value } }),
                    }),
                    h('button', {
                      type: 'button', className: 'mm-inspector-chip',
                      onClick: () => applyStyle({ shadow: null }),
                      'aria-label': 'Remove the drop shadow',
                    }, 'Remove shadow')))
                  : h('button', {
                    type: 'button', className: 'mm-inspector-chip',
                    onClick: () => applyStyle({
                      shadow: {
                        x: 0, y: 8, blur: 24, color: inspectorInkFallback(target) || undefined, opacity: 0.18,
                      },
                    }),
                    'aria-label': 'Add a drop shadow',
                  }, 'Add drop shadow')),
              section('export', 'Export',
                h('div', { className: 'mm-inspector-actions' },
                  h('button', {
                    type: 'button', className: 'mm-inspector-chip',
                    onClick: () => void exportBoard('svg'),
                    'aria-label': 'Export SVG',
                  }, 'SVG'),
                  h('button', {
                    type: 'button', className: 'mm-inspector-chip',
                    onClick: () => void exportBoard('png'),
                    'aria-label': 'Export PNG',
                  }, 'PNG'),
                  h('button', {
                    type: 'button', className: 'mm-inspector-chip',
                    onClick: () => void exportHandoff('html'),
                    'aria-label': 'Export HTML and CSS',
                  }, 'HTML'),
                  h('button', {
                    type: 'button', className: 'mm-inspector-chip',
                    onClick: () => void exportHandoff('spec'),
                    'aria-label': 'Export the design spec',
                  }, 'Spec'))),
              target.type === 'text'
                ? section('type', 'Typography',
                  h('div', { className: 'mm-inspector-row' },
                    h('span', { className: 'mm-inspector-label' }, 'Family'),
                    h('select', {
                      className: 'mm-inspector-select',
                      value: target.fontFamily || 'sans',
                      'aria-label': 'Font family of the selection',
                      onChange: (event) => applyStyle({ fontFamily: event.target.value }),
                    }, Object.keys(CANVAS_FONT_STACKS).map((family) => h('option', { key: family, value: family }, family)))),
                  h('div', { className: 'mm-inspector-grid' },
                    inspectorField('Size', target.fontSize || 14, (value) => applyStyle({ fontSize: Math.max(6, Math.min(512, Math.round(value))) }), { ariaLabel: 'Font size of the selection', min: 6, max: 512 }),
                    inspectorField('Weight', target.fontWeight || 400, (value) => applyStyle({ fontWeight: Math.max(100, Math.min(900, Math.round(value / 100) * 100)) }), { ariaLabel: 'Font weight of the selection', min: 100, max: 900, step: 100 }),
                    inspectorField('Line', target.lineHeight || 1.25, (value) => applyStyle({ lineHeight: Math.max(0.8, Math.min(3, value)) }), { ariaLabel: 'Line height of the selection', min: 0.8, max: 3, step: 0.05 }),
                    inspectorField('Track', target.letterSpacing || 0, (value) => applyStyle({ letterSpacing: Math.max(-5, Math.min(20, value)) }), { ariaLabel: 'Letter spacing of the selection', min: -5, max: 20, step: 0.1 })),
                  h('div', { className: 'mm-inspector-row' },
                    CANVAS_TEXT_ALIGNS.map((align) => h('button', {
                      key: `ins-align-${align.id}`,
                      type: 'button',
                      className: cx('mm-inspector-chip', (target.textAlign || 'left') === align.id && 'is-active'),
                      onClick: () => applyStyle({ textAlign: align.id }),
                      'aria-label': `Text ${align.label.toLocaleLowerCase()} (inspector)`,
                    }, align.label))))
                : null,
            ]
            : section('board', 'Board',
              h('p', { className: 'mm-inspector-hint' }, `${doc?.title || 'Board'} · ${nodes.length} nodes`),
              h('p', { className: 'mm-inspector-hint' }, `${Object.keys(tokenColors).length} colour tokens · ${Object.keys(tokenTypes).length} type tokens`),
              h('p', { className: 'mm-inspector-hint' }, 'Select an object to edit its properties here.')));
      };

      /** The tools sit in the middle of the top bar, where the eye lands. */
      const canvasToolsView = h('div', {
        className: 'mm-canvas-tools',
        role: 'toolbar',
        'aria-label': 'Canvas tools',
        onPointerDown: (event) => event.stopPropagation?.(),
      },
        CANVAS_TOOLS.map((item) => h('button', {
          key: item.id,
          type: 'button',
          className: cx('mm-canvas-tool', tool === item.id && item.id !== 'image' && 'is-active'),
          'data-tool': item.id,
          title: `${item.label} (${item.hint})`,
          'aria-label': item.label,
          'aria-pressed': tool === item.id,
          onMouseEnter: () => setHoveredTool(item),
          onFocus: () => setHoveredTool(item),
          onMouseLeave: () => setHoveredTool(null),
          onBlur: () => setHoveredTool(null),
          onClick: () => {
            if (item.id === 'image') pictureRef.current?.click();
            else {
              if (pathDraft && item.id !== 'path') commitPathDraft(pathDraft.points, false);
              else if (pathDraft && item.id === 'path') setPathDraft(null);
              setTool(item.id);
            }
          },
        }, h(Icon, { name: item.icon, size: 16 }))),
        h('span', { className: 'mm-canvas-tools-gap' }),
        h('button', {
          type: 'button', className: 'mm-canvas-tool', disabled: !history.length,
          onClick: undo, title: 'Undo (⌘Z)', 'aria-label': 'Undo',
          onMouseEnter: () => setHoveredTool(CANVAS_UNDO_HINT),
          onMouseLeave: () => setHoveredTool(null),
        }, h(Icon, { name: 'undo', size: 16 })),
        h('button', {
          type: 'button', className: 'mm-canvas-tool', disabled: !future.length,
          onClick: redo, title: 'Redo (⌘⇧Z)', 'aria-label': 'Redo',
          onMouseEnter: () => setHoveredTool(CANVAS_REDO_HINT),
          onMouseLeave: () => setHoveredTool(null),
        }, h(Icon, { name: 'redo', size: 16 })),
        // Icons alone are a guessing game: the bar names the tool under the
        // pointer, says what it does, and shows its key.
        h('div', { className: 'mm-canvas-tool-caption', 'aria-live': 'polite' },
          h('b', null, (hoveredTool || CANVAS_TOOLS.find((item) => item.id === tool) || CANVAS_TOOLS[0]).label),
          h('span', null, ` — ${(hoveredTool || CANVAS_TOOLS.find((item) => item.id === tool) || CANVAS_TOOLS[0]).hintText || ''}`),
          h('kbd', null, (hoveredTool || CANVAS_TOOLS.find((item) => item.id === tool) || CANVAS_TOOLS[0]).hint)));


      /** Board management and export, folded into one menu so the bar stays quiet. */
      const canvasBarMenuView = h('div', {
        className: 'mm-canvas-bar-panel',
        role: 'menu',
        'aria-label': 'Board actions',
        onPointerDown: (event) => event.stopPropagation?.(),
      },
        h('button', {
          type: 'button', role: 'menuitem', className: 'mm-canvas-bar-item',
          onClick: () => { setBarMoreOpen(false); void createBoard(); },
        }, h(Icon, { name: 'plus', size: 14 }), 'New board'),
        h('button', {
          type: 'button', role: 'menuitem', className: 'mm-canvas-bar-item', disabled: !activeId,
          onClick: () => {
            setBarMoreOpen(false);
            const title = window.prompt?.('Board name', doc?.title || 'Board');
            if (title) void renameBoard(title);
          },
        }, h(Icon, { name: 'edit', size: 14 }), 'Rename board'),
        h('button', {
          type: 'button', role: 'menuitem', className: 'mm-canvas-bar-item', disabled: !activeId,
          onClick: () => { setBarMoreOpen(false); void deleteBoard(); },
        }, h(Icon, { name: 'trash', size: 14 }), 'Delete board'),
        h('div', { className: 'mm-canvas-bar-rule', role: 'separator' }),
        h('button', {
          type: 'button', role: 'menuitem', className: 'mm-canvas-bar-item',
          disabled: !(pourSources || []).some((source) => source.id === pourSource && source.noteIds.length),
          onClick: () => { setBarMoreOpen(false); pourNotes(pourSource); },
        }, h(Icon, { name: 'scatter', size: 14 }), 'Lay out notes'),
        h('label', { className: 'mm-canvas-bar-source' },
          'Notes',
          h('select', {
            className: 'mm-canvas-select',
            value: pourSource,
            'aria-label': 'Which notes to lay out',
            onChange: (event) => setPourSource(event.target.value),
          }, (pourSources || []).map((source) => h('option', { value: source.id, key: source.id }, source.label)))),
        h('div', { className: 'mm-canvas-bar-rule', role: 'separator' }),
        h('button', {
          type: 'button', role: 'menuitem', className: 'mm-canvas-bar-item',
          onClick: () => { setBarMoreOpen(false); void exportBoard('svg'); },
        }, h(Icon, { name: 'exportIcon', size: 14 }), 'Export SVG'),
        h('button', {
          type: 'button', role: 'menuitem', className: 'mm-canvas-bar-item',
          onClick: () => { setBarMoreOpen(false); void exportBoard('png'); },
        }, h(Icon, { name: 'exportIcon', size: 14 }), 'Export PNG'),
        h('div', { className: 'mm-canvas-bar-rule', role: 'separator' }),
        h('button', {
          type: 'button', role: 'menuitem', className: 'mm-canvas-bar-item', disabled: !activeId,
          onClick: () => { setBarMoreOpen(false); figmaRef.current?.click(); },
        }, h(Icon, { name: 'upload', size: 14 }), 'Import Figma file'),
        h('button', {
          type: 'button', role: 'menuitem', className: 'mm-canvas-bar-item', disabled: !activeId,
          onClick: () => { setBarMoreOpen(false); void openImportReport(); },
        }, h(Icon, { name: 'list', size: 14 }), 'Last import report'),
        h('button', {
          type: 'button', role: 'menuitem', className: 'mm-canvas-bar-item', disabled: !activeId,
          onClick: () => {
            setBarMoreOpen(false);
            void openVersionHistory();
          },
        }, h(Icon, { name: 'refresh', size: 14 }), 'Version history'),
        h('div', { className: 'mm-canvas-bar-rule', role: 'separator' }),
        h('span', { className: 'mm-canvas-bar-menu-version' }, `Moments ${PLUGIN_VERSION}`));

      /** The handle a connector is about to snap to. */
      const canvasMagnetView = (() => {
        if (!magnet) return null;
        const node = (doc?.nodes || []).find((item) => item.id === magnet.nodeId);
        if (!node) return null;
        const point = canvasAnchorPoint(node, canvasNodeBounds(node), magnet.anchor);
        const screen = canvasWorldToScreen(point, camera);
        return h('span', {
          className: 'mm-canvas-magnet',
          style: { left: `${screen.x}px`, top: `${screen.y}px` },
          'aria-hidden': true,
        });
      })();

      /** The line that follows the pointer while a connector is drawn. */
      const canvasConnectPreviewView = (() => {
        if (!connectPreview) return null;
        const start = canvasWorldToScreen(connectPreview.from, camera);
        const end = canvasWorldToScreen(connectPreview.to, camera);
        return h('svg', { className: 'mm-canvas-connect-preview', 'aria-hidden': true },
          h('line', { x1: start.x, y1: start.y, x2: end.x, y2: end.y }));
      })();

      /** The bar that edits the selected connector. */
      /** What the last Figma import brought in, and what it left behind. */
      const importReportView = importReportOpen
        ? h('div', {
          className: 'mm-canvas-report',
          role: 'dialog',
          'aria-label': 'Last import report',
          'aria-modal': 'false',
        },
        h('div', { className: 'mm-canvas-report-head' },
          h('span', { className: 'mm-canvas-report-title' }, 'Last import report'),
          h('button', {
            type: 'button', className: 'mm-canvas-report-close',
            'aria-label': 'Close the import report',
            onClick: () => setImportReportOpen(false),
          }, h(Icon, { name: 'close', size: 14 }))),
        importReport
          ? h('div', { className: 'mm-canvas-report-body' },
            h('p', { className: 'mm-canvas-report-source' },
              `${importReport.source || 'Figma file'} · ${new Date(importReport.at).toLocaleString()} · ${importReport.nodeCount} nodes in the file`),
            h('div', { className: 'mm-canvas-report-section' },
              h('span', { className: 'mm-canvas-report-label' }, 'Imported'),
              h('p', { className: 'mm-canvas-report-text' },
                Object.entries(importReport.imported || {}).filter(([, value]) => value > 0)
                  .map(([kind, value]) => `${value} ${kind}`).join(', ') || 'nothing')),
            Object.keys(importReport.skipped || {}).length
              ? h('div', { className: 'mm-canvas-report-section' },
                h('span', { className: 'mm-canvas-report-label' }, 'Not imported'),
                h('ul', { className: 'mm-canvas-report-list' },
                  Object.entries(importReport.skipped || {}).filter(([, value]) => value > 0).map(([kind, value]) => {
                    const samples = (importReport.skippedSamples || {})[kind] || [];
                    return h('li', { key: kind, className: 'mm-canvas-report-item' },
                      h('span', { className: 'mm-canvas-report-count' }, `${value} ${kind}`),
                      samples.length
                        ? h('span', { className: 'mm-canvas-report-samples' }, samples.map((sample) => sample.name || sample.type).filter(Boolean).slice(0, 6).join(' · '))
                        : null);
                  })))
              : null,
            Array.isArray(importReport.warnings) && importReport.warnings.length
              ? h('div', { className: 'mm-canvas-report-section' },
                h('span', { className: 'mm-canvas-report-label' }, 'Notes'),
                h('ul', { className: 'mm-canvas-report-list' },
                  importReport.warnings.map((warning, index) => h('li', { key: `w-${index}`, className: 'mm-canvas-report-text' }, warning))))
              : null,
            h('p', { className: 'mm-canvas-report-hint' }, 'The same report is readable by an agent through design_inspect with view "import".'))
          : h('p', { className: 'mm-canvas-report-text' }, 'This board was not imported from a Figma file.'))
        : null;

      const canvasEdgePanel = (() => {
        const edge = (doc?.edges || []).find((item) => item.id === selectedEdgeId);
        if (!edge) return null;
        // Every step the format allows: a thin annotation and a heavy flow line
        // are both legitimate, so the bar offers the whole 1–8 range.
        const widths = [1, 2, 3, 4, 6, 8];
        const chip = (key, label, active, onClick, title) => h('button', {
          key,
          type: 'button',
          className: cx('mm-canvas-edge-chip', active && 'is-active'),
          onClick,
          title: title || label,
          'aria-label': title || label,
          'aria-pressed': active,
        }, label);
        // The bar sits just above the middle of the connector it edits.
        const from = (doc?.nodes || []).find((node) => node.id === edge.from);
        const to = (doc?.nodes || []).find((node) => node.id === edge.to);
        let anchor = null;
        if (from && to) {
          const middle = canvasEdgePath({ ...edge, curve: edge.curve || 'bezier' }, from, to).middle;
          anchor = canvasWorldToScreen(middle, camera);
        }
        // The bar must not cover the nodes it connects. It floats above both
        // of them, and falls below when the top is off the canvas.
        // The bar lives on the canvas edge, never on top of the work: a
        // floating bar would cover the very nodes the connector joins.
        return h('div', {
          className: 'mm-canvas-edge-panel',
          role: 'toolbar',
          'aria-label': 'Connector style',
          onPointerDown: (event) => event.stopPropagation?.(),
        },
          h('span', { className: 'mm-canvas-edge-group' },
            widths.map((value) => chip(
              `w${value}`,
              h('span', { className: 'mm-canvas-edge-width', style: { height: `${value}px` } }),
              Number(edge.strokeWidth || 2) === value,
              () => applyEdgeStyle({ strokeWidth: value }),
              `Stroke ${value}`,
            ))),
          h('span', { className: 'mm-canvas-edge-sep' }),
          h('span', { className: 'mm-canvas-edge-group' },
            chip('solid', '━', edge.dash === 'solid', () => applyEdgeStyle({ dash: 'solid' }), 'Solid line'),
            chip('dashed', '┅', edge.dash === 'dashed', () => applyEdgeStyle({ dash: 'dashed' }), 'Dashed line'),
            chip('dotted', '┈', edge.dash === 'dotted', () => applyEdgeStyle({ dash: 'dotted' }), 'Dotted line')),
          h('span', { className: 'mm-canvas-edge-sep' }),
          h('span', { className: 'mm-canvas-edge-group' },
            chip('curve-b', '∿', edge.curve === 'bezier', () => applyEdgeStyle({ curve: 'bezier' }), 'Curved line'),
            chip('curve-s', '—', edge.curve === 'straight', () => applyEdgeStyle({ curve: 'straight' }), 'Straight line'),
            chip('curve-e', '⌐', edge.curve === 'elbow', () => applyEdgeStyle({ curve: 'elbow' }), 'Elbow line')),
          h('span', { className: 'mm-canvas-edge-sep' }),
          h('span', { className: 'mm-canvas-edge-group' },
            h('button', {
              type: 'button',
              className: cx('mm-canvas-edge-chip', 'mm-canvas-edge-color', edgeColorOpen && 'is-active'),
              onClick: () => setEdgeColorOpen((open) => !open),
              title: 'Connector colour',
              'aria-label': 'Connector colour',
              'aria-expanded': edgeColorOpen,
            }, h('span', {
              className: 'mm-canvas-edge-swatch',
              // The default colour is the board's own ink, so the chip shows it.
              style: { background: edge.stroke || 'color-mix(in oklab, var(--dsw-alias-label-primary) 55%, transparent)' },
            }))),
          edgeColorOpen
            ? h('div', { className: 'mm-canvas-edge-colors', role: 'group', 'aria-label': 'Connector colour' },
              h('button', {
                type: 'button',
                className: cx('mm-canvas-edge-color-option', !edge.stroke && 'is-active'),
                onClick: () => { applyEdgeStyle({ stroke: null }); setEdgeColorOpen(false); },
                title: 'Default colour',
                'aria-label': 'Default connector colour',
              }, 'Default'),
              canvasPalette(stageRef.current)
                .filter((item) => item.value)
                .map((item) => h('button', {
                  key: 'edge-' + item.id,
                  type: 'button',
                  className: cx('mm-canvas-edge-color-option is-swatch', edge.stroke === item.value && 'is-active'),
                  style: { background: item.value },
                  onClick: () => { applyEdgeStyle({ stroke: item.value }); setEdgeColorOpen(false); },
                  title: item.label,
                  'aria-label': 'Connector colour ' + item.label,
                })),
              h('input', {
                type: 'color',
                className: 'mm-canvas-edge-color-input',
                // The colour input needs a literal value; the board's slate
                // token is the same colour the default line is drawn with.
                value: edge.stroke
                  || canvasPalette(stageRef.current).find((item) => item.id === 'slate')?.value
                  || '',
                'aria-label': 'Custom connector colour',
                onChange: (event) => applyEdgeStyle({ stroke: event.target.value }),
              }))
            : null,
          h('span', { className: 'mm-canvas-edge-sep' }),
          h('span', { className: 'mm-canvas-edge-group' },
            // The end head is one choice, not two switches: clicking the head
            // that is already there takes it away.
            chip('start', '⇥', edge.startArrow !== 'none', () => applyEdgeStyle({
              startArrow: edge.startArrow === 'none' ? 'arrow' : 'none',
            }), 'Start arrow'),
            chip('end', '⇤', edge.endArrow === 'arrow', () => applyEdgeStyle({
              endArrow: edge.endArrow === 'arrow' ? 'none' : 'arrow',
            }), 'Arrow head'),
            chip('end-tri', '▸', edge.endArrow === 'triangle', () => applyEdgeStyle({
              endArrow: edge.endArrow === 'triangle' ? 'none' : 'triangle',
            }), 'Triangle head'),
            chip('end-dot', '●', edge.endArrow === 'circle', () => applyEdgeStyle({
              endArrow: edge.endArrow === 'circle' ? 'none' : 'circle',
            }), 'Circle head')),
          h('span', { className: 'mm-canvas-edge-sep' }),
          h('button', {
            type: 'button',
            className: 'mm-canvas-edge-chip is-danger',
            onClick: deleteSelectedEdge,
            title: 'Delete the connector',
            'aria-label': 'Delete the connector',
          }, h(Icon, { name: 'trash', size: 14 })));
      })();

      const statusLabel = status === 'saving' ? 'Saving…'
        : status === 'saved' ? `Saved · ${savedAt ? formatTime(savedAt) : ''}`
          : status === 'error' ? 'Save failed' : 'All changes saved';

      return h('div', { className: 'mm-canvas-stage', ref: stageRef },
        h('div', { className: 'mm-canvas-bar' },
          h('div', { className: 'mm-canvas-bar-left' },
            h('div', { className: 'mm-canvas-boards' },
              h('button', {
                type: 'button',
                className: cx('mm-canvas-boards-toggle', boardsOpen && 'is-open'),
                onClick: () => setBoardsOpen((open) => !open),
                'aria-expanded': boardsOpen,
                'aria-label': 'Switch board',
                title: 'Switch board',
              },
                h('span', { className: 'mm-canvas-boards-current' },
                  boards.find((board) => board.id === activeId)?.title || 'No board'),
                h(Icon, { name: 'chevron', size: 11 })),
              boardsOpen
                ? h('div', { className: 'mm-canvas-boards-panel', role: 'listbox', 'aria-label': 'Boards' },
                  h('input', {
                    className: 'mm-canvas-boards-search',
                    value: boardQuery,
                    placeholder: 'Search boards',
                    'aria-label': 'Search boards',
                    autoFocus: true,
                    onChange: (event) => setBoardQuery(event.target.value),
                  }),
                  (() => {
                    const needle = boardQuery.trim().toLocaleLowerCase(LOCALE);
                    const visible = boards.filter((board) => !needle || board.title.toLocaleLowerCase(LOCALE).includes(needle));
                    const starred = visible.filter((board) => board.starred);
                    const recent = visible.filter((board) => !board.starred);
                    const row = (board) => h('div', {
                      key: board.id,
                      className: cx('mm-canvas-boards-row', board.id === activeId && 'is-active'),
                      role: 'option',
                      'aria-selected': board.id === activeId,
                    },
                      h('button', {
                        type: 'button',
                        className: 'mm-canvas-boards-name',
                        onClick: () => { setBoardsOpen(false); void switchBoard(board.id); },
                        title: board.title,
                      }, h('span', null, board.title), h('b', null, `${board.nodeCount ?? 0}`)),
                      h('button', {
                        type: 'button',
                        className: cx('mm-canvas-boards-star', board.starred && 'is-starred'),
                        onClick: () => void toggleStarBoard(board),
                        title: board.starred ? 'Unstar' : 'Star',
                        'aria-label': board.starred ? `Unstar ${board.title}` : `Star ${board.title}`,
                      }, h(Icon, { name: 'star', size: 13 })));
                    return h('div', { className: 'mm-canvas-boards-list' },
                      starred.map(row),
                      starred.length && recent.length ? h('div', { className: 'mm-canvas-boards-sep' }) : null,
                      recent.map(row),
                      visible.length === 0 ? h('div', { className: 'mm-canvas-boards-empty' }, 'No board matches') : null);
                  })(),
                  h('button', {
                    type: 'button',
                    className: 'mm-canvas-boards-new',
                    onClick: () => { setBoardsOpen(false); void createBoard(); },
                  }, h(Icon, { name: 'plus', size: 14 }), h('span', null, 'New board')))
                : null)),

          // The tools are the visual centre: they are what the hand reaches for.
          canvasToolsView,

          h('input', {
          ref: figmaRef,
          type: 'file',
          accept: '.fig,.jam,.deck',
          className: 'mm-visually-hidden',
          tabIndex: -1,
          'aria-label': 'Import a Figma file',
          onChange: (event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void importFigmaFile(file);
          },
        }),
          h('input', {
          ref: pictureRef,
          type: 'file',
          accept: '.png,.jpg,.jpeg,.webp,.gif,.svg,.fig,.jam,.deck,image/*',
          multiple: true,
          className: 'mm-visually-hidden',
          tabIndex: -1,
          onChange: (event) => {
            const files = Array.from(event.target.files || []);
            event.target.value = '';
            void addPictures(files);
          },
        }),
        h('div', { className: 'mm-canvas-bar-right' },
          perfHud
            ? h('span', {
              className: 'mm-canvas-perf',
              role: 'status',
              'aria-label': 'Performance',
            }, `${frameRate === null ? '—' : frameRate} FPS · ${drawnNodes.length}/${nodes.length}`)
            : null,
          h('button', {
            type: 'button',
            className: cx('mm-canvas-bar-toggle', inspectorOpen && 'is-open'),
            onClick: () => {
              const next = !inspectorOpen;
              setInspectorOpen(next);
              writeStoredValue('moments-notes:canvas-inspector', next);
            },
            title: 'Inspector: layout, appearance, effects',
            'aria-label': 'Toggle inspector',
            'aria-pressed': inspectorOpen,
          }, h(Icon, { name: 'list', size: 15 })),
          h('button', {
            type: 'button',
            className: cx('mm-canvas-bar-more', perfHud && 'is-open'),
            onClick: () => {
              const next = !perfHud;
              setPerfHud(next);
              writeStoredValue('moments-notes:canvas-perf', next);
            },
            title: 'Performance HUD: FPS and drawn nodes',
            'aria-label': 'Toggle performance HUD',
            'aria-pressed': perfHud,
          }, h(Icon, { name: 'chart', size: 15 })),
          // Saving is the quietest thing on the bar: a dot, with the words on hover.
          h('span', {
            className: cx('mm-canvas-status', `is-${status}`),
            role: 'status',
            title: statusLabel,
            'aria-label': statusLabel,
          }, h('span', { className: 'mm-canvas-status-dot' })),
          // The build is on the bar, not in a menu: a screenshot then answers
          // "is the fix I made actually running?".
          h('span', {
            className: 'mm-canvas-bar-version',
            title: `Moments ${PLUGIN_VERSION}`,
          }, PLUGIN_VERSION),
          h('button', {
            type: 'button',
            className: cx('mm-canvas-bar-more', barMoreOpen && 'is-open'),
            onClick: () => setBarMoreOpen((open) => !open),
            title: 'Board actions',
            'aria-label': 'Board actions',
            'aria-expanded': barMoreOpen,
          }, h(Icon, { name: 'more', size: 16 })),
          barMoreOpen ? canvasBarMenuView : null)),
        h('div', { className: cx('mm-canvas-body', inspectorOpen && 'is-inspector') },
        h('div', {
          className: cx('mm-canvas-surface', tool === 'hand' && 'is-panning'),
          ref: attachSurface,
          role: 'application',
          tabIndex: 0,
          'aria-label': 'Infinite canvas. Press the arrow keys to move what is selected.',
          onPointerDown: onSurfacePointerDown,
          onPointerMove: onSurfacePointerMove,
          onPointerUp: onSurfacePointerUp,
          onPointerCancel: onSurfacePointerUp,
          // Bound natively as well (see attachSurface): React's wheel listener is
          // passive, so preventDefault only works from the native one.
          onWheel: onSurfaceWheel,
          onDoubleClick: (event) => {
            if (!pathDraft) return;
            event.stopPropagation?.();
            commitPathDraft(pathDraft.points, false);
          },
          onKeyDown: onSurfaceKeyDown,
          onContextMenu: onSurfaceContextMenu,
          onPaste: onSurfacePaste,
          onDrop: onSurfaceDrop,
          onDragOver: onSurfaceDragOver,
          style: {
            backgroundSize: `${CANVAS_GRID_SIZE * camera.zoom}px ${CANVAS_GRID_SIZE * camera.zoom}px`,
            backgroundPosition: `${camera.x}px ${camera.y}px`,
          },
        },
          importReportView,
          selectedEdgeId ? canvasEdgePanel : null,
          canvasConnectPreviewView,
          magnet ? canvasMagnetView : null,
          snapGuides.length
            ? h('div', { className: 'mm-canvas-guides', 'aria-hidden': true },
              snapGuides.map((guide, index) => {
                if (guide.axis === 'x') {
                  const point = canvasWorldToScreen({ x: guide.position, y: 0 }, camera);
                  return h('div', { key: `guide-x-${index}`, className: 'mm-canvas-guide is-x', style: { left: `${point.x}px` } });
                }
                const point = canvasWorldToScreen({ x: 0, y: guide.position }, camera);
                return h('div', { key: `guide-y-${index}`, className: 'mm-canvas-guide is-y', style: { top: `${point.y}px` } });
              }))
            : null,
          h('div', {
            className: 'mm-canvas-world',
            style: { transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})` },
          },
            h('div', { className: 'mm-canvas-groups' },
              drawnGroups.map((group) => {
                // A component is a surface like a frame: it has a box, a name
                // and a preview of its own; only its instances are derived.
                const isFrame = group.type === 'frame' || group.type === 'component';
                return h('div', {
                  key: group.id,
                  className: cx(
                    isFrame ? 'mm-canvas-frame' : 'mm-canvas-group',
                    selected.has(group.id) && 'is-selected',
                  ),
                  'data-container-id': group.id,
                  // A frame is a surface of its own: pressing its inside drags
                  // the frame, the way a board behaves. A group is only an
                  // outline, so it stays see-through and is grabbed by its edges.
                  onPointerDown: isFrame
                    ? (event) => {
                      if (event.button !== 0) return;
                      event.stopPropagation?.();
                      capturePointer(event);
                      startGroupDrag(event, group);
                    }
                    : undefined,
                  style: {
                    left: `${group.x}px`,
                    top: `${group.y}px`,
                    width: `${group.w}px`,
                    height: `${group.h}px`,
                    ...(isFrame ? {
                      background: group.fill || undefined,
                      borderRadius: group.radius ? `${group.radius}px` : undefined,
                      borderColor: group.stroke || undefined,
                      borderWidth: group.strokeWidth ? `${group.strokeWidth}px` : undefined,
                    } : {}),
                  },
                  'data-group-id': group.id,
                },
                  isFrame && editingFrameId === group.id
                    ? h('input', {
                      className: 'mm-canvas-frame-title-input',
                      value: frameDraft,
                      autoFocus: true,
                      'aria-label': 'Frame name',
                      onChange: (event) => setFrameDraft(event.target.value),
                      onKeyDown: (event) => {
                        if (event.key === 'Escape') { event.preventDefault?.(); setEditingFrameId(null); }
                        else if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' || event.key === 'Enter') {
                          event.preventDefault?.();
                          commitFrameTitle();
                        }
                      },
                      onBlur: () => commitFrameTitle(),
                    })
                    : h('span', {
                      className: isFrame ? 'mm-canvas-frame-title' : 'mm-canvas-group-title',
                      onDoubleClick: isFrame ? (event) => {
                        event.stopPropagation?.();
                        setEditingFrameId(group.id);
                        setFrameDraft(group.title || '');
                      } : undefined,
                    }, isFrame ? (group.title || 'Frame') : groupTitle(group)),
                  group.grid && group.grid.visible
                    ? h('div', { className: 'mm-canvas-grid', 'aria-hidden': true },
                      Array.from({ length: group.grid.count || 12 }).map((_, index) => h('span', {
                        key: `grid-${index}`,
                        className: 'mm-canvas-grid-band',
                        style: canvasGridBand(group, index),
                      })))
                    : null,
                  ['top', 'right', 'bottom', 'left'].map((side) => h('span', {
                    key: side,
                    className: `mm-canvas-group-edge is-${side}`,
                    onPointerDown: (event) => {
                      event.stopPropagation?.();
                      capturePointer(event);
                      startGroupDrag(event, group);
                    },
                  })));
              })),
            h('svg', { className: 'mm-canvas-edges' },
              edges.map((edge) => {
                const from = nodes.find((node) => node.id === edge.from);
                const to = nodes.find((node) => node.id === edge.to);
                if (!from || !to) return null;
                // A connector whose both ends are off-screen is not visible.
                if (!isNodeOnScreen(from) && !isNodeOnScreen(to)) return null;
                const dash = canvasEdgeDash(edge);
                // A document written before the connector gained its look still
                // has to draw: the defaults live here, not only in the format.
                const endHead = edge.endArrow ?? 'arrow';
                const startHead = edge.startArrow ?? 'none';
                const weight = edge.strokeWidth ?? 2;
                const curve = edge.curve ?? 'bezier';
                const geometry = canvasEdgePath({ ...edge, curve }, from, to);
                // Heads are drawn from the geometry, not from an SVG marker:
                // a marker scales with the stroke and cannot be aimed at the
                // exact end point, which is what made them look broken.
                return h('g', { key: edge.id },
                  // Selection is a halo under the line, not a repaint of it: a
                  // connector keeps its own colour while it is selected.
                  selectedEdgeId === edge.id
                    ? h('path', { className: 'mm-canvas-edge-halo', d: geometry.d })
                    : null,
                  h('path', {
                    className: 'mm-canvas-edge',
                    d: geometry.d,
                    // `currentColor` is the surface ink, so a connector with no
                    // colour of its own still follows the theme.
                    stroke: edge.stroke || 'currentColor',
                    // With `vector-effect: non-scaling-stroke` these are screen
                    // pixels: the authored weight is scaled to the zoom, with a
                    // floor so a flowchart read at 10% still shows its lines.
                    'stroke-width': Math.max(weight * (camera.zoom || 1), 1.4),
                    'vector-effect': 'non-scaling-stroke',
                    'stroke-linecap': 'round',
                    'stroke-linejoin': 'round',
                    ...(dash ? { 'stroke-dasharray': dash } : null),
                  }),
                  ...canvasEdgeHeads(
                    { ...edge, endArrow: endHead, startArrow: startHead },
                    geometry,
                    camera.zoom,
                  ));
              }),
              edges.map((edge) => {
                const from = nodes.find((node) => node.id === edge.from);
                const to = nodes.find((node) => node.id === edge.to);
                if (!from || !to) return null;
                return h('path', {
                  key: `hit-${edge.id}`,
                  className: 'mm-canvas-edge-hit',
                  d: canvasEdgePath(edge, from, to).d,
                  'data-edge-id': edge.id,
                  onPointerDown: (event) => {
                    event.stopPropagation?.();
                    setSelectedEdgeId(edge.id);
                    setSelected(new Set());
                  },
                  onDoubleClick: () => startEditingEdge(edge),
                });
              })),

            canvasMenuView,
          drawnLeaves.map((node) => {
              const isSelected = selected.has(node.id);
              const isEditing = editingId === node.id;
              const note = node.type === 'note' ? noteMap.get(node.noteId) : null;
              return h('div', {
                key: node.id,
                className: cx(
                  'mm-canvas-node',
                  `mm-canvas-node--${node.type}`,
                  node.color && node.color !== 'none' && `is-${node.color}`,
                  isSelected && 'is-selected',
                  isEditing && 'is-editing',
                  overview && 'is-overview',
                ),
                style: nodeStyle(node),
                'data-node-id': node.id,
                'data-node-type': node.type,
                role: 'button',
                tabIndex: 0,
                'aria-label': `${CANVAS_NODE_LABELS[node.type] || 'Object'}: ${canvasSummary(note ? note.content : node.text)}`,
                onPointerDown: (event) => {
                  // Pointer capture eats `dblclick`, so the second tap is
                  // recognised here — but only armed: a second tap that turns
                  // into a drag is a drag, and the release decides.
                  pendingEditRef.current = (
                    event.button === 0 && !node.locked && isDoubleTap(node.id, event)
                  ) ? node : null;
                  onNodePointerDown(event, node);
                },
                onDoubleClick: () => startEditing(node),
                onKeyDown: (event) => onNodeKeyDown(event, node),
                onFocus: () => selectNodes([node.id], false),
              },
                isEditing
                  ? h('textarea', {
                    className: 'mm-canvas-node-input',
                    value: editDraft,
                    autoFocus: true,
                    'aria-label': `${CANVAS_NODE_LABELS[node.type] || 'Object'} text`,
                    onChange: (event) => setEditDraft(event.target.value),
                    // Selecting a word inside the box must not restart the edit.
                    onDoubleClick: (event) => event.stopPropagation?.(),
                    onKeyDown: (event) => {
                      if (event.key === 'Escape') { event.preventDefault?.(); setEditingId(null); }
                      else if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                        event.preventDefault?.();
                        void commitEditing();
                      }
                    },
                    onBlur: () => void commitEditing(),
                  })
                  : overview ? null : nodeBody(node));
            })),
          h('div', { className: 'mm-canvas-overlay' },
            edges.filter((edge) => edge.label && editingEdgeId !== edge.id).map((edge) => {
              const point = edgeLabelPoint(edge);
              if (!point) return null;
              return h('div', {
                key: edge.id,
                className: 'mm-canvas-edge-label',
                style: { left: `${point.x}px`, top: `${point.y}px` },
                onDoubleClick: () => startEditingEdge(edge),
              }, edge.label);
            }),
            editingEdgeId
              ? (() => {
                const edge = edges.find((item) => item.id === editingEdgeId);
                const point = edge ? edgeLabelPoint(edge) : null;
                if (!point) return null;
                return h('input', {
                  className: 'mm-canvas-edge-input',
                  style: { left: `${point.x}px`, top: `${point.y}px` },
                  value: edgeDraft,
                  autoFocus: true,
                  'aria-label': 'Relation label',
                  onChange: (event) => setEdgeDraft(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Escape') { event.preventDefault?.(); setEditingEdgeId(null); }
                    else if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                      event.preventDefault?.();
                      commitEdgeLabel();
                    }
                  },
                  onBlur: () => commitEdgeLabel(),
                });
              })()
              : null,
            selectionFrame
              ? h('div', {
                className: 'mm-canvas-selection',
                style: {
                  left: `${selectionFrame.left}px`,
                  top: `${selectionFrame.top}px`,
                  width: `${selectionFrame.width}px`,
                  height: `${selectionFrame.height}px`,
                },
              })
              : null,
            handles.map((handle) => h('span', {
              key: handle.id,
              className: `mm-canvas-handle is-${handle.id}`,
              'data-handle': handle.id,
              style: { left: `${handle.left}px`, top: `${handle.top}px`, '--mm-handle-hit': `${handleHit}px` },
              onPointerDown: (event) => {
                event.stopPropagation?.();
                capturePointer(event);
                // Only when the halos overlap is the receiving element a guess;
                // then the corner nearest the pointer decides. On a normal box
                // the element under the pointer is already the right corner.
                const overlapping = canvasHandleHalosOverlap(selectionFrame, handleHit);
                startResize(
                  event,
                  (overlapping ? canvasNearestHandle(event, selectionFrame, stageRef.current) : null) || handle.id,
                );
              },
            })),
            editingPoints && selectedPathNode
              ? selectedPathNode.path.points.map((point, index) => {
                const dot = 9 / (camera.zoom || 1);
                const at = {
                  x: (selectedPathNode.x + point.x) * camera.zoom + camera.x,
                  y: (selectedPathNode.y + point.y) * camera.zoom + camera.y,
                };
                return h('span', {
                  key: `anchor-${index}`,
                  className: 'mm-canvas-anchor',
                  'data-anchor': index,
                  style: {
                    left: `${at.x - dot / 2}px`,
                    top: `${at.y - dot / 2}px`,
                    width: `${dot}px`,
                    height: `${dot}px`,
                    borderWidth: `${1.5 / (camera.zoom || 1)}px`,
                  },
                  onPointerDown: (event) => {
                    event.stopPropagation?.();
                    capturePointer(event);
                    startAnchorDrag(event, selectedPathNode, index);
                  },
                });
              })
              : null,
            editingPoints && selectedPathNode
              ? selectedPathNode.path.points.flatMap((point, index) => ['in', 'out'].map((side) => {
                const handle = point[side];
                if (!handle) return null;
                const dot = 7 / (camera.zoom || 1);
                const at = {
                  x: (selectedPathNode.x + point.x + handle.x) * camera.zoom + camera.x,
                  y: (selectedPathNode.y + point.y + handle.y) * camera.zoom + camera.y,
                };
                return h('span', {
                  key: `handle-${index}-${side}`,
                  className: 'mm-canvas-handle-dot',
                  'data-handle-side': side,
                  style: {
                    left: `${at.x - dot / 2}px`,
                    top: `${at.y - dot / 2}px`,
                    width: `${dot}px`,
                    height: `${dot}px`,
                    borderWidth: `${1.5 / (camera.zoom || 1)}px`,
                  },
                  onPointerDown: (event) => {
                    event.stopPropagation?.();
                    capturePointer(event);
                    startHandleDrag(event, selectedPathNode, index, side);
                  },
                });
              })).filter(Boolean)
              : null),
          pathDraft
            ? h('svg', {
              className: 'mm-canvas-path-draft',
              'aria-hidden': true,
              width: '100%',
              height: '100%',
            },
              h('polyline', {
                points: pathDraft.points.map((point) => {
                  const screen = canvasWorldToScreen(point, camera);
                  return `${screen.x},${screen.y}`;
                }).join(' '),
                fill: 'none',
              }),
              pathDraft.points.map((point, index) => {
                const screen = canvasWorldToScreen(point, camera);
                return h('circle', { key: `draft-${index}`, cx: screen.x, cy: screen.y, r: 4 });
              }))
            : null,
          marquee
            ? h('div', {
              className: 'mm-canvas-marquee',
              style: (() => {
                const topLeft = canvasWorldToScreen({ x: marquee.x, y: marquee.y }, camera);
                const bottomRight = canvasWorldToScreen({ x: marquee.x + marquee.w, y: marquee.y + marquee.h }, camera);
                return {
                  left: `${topLeft.x}px`,
                  top: `${topLeft.y}px`,
                  width: `${bottomRight.x - topLeft.x}px`,
                  height: `${bottomRight.y - topLeft.y}px`,
                };
              })(),
            })
            : null),
          styleTarget
            ? h('div', {
              className: cx('mm-canvas-style', inspectorOpen && 'is-hidden'),
              role: 'toolbar',
              'aria-label': 'Appearance',
              onPointerDown: (event) => event.stopPropagation?.(),
            },
              h('div', { className: 'mm-canvas-style-row' },
                h('span', { className: 'mm-canvas-style-label' }, 'Fill'),
                palette.map((color) => h('button', {
                  key: `fill-${color.id}`,
                  type: 'button',
                  className: cx('mm-canvas-swatch', color.value === null && 'is-none', (styleTarget.fill ?? null) === color.value && 'is-active'),
                  style: color.value ? { background: color.value } : undefined,
                  title: `Fill: ${color.label}`,
                  'aria-label': `Fill: ${color.label}`,
                  onClick: () => applyStyle({ fill: color.value }),
                }))),
              Object.keys(tokenColors).length || Object.keys(tokenStops).length
                ? h('div', { className: 'mm-canvas-style-row' },
                  h('span', { className: 'mm-canvas-style-label' }, 'Token'),
                  Object.keys(tokenColors).sort().map((name) => {
                    const ink = styleTarget.type === 'text';
                    const key = ink ? 'textColorToken' : 'fillToken';
                    const active = (styleTarget[key] || null) === name;
                    return h('button', {
                      key: `fill-token-${name}`,
                      type: 'button',
                      className: cx('mm-canvas-swatch', active && 'is-active'),
                      style: { background: tokenColors[name] },
                      title: `Token: ${name}`,
                      'aria-label': `${ink ? 'Ink' : 'Fill'} token ${name}`,
                      onClick: () => applyStyle(ink
                        ? { textColorToken: active ? null : name, textColor: tokenColors[name] }
                        : { fillToken: active ? null : name, fill: tokenColors[name] }),
                    });
                  }),
                  Object.keys(tokenStops).sort().map((name) => {
                    const gradient = tokenStops[name];
                    const active = (styleTarget.gradientToken || null) === name;
                    return h('button', {
                      key: `gradient-token-${name}`,
                      type: 'button',
                      className: cx('mm-canvas-swatch', active && 'is-active'),
                      style: { background: `linear-gradient(${gradient.angle || 180}deg, ${gradient.from}, ${gradient.to})` },
                      title: `Gradient token: ${name}`,
                      'aria-label': `Gradient token ${name}`,
                      onClick: () => applyStyle({ gradientToken: active ? null : name, gradient: active ? null : gradient }),
                    });
                  }))
                : null,
              styleTarget.type === 'text' && Object.keys(tokenTypes).length
                ? h('div', { className: 'mm-canvas-style-row' },
                  h('span', { className: 'mm-canvas-style-label' }, 'Style'),
                  Object.keys(tokenTypes).sort().map((name) => h('button', {
                    key: `type-token-${name}`,
                    type: 'button',
                    className: cx('mm-canvas-style-chip', styleTarget.typeToken === name && 'is-active'),
                    title: `Type token: ${name}`,
                    'aria-label': `Type token ${name}`,
                    onClick: () => applyStyle(styleTarget.typeToken === name
                      ? { typeToken: null }
                      : { typeToken: name, ...tokenTypes[name] }),
                  }, name)))
                : null,
              parentOfSelected
                ? h('div', { className: 'mm-canvas-style-row' },
                  h('span', { className: 'mm-canvas-style-label' }, 'Pins'),
                  h('select', {
                    className: 'mm-canvas-select',
                    value: styleTarget.constraints?.horizontal || 'left',
                    'aria-label': 'Horizontal pin',
                    onChange: (event) => applyStyle({
                      constraints: {
                        ...(styleTarget.constraints || { horizontal: 'left', vertical: 'top' }),
                        horizontal: event.target.value,
                      },
                    }),
                  }, CANVAS_PINS_H.map((value) => h('option', { key: value, value }, value))),
                  h('select', {
                    className: 'mm-canvas-select',
                    value: styleTarget.constraints?.vertical || 'top',
                    'aria-label': 'Vertical pin',
                    onChange: (event) => applyStyle({
                      constraints: {
                        ...(styleTarget.constraints || { horizontal: 'left', vertical: 'top' }),
                        vertical: event.target.value,
                      },
                    }),
                  }, CANVAS_PINS_V.map((value) => h('option', { key: value, value }, value))))
                : null,
              h('div', { className: 'mm-canvas-style-row' },
                h('span', { className: 'mm-canvas-style-label' }, 'Line'),
                palette.map((color) => h('button', {
                  key: `stroke-${color.id}`,
                  type: 'button',
                  className: cx('mm-canvas-swatch', color.value === null && 'is-none', (styleTarget.stroke ?? null) === color.value && 'is-active'),
                  style: color.value ? { background: color.value } : undefined,
                  title: `Line: ${color.label}`,
                  'aria-label': `Line: ${color.label}`,
                  onClick: () => applyStyle({ stroke: color.value }),
                }))),
              h('div', { className: 'mm-canvas-style-row' },
                h('span', { className: 'mm-canvas-style-label' }, 'Width'),
                CANVAS_STROKE_WIDTHS.map((width) => h('button', {
                  key: `width-${width}`,
                  type: 'button',
                  className: cx('mm-canvas-style-chip', (styleTarget.strokeWidth ?? 0) === width && 'is-active'),
                  title: `Line width ${width}`,
                  'aria-label': `Line width ${width}`,
                  onClick: () => applyStyle({ strokeWidth: width }),
                }, String(width))),
                h('span', { className: 'mm-canvas-style-label' }, 'Radius'),
                CANVAS_RADII.map((radius) => h('button', {
                  key: `radius-${radius}`,
                  type: 'button',
                  className: cx('mm-canvas-style-chip', (styleTarget.radius ?? 0) === radius && 'is-active'),
                  title: `Corner radius ${radius}`,
                  'aria-label': `Corner radius ${radius}`,
                  onClick: () => applyStyle({ radius }),
                }, String(radius))),
                h('span', { className: 'mm-canvas-style-label' }, 'Opacity'),
                CANVAS_OPACITIES.map((opacity) => h('button', {
                  key: `opacity-${opacity}`,
                  type: 'button',
                  className: cx('mm-canvas-style-chip', Math.round((styleTarget.opacity ?? 1) * 100) === Math.round(opacity * 100) && 'is-active'),
                  title: `Opacity ${Math.round(opacity * 100)}%`,
                  'aria-label': `Opacity ${Math.round(opacity * 100)}%`,
                  onClick: () => applyStyle({ opacity }),
                }, `${Math.round(opacity * 100)}%`))),
              h('div', { className: 'mm-canvas-style-row' },
                h('span', { className: 'mm-canvas-style-label' }, 'Text'),
                CANVAS_TEXT_ALIGNS.map((align) => h('button', {
                  key: `align-${align.id}`,
                  type: 'button',
                  className: cx('mm-canvas-style-chip', (styleTarget.textAlign ?? 'left') === align.id && 'is-active'),
                  title: `Text ${align.label.toLocaleLowerCase()}`,
                  'aria-label': `Text ${align.label.toLocaleLowerCase()}`,
                  onClick: () => applyStyle({ textAlign: align.id }),
                }, align.label))))
            : null,

          selected.size
            ? h('div', {
              className: 'mm-canvas-actions',
              role: 'toolbar',
              'aria-label': 'Selection actions',
              onPointerDown: (event) => event.stopPropagation?.(),
            },
              h('button', {
                type: 'button',
                className: 'mm-canvas-tool',
                disabled: !selected.size,
                onClick: () => groupSelection(),
                title: 'Group the selection',
                'aria-label': 'Group the selection',
              }, h(Icon, { name: 'group', size: 15 })),
              h('button', {
                type: 'button',
                className: 'mm-canvas-tool',
                disabled: !selected.size,
                onClick: () => frameSelection(),
                title: 'Frame the selection',
                'aria-label': 'Frame the selection',
              }, h(Icon, { name: 'frame', size: 15 })),
              h('button', {
                type: 'button',
                className: 'mm-canvas-tool',
                disabled: ![...selected].some((id) => (doc?.nodes || []).some((node) => node.id === id && (node.type === 'group' || node.type === 'frame'))),
                onClick: () => ungroupSelection(),
                title: 'Ungroup the selection',
                'aria-label': 'Ungroup the selection',
              }, h(Icon, { name: 'ungroup', size: 15 })),
              selectedPathNode
                ? h('button', {
                  type: 'button',
                  className: 'mm-canvas-tool',
                  onClick: () => togglePathCurve(selectedPathNode),
                  title: selectedPathNode.path.points.some((point) => point.in || point.out) ? 'Straighten the path' : 'Curve the path',
                  'aria-label': selectedPathNode.path.points.some((point) => point.in || point.out) ? 'Straighten the path' : 'Curve the path',
                }, h(Icon, { name: 'connector', size: 15 }))
                : null,
              selected.size > 1 ? h('span', { className: 'mm-canvas-toolbar-gap' }) : null,
              selected.size > 1
                ? CANVAS_ALIGNMENTS.map((item) => h('button', {
                  key: item.id,
                  type: 'button',
                  className: 'mm-canvas-tool',
                  disabled: item.id.startsWith('distribute') && selected.size < 3,
                  onClick: () => alignSelection(item.id),
                  title: item.label,
                  'aria-label': item.label,
                }, h(Icon, { name: item.icon, size: 15 })))
                : null)
            : null,
          h('div', {
            className: 'mm-canvas-zoom',
            onPointerDown: (event) => event.stopPropagation?.(),
          },
          h('button', {
            type: 'button', className: 'mm-canvas-tool', onClick: () => zoomBy(1 / 1.2),
            title: 'Zoom out', 'aria-label': 'Zoom out',
          }, h(Icon, { name: 'zoomOut', size: 15 })),
          h('button', {
            type: 'button', className: 'mm-canvas-zoom-readout', onClick: resetZoom,
            title: 'Reset zoom to 100%', 'aria-label': 'Reset zoom',
          }, `${Math.round(camera.zoom * 100)}%`),
          h('button', {
            type: 'button', className: 'mm-canvas-tool', onClick: () => zoomBy(1.2),
            title: 'Zoom in', 'aria-label': 'Zoom in',
          }, h(Icon, { name: 'zoomIn', size: 15 })),
          h('button', {
            type: 'button', className: 'mm-canvas-tool', onClick: fitToContent,
            title: 'Fit everything (⌘0)', 'aria-label': 'Fit everything',
          }, h(Icon, { name: 'fit', size: 15 }))),
        !loading && !doc
          ? h('div', { className: 'mm-canvas-empty' },
            h(Icon, { name: 'canvas', size: 24 }),
            h('strong', null, 'No board yet'),
            h('span', null, 'A board is one infinite sheet. Make the first one and start arranging thoughts on it.'),
            h('button', {
              type: 'button', className: 'mm-canvas-empty-action',
              onClick: () => void createBoard(),
            }, h(Icon, { name: 'plus', size: 14 }), h('span', null, 'Create a board')))
          : null,
        doc && nodes.length === 0 && !loading
          ? h('div', { className: 'mm-canvas-empty' },
            h(Icon, { name: 'canvas', size: 24 }),
            h('strong', null, 'This board is empty'),
            h('span', null, 'Pick the sticky-note tool and click anywhere, or send a note here from the timeline.'),
            h('button', {
              type: 'button', className: 'mm-canvas-empty-action',
              onClick: () => setTool('sticky'),
            }, h(Icon, { name: 'sticky', size: 14 }), h('span', null, 'Add a sticky note')))
          : null,
        loading ? h('div', { className: 'mm-canvas-loading' }, 'Loading the board…') : null,
        inspectorOpen ? canvasInspectorView() : h('button', {
          type: 'button',
          className: 'mm-canvas-inspector-open',
          title: 'Show the inspector',
          'aria-label': 'Show the inspector',
          onClick: () => {
            setInspectorOpen(true);
            writeStoredValue('moments-notes:canvas-inspector', true);
          },
        }, h('span', { className: 'mm-canvas-inspector-open-icon' }, h(Icon, { name: 'chevron', size: 13 })), 'Inspector'),
        versionsOpen
          ? h('div', {
            className: 'mm-canvas-versions',
            role: 'dialog',
            'aria-label': 'Version history',
            onPointerDown: (event) => event.stopPropagation?.(),
          },
            h('div', { className: 'mm-canvas-versions-head' },
              h('strong', null, 'Version history'),
              h('button', {
                type: 'button', className: 'mm-inspector-chip',
                onClick: () => setVersionsOpen(false),
                'aria-label': 'Close version history',
              }, 'Close')),
            versions.length
              ? h('ul', { className: 'mm-canvas-versions-list' },
                versions.slice().reverse().map((version) => h('li', {
                  key: version.id,
                  className: 'mm-canvas-versions-row',
                },
                  h('span', { className: 'mm-canvas-versions-when' }, new Date(version.at).toLocaleString()),
                  h('span', { className: 'mm-canvas-versions-count' }, `${version.nodeCount} nodes`),
                  h('button', {
                    type: 'button', className: 'mm-inspector-chip',
                    onClick: () => void restoreVersion(version.id),
                    'aria-label': `Restore the version from ${new Date(version.at).toLocaleString()}`,
                  }, 'Restore'))))
              : h('p', { className: 'mm-inspector-hint' }, 'No versions yet — they are saved whenever the board changes.'))
          : null,
        editingPoints
          ? h('div', { className: 'mm-canvas-connect-hint', role: 'status' },
            'Editing points — drag an anchor, or press Esc to go back to moving the shape')
          : tool === 'connector'
            ? h('div', { className: 'mm-canvas-connect-hint', role: 'status' },
              connectFrom
                ? 'The start is set — click a second object to finish the line · Esc leaves'
                : 'Drag onto a second object to connect, or click one and then another · Esc leaves')
            : null,
        // The AI entry is a button in the bottom-left corner, not a permanent
        // bar: the connector style panel and the connect hint own the
        // bottom-centre strip, and the bar used to sit underneath them.
        aiOpen
          ? h('div', {
            className: cx('mm-canvas-dock', 'is-open', selectedEdgeId && 'is-lifted'),
            role: 'search',
            'aria-label': 'Ask AI',
            onPointerDown: (event) => event.stopPropagation?.(),
          },
            h(Icon, { name: 'send', size: 13 }),
            h('input', {
              ref: aiInputRef,
              className: 'mm-canvas-ai-input',
              type: 'text',
              value: aiPrompt,
              placeholder: 'Ask AI to change this board',
              title: 'The request lands on the board as a note and is copied',
              'aria-label': 'AI request for this board',
              onChange: (event) => setAiPrompt(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault?.();
                  submitDesignRequest();
                  return;
                }
                if (event.key === 'Escape') {
                  event.preventDefault?.();
                  event.stopPropagation?.();
                  setAiOpen(false);
                }
              },
            }),
            h('button', {
              type: 'button',
              className: 'mm-canvas-ai-send',
              disabled: !aiPrompt.trim(),
              onClick: () => submitDesignRequest(),
              'aria-label': 'Place the request on the board',
            }, h(Icon, { name: 'send', size: 14 })),
            h('button', {
              type: 'button',
              className: 'mm-canvas-ai-close',
              onClick: () => setAiOpen(false),
              'aria-label': 'Close the AI field',
            }, h(Icon, { name: 'close', size: 14 })))
          : h('button', {
            type: 'button',
            className: 'mm-canvas-ai-launcher',
            onClick: () => setAiOpen(true),
            'aria-expanded': false,
            'aria-label': 'Ask AI to change the board',
            title: 'Ask AI to change this board',
          },
            h(Icon, { name: 'send', size: 13 }),
            h('span', null, 'Ask AI')),
        ),
        );
    }

    /** One row of the layer tree. */
    function CanvasLayerRow({ layer, depth, api }) {
      const icon = layer.type === 'group' ? 'group'
        : layer.type === 'frame' ? 'frame'
          : layer.type === 'component' ? 'canvas'
            : layer.type === 'instance' ? 'copy'
              : layer.type === 'image' ? 'image'
                : layer.type === 'note' ? 'edit'
                  : layer.type === 'text' ? 'text'
                    : layer.type === 'shape'
                      ? (layer.shape === 'ellipse' ? 'ellipse' : layer.shape === 'path' ? 'connector' : 'rect')
                      : 'sticky';
      return h(React.Fragment, null,
        h('div', {
          className: cx('mm-layer-row', layer.selected && 'is-selected', layer.hidden && 'is-hidden'),
          'data-layer-id': layer.id,
          style: { paddingLeft: `${8 + depth * 12}px` },
        },
          layer.collapsible
            ? h('button', {
              type: 'button',
              className: cx('mm-layer-chevron', layer.collapsed && 'is-closed'),
              onClick: () => api?.toggleCollapsed?.(layer.id),
              title: layer.collapsed ? `Expand ${layer.name}` : `Collapse ${layer.name}`,
              'aria-label': layer.collapsed ? `Expand ${layer.name}` : `Collapse ${layer.name}`,
              'aria-expanded': !layer.collapsed,
            }, h(Icon, { name: 'chevron', size: 11 }))
            : h('span', { className: 'mm-layer-chevron is-empty', 'aria-hidden': true }),
          h('button', {
            type: 'button',
            className: 'mm-layer-name',
            onClick: () => api?.selectNode?.(layer.id),
            title: layer.name,
          }, h(Icon, { name: icon, size: 13 }), h('span', null, layer.name)),
          h('button', {
            type: 'button',
            className: 'mm-layer-eye',
            onClick: () => api?.toggleVisibility?.(layer.id),
            title: layer.hidden ? 'Show' : 'Hide',
            'aria-label': layer.hidden ? `Show ${layer.name}` : `Hide ${layer.name}`,
          }, h(Icon, { name: layer.hidden ? 'eyeOff' : 'eye', size: 13 }))),
        layer.collapsed ? null : (layer.children || []).map((child) => h(CanvasLayerRow, {
          key: child.id, layer: child, depth: depth + 1, api,
        })));
    }

    function MomentsApp() {
      const [notes, setNotes] = useState([]);
      const [tags, setTags] = useState([]);
      const [stats, setStats] = useState({});
      const [loading, setLoading] = useState(true);
      const [refreshing, setRefreshing] = useState(false);
      const [error, setError] = useState('');
      // The id of the Host log line behind the current error, when there is one.
      const [errorLogId, setErrorLogId] = useState('');
      const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
      const [diagnosticsData, setDiagnosticsData] = useState({ entries: [], location: null });
      const [partialWarning, setPartialWarning] = useState('');
      const [notice, setNotice] = useState('');
      const [busy, setBusy] = useState('');
      const [content, setContent] = useState('');
      const [attachments, setAttachments] = useState([]);
      const [editingId, setEditingId] = useState(null);
      const [inlineEditingId, setInlineEditingId] = useState(null);
      const [query, setQuery] = useState('');
      const [recentSearches, setRecentSearches] = useState(readRecentSearches);
      const [activeTag, setActiveTag] = useState('');
      const [activeView, setActiveView] = useState('all');
      const [dateFilter, setDateFilter] = useState('all');
      const [mainMode, setMainMode] = useState('timeline');
      const [pendingCanvasNotes, setPendingCanvasNotes] = useState([]);
      const [canvasLayers, setCanvasLayers] = useState([]);
      const [sidebarCollapsed, setSidebarCollapsed] = useState(
        () => readStoredValue('moments-notes:sidebar-collapsed', false) === true,
      );
      const setSidebar = useCallback((collapsed) => {
        setSidebarCollapsed(collapsed);
        writeStoredValue('moments-notes:sidebar-collapsed', collapsed);
      }, []);
      const canvasApiRef = useRef(null);
      const [expandedNotes, setExpandedNotes] = useState(() => new Set());
      const [relatedNote, setRelatedNote] = useState(null);
      const [confirmState, setConfirmState] = useState(null);
      const [confirmBusy, setConfirmBusy] = useState(false);
      const [importData, setImportData] = useState(null);
      const [importName, setImportName] = useState('');
      const [statsOpen, setStatsOpen] = useState(false);
      // The JSON backup and the Markdown download share one "Files" menu: three
      // icons in the title bar read as three different products.
      const [filesOpen, setFilesOpen] = useState(false);
      const editorRef = useRef(null);
      const searchRef = useRef(null);
      const importRef = useRef(null);
      const mounted = useRef(true);

      useEffect(() => () => { mounted.current = false; }, []);

      // A design tool card asks the workspace to show its board: remember the
      // board, switch to Design, and tell a live canvas panel to load it.
      useEffect(() => {
        const openDesign = (event) => {
          const boardId = event?.detail?.boardId;
          if (typeof boardId !== 'string' || !boardId) return;
          writeStoredValue(CANVAS_ACTIVE_KEY, boardId);
          setActiveView('canvas');
          window.dispatchEvent(new CustomEvent('moments:design-active', { detail: { boardId } }));
        };
        window.addEventListener('moments:open-design', openDesign);
        return () => window.removeEventListener('moments:open-design', openDesign);
      }, []);

      // Uncaught browser failures are the ones that leave no trace in the UI
      // unless something listens for them; both channels land in the log.
      useEffect(() => {
        if (typeof window === 'undefined') return undefined;
        const seen = new Set();
        // A fetch cancelled by a navigation or a reload is not a defect: it is
        // the page going away. Recording it would bury the real failures.
        const cancelled = (message) => /aborted|aborterror|body streambuffer was aborted|fetch is aborted/i.test(message);
        const report = (kind, error) => {
          const message = error?.message || String(error || 'Unknown browser failure');
          if (cancelled(message)) return;
          const key = `${kind}:${message}`.slice(0, 200);
          if (seen.has(key)) return;
          seen.add(key);
          void api('client-error', {
            method: kind,
            code: 'browser',
            message,
            stack: typeof error?.stack === 'string' ? error.stack : '',
            detail: { href: typeof location !== 'undefined' ? String(location.href) : '' },
          }).catch(() => {});
        };
        const onError = (event) => report('window.onerror', event?.error ?? event?.message);
        const onRejection = (event) => report('unhandledrejection', event?.reason);
        window.addEventListener('error', onError);
        window.addEventListener('unhandledrejection', onRejection);
        return () => {
          window.removeEventListener('error', onError);
          window.removeEventListener('unhandledrejection', onRejection);
        };
      }, []);

      const openDiagnostics = useCallback(async () => {
        setDiagnosticsOpen(true);
        try {
          const result = await api('diagnostics', { limit: 60 });
          setDiagnosticsData({
            entries: Array.isArray(result?.entries) ? result.entries : [],
            location: result?.location ?? null,
          });
        } catch (failure) {
          setDiagnosticsData({ entries: [], location: null, error: failure?.message || String(failure) });
        }
      }, []);

      const showError = useCallback((input) => {
        // A thrown failure carries the log id; a plain string does not.
        const message = typeof input === 'string' ? input : (input?.message || String(input || 'Something went wrong'));
        setErrorLogId(typeof input === 'object' && input && typeof input.logId === 'string' ? input.logId : '');
        setError(message || 'Something went wrong');
      }, []);

      /**
       * Open or close the desktop float.
       *
       * The Harness page cannot own a window that stays on top of other
       * applications, so the desktop float is a native window the Host starts
       * on request. When that window is unavailable the in-page float takes
       * over, because it is still the quickest way to capture a thought.
       */
      const openDesktopFloat = useCallback(async () => {
        try {
          const status = await api('float-status', {});
          if (status?.open) {
            await api('float-close', {});
            setNotice('Desktop float closed');
            return;
          }
          await api('float-open', {});
          setNotice('Desktop float is open — keep capturing while you use another app');
        } catch (failure) {
          floatBus.set(true);
          setNotice(`Desktop float unavailable: ${failure.message || failure} — using the in-app float instead`);
        }
      }, [setNotice]);

      const loadSnapshot = useCallback(async (silent = false) => {
        if (silent) setRefreshing(true);
        else setLoading(true);
        setError('');
        setPartialWarning('');
        try {
          const result = await api('snapshot', {});
          if (!mounted.current) return;
          const snapshotNotes = Array.isArray(result?.notes) ? result.notes : [];
          const readableNotes = snapshotNotes.filter((note) => note && typeof note.id === 'string' && note.id);
          const failedItems = snapshotNotes.length - readableNotes.length;
          setNotes(readableNotes);
          setPartialWarning(failedItems ? `${failedItems} notes could not be displayed. Retry failed items to reload the workspace.` : '');
          setTags(Array.isArray(result?.tags) || (result?.tags && typeof result.tags === 'object') ? result.tags : []);
          setStats(result?.stats && typeof result.stats === 'object' ? result.stats : {});
        } catch (failure) {
          if (mounted.current) {
            const permissionDenied = failure.code === 'HTTP_401' || failure.code === 'HTTP_403';
            setError(permissionDenied ? 'Permission required. Reopen Harness with an authenticated session, then retry.' : failure.message || String(failure));
          }
        } finally {
          if (mounted.current) {
            setLoading(false);
            setRefreshing(false);
          }
        }
      }, []);

      useEffect(() => {
        void loadSnapshot();
      }, [loadSnapshot]);

      useEffect(() => {
        try {
          localStorage.setItem(RECENT_SEARCH_KEY, JSON.stringify(recentSearches));
        } catch {
          // Storage can be disabled without affecting note capture.
        }
      }, [recentSearches]);

      useEffect(() => {
        if (!filesOpen) return undefined;
        const close = () => setFilesOpen(false);
        const onKey = (event) => {
          if (event.key === 'Escape') { event.preventDefault?.(); setFilesOpen(false); }
        };
        window.addEventListener('pointerdown', close);
        window.addEventListener('keydown', onKey);
        return () => {
          window.removeEventListener('pointerdown', close);
          window.removeEventListener('keydown', onKey);
        };
      }, [filesOpen]);

      useEffect(() => {
        if (!notice) return undefined;
        const timer = setTimeout(() => setNotice(''), 3200);
        return () => clearTimeout(timer);
      }, [notice]);

      const focusEditor = useCallback(() => {
        editorRef.current?.focus();
        editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, []);

      useEffect(() => {
        const handleKeyboard = (event) => {
          if (event.key === 'Escape') {
            setRelatedNote(null);
            setConfirmState(null);
            setImportData(null);
            setStatsOpen(false);
            return;
          }
          const target = event.target;
          const editing = target instanceof HTMLElement && (target.matches('input,textarea,select') || target.isContentEditable);
          if (editing || event.metaKey || event.ctrlKey || event.altKey) return;
          // The canvas owns the keyboard while it is open; its own shortcuts
          // would otherwise be taken over by the timeline.
          if (mainMode === 'canvas' || event.defaultPrevented) return;
          if (event.key === '/') {
            event.preventDefault();
            searchRef.current?.focus();
          } else if (event.key.toLocaleLowerCase() === 'n' && activeView !== 'trash') {
            event.preventDefault();
            setMainMode('timeline');
            requestAnimationFrame(focusEditor);
          }
        };
        document.addEventListener('keydown', handleKeyboard);
        return () => document.removeEventListener('keydown', handleKeyboard);
      }, [activeView, focusEditor, mainMode]);

      const rememberSearch = (term) => {
        const clean = term.trim();
        if (!clean) return;
        setRecentSearches((current) => [clean, ...current.filter((item) => item !== clean)].slice(0, 8));
      };

      const saveNote = async (content, attachments) => {
        if (busy) return;
        setBusy('save');
        setError('');
        try {
          if (editingId) {
            await api('update', { id: editingId, content, attachments });
          } else {
            await api('create', { content, attachments });
          }
          setContent('');
          setAttachments([]);
          setEditingId(null);
          setActiveView('all');
          setMainMode('timeline');
          setNotice(editingId ? 'Changes saved' : 'Thought captured');
          await loadSnapshot(true);
        } catch (failure) {
          setError(failure.message || String(failure));
        } finally {
          if (mounted.current) setBusy('');
        }
      };

      const startEdit = (note) => {
        if (note.deletedAt) return;
        setInlineEditingId(note.id);
      };

      const saveInlineEdit = async (note, nextContent, nextAttachments) => {
        if (busy) return;
        setBusy('inline-save');
        setError('');
        try {
          const attachments = Array.isArray(nextAttachments) ? nextAttachments : (note.attachments || []);
          await api('update', { id: note.id, content: nextContent, attachments });
          setInlineEditingId(null);
          setNotice('Changes saved');
          await loadSnapshot(true);
        } catch (failure) {
          setError(failure.message || String(failure));
        } finally {
          if (mounted.current) setBusy('');
        }
      };

      const cancelInlineEdit = () => setInlineEditingId(null);

      const cancelEdit = () => {
        setEditingId(null);
        setContent('');
        setAttachments([]);
      };

      const runNoteAction = async (action, note) => {
        const id = note.id;
        if (action === 'trash') {
          setConfirmState({
            title: 'Move to trash?',
            body: 'Notes stay for 30 days and can be restored any time; after that the Host deletes them for good.',
            warning: 'You can still restore it from the trash afterwards, so nothing is lost right away.',
            confirmLabel: 'Move to trash',
            action: () => runNoteAction('trash-confirmed', note),
          });
          return;
        }
        if (action === 'purge') {
          setConfirmState({
            title: 'Delete this note permanently?',
            body: 'This removes the note and its attachments from local data for good. It cannot be undone.',
            warning: 'If you only need it out of the way, use "Delete" and restore it from the trash later.',
            confirmLabel: 'Delete permanently',
            action: () => runNoteAction('purge-confirmed', note),
          });
          return;
        }
        setBusy(`${action}:${id}`);
        setError('');
        try {
          if (action === 'pin') {
            const pinned = !note.pinned;
            await api('pin', { id, pinned });
          } else if (action === 'trash-confirmed') {
            await api('trash', { id });
          } else if (action === 'restore') {
            await api('restore', { id });
          } else if (action === 'purge-confirmed') {
            await api('purge', { id });
          }
          const messages = {
            pin: note.pinned ? 'Unpinned' : 'Note pinned',
            'trash-confirmed': 'Moved to trash — restorable for 30 days',
            restore: 'Note restored',
            'purge-confirmed': 'Note deleted permanently',
          };
          setNotice(messages[action] || 'Done');
          if (editingId === id && action !== 'pin') cancelEdit();
          await loadSnapshot(true);
        } catch (failure) {
          setError(failure.message || String(failure));
        } finally {
          if (mounted.current) setBusy('');
        }
      };

      const copyNote = async (note) => {
        try {
          await copyText(note.content || '');
          setNotice('Note copied');
        } catch (failure) {
          setError(failure.message || String(failure));
        }
      };

      const toggleExpand = (id) => {
        setExpandedNotes((current) => {
          const next = new Set(current);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      };

      const selectTag = useCallback((tag) => {
        setActiveTag(tag);
        setActiveView('all');
        setMainMode('timeline');
      }, []);

      const clearFilters = () => {
        setQuery('');
        setActiveTag('');
        setDateFilter('all');
        setActiveView('all');
      };

      const exportJson = async () => {
        setBusy('export');
        setError('');
        try {
          const result = await api('export', {});
          const output = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
          downloadFile(`moments-notes-${dateKey(new Date())}.json`, output, 'application/json;charset=utf-8');
          setNotice('JSON backup exported');
        } catch (failure) {
          setError(failure.message || String(failure));
        } finally {
          if (mounted.current) setBusy('');
        }
      };

      const exportMarkdown = () => {
        try {
          downloadFile(`moments-notes-${dateKey(new Date())}.md`, notesToMarkdown(notes), 'text/markdown;charset=utf-8');
          setNotice('Markdown exported');
        } catch (failure) {
          setError(failure.message || String(failure));
        }
      };

      const readImport = async (file) => {
        if (!file) return;
        setError('');
        // A Figma file is not a notes backup: sending it through JSON.parse
        // only produces "Unexpected token PK". Point at the right entry.
        if (canvasIsFigmaFile(file)) {
          setActiveView('canvas');
          setError('This is a Figma / FigJam file. Open Design and drop it on the board, or use the board menu (⋯) → Import Figma file.');
          if (importRef.current) importRef.current.value = '';
          return;
        }
        try {
          if (file.size > 30 * 1024 * 1024) throw new Error('The backup must be 30 MB or smaller');
          const data = JSON.parse(await file.text());
          if (!data || typeof data !== 'object') throw new Error('The backup must be a JSON object or array');
          const importedNotes = Array.isArray(data) ? data : data.notes;
          if (!Array.isArray(importedNotes)) throw new Error('The backup has no notes array');
          setImportData(Array.isArray(data) ? { version: 1, notes: data } : data);
          setImportName(file.name);
        } catch (failure) {
          setError(`Cannot read the backup: ${failure.message || String(failure)}`);
        } finally {
          if (importRef.current) importRef.current.value = '';
        }
      };

      const runImport = async (data, mode) => {
        setBusy('import');
        setError('');
        try {
          await api('import', { data, mode });
          setImportData(null);
          setImportName('');
          setActiveView('all');
          setMainMode('timeline');
          clearFilters();
          setNotice(mode === 'replace' ? 'Backup replaced your notes' : 'Backup merged into your notes');
          await loadSnapshot(true);
        } catch (failure) {
          setError(failure.message || String(failure));
        } finally {
          if (mounted.current) setBusy('');
        }
      };

      const requestImport = (data, mode) => {
        if (mode === 'replace') {
          setConfirmState({
            title: 'Replace all current notes?',
            body: 'Replacing overwrites your local data with the backup.',
            warning: 'Export a JSON backup first, then continue.',
            confirmLabel: 'Replace with backup',
            action: () => runImport(data, mode),
          });
        } else {
          void runImport(data, mode);
        }
      };

      const handleConfirm = async () => {
        if (!confirmState) return;
        setConfirmBusy(true);
        try {
          await confirmState.action();
          if (mounted.current) setConfirmState(null);
        } finally {
          if (mounted.current) setConfirmBusy(false);
        }
      };

      const tagTree = useMemo(() => buildTagTree(notes, tags), [notes, tags]);
      const visibleNotes = useMemo(() => {
        const needle = query.trim().toLocaleLowerCase(LOCALE);
        const today = dateKey(new Date());
        return notes.filter((note) => {
          if (activeView === 'trash' ? !note.deletedAt : note.deletedAt) return false;
          if (activeView === 'pinned' && !note.pinned) return false;
          if (activeTag && !extractTags(note.content).some((tag) => tag === activeTag || tag.startsWith(`${activeTag}/`))) return false;
          if (dateFilter === 'today' && dateKey(note.createdAt) !== today) return false;
          if (dateFilter === '7d' || dateFilter === '30d') {
            const days = dateFilter === '7d' ? 7 : 30;
            const threshold = new Date();
            threshold.setDate(threshold.getDate() - days + 1);
            threshold.setHours(0, 0, 0, 0);
            if (validDate(note.createdAt) < threshold) return false;
          }
          if (dateFilter.startsWith('day:') && dateKey(note.createdAt) !== dateFilter.slice(4)) return false;
          if (needle) {
            const haystack = [note.content, ...extractTags(note.content), ...(note.attachments || []).map((item) => item.name)]
              .join(' ').toLocaleLowerCase(LOCALE);
            if (!haystack.includes(needle)) return false;
          }
          return true;
        }).sort((a, b) => {
          if (activeView !== 'trash' && Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
          return validDate(b.createdAt) - validDate(a.createdAt);
        });
      }, [notes, query, activeTag, activeView, dateFilter]);

      /** The groups of notes the canvas can lay out. */
      const pourSources = useMemo(() => {
        const alive = notes.filter((note) => !note.deletedAt);
        const sources = [
          { id: 'current', label: 'The filtered notes', noteIds: visibleNotes.filter((note) => !note.deletedAt).map((note) => note.id) },
          { id: 'all', label: 'All notes', noteIds: alive.map((note) => note.id) },
        ];
        for (const tag of tags) {
          const name = typeof tag === 'string' ? tag : tag?.name;
          if (!name) continue;
          sources.push({
            id: `tag:${name}`,
            label: `#${name}`,
            noteIds: alive
              .filter((note) => extractTags(note.content).some((item) => item === name || item.startsWith(`${name}/`)))
              .map((note) => note.id),
          });
        }
        return sources;
      }, [notes, tags, visibleNotes]);

      const handleCanvasApi = useCallback((api) => { canvasApiRef.current = api; }, []);
      const handleCanvasState = useCallback((layers) => { setCanvasLayers(layers); }, []);

      const filtered = Boolean(query.trim() || activeTag || dateFilter !== 'all');
      const activeCount = notes.filter((note) => !note.deletedAt).length;
      const pinnedCount = notes.filter((note) => !note.deletedAt && note.pinned).length;
      const trashCount = notes.filter((note) => note.deletedAt).length;
      /**
       * Send a note to the canvas.
       *
       * The note keeps its identity: the canvas node shows the live note and
       * edits made on the canvas go back to the same note.
       */
      const addNoteToCanvas = useCallback((note) => {
        if (!note?.id) return;
        setPendingCanvasNotes((current) => (current.includes(note.id) ? current : [...current, note.id]));
        setMainMode('canvas');
        setNotice('Sent to the canvas');
      }, []);

      /** The canvas says which notes it has taken, so they are not sent twice. */
      const consumePendingCanvasNotes = useCallback((ids) => {
        const taken = new Set(ids || []);
        setPendingCanvasNotes((current) => current.filter((id) => !taken.has(id)));
      }, []);

      const noteProps = {
        onEdit: startEdit,
        onCopy: copyNote,
        onAction: runNoteAction,
        onRelated: setRelatedNote,
        onTag: selectTag,
        onAddToCanvas: addNoteToCanvas,
        expandedNotes,
        onToggleExpand: toggleExpand,
        busy: Boolean(busy),
        editingId: inlineEditingId,
        onSaveInline: saveInlineEdit,
        onCancelInline: cancelInlineEdit,
        onError: showError,
      };

      const statsPanel = h(StatsPanel, { notes, tags, snapshotStats: stats, dateFilter, onSelectDate: setDateFilter });

      return h('div', { className: 'mm-app' },
        h('div', { className: cx('mm-shell', sidebarCollapsed && 'is-collapsed') },
          h('aside', { className: cx('mm-left', sidebarCollapsed && 'is-collapsed'), 'aria-label': 'Note navigation' },
            // Collapsed, the sidebar keeps every way in: the navigation turns
            // into an icon rail instead of disappearing behind one button.
            sidebarCollapsed
              ? h('button', {
                type: 'button',
                className: 'mm-side-logo',
                onClick: () => setSidebar(false),
                title: 'Expand the sidebar',
                'aria-label': 'Expand the sidebar',
                'aria-expanded': false,
              },
                h(PanelIcon, { active: false }),
                h(Icon, { name: 'chevron', size: 12 }))
              : h('div', { className: 'mm-side-top' },
                h('div', { className: 'mm-nav-heading' }, 'Notes'),
                h('button', {
                  type: 'button',
                  className: 'mm-side-toggle',
                  onClick: () => setSidebar(true),
                  title: 'Collapse the sidebar',
                  'aria-label': 'Collapse the sidebar',
                  'aria-expanded': true,
                }, h(Icon, { name: 'chevron', size: 12 }))),
            h('nav', { className: 'mm-nav', 'aria-label': 'Note views' },
              h('button', {
                type: 'button', className: cx(mainMode === 'timeline' && activeView === 'all' && 'is-active'),
                onClick: () => { setMainMode('timeline'); setActiveView('all'); },
                // The words are hidden when the rail is collapsed, so the name
                // has to live on the button itself.
                title: 'All notes', 'aria-label': `All notes (${activeCount})`,
              }, h(Icon, { name: 'edit' }), h('span', null, 'All notes'), h('b', null, activeCount)),
              h('button', {
                type: 'button', className: cx(mainMode === 'timeline' && activeView === 'pinned' && 'is-active'),
                onClick: () => { setMainMode('timeline'); setActiveView('pinned'); },
                title: 'PinNotes', 'aria-label': `PinNotes (${pinnedCount})`,
              }, h(Icon, { name: 'pin' }), h('span', null, 'PinNotes'), h('b', null, pinnedCount)),
              h('button', {
                type: 'button', className: cx(mainMode === 'review' && 'is-active'), onClick: () => setMainMode('review'),
                title: 'Daily review', 'aria-label': 'Daily review',
              }, h(Icon, { name: 'review' }), h('span', null, 'Daily review')),
              h('button', {
                type: 'button', className: cx(mainMode === 'canvas' && 'is-active'), onClick: () => setMainMode('canvas'),
                title: 'Design', 'aria-label': 'Design',
              }, h(Icon, { name: 'canvas' }), h('span', null, 'Design')),
              h('button', {
                type: 'button', className: cx(mainMode === 'timeline' && activeView === 'trash' && 'is-active'),
                onClick: () => { setMainMode('timeline'); setActiveView('trash'); },
                title: 'Trash', 'aria-label': `Trash (${trashCount})`,
              }, h(Icon, { name: 'trash' }), h('span', null, 'Trash'), h('b', null, trashCount))),
            sidebarCollapsed
              ? null
              : mainMode === 'canvas'
              ? h('section', { className: 'mm-sidebar-layers' },
                h('div', { className: 'mm-sidebar-heading' }, h('h2', null, 'Layers')),
                canvasLayers.length
                  ? h('div', { className: 'mm-layer-tree' }, canvasLayers.map((layer) => h(CanvasLayerRow, {
                    key: layer.id, layer, depth: 0, api: canvasApiRef.current,
                  })))
                  : h('div', { className: 'mm-sidebar-empty' }, 'No layers yet'))
              : h('section', { className: 'mm-sidebar-tags' },
                h('div', { className: 'mm-sidebar-heading' }, h('h2', null, 'Tags'), activeTag ? h('button', { type: 'button', onClick: () => setActiveTag('') }, 'Clear') : null),
                h(TagTree, { nodes: tagTree, activeTag, onTag: selectTag })),
            sidebarCollapsed
              ? null
              : h('div', { className: 'mm-sidebar-footer' }, h('span', { className: 'mm-local-dot' }), 'Data stays in this workspace')),
          h('main', { className: 'mm-center' },
            h('header', { className: 'mm-titlebar' },
              h('div', { className: 'mm-title-row' },
                h('h1', { className: 'mm-title' }, 'Moments'),
                h('div', { className: 'mm-topbar-actions' },
                  h('button', { type: 'button', className: 'mm-header-button is-primary', onClick: () => void openDesktopFloat(), title: 'Open the desktop float', 'aria-label': 'Open the desktop float' }, h(Icon, { name: 'window', size: 14 }), h('span', null, 'Float')),
                  h('button', { type: 'button', className: 'mm-header-button', onClick: () => setStatsOpen(true), title: 'Statistics', 'aria-label': 'Statistics' }, h(Icon, { name: 'chart' }), h('span', null, 'Stats')),
                  h('button', { type: 'button', className: 'mm-header-button', onClick: () => void loadSnapshot(), disabled: loading || refreshing, title: 'Refresh the notes', 'aria-label': 'Refresh the notes' }, h(Icon, { name: 'refresh' }), h('span', null, refreshing ? 'Refreshing' : 'Refresh')),
                  h('div', { className: 'mm-backup-actions' },
                    h('input', { ref: importRef, type: 'file', accept: '.json,application/json', className: 'mm-visually-hidden', onChange: (event) => void readImport(event.target.files?.[0]), tabIndex: -1 }),
                    h('div', { className: 'mm-files' },
                      h('button', {
                        type: 'button',
                        className: cx('mm-header-button', filesOpen && 'is-open'),
                        onClick: () => setFilesOpen((open) => !open),
                        title: 'Files: import, backup, export',
                        'aria-label': 'Files',
                        'aria-haspopup': 'menu',
                        'aria-expanded': filesOpen,
                      }, h(Icon, { name: 'folder', size: 15 })),
                      filesOpen
                        ? h('div', { className: 'mm-files-menu', role: 'menu', 'aria-label': 'Files' },
                          h('button', {
                            type: 'button', role: 'menuitem', className: 'mm-files-item',
                            onClick: () => { setFilesOpen(false); importRef.current?.click(); },
                          }, h(Icon, { name: 'upload', size: 14 }), h('span', null, 'Import JSON backup')),
                          h('button', {
                            type: 'button', role: 'menuitem', className: 'mm-files-item',
                            onClick: () => { setFilesOpen(false); void exportJson(); },
                            disabled: busy === 'export',
                          }, h(Icon, { name: 'download', size: 14 }), h('span', null, 'Export JSON backup')),
                          h('button', {
                            type: 'button', role: 'menuitem', className: 'mm-files-item',
                            onClick: () => { setFilesOpen(false); exportMarkdown(); },
                            disabled: !activeCount,
                          }, h(Icon, { name: 'markdown', size: 14 }), h('span', null, 'Export Markdown')))
                        : null)))),
              h('div', { className: 'mm-toolbar' },
                mainMode === 'canvas'
                  ? h('div', { className: 'mm-canvas-hint' },
                    h(Icon, { name: 'hand', size: 14 }),
                    h('span', null, 'Drag to pan · ⌘ + scroll to zoom · V select · N sticky note · C connector'))
                  : h(SearchBar, { query, onChange: setQuery, onSearch: rememberSearch, recentSearches, searchRef }))),
            error ? h('div', { className: 'mm-error-banner', role: 'alert' },
              h('span', null,
                error,
                errorLogId ? h('code', { className: 'mm-error-logid' }, `日志编号 ${errorLogId}`) : null),
              h('button', { type: 'button', onClick: () => void openDiagnostics(), 'aria-label': 'Open the diagnostic log' }, '查看日志'),
              h('button', { type: 'button', onClick: () => void loadSnapshot() }, 'Retry'),
              h('button', { type: 'button', 'aria-label': 'Dismiss the error', onClick: () => { setError(''); setErrorLogId(''); } }, h(Icon, { name: 'close', size: 14 }))) : null,
            partialWarning ? h('div', { className: 'mm-partial-banner', role: 'alert' },
              h(Icon, { name: 'refresh', size: 16 }),
              h('span', null, partialWarning),
              h('button', { type: 'button', onClick: () => void loadSnapshot() }, 'Retry failed items'),
              h('button', { type: 'button', 'aria-label': 'Dismiss the partial-failure warning', onClick: () => setPartialWarning('') }, h(Icon, { name: 'close', size: 14 }))) : null,
            h('div', { className: cx('mm-main-scroll', mainMode === 'canvas' && 'is-canvas') },
              mainMode === 'canvas'
                ? h(CanvasPanel, {
                  notes,
                  pendingNoteIds: pendingCanvasNotes,
                  pourSources,
                  onPendingConsumed: consumePendingCanvasNotes,
                  onError: showError,
                  onNotice: setNotice,
                  onNoteUpdated: () => loadSnapshot(true),
                  onStateChange: handleCanvasState,
                  onApiReady: handleCanvasApi,
                })
                : mainMode === 'review' ? h(ReviewPanel, { noteProps, onError: showError, notes }) : h(React.Fragment, null,
                activeView !== 'trash' ? h(Editor, {
                  content,
                  setContent,
                  attachments,
                  setAttachments,
                  editingId,
                  onSave: saveNote,
                  onCancel: cancelEdit,
                  tags: [...new Set([...normalizeSuppliedTags(tags), ...notes.flatMap((note) => extractTags(note.content))])],
                  busy: Boolean(busy),
                  editorRef,
                  onError: showError,
                }) : h('div', { className: 'mm-trash-banner' }, h(Icon, { name: 'trash', size: 20 }),
                  h('div', null, h('strong', null, 'Trash'), h('span', null, 'Deleted notes stay for 30 days and can be restored any time; after that they are removed for good.'))),
                h('section', { className: 'mm-timeline-section' },
                  h('div', { className: 'mm-timeline-toolbar' },
                    h('div', null,
                      h('h1', null, activeView === 'trash' ? 'Trash' : activeView === 'pinned' ? 'PinNotes' : 'Timeline'),
                      h('span', null, `${visibleNotes.length} notes${activeTag ? ` · #${activeTag}` : ''}`)),
                    h('div', { className: 'mm-filter-controls' },
                      h('select', { value: dateFilter, onChange: (event) => setDateFilter(event.target.value), 'aria-label': 'Filter by date' },
                        h('option', { value: 'all' }, 'All dates'),
                        h('option', { value: 'today' }, 'Today'),
                        h('option', { value: '7d' }, 'Last 7 days'),
                        h('option', { value: '30d' }, 'Last 30 days'),
                        dateFilter.startsWith('day:') ? h('option', { value: dateFilter }, dateFilter.slice(4)) : null),
                      filtered ? h('button', { type: 'button', className: 'mm-text-button', onClick: clearFilters }, 'Clear filters') : null)),
                  h(Timeline, {
                    notes: visibleNotes,
                    loading,
                    filtered: filtered || activeView !== 'all',
                    onClear: clearFilters,
                    onCreate: focusEditor,
                    noteProps,
                  })))))),
        notice ? h('div', { className: 'mm-toast', role: 'status' }, h('span', { className: 'mm-toast-check' }, h(Icon, { name: 'check', size: 14 })), notice) : null,
        relatedNote ? h(RelatedDialog, { note: relatedNote, onClose: () => setRelatedNote(null), onSelect: setRelatedNote, onTag: (tag) => { selectTag(tag); setRelatedNote(null); } }) : null,
        confirmState ? h(ConfirmDialog, { config: confirmState, busy: confirmBusy || busy === 'import', onCancel: () => setConfirmState(null), onConfirm: handleConfirm }) : null,
        importData ? h(ImportDialog, { data: importData, fileName: importName, busy: busy === 'import', onClose: () => setImportData(null), onImport: requestImport }) : null,
        statsOpen ? h(DialogShell, { title: 'Note statistics and trail', onClose: () => setStatsOpen(false), className: 'mm-stats-dialog' }, statsPanel) : null,
        diagnosticsOpen ? h(DialogShell, { title: 'Diagnostic log', onClose: () => setDiagnosticsOpen(false), className: 'mm-diagnostics-dialog' },
          h('div', { className: 'mm-diagnostics' },
            h('p', { className: 'mm-diagnostics-hint' },
              diagnosticsData.location?.filePath
                ? `Every failure the plugin answers and every browser error is written here: ${diagnosticsData.location.filePath}`
                : 'The log file is not available, showing what this session reported.'),
            diagnosticsData.error ? h('p', { className: 'mm-inline-error', role: 'alert' }, diagnosticsData.error) : null,
            diagnosticsData.entries.length
              ? h('ul', { className: 'mm-diagnostics-list' },
                diagnosticsData.entries.map((entry) => h('li', { key: entry.id, className: 'mm-diagnostics-row' },
                  h('div', { className: 'mm-diagnostics-head' },
                    h('code', { className: 'mm-diagnostics-id' }, entry.id),
                    h('span', { className: 'mm-diagnostics-time' }, entry.atIso || new Date(entry.at || Date.now()).toISOString()),
                    h('span', { className: 'mm-diagnostics-scope' }, entry.scope || 'host'),
                    entry.method ? h('span', { className: 'mm-diagnostics-method' }, entry.method) : null,
                    entry.code ? h('span', { className: 'mm-diagnostics-code' }, entry.code) : null),
                  h('p', { className: 'mm-diagnostics-message' }, entry.message || '(no message)'),
                  entry.detail?.payload?.suspects?.length || entry.detail?.suspects?.length
                    ? h('p', { className: 'mm-diagnostics-detail' },
                      `超出限制的对象：${JSON.stringify(entry.detail?.payload?.suspects ?? entry.detail?.suspects)}`)
                    : null)))
              : h('p', { className: 'mm-diagnostics-empty' }, 'Nothing has failed yet.')),
            h('div', { className: 'mm-diagnostics-actions' },
              h('button', { type: 'button', className: 'mm-inspector-chip', onClick: () => void openDiagnostics() }, 'Refresh'),
              h('button', {
                type: 'button',
                className: 'mm-inspector-chip',
                onClick: () => {
                  const text = diagnosticsData.entries
                    .map((entry) => `[${entry.atIso}] ${entry.scope}/${entry.method} ${entry.code}: ${entry.message}`)
                    .join('\n');
                  void navigator?.clipboard?.writeText?.(text);
                },
              }, 'Copy'))) : null);
    }

    const CSS = `
      /* Warm paper surfaces and one ember accent. Every value follows the
         host theme; the plugin owns depth and identity, not the shell chrome. */
      .mm-app,.mm-float,.mm-panel-icon{
        --mm-accent-base:rgb(181 64 42);
        --mm-surface-0:color-mix(in oklab,var(--dsw-alias-bg-base) 97%,var(--mm-accent-base) 3%);
        --mm-surface-1:color-mix(in oklab,var(--dsw-alias-bg-base) 99%,var(--mm-accent-base) 1%);
        --mm-surface-2:color-mix(in oklab,var(--dsw-alias-bg-base) 94%,var(--mm-accent-base) 6%);
        --mm-surface-3:color-mix(in oklab,var(--dsw-alias-bg-base) 90%,var(--mm-accent-base) 10%);
        --mm-overlay:var(--dsw-alias-bg-overlay);
        --mm-line:color-mix(in oklab,var(--dsw-alias-label-primary) 10%,transparent);
        --mm-line-strong:color-mix(in oklab,var(--dsw-alias-label-primary) 17%,transparent);
        --mm-canvas-shape-blank:rgb(0 0 0 / .08);
        --mm-shadow-card:0 1px 2px rgb(0 0 0 / .04),0 12px 28px -20px rgb(0 0 0 / .24);
        --mm-shadow-float:0 2px 6px rgb(0 0 0 / .08),0 16px 36px -12px rgb(0 0 0 / .20);
        --mm-accent:var(--mm-accent-base);
        --mm-accent-hover:color-mix(in oklab,var(--mm-accent-base) 88%,var(--dsw-alias-label-primary) 12%);
        --mm-accent-soft:color-mix(in oklab,var(--mm-accent-base) 10%,var(--mm-surface-1));
        --mm-accent-ring:color-mix(in oklab,var(--mm-accent-base) 14%,transparent);
        --mm-accent-line:color-mix(in oklab,var(--mm-accent-base) 42%,transparent);
        --mm-accent-ink:rgb(154 53 33);
        --mm-on-accent:rgb(255 255 255);
        --mm-palette-ember:rgb(181 64 42);
        --mm-palette-amber:rgb(201 146 44);
        --mm-palette-rose:rgb(192 90 98);
        --mm-palette-sage:rgb(95 143 108);
        --mm-palette-sky:rgb(74 127 181);
        --mm-palette-violet:rgb(124 107 196);
        --mm-palette-slate:rgb(107 114 128);
        /* Ink a node's own fill can carry, whatever the theme is doing: white
           paper still needs a dark word written on it in the dark theme. */
        --mm-ink-on-light:rgb(16 20 24);
        --mm-ink-on-dark:rgb(244 246 248);
        --mm-export-background:rgb(251 250 248);
        --mm-export-ink:rgb(43 41 38);
        --mm-export-line:rgb(141 139 134);
        --mm-tint-amber:color-mix(in oklab,var(--mm-palette-amber) 20%,var(--mm-surface-1));
        --mm-tint-rose:color-mix(in oklab,var(--mm-palette-rose) 18%,var(--mm-surface-1));
        --mm-tint-sage:color-mix(in oklab,var(--mm-palette-sage) 18%,var(--mm-surface-1));
        --mm-tint-sky:color-mix(in oklab,var(--mm-palette-sky) 18%,var(--mm-surface-1));
        --mm-overview-note:color-mix(in oklab,var(--mm-accent-base) 55%,var(--mm-surface-1));
        --mm-overview-sticky:color-mix(in oklab,var(--dsw-alias-label-primary) 20%,var(--mm-surface-1));
      }
      body[data-ds-dark-theme] .mm-app,body[data-ds-dark-theme] .mm-float,body[data-ds-dark-theme] .mm-panel-icon{
        --mm-accent-base:rgb(228 100 74);
        --mm-surface-0:color-mix(in oklab,var(--dsw-alias-bg-base) 96%,var(--mm-accent-base) 4%);
        --mm-surface-1:color-mix(in oklab,var(--dsw-alias-bg-base) 92%,var(--dsw-alias-label-primary) 8%);
        --mm-surface-2:color-mix(in oklab,var(--dsw-alias-bg-base) 87%,var(--dsw-alias-label-primary) 13%);
        --mm-surface-3:color-mix(in oklab,var(--dsw-alias-bg-base) 82%,var(--dsw-alias-label-primary) 18%);
        --mm-shadow-card:0 1px 2px rgb(0 0 0 / .24),0 12px 28px -20px rgb(0 0 0 / .56);
        --mm-shadow-float:0 2px 6px rgb(0 0 0 / .28),0 16px 36px -12px rgb(0 0 0 / .52);
        --mm-accent-ink:var(--mm-accent-base);
        --mm-on-accent:rgb(21 21 23);
        /* The host's overlay token is a mid grey in the dark theme, which turns
           every floating control (the AI field, menus, hints) into a grey chip.
           A dark theme wants a dark glass tinted by the surface above the board. */
        --mm-overlay:color-mix(in oklab,var(--mm-surface-2) 96%,transparent);
        /* A tint mixed into a dark surface reads as mud, so the dark theme
           lifts the surface first and keeps the hue readable. */
        --mm-tint-amber:color-mix(in oklab,var(--mm-palette-amber) 26%,var(--mm-surface-2));
        --mm-tint-rose:color-mix(in oklab,var(--mm-palette-rose) 24%,var(--mm-surface-2));
        --mm-tint-sage:color-mix(in oklab,var(--mm-palette-sage) 24%,var(--mm-surface-2));
        --mm-tint-sky:color-mix(in oklab,var(--mm-palette-sky) 24%,var(--mm-surface-2));
        --mm-overview-note:color-mix(in oklab,var(--mm-accent-base) 42%,var(--mm-surface-2));
        --mm-overview-sticky:color-mix(in oklab,var(--dsw-alias-label-primary) 26%,var(--mm-surface-2));
      }
      .mm-app{position:relative;height:100%;min-height:0;overflow:hidden;background:var(--mm-surface-0);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:1.6}
      .mm-app *{box-sizing:border-box}
      .mm-app button,.mm-app input,.mm-app textarea,.mm-app select{font:inherit}
      .mm-app button{touch-action:manipulation}
      .mm-app button:focus-visible,.mm-app a:focus-visible,.mm-app input:focus-visible,.mm-app select:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
      .mm-app button:disabled{cursor:not-allowed;opacity:.48}
      .mm-app button:active:not(:disabled){transform:scale(.97)}
      .mm-icon{display:inline-block;flex:none;vertical-align:middle}
      .mm-shell{display:grid;grid-template-columns:var(--mm-side-width,200px) minmax(0,1fr);height:100%;min-height:0}
      .mm-shell.is-collapsed{--mm-side-width:56px}
      .mm-left{display:flex;flex-direction:column;min-height:0;overflow-y:auto;padding:20px 12px 16px;border-right:1px solid var(--mm-line);background:color-mix(in oklab,var(--dsw-specific-sidebar-fill) 97%,var(--mm-accent-base) 3%)}
      .mm-left.is-collapsed{align-items:center;padding:14px 0 16px;overflow:hidden}
      /* 折叠成图标栏：每个入口留一个 32px 的方块，名字靠 title 与 aria-label。 */
      .mm-left.is-collapsed .mm-nav{gap:4px;width:100%;align-items:center;margin-top:8px}
      .mm-left.is-collapsed .mm-nav button{justify-content:center;width:32px;min-height:32px;padding:0;border-radius:var(--dsw-radius-sm)}
      .mm-left.is-collapsed .mm-nav button span,
      .mm-left.is-collapsed .mm-nav button b{display:none}
      .mm-left.is-collapsed .mm-nav button .mm-icon{width:16px;height:16px}
      .mm-left.is-collapsed .mm-nav button.is-active:after{content:"";position:absolute;left:-8px;top:50%;width:2px;height:16px;margin-top:-8px;border-radius:2px;background:var(--mm-accent-base)}
      .mm-side-top{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 8px 10px}
      .mm-side-top .mm-nav-heading{padding:0;margin:0}
      .mm-side-toggle{display:flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:0;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background 120ms ease,color 120ms ease}
      .mm-side-toggle:hover{background:var(--mm-surface-2);color:var(--dsw-alias-label-primary)}
      .mm-side-toggle .mm-icon{transform:rotate(180deg)}
      .mm-side-logo{display:flex;flex-direction:column;align-items:center;gap:6px;padding:6px 4px;border:0;border-radius:var(--dsw-radius-md);background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary);transition:background 120ms ease}
      .mm-side-logo:hover{background:var(--mm-surface-2);color:var(--dsw-alias-label-primary)}
      .mm-side-logo .mm-panel-icon{width:24px;height:24px}
      .mm-nav-heading{padding:0 8px 12px;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase}
      .mm-nav{display:flex;flex-direction:column;gap:4px}
      .mm-nav button{position:relative;display:flex;align-items:center;gap:8px;width:100%;min-height:36px;padding:8px 12px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);text-align:left;cursor:pointer;transition:background-color 100ms ease,color 100ms ease}
      .mm-nav button:hover{background:var(--mm-surface-2);color:var(--dsw-alias-label-primary)}
      .mm-nav button.is-active{background:var(--mm-accent-soft);color:var(--mm-accent-ink);font-weight:600}
      .mm-nav button span{flex:1}
      .mm-nav button b{min-width:20px;font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right}
      .mm-sidebar-tags{margin-top:32px;min-height:0}
      .mm-sidebar-heading{display:flex;align-items:center;justify-content:space-between;padding:0 8px 8px}
      .mm-sidebar-heading h2{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase}
      .mm-sidebar-heading button{min-height:24px;padding:0 4px;border:0;background:transparent;color:var(--mm-accent-ink);font-size:12px;cursor:pointer}
      .mm-tag-tree{display:flex;flex-direction:column;gap:2px}
      .mm-tag-row{display:flex;align-items:center;min-width:0;padding-left:calc(var(--mm-depth) * 12px)}
      .mm-tag-chevron,.mm-tag-spacer{display:flex;align-items:center;justify-content:center;width:24px;height:24px;flex:none}
      .mm-tag-chevron{padding:0;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:transform 200ms cubic-bezier(.23,1,.32,1)}
      .mm-tag-chevron.is-open{transform:rotate(90deg)}
      .mm-tag-button{display:flex;align-items:center;gap:8px;min-width:0;min-height:32px;flex:1;padding:4px 8px 4px 0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;text-align:left;transition:background-color 100ms ease,color 100ms ease}
      .mm-tag-button:hover{background:var(--mm-surface-2);color:var(--dsw-alias-label-primary)}
      .mm-tag-button.is-active{background:var(--mm-accent-soft);color:var(--mm-accent-ink);font-weight:500}
      .mm-tag-name{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .mm-tag-name:before{content:"#";margin-right:4px;color:var(--dsw-alias-label-secondary)}
      .mm-tag-count{font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
      .mm-sidebar-empty{padding:4px 8px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}
      .mm-sidebar-footer{display:flex;align-items:center;gap:8px;margin-top:auto;padding:32px 8px 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.45}
      .mm-local-dot{width:6px;height:6px;flex:none;border-radius:50%;background:var(--mm-accent)}
      .mm-center{display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--mm-surface-0)}
      .mm-titlebar{position:relative;z-index:15;display:grid;grid-template-columns:auto minmax(220px,440px) minmax(0,1fr);grid-template-areas:"title search actions";align-items:center;gap:16px;padding:12px 20px;border-bottom:1px solid var(--mm-line);background:var(--mm-surface-0)}
      .mm-title-row{display:contents}
      .mm-title{grid-area:title;margin:0;color:var(--dsw-alias-label-primary);font-size:18px;font-weight:600;line-height:1.35;letter-spacing:-.01em}
      .mm-toolbar{position:relative;grid-area:search;display:flex;align-items:center;min-width:0}
      .mm-search-wrap{grid-area:search;position:relative;min-width:0;width:100%;max-width:100%;overflow:hidden}
      .mm-search{display:flex;align-items:center;gap:8px;min-width:0;max-width:100%;height:36px;padding:0 12px;border:1px solid var(--mm-line);border-radius:var(--dsw-radius-sm);background:var(--mm-surface-1);color:var(--dsw-alias-label-secondary);transition:border-color 100ms ease,background-color 100ms ease}
      .mm-search:focus-within{border-color:var(--mm-accent-line);background:var(--mm-surface-1)}
      .mm-search input{min-width:0;flex:1;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary);font-size:13px}
      .mm-search input::placeholder{color:var(--dsw-alias-label-secondary)}
      .mm-search kbd{min-width:20px;padding:0 4px;border:1px solid var(--mm-line-strong);border-radius:var(--dsw-radius-xs);background:var(--mm-surface-1);color:var(--dsw-alias-label-secondary);font-size:12px;font-family:inherit;text-align:center}
      .mm-search-clear{display:flex;min-width:24px;min-height:24px;align-items:center;justify-content:center;padding:4px;border:0;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
      .mm-recent-searches{position:absolute;top:calc(100% + 8px);left:0;right:0;z-index:30;padding:8px;border:1px solid var(--mm-line-strong);border-radius:var(--dsw-radius-md);background:var(--mm-overlay);box-shadow:var(--mm-shadow-float);animation:mm-pop-in 150ms cubic-bezier(.23,1,.32,1)}
      .mm-recent-title{padding:4px 8px 8px;color:var(--dsw-alias-label-secondary);font-size:12px}
      .mm-recent-searches button{display:flex;align-items:center;gap:8px;width:100%;min-height:32px;padding:8px;border:0;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;text-align:left;font-size:13px}
      .mm-recent-searches button:hover{background:var(--mm-surface-2);color:var(--dsw-alias-label-primary)}
      .mm-topbar-actions{grid-area:actions;display:flex;align-items:center;justify-self:end;gap:4px;min-width:0;max-width:100%;overflow:hidden}
      .mm-files{position:relative;display:flex;align-items:center}
      .mm-header-button.is-open{background:var(--mm-surface-2);color:var(--dsw-alias-label-primary)}
      .mm-files-menu{position:absolute;right:0;top:calc(100% + 6px);z-index:40;display:flex;flex-direction:column;gap:1px;min-width:196px;padding:4px;border:1px solid var(--mm-line-strong);border-radius:var(--dsw-radius-md);background:var(--mm-overlay);box-shadow:var(--mm-shadow-float)}
      .mm-files-item{display:flex;align-items:center;gap:8px;min-height:30px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;text-align:left;cursor:pointer}
      .mm-files-item:hover:not(:disabled){background:var(--mm-surface-2)}
      .mm-files-item:disabled{opacity:.5;cursor:not-allowed}
      .mm-files-item .mm-icon{color:var(--dsw-alias-label-secondary)}
      .mm-backup-actions{display:flex;align-items:center;gap:4px;padding-left:8px;margin-left:4px;border-left:1px solid var(--mm-line)}
      .mm-header-button{display:inline-flex;align-items:center;justify-content:center;gap:0;width:30px;height:30px;min-height:30px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;white-space:nowrap;transition:background-color 100ms ease,color 100ms ease}
      /* The bar carries icons only; the label survives in title and aria-label. */
      .mm-header-button>span:not(.mm-md-mark){display:none}
      .mm-header-button:hover:not(:disabled){background:var(--mm-surface-2);color:var(--dsw-alias-label-primary)}
      .mm-header-button.is-primary{background:var(--mm-accent-soft);color:var(--mm-accent-ink);font-weight:500}
      .mm-header-button.is-primary:hover:not(:disabled){background:var(--mm-accent-soft);color:var(--mm-accent-ink)}
      .mm-md-mark{display:inline-flex;align-items:center}
      .mm-main-scroll{min-height:0;flex:1;overflow-y:auto;overscroll-behavior:contain;padding:32px clamp(24px,4vw,48px) 64px;scroll-behavior:smooth}
      .mm-main-scroll>*{width:min(100%,880px);margin-left:auto;margin-right:auto}
      .mm-editor{position:relative;margin-bottom:32px;padding:20px;border:1px solid var(--mm-line);border-radius:var(--dsw-radius-md);background:var(--mm-surface-1);box-shadow:var(--mm-shadow-card);transition:border-color 200ms cubic-bezier(.23,1,.32,1),box-shadow 200ms cubic-bezier(.23,1,.32,1)}
      .mm-editor:focus-within{border-color:var(--mm-accent-line);box-shadow:var(--mm-shadow-card),0 0 0 3px var(--mm-accent-ring)}
      .mm-editor.is-editing{border-color:var(--mm-accent-line)}
      .mm-editor-topline{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px}
      .mm-editor-kicker{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;letter-spacing:.02em}
      .mm-editor-input-wrap{position:relative}
      .mm-editor-input{display:block;width:100%;min-height:112px;max-height:420px;padding:0 0 12px;border:0;outline:0;resize:vertical;background:transparent;color:var(--dsw-alias-label-primary);font-size:16px;line-height:1.7}
      .mm-editor-input::placeholder{color:var(--dsw-alias-label-secondary)}
      .mm-editor-input:focus-visible{outline:0}
      .mm-tag-suggestions{position:absolute;left:0;bottom:8px;z-index:25;width:min(320px,100%);padding:8px;border:1px solid var(--mm-line-strong);border-radius:var(--dsw-radius-md);background:var(--mm-overlay);box-shadow:var(--mm-shadow-float);animation:mm-pop-in 150ms cubic-bezier(.23,1,.32,1)}
      .mm-suggestion-title{padding:4px 8px 8px;color:var(--dsw-alias-label-secondary);font-size:12px}
      .mm-suggestion{display:flex;align-items:center;gap:8px;width:100%;min-height:32px;padding:8px;border:0;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;text-align:left;font-size:13px}
      .mm-suggestion:hover,.mm-suggestion.is-active{background:var(--mm-surface-2);color:var(--mm-accent-ink)}
      .mm-attachment-previews{display:flex;gap:8px;overflow-x:auto;padding:4px 0 12px}
      .mm-attachment-preview{position:relative;width:72px;height:72px;flex:none;overflow:hidden;border:1px solid var(--mm-line-strong);border-radius:var(--dsw-radius-sm);background:var(--mm-surface-2)}
      .mm-attachment-preview img{width:100%;height:100%;object-fit:cover}
      .mm-remove-image{position:absolute;top:4px;right:4px;display:flex;width:24px;height:24px;align-items:center;justify-content:center;padding:4px;border:0;border-radius:50%;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);cursor:pointer}
      .mm-inline-editor{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;border:0;background:transparent}
      .mm-inline-editor-input{display:block;width:100%;min-height:88px;max-height:420px;padding:0 0 8px;border:0;outline:0;resize:vertical;background:transparent;color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.7}
      .mm-inline-editor-input:focus-visible{outline:0}
      .mm-inline-attachments{display:flex;gap:8px;overflow-x:auto;padding:4px 0}
      .mm-inline-toolbar{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
      .mm-inline-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding-top:8px}
      .mm-inline-count{margin-right:auto;color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums}
      .mm-inline-send{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:var(--mm-accent);color:var(--mm-on-accent);cursor:pointer;transition:background-color 100ms ease}
      .mm-inline-send:hover:not(:disabled){background:var(--mm-accent-hover)}
      .mm-inline-send:disabled{opacity:.45;cursor:not-allowed}
      .mm-format-toolbar{display:flex;align-items:center;gap:4px;flex-wrap:wrap;padding:12px 0 0}
      .mm-format-button{display:inline-flex;align-items:center;justify-content:center;min-width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;line-height:1;transition:background-color 100ms ease,color 100ms ease}
      .mm-format-button:hover:not(:disabled){background:var(--mm-surface-2);color:var(--dsw-alias-label-primary)}
      .mm-format-button:disabled{opacity:.45;cursor:not-allowed}
      .mm-format-hint{margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:12px}
      .mm-editor-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:12px}
      .mm-editor-tools{display:flex;align-items:center;gap:4px;min-width:0}
      .mm-editor-icon-button{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color 100ms ease,color 100ms ease}
      .mm-editor-icon-button:hover:not(:disabled){background:var(--mm-surface-2);color:var(--dsw-alias-label-primary)}
      .mm-editor-icon-button.is-active{background:var(--mm-accent-soft);color:var(--mm-accent-ink)}
      .mm-editor-icon-button:disabled{opacity:.45;cursor:not-allowed}
      .mm-editor-actions{display:flex;align-items:center;gap:8px}
      .mm-editor-count{color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums}
      .mm-editor-send{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:var(--mm-accent);color:var(--mm-on-accent);cursor:pointer;transition:background-color 100ms ease}
      .mm-editor-send:hover:not(:disabled){background:var(--mm-accent-hover)}
      .mm-editor-send:disabled{opacity:.45;cursor:not-allowed}
      .mm-tool-button{display:inline-flex;align-items:center;gap:8px;min-height:28px;padding:4px 0;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;white-space:nowrap}
      .mm-tool-button:hover{color:var(--mm-accent-ink)}
      .mm-editor-hint{margin-left:8px;color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap}
      .mm-save-button,.mm-primary-button,.mm-secondary-button,.mm-danger-button{display:inline-flex;align-items:center;justify-content:center;min-height:36px;padding:8px 16px;border:1px solid transparent;border-radius:var(--dsw-radius-sm);cursor:pointer;font-size:13px;font-weight:600;white-space:nowrap;transition:background-color 100ms ease,color 100ms ease}
      .mm-save-button,.mm-primary-button{background:var(--mm-accent);color:var(--mm-on-accent)}
      .mm-save-button:hover:not(:disabled),.mm-primary-button:hover:not(:disabled){background:var(--mm-accent-hover)}
      .mm-secondary-button{border-color:var(--mm-line-strong);background:var(--mm-surface-1);color:var(--dsw-alias-label-primary)}
      .mm-secondary-button:hover:not(:disabled){background:var(--mm-surface-2)}
      .mm-danger-button{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-base)}
      .mm-text-button{display:inline-flex;align-items:center;gap:4px;min-height:28px;padding:4px;border:0;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--mm-accent-ink);cursor:pointer;font-size:12px}
      .mm-text-button:hover{text-decoration:underline}
      .mm-text-button.is-quiet{color:var(--dsw-alias-label-secondary)}
      .mm-text-button.is-quiet:hover{color:var(--dsw-alias-label-primary);text-decoration:none}
      .mm-timeline-toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:24px}
      .mm-timeline-toolbar>div:first-child{display:flex;align-items:baseline;gap:8px}
      .mm-timeline-toolbar h1{margin:0;font-size:18px;font-weight:600;letter-spacing:-.01em}
      .mm-timeline-toolbar span{color:var(--dsw-alias-label-secondary);font-size:12px}
      .mm-filter-controls{display:flex;align-items:center;gap:8px}
      .mm-filter-controls select{max-width:144px;min-height:32px;padding:4px 24px 4px 8px;border:1px solid var(--mm-line);border-radius:var(--dsw-radius-sm);background:var(--mm-surface-1);color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}
      .mm-timeline{display:flex;flex-direction:column;gap:32px}
      .mm-day-group{position:relative;display:grid;grid-template-columns:88px minmax(0,1fr);gap:16px;align-items:start}
      .mm-day-group:before{display:none}
      .mm-day-marker{position:sticky;top:16px;display:flex;flex-direction:column;align-items:flex-start;gap:4px;padding:12px 0 0 16px;border-left:1px solid var(--mm-line);text-align:left}
      .mm-day-marker:before{content:"";position:absolute;left:-1px;top:12px;width:2px;height:20px;border-radius:999px;background:var(--mm-accent)}
      .mm-day-marker h2{margin:0;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:1.4}
      .mm-day-marker span{color:var(--dsw-alias-label-secondary);font-size:12px}
      .mm-day-notes{position:relative;display:flex;flex-direction:column;gap:12px}
      .mm-day-notes:before{display:none}
      .mm-note-card{position:relative;padding:20px;border:1px solid var(--mm-line);border-radius:var(--dsw-radius-md);background:var(--mm-surface-1);box-shadow:none;transition:border-color 200ms cubic-bezier(.23,1,.32,1),background-color 200ms cubic-bezier(.23,1,.32,1)}
      .mm-note-card:hover{border-color:var(--mm-line-strong)}
      .mm-note-card.is-editing{border-color:var(--mm-accent);box-shadow:0 0 0 3px var(--mm-accent-ring)}
      .mm-note-card.is-pinned{border-left:2px solid var(--mm-accent)}
      .mm-note-header{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px}
      .mm-note-time{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums}
      .mm-note-time>span{padding:0 4px;border-radius:var(--dsw-radius-xs);background:var(--mm-surface-2)}
      .mm-pinned-badge{display:inline-flex;align-items:center;gap:4px;color:var(--mm-accent-ink);font-size:12px;font-weight:500}
      .mm-note-content{position:relative;color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.75;overflow-wrap:anywhere;cursor:text}
      .mm-note-content.is-collapsed{max-height:196px;overflow:hidden}
      .mm-note-content.is-collapsed:after{content:"";position:absolute;left:0;right:0;bottom:0;height:48px;background:linear-gradient(transparent,var(--mm-surface-1));pointer-events:none}
      .mm-safe-text{display:flex;flex-direction:column;gap:4px}
      .mm-text-line{min-height:1.4em;white-space:pre-wrap}
      .mm-text-line.is-bullet{display:flex;gap:8px;padding-left:4px}
      .mm-text-line.is-ordered .mm-bullet{min-width:16px;text-align:right;font-variant-numeric:tabular-nums}
      .mm-bullet{color:var(--dsw-alias-label-secondary)}
      .mm-heading{font-weight:600;color:var(--dsw-alias-label-primary);line-height:1.4}
      .mm-heading.is-level-1{font-size:18px}
      .mm-heading.is-level-2{font-size:16px}
      .mm-heading.is-level-3{font-size:14px}
      .mm-quote{padding-left:12px;border-left:2px solid var(--mm-line-strong);color:var(--dsw-alias-label-secondary)}
      .mm-strike{text-decoration:line-through;color:var(--dsw-alias-label-secondary)}
      .mm-italic{font-style:italic}
      .mm-inline-code{padding:1px 4px;border-radius:var(--dsw-radius-xs);background:var(--mm-surface-2);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}
      .mm-inline-link{color:var(--mm-accent-ink);text-decoration:none;overflow-wrap:anywhere}
      .mm-inline-link:hover{text-decoration:underline}
      .mm-inline-tag{display:inline;padding:1px 4px;border:0;border-radius:var(--dsw-radius-xs);background:var(--mm-accent-soft);color:var(--mm-accent-ink);cursor:pointer;font:inherit;line-height:inherit}
      .mm-inline-tag:hover{text-decoration:underline}
      .mm-expand-button{min-height:28px;margin:8px 0 0;padding:4px 0;border:0;background:transparent;color:var(--mm-accent-ink);cursor:pointer;font-size:12px;font-weight:500}
      .mm-note-images{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:8px;margin-top:16px}
      .mm-note-image-link{display:block;height:124px;overflow:hidden;border:1px solid var(--mm-line);border-radius:var(--dsw-radius-sm);background:var(--mm-surface-2)}
      .mm-note-image-link img{width:100%;height:100%;object-fit:cover;transition:transform 200ms cubic-bezier(.23,1,.32,1)}
      .mm-note-image-link:hover img{transform:scale(1.025)}
      .mm-note-actions{display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-top:16px}
      .mm-action{display:inline-flex;align-items:center;gap:4px;min-height:28px;padding:4px 8px;border:0;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;transition:background-color 100ms ease,color 100ms ease}
      .mm-action:hover:not(:disabled){background:var(--mm-surface-2);color:var(--dsw-alias-label-primary)}
      .mm-action.is-danger{margin-left:auto}
      .mm-action.is-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary)}
      .mm-deleted-hint{margin-top:12px;color:var(--dsw-alias-label-secondary);font-size:12px}
      .mm-trash-banner{display:flex;align-items:flex-start;gap:12px;margin-bottom:32px;padding:16px;border:1px solid color-mix(in oklab,var(--dsw-alias-state-warn-primary) 32%,transparent);border-radius:var(--dsw-radius-md);background:color-mix(in oklab,var(--dsw-alias-state-warn-primary) 8%,var(--mm-surface-1));color:var(--dsw-alias-label-primary)}
      .mm-trash-banner>.mm-icon{margin-top:2px;color:var(--dsw-alias-state-warn-primary)}
      .mm-trash-banner>div{display:flex;flex-direction:column;gap:4px}
      .mm-trash-banner span{color:var(--dsw-alias-label-secondary);font-size:12px}
      .mm-empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:240px;padding:32px 24px;text-align:center}
      .mm-empty-illustration{display:flex;align-items:center;justify-content:center;width:48px;height:48px;margin-bottom:16px;border:0;border-radius:var(--dsw-radius-md);background:var(--mm-accent-soft);color:var(--mm-accent-ink)}
      .mm-empty-state h2{margin:0 0 8px;color:var(--dsw-alias-label-primary);font-size:16px;font-weight:600}
      .mm-empty-state p{max-width:400px;margin:0 0 16px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.55}
      .mm-loading{display:flex;align-items:center;justify-content:center;gap:8px;min-height:180px;color:var(--dsw-alias-label-secondary);font-size:13px}
      .mm-spinner{width:18px;height:18px;border:2px solid var(--mm-line-strong);border-top-color:var(--mm-accent);border-radius:50%;animation:mm-spin .8s linear infinite}
      @keyframes mm-spin{to{transform:rotate(360deg)}}
      .mm-error-banner{display:flex;align-items:center;gap:8px;padding:12px 20px;border-bottom:1px solid color-mix(in oklab,var(--dsw-alias-state-error-primary) 36%,transparent);background:color-mix(in oklab,var(--dsw-alias-state-error-primary) 8%,var(--mm-surface-1));color:var(--dsw-alias-state-error-primary);font-size:12px}
      .mm-error-banner span{display:flex;align-items:center;gap:8px;min-width:0;flex:1;overflow-wrap:anywhere}
      .mm-error-logid{padding:1px 6px;border-radius:var(--dsw-radius-xs);background:color-mix(in oklab,var(--dsw-alias-state-error-primary) 12%,transparent);font-family:var(--mm-mono-font,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;white-space:nowrap}
      .mm-diagnostics{display:flex;flex-direction:column;gap:12px;min-width:0}
      .mm-diagnostics-hint{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;overflow-wrap:anywhere}
      .mm-diagnostics-list{display:flex;flex-direction:column;gap:8px;max-height:46vh;margin:0;padding:0;overflow-y:auto;list-style:none;scrollbar-width:none}
      .mm-diagnostics-list::-webkit-scrollbar{display:none}
      .mm-diagnostics-row{display:flex;flex-direction:column;gap:4px;padding:10px;border:1px solid var(--mm-line);border-radius:var(--dsw-radius-sm);background:var(--mm-surface-1)}
      .mm-diagnostics-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:11px}
      .mm-diagnostics-id{color:var(--dsw-alias-label-primary);font-weight:600}
      .mm-diagnostics-code{color:var(--dsw-alias-state-error-primary)}
      .mm-diagnostics-message{margin:0;color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.5;overflow-wrap:anywhere}
      .mm-diagnostics-detail{margin:0;color:var(--dsw-alias-state-warn-primary);font-size:11px;line-height:1.5;overflow-wrap:anywhere}
      .mm-diagnostics-empty{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px}
      .mm-diagnostics-actions{display:flex;gap:8px;justify-content:flex-end}
      .mm-error-banner button{min-height:28px;padding:4px 8px;border:0;border-radius:var(--dsw-radius-xs);background:transparent;color:inherit;cursor:pointer;font-size:12px}
      .mm-error-banner button:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}
      .mm-partial-banner{display:flex;align-items:center;gap:8px;padding:12px 20px;border-bottom:1px solid color-mix(in oklab,var(--dsw-alias-state-warn-primary) 32%,transparent);background:color-mix(in oklab,var(--dsw-alias-state-warn-primary) 8%,var(--mm-surface-1));color:var(--dsw-alias-label-primary);font-size:12px}
      .mm-partial-banner>.mm-icon{flex:none;color:var(--dsw-alias-state-warn-primary)}
      .mm-partial-banner span{min-width:0;flex:1;overflow-wrap:anywhere}
      .mm-partial-banner button{min-height:28px;padding:4px 8px;border:0;border-radius:var(--dsw-radius-xs);background:transparent;color:inherit;cursor:pointer;font-size:12px;white-space:nowrap}
      .mm-partial-banner button:hover{background:var(--mm-surface-2)}
      .mm-inline-error{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:12px 0;padding:12px;border:1px solid color-mix(in oklab,var(--dsw-alias-state-error-primary) 36%,transparent);border-radius:var(--dsw-radius-sm);background:color-mix(in oklab,var(--dsw-alias-state-error-primary) 6%,var(--mm-surface-1));color:var(--dsw-alias-state-error-primary);font-size:12px}
      .mm-inline-error button{min-height:28px;border:0;background:transparent;color:inherit;cursor:pointer;text-decoration:underline}
      .mm-muted{color:var(--dsw-alias-label-secondary)}
      .mm-stats-panel{display:flex;flex-direction:column;gap:24px}
      .mm-section-heading{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px}
      .mm-section-heading h3{margin:0;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600}
      .mm-section-heading span{color:var(--dsw-alias-label-secondary);font-size:12px}
      .mm-stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
      .mm-stat-card{display:flex;flex-direction:column;padding:16px;border:1px solid var(--mm-line);border-radius:var(--dsw-radius-md);background:var(--mm-surface-1)}
      .mm-stat-card strong{font-size:18px;font-weight:600;line-height:1.3;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
      .mm-stat-card span{margin-top:4px;color:var(--dsw-alias-label-secondary);font-size:12px}
      .mm-stat-card.is-primary{background:var(--mm-accent-soft);color:var(--mm-accent-ink);border-color:var(--mm-accent-line)}
      .mm-stat-card.is-primary span{color:var(--mm-accent-ink)}
      .mm-stat-details{display:flex;flex-wrap:wrap;gap:8px 12px;margin-top:12px;color:var(--dsw-alias-label-secondary);font-size:12px}
      .mm-heatmap-grid{display:grid;grid-template-rows:repeat(7,9px);grid-auto-flow:column;grid-auto-columns:minmax(7px,1fr);gap:3px;width:100%}
      .mm-heat-cell{min-width:0;padding:0;border:0;border-radius:var(--dsw-radius-xs);cursor:pointer}
      .mm-heat-cell.level-0,.mm-heatmap-legend .level-0{background:var(--mm-surface-2)}
      .mm-heat-cell.level-1,.mm-heatmap-legend .level-1{background:color-mix(in oklab,var(--mm-accent-base) 22%,var(--mm-surface-2))}
      .mm-heat-cell.level-2,.mm-heatmap-legend .level-2{background:color-mix(in oklab,var(--mm-accent-base) 45%,var(--mm-surface-2))}
      .mm-heat-cell.level-3,.mm-heatmap-legend .level-3{background:color-mix(in oklab,var(--mm-accent-base) 68%,var(--mm-surface-2))}
      .mm-heat-cell.level-4,.mm-heatmap-legend .level-4{background:var(--mm-accent-base)}
      .mm-heat-cell:hover,.mm-heat-cell.is-selected{outline:2px solid var(--dsw-alias-label-primary);outline-offset:1px}
      .mm-heatmap-legend{display:flex;align-items:center;justify-content:flex-end;gap:4px;margin-top:8px;color:var(--dsw-alias-label-secondary);font-size:12px}
      .mm-heatmap-legend i{width:8px;height:8px;border-radius:var(--dsw-radius-xs)}
      .mm-review-heading{margin-bottom:24px}
      .mm-review-heading h1{margin:0 0 4px;font-size:18px;line-height:1.4;font-weight:600}
      .mm-review-heading p{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px}
      .mm-review-controls{display:flex;gap:8px;margin-bottom:24px}
      .mm-review-controls button{display:inline-flex;align-items:center;gap:8px;min-height:36px;padding:8px 12px;border:1px solid var(--mm-line);border-radius:var(--dsw-radius-sm);background:var(--mm-surface-1);color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:13px;transition:border-color 100ms ease,background-color 100ms ease,color 100ms ease}
      .mm-review-controls button.is-active{border-color:var(--mm-accent-line);background:var(--mm-accent-soft);color:var(--mm-accent-ink);font-weight:500}
      .mm-review-notes{display:flex;flex-direction:column;gap:12px}
      .mm-review-count{color:var(--dsw-alias-label-secondary);font-size:12px}
      .mm-note-card.is-compact{padding:20px}
      .mm-float{position:fixed;right:24px;bottom:24px;z-index:220;width:min(360px,calc(100vw - 32px));overflow:hidden;border:1px solid var(--mm-line-strong);border-radius:var(--dsw-radius-lg);background:var(--mm-surface-1);box-shadow:var(--mm-shadow-float);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:1.6}
      .mm-float *{box-sizing:border-box}
      .mm-float button,.mm-float textarea{font:inherit}
      .mm-float button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
      .mm-float textarea:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
      .mm-float-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 16px;border-bottom:1px solid var(--mm-line);cursor:grab;user-select:none}
      .mm-float-title{font-size:13px;font-weight:600}
      .mm-float-actions{display:flex;align-items:center;gap:4px}
      .mm-float-button{display:inline-flex;align-items:center;justify-content:center;min-width:28px;min-height:28px;padding:4px 8px;border:0;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;transition:background-color 100ms ease,color 100ms ease}
      .mm-float-button:hover:not(:disabled){background:var(--mm-surface-2);color:var(--dsw-alias-label-primary)}
      .mm-float-button.is-active{color:var(--mm-accent-ink)}
      .mm-float-body{display:flex;flex-direction:column;gap:12px;padding:16px}
      .mm-float-input{display:block;width:100%;min-height:88px;resize:vertical;padding:0;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:1.7}
      .mm-float-input::placeholder{color:var(--dsw-alias-label-secondary)}
      .mm-float-input:focus-visible{outline:0}
      .mm-float-error{padding:12px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-state-error-primary);font-size:12px}
      .mm-float-footer{display:flex;align-items:center;gap:8px}
      .mm-float-count{margin-right:auto;color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums}
      .mm-float-save{min-height:32px;padding:4px 16px;border:0;border-radius:var(--dsw-radius-sm);background:var(--mm-accent);color:var(--mm-on-accent);cursor:pointer;font-size:13px;font-weight:600;transition:background-color 100ms ease}
      .mm-float-save:hover:not(:disabled){background:var(--mm-accent-hover)}
      .mm-float-save:disabled{opacity:.45;cursor:not-allowed}
      .mm-float-list{display:flex;flex-direction:column;gap:4px;margin:0;padding:12px 0 0;border-top:1px solid var(--mm-line);list-style:none}
      .mm-float-note{display:block;width:100%;min-height:44px;padding:8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit;transition:background-color 100ms ease}
      .mm-float-note:hover{background:var(--mm-surface-2)}
      .mm-float-note time{display:block;color:var(--dsw-alias-label-secondary);font-size:12px}
      .mm-float-note span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
      .mm-overlay{position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;padding:24px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 28%,transparent);backdrop-filter:blur(3px);animation:mm-fade-in 200ms cubic-bezier(.23,1,.32,1)}
      .mm-dialog{display:flex;flex-direction:column;width:min(620px,100%);max-height:min(780px,90vh);overflow:hidden;border:1px solid var(--mm-line-strong);border-radius:var(--dsw-radius-lg);background:var(--mm-surface-1);box-shadow:var(--mm-shadow-float);animation:mm-dialog-in 200ms cubic-bezier(.23,1,.32,1)}
      @keyframes mm-fade-in{from{opacity:0}to{opacity:1}}
      @keyframes mm-dialog-in{from{opacity:0;transform:translateY(8px) scale(.96)}to{opacity:1;transform:none}}
      @keyframes mm-pop-in{from{opacity:0;transform:translateY(4px) scale(.96)}to{opacity:1;transform:none}}
      .mm-dialog-header{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--mm-line)}
      .mm-dialog-header h2{margin:0;font-size:16px;font-weight:600}
      .mm-icon-button{display:flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color 100ms ease,color 100ms ease}
      .mm-icon-button:hover{background:var(--mm-surface-2);color:var(--dsw-alias-label-primary)}
      .mm-related-source{margin:20px 20px 0;padding:12px 16px;border-left:2px solid var(--mm-accent);border-radius:0 var(--dsw-radius-md) var(--dsw-radius-md) 0;background:var(--mm-surface-2)}
      .mm-related-source>span{display:block;margin-bottom:4px;color:var(--dsw-alias-label-secondary);font-size:12px}
      .mm-related-source .mm-safe-text{max-height:100px;overflow-y:auto;font-size:13px}
      .mm-related-body{display:flex;flex-direction:column;gap:12px;min-height:100px;overflow-y:auto;padding:20px}
      .mm-related-card{padding:16px;border:1px solid var(--mm-line);border-radius:var(--dsw-radius-md);background:var(--mm-surface-1)}
      .mm-related-card time{display:block;margin-bottom:4px;color:var(--dsw-alias-label-secondary);font-size:12px}
      .mm-related-card .mm-safe-text{font-size:13px}
      .mm-dialog-empty{padding:24px 0;color:var(--dsw-alias-label-secondary);font-size:13px;text-align:center}
      .mm-confirm-dialog{width:min(440px,100%);padding-bottom:20px}
      .mm-confirm-body{margin:0;padding:20px 20px 0;color:var(--dsw-alias-label-secondary);font-size:14px}
      .mm-confirm-warning{margin:12px 20px 0;padding:12px;border-radius:var(--dsw-radius-sm);background:color-mix(in oklab,var(--dsw-alias-state-warn-primary) 10%,var(--mm-surface-1));color:var(--dsw-alias-label-primary);font-size:12px}
      .mm-dialog-actions{display:flex;justify-content:flex-end;gap:8px;padding:20px 20px 0}
      .mm-import-dialog{width:min(500px,100%);padding-bottom:20px}
      .mm-import-file{display:flex;align-items:center;gap:12px;margin:20px 20px 0;padding:16px;border:1px solid var(--mm-line);border-radius:var(--dsw-radius-md);background:var(--mm-surface-2);color:var(--mm-accent-ink)}
      .mm-import-file>div{display:flex;flex-direction:column;min-width:0}
      .mm-import-file strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:13px}
      .mm-import-file span{color:var(--dsw-alias-label-secondary);font-size:12px}
      .mm-dialog-description{margin:12px 20px;color:var(--dsw-alias-label-secondary);font-size:13px}
      .mm-import-options{display:flex;justify-content:flex-end;gap:8px;padding:4px 20px 0}
      .mm-stats-dialog{width:min(560px,100%)}
      .mm-stats-dialog>.mm-stats-panel{overflow-y:auto;padding:20px}
      .mm-toast{position:absolute;left:224px;right:auto;bottom:24px;z-index:150;display:flex;align-items:center;gap:8px;max-width:calc(100% - 248px);padding:12px 16px;border:0;border-radius:999px;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);box-shadow:var(--mm-shadow-float);font-size:13px;animation:mm-toast-in 200ms cubic-bezier(.23,1,.32,1)}
      .mm-toast-check{display:inline-flex;color:currentColor}
      @keyframes mm-toast-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
      /* The infinite canvas. The dot grid is the one device the canvas adds;
         every surface, line and radius still comes from the Moments paper
         tokens, and the accent is reserved for what is selected. */
      .mm-main-scroll.is-canvas{display:flex;overflow:hidden;padding:0}
      .mm-main-scroll.is-canvas>*{width:100%;max-width:none;margin:0;min-height:0}
      .mm-canvas-stage{position:relative;display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden;background:var(--mm-surface-0)}
      .mm-canvas-bar{position:relative;display:flex;align-items:center;gap:12px;height:48px;padding:0 12px;border-bottom:1px solid var(--mm-line);background:var(--mm-surface-1);z-index:6}
      .mm-canvas-bar-left{display:flex;align-items:center;gap:6px;flex:none;min-width:0}
      .mm-canvas-tools{display:flex;align-items:center;justify-content:flex-start;gap:2px;flex:1;min-width:0}
      .mm-canvas-tools-gap{width:1px;height:18px;margin:0 6px;background:var(--mm-line);flex:none}
      .mm-canvas-tool-caption{display:inline-flex;align-items:center;gap:8px;min-width:0;margin-left:14px;overflow:hidden;white-space:nowrap;font-size:11.5px;line-height:1.2;color:var(--dsw-alias-label-secondary)}
      .mm-canvas-tool-caption b{flex:none;font-weight:600;color:var(--dsw-alias-label-primary)}
      .mm-canvas-tool-caption span{min-width:0;overflow:hidden;text-overflow:ellipsis}
      .mm-canvas-tool-caption kbd{flex:none;padding:1px 5px;border:1px solid var(--mm-line);border-radius:var(--dsw-radius-xs);background:var(--mm-surface-2);color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:10.5px}
      .mm-canvas-toolbar-gap{width:1px;height:20px;margin:0 4px;background:var(--mm-line);flex:none}
      .mm-canvas-select{height:28px;max-width:260px;padding:0 8px;border:1px solid var(--mm-line);border-radius:var(--dsw-radius-sm);background:var(--mm-surface-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
      .mm-canvas-bar-button{display:inline-flex;align-items:center;gap:8px;height:32px;padding:0 12px;border:1px solid var(--mm-line);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;cursor:pointer;transition:background-color 100ms ease,color 100ms ease}
      .mm-canvas-bar-button:hover:not(:disabled){background:var(--mm-surface-2);color:var(--dsw-alias-label-primary)}
      .mm-canvas-perf{font-variant-numeric:tabular-nums;font-size:11px;line-height:1;color:var(--dsw-alias-label-secondary);white-space:nowrap;padding:0 6px;border:1px solid var(--mm-line);border-radius:var(--dsw-radius-xs);height:22px;display:inline-flex;align-items:center}
      .mm-canvas-status{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;flex:none}
      .mm-canvas-status-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary,var(--mm-line-strong));transition:background-color 120ms ease}
      .mm-canvas-status.is-saving .mm-canvas-status-dot{background:var(--dsw-alias-state-warn-primary);animation:mm-save-pulse 1.2s ease-in-out infinite}
      .mm-canvas-status.is-saved .mm-canvas-status-dot{background:var(--dsw-alias-state-success-primary,rgb(52 168 83))}
      .mm-canvas-status.is-error .mm-canvas-status-dot{background:var(--dsw-alias-state-error-primary)}
      @keyframes mm-save-pulse{0%,100%{opacity:1}50%{opacity:.35}}
      @media(prefers-reduced-motion: reduce){.mm-canvas-status.is-saving .mm-canvas-status-dot{animation:none}}
      .mm-canvas-status.is-saved{color:var(--mm-accent-ink)}
      .mm-canvas-status.is-error{color:var(--dsw-alias-state-error-primary)}
      .mm-canvas-hint{display:flex;align-items:center;gap:8px;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px}
      .mm-canvas-hint span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .mm-canvas-body{position:relative;flex:1;min-height:0;overflow:hidden}
      .mm-canvas-body.is-inspector .mm-canvas-surface{right:280px}
      .mm-canvas-connect-hint{position:absolute;left:50%;top:16px;transform:translateX(-50%);z-index:4;padding:8px 12px;border:1px solid var(--mm-line-strong);border-radius:var(--dsw-radius-sm);background:var(--mm-overlay);box-shadow:var(--mm-shadow-float);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.4;white-space:nowrap}
      .mm-canvas-body.is-inspector .mm-canvas-connect-hint{left:calc(50% - 140px)}
      /* The AI field folds out of the bottom-left corner. It is anchored left so
         the connector style panel, which owns the bottom-centre strip, can never
         sit on top of it; when a connector is selected the field lifts clear of
         that panel instead of relying on stacking order. */
      .mm-canvas-dock{position:absolute;left:16px;bottom:16px;z-index:9;display:flex;align-items:center;gap:8px;width:min(440px,calc(100% - 32px));padding:6px;border:1px solid var(--mm-line-strong);border-radius:var(--dsw-radius-lg);background:var(--mm-overlay);box-shadow:var(--mm-shadow-float);color:var(--dsw-alias-label-secondary)}
      .mm-canvas-dock.is-lifted{bottom:76px}
      .mm-canvas-ai-launcher{position:absolute;left:16px;bottom:16px;z-index:9;display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 12px;border:1px solid var(--mm-line-strong);border-radius:999px;background:var(--mm-overlay);box-shadow:var(--mm-shadow-float);color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;cursor:pointer;transition:color 100ms ease,border-color 100ms ease}
      /* The import report is evidence about a board, so it reads like a record:
         sections, counts, and the names of what did not come through. */
      .mm-canvas-report{position:absolute;right:16px;bottom:64px;z-index:10;width:min(360px,calc(100% - 32px));max-height:min(420px,calc(100% - 96px));display:flex;flex-direction:column;border:1px solid var(--mm-line-strong);border-radius:var(--dsw-radius-lg);background:var(--mm-overlay);box-shadow:var(--mm-shadow-float);color:var(--dsw-alias-label-primary);overflow:hidden}
      .mm-canvas-report-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border-bottom:1px solid var(--mm-line)}
      .mm-canvas-report-title{font-size:12px;font-weight:600;letter-spacing:0.01em}
      .mm-canvas-report-close{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
      .mm-canvas-report-close:hover{background:var(--mm-surface-2);color:var(--dsw-alias-label-primary)}
      .mm-canvas-report-body{display:flex;flex-direction:column;gap:10px;padding:12px;overflow:auto}
      .mm-canvas-report-source{margin:0;font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-word}
      .mm-canvas-report-section{display:flex;flex-direction:column;gap:4px}
      .mm-canvas-report-label{font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
      .mm-canvas-report-text{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
      .mm-canvas-report-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px}
      .mm-canvas-report-item{display:flex;flex-direction:column;gap:2px}
      .mm-canvas-report-count{font-size:12px;font-weight:600}
      .mm-canvas-report-samples{font-size:11px;line-height:1.45;color:var(--dsw-alias-label-secondary);word-break:break-word}
      .mm-canvas-report-hint{margin:0;font-size:11px;line-height:1.45;color:var(--dsw-alias-label-secondary)}
      .mm-canvas-ai-launcher:hover{color:var(--dsw-alias-label-primary);border-color:var(--mm-accent-base)}
      .mm-canvas-ai-launcher:focus-visible{outline:2px solid var(--mm-accent-base);outline-offset:2px}
      .mm-canvas-ai-close{width:30px;height:30px;flex:none;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
      .mm-canvas-ai-close:hover{background:var(--mm-surface-2);color:var(--dsw-alias-label-primary)}
      .mm-canvas-ai-input{flex:1;min-width:0;height:30px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}
      .mm-canvas-ai-input::placeholder{color:var(--dsw-alias-label-tertiary,var(--mm-line-strong))}
      .mm-canvas-ai-send{width:30px;height:30px;flex:none;border:1px solid var(--mm-line);border-radius:var(--dsw-radius-sm);background:var(--mm-surface-2);color:var(--dsw-alias-label-primary);display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
      .mm-canvas-ai-send:disabled{opacity:.45;cursor:default}
      .mm-inspector-actions{display:flex;flex-wrap:wrap;gap:6px}
      .mm-inspector-grow{flex:1;min-width:0;height:22px;padding:0 4px;border:1px solid var(--mm-line);border-radius:var(--dsw-radius-xs);background:var(--mm-surface-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px}
      .mm-canvas-versions{position:absolute;right:16px;top:16px;z-index:7;width:320px;max-height:60%;display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--mm-line);border-radius:var(--dsw-radius-md);background:var(--mm-surface-1);box-shadow:var(--mm-shadow-card);overflow:hidden}
      .mm-canvas-versions-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
      .mm-canvas-versions-list{list-style:none;margin:0;padding:0;overflow-y:auto;display:flex;flex-direction:column;gap:4px}
      .mm-canvas-versions-row{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-secondary)}
      .mm-canvas-versions-when{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .mm-canvas-versions-count{flex:none;font-variant-numeric:tabular-nums}
      .mm-canvas-grid{position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:0}
      .mm-canvas-grid-band{position:absolute;background:color-mix(in oklab,var(--mm-accent-base) 10%,transparent);outline:1px solid color-mix(in oklab,var(--mm-accent-base) 24%,transparent)}
      .mm-inspector-swatch{width:24px;height:24px;flex:none;padding:0;border:1px solid var(--mm-line-strong);border-radius:var(--dsw-radius-sm);cursor:pointer}
      .mm-inspector-swatch.is-active{outline:2px solid var(--mm-accent-base);outline-offset:1px}
      .mm-canvas-body.is-inspector .mm-canvas-zoom{right:296px}
      .mm-canvas-style.is-hidden{display:none}
      .mm-inspector-header{position:relative;display:flex;flex-direction:column;gap:4px;padding:16px 40px 12px 12px;border-bottom:1px solid var(--mm-line)}
      /* The way out of the panel lives in the panel: a chevron at its top edge. */
      .mm-inspector-collapse{position:absolute;top:10px;right:8px;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
      .mm-inspector-collapse:hover{background:var(--mm-surface-2);color:var(--dsw-alias-label-primary)}
      .mm-inspector-collapse:focus-visible{outline:2px solid var(--mm-accent-base);outline-offset:1px}
      /* Collapsed: a tab stays where the panel was, so reopening is one click. */
      .mm-canvas-inspector-open{position:absolute;top:8px;right:8px;z-index:6;display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 10px;border:1px solid var(--mm-line-strong);border-radius:var(--dsw-radius-sm);background:var(--mm-overlay);box-shadow:var(--mm-shadow-card);color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}
      .mm-canvas-inspector-open:hover{color:var(--dsw-alias-label-primary);border-color:var(--mm-accent-base)}
      .mm-canvas-inspector-open:focus-visible{outline:2px solid var(--mm-accent-base);outline-offset:1px}
      .mm-canvas-inspector-open-icon{display:inline-flex;transform:scaleX(-1)}
      .mm-inspector-object{overflow:hidden;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:1.4;text-overflow:ellipsis;white-space:nowrap}
      .mm-inspector-meta{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.45}
      .mm-canvas-inspector{position:absolute;top:0;right:0;bottom:0;width:280px;max-width:100%;z-index:5;display:flex;flex-direction:column;overflow-y:auto;overflow-x:hidden;border-left:1px solid var(--mm-line);background:var(--mm-surface-1);scrollbar-width:none}
      .mm-canvas-inspector::-webkit-scrollbar{display:none}
      .mm-inspector-section{display:flex;flex-direction:column;gap:8px;padding:16px 12px;border-bottom:1px solid var(--mm-line)}
      .mm-inspector-title{margin:0;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
      .mm-inspector-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px;min-width:0}
      .mm-inspector-field{display:flex;align-items:center;gap:6px;min-width:0;height:28px;padding:0 8px;border:1px solid var(--mm-line);border-radius:var(--dsw-radius-sm);background:var(--mm-surface-1)}
      .mm-inspector-field .mm-inspector-label{flex:none}
      .mm-inspector-label{font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
      .mm-inspector-input{flex:1;min-width:0;height:22px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;font-variant-numeric:tabular-nums;outline:none}
      .mm-inspector-row{display:flex;align-items:center;gap:8px;min-height:28px;min-width:0;flex-wrap:wrap}
      .mm-inspector-row .mm-inspector-select{min-width:0}
      .mm-inspector-section>*{min-width:0}
      .mm-canvas-dock{max-width:calc(100% - 32px)}
      .mm-inspector-color{width:32px;height:28px;padding:2px;border:1px solid var(--mm-line);border-radius:var(--dsw-radius-sm);background:transparent;cursor:pointer}
      .mm-inspector-select{flex:1;height:28px;padding:0 8px;border:1px solid var(--mm-line);border-radius:var(--dsw-radius-sm);background:var(--mm-surface-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
      .mm-inspector-chip{height:auto;min-height:28px;padding:2px 8px;border:1px solid var(--mm-line);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
      .mm-inspector-chip:hover{background:var(--mm-surface-2);color:var(--dsw-alias-label-primary)}
      .mm-inspector-chip.is-active{background:var(--mm-accent-soft);color:var(--mm-accent-ink);border-color:var(--mm-accent-line);font-weight:500}
      .mm-inspector-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
      .mm-canvas-surface{position:absolute;inset:0;overflow:hidden;touch-action:none;background-color:var(--dsw-alias-bg-base);background-image:radial-gradient(circle,color-mix(in oklab,var(--dsw-alias-label-primary) 8%,transparent) 1px,transparent 1px);cursor:default}
      .mm-canvas-surface.is-panning{cursor:grab}
      .mm-canvas-world{position:absolute;left:0;top:0;width:0;height:0;transform-origin:0 0}
      .mm-canvas-node{position:absolute;display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--mm-line-strong);border-radius:var(--dsw-radius-md);background:var(--mm-surface-1);box-shadow:var(--mm-shadow-card),inset 0 1px 0 color-mix(in oklab,var(--dsw-alias-label-primary) 7%,transparent);cursor:grab;overflow:hidden}
      .mm-canvas-node--text{padding:0;border-color:transparent;background:transparent;box-shadow:none;cursor:text;overflow:visible}
      .mm-canvas-node--text .mm-canvas-node-text{overflow:visible}
      .mm-design-card{display:flex;flex-direction:column;gap:12px;padding:16px;border:1px solid var(--mm-line);border-radius:var(--dsw-radius-md);background:var(--mm-surface-1)}
      .mm-design-card-head{display:flex;align-items:center;gap:8px;color:var(--mm-accent-ink)}
      .mm-design-card-title{margin:0;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:1.4}
      .mm-design-card-summary{margin:0;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere}
      .mm-design-card-preview{display:block;width:100%;max-height:320px;aspect-ratio:16/10;object-fit:contain;object-position:top left;border:1px solid var(--mm-line);border-radius:var(--dsw-radius-sm);background:var(--mm-surface-0)}
      .mm-design-card-action{align-self:flex-start;min-height:32px;padding:4px 12px;border:1px solid transparent;border-radius:var(--dsw-radius-sm);background:var(--mm-accent-soft);color:var(--mm-accent-ink);font-size:12px;font-weight:500;cursor:pointer}
      .mm-design-card-action:hover{background:var(--mm-surface-2)}
      .mm-design-card-hint{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary)}
      .mm-design-card.is-error .mm-design-card-summary{color:var(--dsw-alias-state-error-primary)}
      .mm-canvas-guides{position:absolute;inset:0;pointer-events:none;z-index:6}
      .mm-canvas-guide{position:absolute;background:var(--mm-accent-base);opacity:.65}
      .mm-canvas-guide.is-x{top:0;bottom:0;width:1px}
      .mm-canvas-guide.is-y{left:0;right:0;height:1px}
      .mm-canvas-node--instance{padding:0;border:1px dashed var(--mm-line-strong);background:transparent;box-shadow:none;cursor:grab}
      .mm-canvas-instance-label{position:absolute;left:6px;top:6px;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--dsw-alias-label-secondary)}
      .mm-canvas-node--sticky{padding:16px;border-color:transparent;border-radius:var(--dsw-radius-sm);background:var(--mm-tint-amber);box-shadow:none}
      .mm-canvas-node--sticky .mm-canvas-node-text{line-height:1.5}
      .mm-canvas-node.is-amber{background:var(--mm-tint-amber)}
      .mm-canvas-node.is-rose{background:var(--mm-tint-rose)}
      .mm-canvas-node.is-sage{background:var(--mm-tint-sage)}
      .mm-canvas-node.is-sky{background:var(--mm-tint-sky)}
      .mm-canvas-node-text{font-size:13px;line-height:1.25;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;overflow:hidden}
      .mm-canvas-node-empty{font-size:13px;line-height:1.55;color:var(--dsw-alias-label-secondary);font-style:italic}
      .mm-canvas-node-input{width:100%;height:100%;padding:0;border:0;outline:0;resize:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.55}
      .mm-canvas-edges{position:absolute;left:0;top:0;width:1px;height:1px;overflow:visible;pointer-events:none}
      .mm-canvas-edge{fill:none;vector-effect:non-scaling-stroke;stroke-linecap:round;stroke-linejoin:round}
      .mm-canvas-edge-head{pointer-events:none}
      .mm-canvas-edge-head.is-arrow{stroke-linecap:round;stroke-linejoin:round}
      .mm-canvas-connect-preview{position:absolute;inset:0;z-index:6;overflow:visible;pointer-events:none}
      .mm-canvas-connect-preview line{stroke:var(--mm-accent-base);stroke-width:2;stroke-dasharray:6 4;stroke-linecap:round}
      .mm-canvas-magnet{position:absolute;z-index:7;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;background:var(--mm-accent);box-shadow:0 0 0 3px var(--mm-accent-ring);pointer-events:none}
      .mm-canvas-edge-halo{fill:none;stroke:var(--mm-accent-base);stroke-width:9;stroke-opacity:.16;vector-effect:non-scaling-stroke;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}
      .mm-canvas-edge-panel{position:absolute;left:50%;bottom:16px;z-index:8;display:flex;align-items:center;gap:4px;padding:4px 8px;border:1px solid var(--mm-line);border-radius:var(--dsw-radius-md);background:var(--mm-surface-1);box-shadow:var(--mm-shadow-card);transform:translateX(-50%)}
      .mm-canvas-edge-group{display:flex;align-items:center;gap:2px}
      .mm-canvas-edge-sep{width:1px;height:16px;margin:0 4px;background:var(--mm-line)}
      .mm-canvas-edge-color{position:relative}
      .mm-canvas-edge-swatch{display:block;width:14px;height:14px;border-radius:3px;box-shadow:inset 0 0 0 1px color-mix(in oklab, var(--dsw-alias-label-primary) 22%, transparent)}
      .mm-canvas-edge-colors{position:absolute;left:50%;bottom:calc(100% + 8px);transform:translateX(-50%);z-index:9;display:grid;grid-template-columns:repeat(4, 26px);gap:6px;padding:10px;border:1px solid var(--mm-line-strong);border-radius:var(--dsw-radius-md);background:var(--mm-overlay);box-shadow:var(--mm-shadow-float)}
      .mm-canvas-edge-color-option{display:flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:1px solid var(--mm-line);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1;cursor:pointer}
      .mm-canvas-edge-color-option:hover{border-color:var(--mm-line-strong);color:var(--dsw-alias-label-primary)}
      .mm-canvas-edge-color-option.is-active{border-color:var(--mm-accent-line);box-shadow:0 0 0 2px var(--mm-accent-ring)}
      .mm-canvas-edge-color-option.is-swatch:first-of-type{grid-column:span 4;width:auto}
      .mm-canvas-edge-colors > .mm-canvas-edge-color-option:first-child{grid-column:span 2;width:auto;padding:0 8px;font-size:11px}
      .mm-canvas-edge-color-input{grid-column:span 4;width:100%;height:26px;padding:0;border:1px solid var(--mm-line);border-radius:var(--dsw-radius-sm);background:transparent;cursor:pointer}
      .mm-canvas-edge-chip{display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:24px;padding:0 4px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:13px;line-height:1;cursor:pointer;transition:background-color 120ms ease,color 120ms ease}
      .mm-canvas-edge-chip:hover{background:var(--mm-surface-2);color:var(--dsw-alias-label-primary)}
      .mm-canvas-edge-chip.is-active{background:var(--mm-accent-soft);color:var(--mm-accent-ink)}
      .mm-canvas-edge-chip.is-danger:hover{background:var(--mm-surface-2);color:var(--dsw-alias-state-error-primary)}
      .mm-canvas-edge-width{display:block;width:16px;border-radius:2px;background:currentColor}

      .mm-canvas-overlay{position:absolute;inset:0;z-index:2;pointer-events:none}
      .mm-canvas-selection{position:absolute;border:0;outline:1px solid var(--mm-accent-base);outline-offset:2px;border-radius:var(--dsw-radius-xs);pointer-events:none}
      .mm-canvas-handle{position:absolute;width:8px;height:8px;margin:-4px 0 0 -4px;border:1px solid var(--mm-accent-base);border-radius:var(--dsw-radius-xs);background:var(--mm-surface-1);pointer-events:auto;cursor:nwse-resize}
      .mm-canvas-handle::after{content:"";position:absolute;inset:calc(-1 * var(--mm-handle-hit,9px))}
      .mm-canvas-anchor::after,.mm-canvas-handle-dot::after{content:"";position:absolute;inset:-9px}
      .mm-canvas-bar-toggle{border:0;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm);width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
      .mm-canvas-bar-toggle.is-open,.mm-canvas-bar-toggle:hover{background:var(--mm-surface-2);color:var(--dsw-alias-label-primary)}

      .mm-canvas-handle-dot{position:absolute;z-index:3;width:7px;height:7px;margin:-4px 0 0 -4px;border-radius:50%;border:1.5px solid var(--mm-accent-base);background:var(--mm-surface-1);pointer-events:auto;cursor:crosshair}
      .mm-canvas-anchor{position:absolute;z-index:3;width:9px;height:9px;margin:-5px 0 0 -5px;border:1.5px solid var(--mm-accent-base);border-radius:50%;background:var(--mm-surface-1);pointer-events:auto;cursor:move}
      .mm-canvas-path-draft{position:absolute;inset:0;pointer-events:none;z-index:7}
      .mm-canvas-path-draft polyline{stroke:var(--mm-accent-base);stroke-width:1.5;stroke-dasharray:4 3}
      .mm-canvas-path-draft circle{fill:var(--mm-accent-base)}
      .mm-canvas-handle.is-ne,.mm-canvas-handle.is-sw{cursor:nesw-resize}
      .mm-canvas-marquee{position:absolute;z-index:3;border:1px solid var(--mm-accent);background:var(--mm-accent-ring);pointer-events:none}
      .mm-canvas-bar-right{display:flex;align-items:center;gap:6px;flex:none;position:relative}
      .mm-canvas-bar-version{color:var(--dsw-alias-label-secondary);font-size:11px;font-variant-numeric:tabular-nums;letter-spacing:.02em;opacity:.85}
      .mm-canvas-bar-menu-version{padding:6px 10px 2px;color:var(--dsw-alias-label-secondary);font-size:11px;font-variant-numeric:tabular-nums}
      .mm-canvas-bar-more{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color 120ms ease,color 120ms ease}
      .mm-canvas-bar-more:hover,.mm-canvas-bar-more.is-open{background:var(--mm-surface-2);color:var(--dsw-alias-label-primary)}
      .mm-canvas-bar-panel{position:absolute;right:0;top:calc(100% + 6px);display:flex;flex-direction:column;gap:1px;min-width:224px;padding:4px;border:1px solid var(--mm-line-strong);border-radius:var(--dsw-radius-md);background:var(--mm-overlay);box-shadow:var(--mm-shadow-float);z-index:30}
      .mm-canvas-bar-item{display:flex;align-items:center;gap:10px;width:100%;padding:7px 10px;border:0;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:1.3;text-align:left;cursor:pointer}
      .mm-canvas-bar-item:hover:not(:disabled){background:var(--mm-surface-2)}
      .mm-canvas-bar-item:focus-visible{outline:2px solid var(--mm-accent-base);outline-offset:-2px}
      .mm-canvas-bar-item:disabled{opacity:.4;cursor:default}
      .mm-canvas-bar-rule{height:1px;margin:4px 8px;background:var(--mm-line)}
      .mm-canvas-bar-source{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:4px 10px 6px;color:var(--dsw-alias-label-secondary);font-size:12px}
      .mm-canvas-bar-source .mm-canvas-select{max-width:132px}
      .mm-canvas-boards{position:relative}
      .mm-canvas-boards-toggle{display:inline-flex;align-items:center;gap:6px;max-width:280px;height:32px;padding:0 12px;border:1px solid var(--mm-line);border-radius:var(--dsw-radius-sm);background:var(--mm-surface-2);color:var(--dsw-alias-label-primary);font-size:13px;cursor:pointer;transition:border-color 100ms ease}
      .mm-canvas-boards-toggle:hover{border-color:var(--mm-line-strong)}
      .mm-canvas-boards-toggle.is-open{border-color:var(--mm-accent-line)}
      .mm-canvas-boards-toggle .mm-icon{transition:transform 200ms cubic-bezier(.23,1,.32,1)}
      .mm-canvas-boards-toggle.is-open .mm-icon{transform:rotate(180deg)}
      .mm-canvas-boards-current{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
      .mm-canvas-boards-panel{position:absolute;left:0;top:calc(100% + 6px);z-index:20;display:flex;flex-direction:column;width:300px;max-height:420px;border:1px solid var(--mm-line-strong);border-radius:var(--dsw-radius-md);background:var(--mm-overlay);box-shadow:var(--mm-shadow-float);animation:mm-pop-in 150ms cubic-bezier(.23,1,.32,1)}
      .mm-canvas-boards-search{margin:10px 10px 6px;height:32px;padding:0 12px;border:1px solid var(--mm-line);border-radius:var(--dsw-radius-sm);background:var(--mm-surface-1);color:var(--dsw-alias-label-primary);font-size:13px;outline:0}
      .mm-canvas-boards-search:focus-visible{border-color:var(--mm-accent-line)}
      .mm-canvas-boards-list{display:flex;flex-direction:column;gap:1px;overflow-y:auto;padding:4px 6px}
      .mm-canvas-boards-row{display:flex;align-items:center;gap:4px;border-radius:var(--dsw-radius-sm)}
      .mm-canvas-boards-row:hover{background:var(--mm-surface-2)}
      .mm-canvas-boards-row.is-active{background:var(--mm-accent-soft)}
      .mm-canvas-boards-name{display:flex;align-items:center;gap:8px;flex:1;min-width:0;min-height:32px;padding:0 8px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;text-align:left;cursor:pointer}
      .mm-canvas-boards-name span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .mm-canvas-boards-name b{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
      .mm-canvas-boards-star{display:flex;align-items:center;justify-content:center;width:26px;height:26px;flex:none;padding:0;border:0;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));cursor:pointer}
      .mm-canvas-boards-star:hover{background:var(--mm-surface-3);color:var(--dsw-alias-label-primary)}
      .mm-canvas-boards-star.is-starred{color:var(--mm-accent)}
      .mm-canvas-boards-star.is-starred .mm-icon{fill:currentColor}
      .mm-canvas-boards-sep{height:1px;margin:4px 8px;background:var(--mm-line)}
      .mm-canvas-boards-empty{padding:16px 12px;color:var(--dsw-alias-label-secondary);font-size:12px;text-align:center}
      .mm-canvas-boards-new{display:flex;align-items:center;gap:8px;min-height:36px;margin:4px 6px 6px;padding:0 12px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--mm-accent-ink);font-size:13px;font-weight:500;text-align:left;cursor:pointer}
      .mm-canvas-boards-new:hover{background:var(--mm-surface-2)}
      .mm-canvas-export{display:flex;align-items:center;gap:4px}
      .mm-canvas-bar-gap{width:1px;height:20px;margin:0 4px;background:var(--mm-line)}
      .mm-canvas-groups{position:absolute;left:0;top:0;width:0;height:0}
      .mm-canvas-group{position:absolute;border:1px dashed var(--mm-line-strong);border-radius:var(--dsw-radius-md);pointer-events:none}
      .mm-canvas-group.is-selected{border-color:var(--mm-accent);border-style:solid}
      .mm-canvas-group-title{position:absolute;left:0;top:-18px;max-width:240px;overflow:hidden;padding:0 4px;border-radius:var(--dsw-radius-xs);background:var(--mm-surface-0);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;white-space:nowrap;text-overflow:ellipsis}
      .mm-canvas-group-edge{position:absolute;pointer-events:auto;cursor:move}
      .mm-canvas-group-edge.is-top{left:0;right:0;top:0;height:6px}
      .mm-canvas-group-edge.is-bottom{left:0;right:0;bottom:0;height:6px}
      .mm-canvas-group-edge.is-left{top:0;bottom:0;left:0;width:6px}
      .mm-canvas-group-edge.is-right{top:0;bottom:0;right:0;width:6px}
      .mm-canvas-frame{position:absolute;border:1px solid var(--mm-line-strong);border-radius:var(--dsw-radius-md);background:var(--mm-surface-1);pointer-events:auto;cursor:move}
      .mm-canvas-frame.is-selected{border-color:var(--mm-accent-base);border-width:1px}
      .mm-canvas-frame-title{position:absolute;left:0;top:-22px;max-width:320px;overflow:hidden;padding:2px 6px;border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:600;letter-spacing:.04em;line-height:16px;text-transform:uppercase;white-space:nowrap;text-overflow:ellipsis;pointer-events:auto;cursor:text}
      .mm-canvas-frame-title:hover{color:var(--dsw-alias-label-primary)}
      .mm-canvas-frame-title-input{position:absolute;left:0;top:-22px;width:240px;padding:2px 6px;border:1px solid var(--mm-accent);border-radius:var(--dsw-radius-xs);background:var(--mm-surface-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;font-weight:600;letter-spacing:.04em;line-height:16px;text-transform:uppercase;outline:0;pointer-events:auto}
      .mm-canvas-node--shape{cursor:default}
      .mm-canvas-node--image{padding:0;overflow:hidden;background:var(--mm-surface-2)}
      .mm-canvas-image{display:block;width:100%;height:100%;object-fit:cover;pointer-events:none;-webkit-user-drag:none}
      .mm-canvas-shape{display:block;width:100%;height:100%;overflow:visible;pointer-events:none}
      .mm-canvas-shape-label{position:absolute;left:0;right:0;top:50%;transform:translateY(-50%);padding:0 8px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.4;text-align:center;pointer-events:none}
      .mm-canvas-node.is-overview{padding:0;box-shadow:none}
      .mm-canvas-node.is-overview.mm-canvas-node--note{background:var(--mm-overview-note)}
      .mm-canvas-node.is-overview.mm-canvas-node--sticky{background:var(--mm-overview-sticky)}
      .mm-canvas-node.is-overview.mm-canvas-node--text{background:transparent}
      .mm-canvas-edge-hit{fill:none;stroke:transparent;stroke-width:12;pointer-events:stroke;vector-effect:non-scaling-stroke;cursor:text}
      .mm-canvas-edge-label{position:absolute;z-index:3;transform:translate(-50%,-50%);padding:2px 8px;border:1px solid var(--mm-line);border-radius:999px;background:var(--mm-surface-1);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;white-space:nowrap;pointer-events:auto;cursor:text}
      .mm-canvas-edge-input{position:absolute;z-index:4;transform:translate(-50%,-50%);width:140px;padding:2px 8px;border:1px solid var(--mm-accent);border-radius:999px;background:var(--mm-surface-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;line-height:16px;text-align:center;outline:0}
      .mm-canvas-menu{position:absolute;z-index:24;min-width:208px;max-height:min(70vh,420px);overflow-y:auto;padding:4px;border:1px solid var(--mm-line);border-radius:var(--dsw-radius-md);background:var(--mm-surface-1);box-shadow:var(--mm-shadow-float);display:flex;flex-direction:column;gap:1px}
      .mm-canvas-menu-item{display:flex;align-items:center;justify-content:space-between;gap:16px;width:100%;padding:7px 10px;border:0;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:1.3;text-align:left;cursor:pointer}
      .mm-canvas-menu-item:hover:not(:disabled){background:var(--mm-surface-2)}
      .mm-canvas-menu-item:focus-visible{outline:2px solid var(--mm-accent-base);outline-offset:-2px}
      .mm-canvas-menu-item:disabled{opacity:.4;cursor:default}
      .mm-canvas-menu-item kbd{padding:0;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:11px;letter-spacing:.02em}
      .mm-canvas-menu-rule{height:1px;margin:4px 8px;background:var(--mm-line)}
      .mm-canvas-style{position:absolute;right:16px;top:16px;z-index:5;display:flex;flex-direction:column;gap:8px;max-width:320px;padding:10px;border:1px solid var(--mm-line);border-radius:var(--dsw-radius-md);background:var(--mm-surface-1);box-shadow:var(--mm-shadow-card)}
      .mm-canvas-style-row{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
      .mm-canvas-style-label{margin-right:4px;color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500;letter-spacing:.04em;text-transform:uppercase}
      .mm-canvas-swatch{width:18px;height:18px;padding:0;border:1px solid var(--mm-line-strong);border-radius:var(--dsw-radius-xs);cursor:pointer;transition:transform 100ms ease}
      .mm-canvas-swatch:hover{transform:scale(1.12)}
      .mm-canvas-swatch.is-none{background:linear-gradient(to top right,transparent 42%,var(--mm-line-strong) 42%,var(--mm-line-strong) 58%,transparent 58%)}
      .mm-canvas-swatch.is-active{outline:2px solid var(--mm-accent);outline-offset:1px}
      .mm-canvas-style-chip{min-width:28px;height:24px;padding:0 6px;border:1px solid var(--mm-line);border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:22px;cursor:pointer;transition:background-color 100ms ease,color 100ms ease}
      .mm-canvas-style-chip:hover{background:var(--mm-surface-2);color:var(--dsw-alias-label-primary)}
      .mm-canvas-style-chip.is-active{border-color:var(--mm-accent-line);background:var(--mm-accent-soft);color:var(--mm-accent-ink);font-weight:500}
      .mm-canvas-actions{position:absolute;left:16px;bottom:16px;z-index:5;display:flex;align-items:center;gap:2px;padding:4px;border:1px solid var(--mm-line);border-radius:var(--dsw-radius-md);background:var(--mm-surface-1);box-shadow:var(--mm-shadow-card)}
      .mm-sidebar-layers{margin-top:32px;min-height:0;overflow-y:auto}
      .mm-layer-tree{display:flex;flex-direction:column;gap:1px}
      .mm-layer-row{display:flex;align-items:center;gap:4px;min-height:32px;padding-right:4px;border-radius:var(--dsw-radius-sm)}
      .mm-layer-row:hover{background:var(--mm-surface-2)}
      .mm-layer-row.is-selected{background:var(--mm-accent-soft)}
      .mm-layer-row.is-hidden .mm-layer-name{opacity:1;color:var(--dsw-alias-label-secondary)}
      .mm-layer-name{display:flex;align-items:center;gap:6px;flex:1;min-width:0;min-height:28px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;text-align:left;cursor:pointer}
      .mm-layer-row.is-selected .mm-layer-name{color:var(--mm-accent-ink);font-weight:500}
      .mm-layer-name span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .mm-layer-eye{display:flex;align-items:center;justify-content:center;width:24px;height:24px;flex:none;padding:0;border:0;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
      .mm-layer-eye:hover{background:var(--mm-surface-3);color:var(--dsw-alias-label-primary)}
      .mm-layer-chevron{display:flex;align-items:center;justify-content:center;width:24px;height:24px;flex:none;padding:0;border:0;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:transform 200ms cubic-bezier(.23,1,.32,1)}
      .mm-layer-chevron .mm-icon{transform:rotate(90deg)}
      .mm-layer-chevron.is-closed .mm-icon{transform:none}
      .mm-layer-chevron.is-empty{cursor:default;pointer-events:none}
      .mm-layer-chevron:hover:not(.is-empty){background:var(--mm-surface-3);color:var(--dsw-alias-label-primary)}
      .mm-canvas-tool{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;flex:none;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color 120ms ease,color 120ms ease}
      .mm-canvas-tool:disabled{opacity:.35;cursor:default}
      .mm-canvas-tool:hover:not(:disabled){background:var(--mm-surface-2);color:var(--dsw-alias-label-primary)}
      .mm-canvas-tool.is-active{background:var(--mm-accent-soft);color:var(--mm-accent-ink)}
      .mm-canvas-zoom{position:absolute;right:16px;bottom:16px;z-index:5;display:flex;align-items:center;gap:2px;padding:4px;border:1px solid var(--mm-line);border-radius:var(--dsw-radius-md);background:var(--mm-surface-1);box-shadow:var(--mm-shadow-card)}
      .mm-canvas-zoom-readout{min-width:52px;height:32px;padding:0 4px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums;cursor:pointer}
      .mm-canvas-zoom-readout:hover{background:var(--mm-surface-2);color:var(--dsw-alias-label-primary)}
      .mm-canvas-empty{position:absolute;left:50%;top:50%;z-index:4;display:flex;flex-direction:column;align-items:center;gap:8px;width:min(360px,calc(100% - 48px));padding:24px;border:1px solid var(--mm-line);border-radius:var(--dsw-radius-lg);background:var(--mm-surface-1);box-shadow:var(--mm-shadow-card);color:var(--dsw-alias-label-secondary);text-align:center;transform:translate(-50%,-50%)}
      .mm-canvas-empty strong{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600}
      .mm-canvas-empty span{font-size:13px;line-height:1.55}
      .mm-canvas-empty-action{display:inline-flex;align-items:center;gap:8px;margin-top:4px;height:32px;padding:0 12px;border:0;border-radius:var(--dsw-radius-sm);background:var(--mm-accent);color:var(--mm-on-accent);font-size:13px;font-weight:600;cursor:pointer}
      .mm-canvas-loading{position:absolute;left:50%;top:50%;z-index:4;transform:translate(-50%,-50%);color:var(--dsw-alias-label-secondary);font-size:13px}
      .mm-panel-icon{display:inline-flex;color:var(--dsw-alias-label-secondary)}
      .mm-panel-icon.is-active{color:var(--mm-accent)}
      .mm-visually-hidden{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
      @media(max-width:1380px){.mm-titlebar{grid-template-columns:auto minmax(200px,360px) minmax(0,1fr);gap:12px}.mm-editor-hint{display:none}}
      @media(max-width:1100px){.mm-shell{--mm-side-width:184px}.mm-titlebar{grid-template-columns:auto minmax(180px,300px) minmax(0,1fr);padding:12px 16px}.mm-backup-actions{padding-left:4px;margin-left:0}.mm-main-scroll{padding:24px 24px 48px}.mm-toast{left:208px;max-width:calc(100% - 232px)}}
      @media(max-width:960px){.mm-titlebar{grid-template-columns:1fr auto;grid-template-areas:"title actions" "search search";gap:12px}.mm-search-wrap{max-width:none}.mm-main-scroll>*{width:100%}}
      @media(max-width:820px){.mm-shell{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr);--mm-side-width:auto}.mm-shell.is-collapsed{grid-template-columns:1fr}.mm-left.is-collapsed{align-items:stretch;padding:8px 12px}.mm-side-top{display:none}.mm-side-logo{display:none}.mm-left{display:grid;grid-template-columns:1fr;padding:8px 12px;border-right:0;border-bottom:1px solid var(--mm-line);overflow:visible}.mm-nav-heading{display:none}.mm-nav{flex-direction:row;align-items:center;gap:4px;overflow-x:auto}.mm-nav button{width:auto;white-space:nowrap;padding:8px 12px}.mm-nav button b{display:none}.mm-sidebar-tags,.mm-sidebar-layers,.mm-sidebar-footer{display:none}.mm-main-scroll{padding:24px 16px 48px}.mm-day-group{display:flex;flex-direction:column;gap:8px}.mm-day-marker{position:static;flex-direction:row;align-items:baseline;gap:8px;padding:0;border-left:0}.mm-day-marker:before{display:none}.mm-day-marker h2{display:inline}.mm-review-controls{flex-wrap:wrap}.mm-toast{left:16px;max-width:calc(100% - 32px)}}
      @media(max-width:560px){.mm-titlebar{padding:12px}.mm-topbar-actions{gap:0}.mm-backup-actions{gap:0}.mm-nav{justify-content:flex-start}.mm-nav button{flex:1;justify-content:center;min-width:0;padding:8px 4px}.mm-nav button .mm-icon{display:none}.mm-nav button span{flex:none;font-size:12px}.mm-editor{padding:16px}.mm-editor-input{font-size:16px}.mm-editor-count{display:none}.mm-editor-footer{align-items:flex-end}.mm-editor-tools{flex-wrap:wrap}.mm-timeline-toolbar{align-items:flex-start}.mm-timeline-toolbar>div:first-child{flex-direction:column;gap:2px}.mm-note-card,.mm-note-card.is-compact{padding:16px}.mm-action.is-danger{margin-left:0}.mm-note-time time{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mm-overlay{padding:12px}.mm-dialog{max-height:94vh}.mm-import-options{flex-direction:column}.mm-import-options button{width:100%}}
      @media(prefers-reduced-motion:reduce){.mm-app *,.mm-app *:before,.mm-app *:after,.mm-float *,.mm-float *:before,.mm-float *:after{scroll-behavior:auto!important;animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}
    `;

    /**
     * One design tool result, with the board it touched drawn beside it.
     *
     * The picture comes from the same SVG renderer the exporter uses, so the
     * card can never show a design the deliverable would not.
     */
    function DesignToolView(props) {
      const block = props?.block || {};
      const meta = block?.meta?.momentsDesign;
      const boardId = typeof meta?.boardId === 'string' && meta.boardId ? meta.boardId : null;
      const summary = (Array.isArray(block?.content) ? block.content : [])
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n')
        .trim();
      const failed = block?.isError === true;
      return h('div', {
        className: cx('mm-design-card', failed && 'is-error'),
        role: failed ? 'alert' : undefined,
      },
        h('div', { className: 'mm-design-card-head' },
          h(Icon, { name: 'canvas', size: 16 }),
          h('strong', { className: 'mm-design-card-title' }, meta?.title || 'Design board')),
        failed
          ? h('p', { className: 'mm-design-card-summary', role: 'alert' }, `Design tool failed. ${summary || 'Check the tool output and retry.'}`)
          : h('p', { className: 'mm-design-card-summary' }, summary || 'Design tool call'),
        boardId
          ? h('img', {
            className: 'mm-design-card-preview',
            src: `${DESIGN_PREVIEW_ROUTE}?id=${encodeURIComponent(boardId)}&v=${block?.seq ?? 0}`,
            alt: `Design preview: ${meta?.title || 'board'}`,
            loading: 'lazy',
            draggable: false,
          })
          : null,
        boardId
          ? h('button', {
            type: 'button',
            className: 'mm-design-card-action',
            onClick: () => {
              // A host without a browser event loop (tests, SSR) simply has no
              // workspace to jump to.
              if (typeof window === 'undefined' || typeof CustomEvent !== 'function') return;
              window.dispatchEvent?.(new CustomEvent('moments:open-design', { detail: { boardId } }));
            },
          }, '在 Design 中打开')
          : h('p', { className: 'mm-design-card-hint' }, '打开左侧 Moments 面板查看这块板'));
    }

    /**
     * Answer snapshot requests from the Host, with or without the Design panel.
     *
     * An agent asks for a picture while the person is chatting, so the
     * responder must not depend on the canvas being on screen: it reads the
     * saved board, draws it with the same renderer the export uses, and sends
     * the PNG back. It parks one long poll, so an idle page costs nothing.
     */
    /**
     * Answer snapshot requests from the Host, with or without the Design panel.
     *
     * An agent asks for a picture while the person is chatting, so this must not
     * depend on the canvas being on screen: it reads the saved board, draws it
     * with the same renderer the export uses, and sends the PNG back. It parks
     * one long poll, so an idle page costs nothing.
     */
    function startSnapshotResponder() {
      let stopped = false;
      const idle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const tokens = () => {
        // The palette lives on the plugin's own surfaces. On the chat page the
        // Design canvas is not mounted, but the sidebar icon is, and it carries
        // the same token block; with neither, the defaults below apply.
        const host = document.querySelector('.mm-app, .mm-float, .mm-panel-icon');
        const read = (name, fallback) => {
          const value = host ? getComputedStyle(host).getPropertyValue(name).trim() : '';
          return value || fallback;
        };
        return {
          background: read('--mm-export-background', 'rgb(251 250 248)'),
          ink: read('--mm-export-ink', 'rgb(43 41 38)'),
          line: read('--mm-export-line', 'rgb(141 139 134)'),
          sticky: read('--mm-note-fill', 'rgb(255 243 191)'),
        };
      };
      const answer = async (job) => {
        const loaded = await api('canvas-load', { id: job.boardId });
        const board = loaded?.canvas;
        const nodes = Array.isArray(board?.nodes) ? board.nodes : [];
        if (!nodes.length) {
          await api('snapshot-put', { jobId: job.jobId, dataUrl: '' }).catch(() => {});
          return;
        }
        const svg = await canvasSceneSvg(nodes, board.edges || [], {
          region: job.region || undefined,
          padding: 0,
          ...tokens(),
        });
        if (!svg) return;
        // A 46000px board must not become a 92000px PNG; the agent can ask for a
        // region when it needs detail.
        const size = /width="(\d+)" height="(\d+)"/.exec(svg);
        const width = size ? Number(size[1]) : 0;
        const cap = 2048;
        const wanted = Number(job.scale) > 0 ? Number(job.scale) : 2;
        const scale = width > 0 ? Math.min(wanted, cap / width) : wanted;
        const blob = await canvasExportPng(svg, Math.max(0.25, scale));
        const dataUrl = await canvasBlobDataUrl(blob);
        await api('snapshot-put', { jobId: job.jobId, dataUrl });
      };
      const pump = async () => {
        let failures = 0;
        while (!stopped) {
          try {
            const waiting = await api('snapshot-wait', { holdMs: 20000 });
            failures = 0;
            if (stopped) return;
            const job = waiting?.job;
            if (!job) {
              // A long poll that returns at once is not holding; yield first.
              await idle(250);
              continue;
            }
            await answer(job);
          } catch {
            if (stopped) return;
            failures += 1;
            await idle(Math.min(30000, failures >= 3 ? 2000 * failures : 800));
          }
        }
      };
      void pump();
      return () => { stopped = true; };
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => installStyles(), 'moments-notes: stylesheets');
        // The canvas answers an agent's picture request whether or not the
        // person is looking at it, so the responder lives with the plugin.
        ctx.effect(() => startSnapshotResponder(), 'moments-notes: canvas snapshots');
        ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'moments-notes',
          order: 21,
          label: () => 'Moments',
        }, PanelIcon)));
        for (const toolName of DESIGN_TOOL_NAMES) {
          ctx.effect(() => ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
            name: 'tool.call.toolview',
            key: toolName,
          }, DesignToolView)), `moments-notes: ${toolName} design card`);
        }
        ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'moments-notes',
        }, (props) => h(MomentsApp, props))));
        ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'moments-float',
          order: 30,
          label: () => 'Moments float',
        }, MiniFloat)));
        ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'moments-quick-note',
          order: 5,
          label: () => 'Quick capture',
        }, QuickFloatButton)));
        ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document.actions', () => ctx.slots.register({
          name: 'sidebar.right.tab.document.actions',
          id: 'moments-quick-note',
          order: -20,
          label: () => 'Quick capture',
        }, QuickFloatButton)));
      },
    };
  },
});
