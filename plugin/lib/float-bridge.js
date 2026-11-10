/**
 * Bridge between the native desktop float and the note repository.
 *
 * The window is a separate operating-system window, so it cannot reach the
 * Harness page. It talks to the Host instead: the Host answers `query` with
 * the matching notes and receives `create`, `update`, `trash` and `pin`
 * commands back.
 */

const VISIBLE_NOTES = 200;

/** Convert one note into the shape the window understands. */
function toFloatNote(note, { includeData = false } = {}) {
  return {
    id: note.id,
    content: note.content || '',
    createdAt: note.createdAt,
    pinned: note.pinned === true,
    attachments: (note.attachments || []).map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      type: attachment.type,
      size: attachment.size,
      ...(includeData ? { dataUrl: attachment.dataUrl } : {}),
    })),
  };
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Connect one desktop float to one repository. */
export function createFloatBridge({ repository, desktopFloat, draftStore }) {
  let helperAvailable = null;
  let lastQuery = '';
  const stopWatching = repository.subscribe(() => {
    void pushNotes();
  });

  /** Answer the window's question with the notes that match it. */
  async function pushNotes() {
    if (!desktopFloat.isOpen()) return;
    try {
      const notes = await repository.list({
        query: lastQuery,
        limit: VISIBLE_NOTES,
        sort: 'createdAt',
        order: 'desc',
        pinnedFirst: false,
      });
      await desktopFloat.send({
        type: 'notes',
        notes: notes.map((note) => toFloatNote(note)),
        total: notes.length,
      });
    } catch {
      // The window is a mirror; a failed refresh must not break the Host.
    }
  }

  /**
   * Hand the window the draft from the last time it was closed.
   *
   * A draft that was editing a note can only be restored while that note is
   * still there; otherwise the text is restored as a new note so it is never
   * stranded behind an id that no longer exists.
   */
  async function pushDraft() {
    if (!desktopFloat.isOpen() || !draftStore) return;
    try {
      const draft = await draftStore.read();
      if (!draft) return;
      let editingId = draft.editingId;
      if (editingId) {
        const snapshot = await repository.snapshot({});
        const note = (snapshot.notes ?? []).find((candidate) => candidate.id === editingId);
        if (!note || note.deletedAt) editingId = null;
      }
      await desktopFloat.send({
        type: 'draft',
        draft: {
          content: draft.content,
          ...(editingId ? { editingId } : {}),
          ...(draft.attachments.length > 0 ? { attachments: draft.attachments } : {}),
        },
      });
    } catch {
      // Restoring a draft is a convenience; it must never keep the window shut.
    }
  }

  async function pushNote(noteId) {
    if (!desktopFloat.isOpen()) return;
    try {
      const snapshot = await repository.snapshot({});
      const note = snapshot.notes.find((candidate) => candidate.id === noteId);
      if (!note) return;
      await desktopFloat.send({ type: 'note', note: toFloatNote(note, { includeData: true }) });
    } catch {
      // The window asks for a note it may no longer have.
    }
  }

  /** A committed note replaces the draft it came from. */
  async function clearDraft() {
    if (!draftStore) return;
    try {
      await draftStore.clear();
    } catch {
      // A stale draft is harmless: the next window offers it, and saving wins.
    }
  }

  async function fail(error) {
    await desktopFloat.send({ type: 'error', detail: message(error) });
  }

  async function handleCommand(event) {
    switch (event.type) {
      case 'ready':
        await pushDraft();
        await pushNotes();
        break;
      case 'query':
        lastQuery = String(event.query || '');
        await pushNotes();
        break;
      case 'load':
        await pushNote(String(event.id || ''));
        break;
      case 'draft': {
        if (!draftStore) break;
        try {
          await draftStore.write(event.draft);
        } catch {
          // Losing a debounced draft must not interrupt typing; the next tick
          // writes again and a closing window flushes with `force`.
        }
        break;
      }
      case 'create': {
        try {
          await repository.create({ content: event.content, attachments: event.attachments });
          await clearDraft();
          await desktopFloat.send({ type: 'saved', detail: 'Saved' });
        } catch (error) {
          await fail(error);
        }
        break;
      }
      case 'update': {
        try {
          const input = {};
          if (Object.hasOwn(event, 'content')) input.content = event.content;
          if (Object.hasOwn(event, 'attachments')) input.attachments = event.attachments;
          await repository.update(String(event.id || ''), input);
          await clearDraft();
          await desktopFloat.send({ type: 'saved', detail: 'Updated' });
        } catch (error) {
          await fail(error);
        }
        break;
      }
      case 'trash': {
        try {
          await repository.trash(String(event.id || ''));
          await desktopFloat.send({ type: 'saved', detail: 'Moved to trash' });
        } catch (error) {
          await fail(error);
        }
        break;
      }
      case 'pin': {
        try {
          await repository.setPinned(String(event.id || ''), event.pinned === true);
          await desktopFloat.send({ type: 'saved', detail: event.pinned === true ? 'Pinned' : 'Unpinned' });
        } catch (error) {
          await fail(error);
        }
        break;
      }
      default:
        break;
    }
  }

  const stopCommands = desktopFloat.onCommand((event) => {
    void handleCommand(event);
  });

  return {
    /** Open the desktop window and hand it the current notes. */
    async open() {
      if (!desktopFloat.isOpen()) {
        helperAvailable = await desktopFloat.available();
        if (!helperAvailable) {
          throw new Error('The desktop float is not built on this machine yet — run moments-notes/native/build.sh first');
        }
        await desktopFloat.start();
      }
      await pushNotes();
      return { open: true };
    },

    /** Close the desktop window. */
    async close() {
      await desktopFloat.stop();
      return { open: false };
    },

    /** Report whether the desktop window is on screen. */
    status() {
      return {
        open: desktopFloat.isOpen(),
        available: helperAvailable === true,
        failure: desktopFloat.failure || '',
      };
    },

    /** Release the window and every listener. */
    async dispose() {
      // Stop the window first: a closing window still writes its draft.
      await desktopFloat.stop().catch(() => {});
      stopCommands();
      stopWatching();
    },
  };
}
