'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  DRAFT_STORE_KEY,
  MAX_DRAFT_ENTRIES,
  emptyDraft,
  loadDraftStore,
  serializeDraft,
  deserializeDraft,
  mergeDraftEntry,
  renamedDraftStore,
  persistDraftStore,
} = require('../../src/renderer/draft-store.cjs');

describe('draft-store', () => {
  beforeEach(() => {
    global.localStorage = {
      data: {},
      getItem(key) { return this.data[key] ?? null; },
      setItem(key, value) { this.data[key] = String(value); },
    };
  });

  it('round-trips text and attachment paths', () => {
    const serialized = serializeDraft({
      text: 'hello',
      attachments: [{ path: '/tmp/a.png', thumbDataUri: 'data:image/png;base64,abc' }],
    });
    const restored = deserializeDraft(serialized);
    assert.equal(restored.text, 'hello');
    assert.deepEqual(restored.attachments, [{ kind: 'image', path: '/tmp/a.png', thumbDataUri: null }]);
  });

  it('preserves in-memory thumbnail data while persisted entries remain path-only', () => {
    const attachment = { kind: 'image', path: '/tmp/paste.png', thumbDataUri: 'data:image/png;base64,preview' };
    const entry = mergeDraftEntry(undefined, { attachments: [attachment] });

    assert.deepEqual(deserializeDraft(entry).attachments, [attachment]);
    const persisted = persistDraftStore({ session: entry });
    assert.deepEqual(persisted.session.paths, ['/tmp/paste.png']);
    assert.equal('attachments' in persisted.session, false);
  });

  it('round-trips path-only file attachments with their kind and derived basename', () => {
    const serialized = serializeDraft({
      text: 'review',
      attachments: [
        { kind: 'file', path: '/tmp/report.pdf', basename: 'report.pdf' },
        { kind: 'file', path: 'C:\\work\\notes.md', basename: 'notes.md' },
      ],
    });
    assert.deepEqual(serialized.filePaths, ['/tmp/report.pdf', 'C:\\work\\notes.md']);
    assert.deepEqual(deserializeDraft(serialized).attachments, [
      { kind: 'file', path: '/tmp/report.pdf', basename: 'report.pdf' },
      { kind: 'file', path: 'C:\\work\\notes.md', basename: 'notes.md' },
    ]);

    persistDraftStore({ session: serialized });
    const restored = deserializeDraft(loadDraftStore().session);
    assert.deepEqual(restored.attachments, [
      { kind: 'file', path: '/tmp/report.pdf', basename: 'report.pdf' },
      { kind: 'file', path: 'C:\\work\\notes.md', basename: 'notes.md' },
    ]);
  });

  it('loads the old shape without file attachments unchanged', () => {
    const old = { text: 'old draft', paths: ['/tmp/old.png'], at: 10 };
    global.localStorage.setItem(DRAFT_STORE_KEY, JSON.stringify({ session: old }));
    assert.deepEqual(loadDraftStore().session, old);
    assert.deepEqual(deserializeDraft(loadDraftStore().session), {
      text: 'old draft',
      attachments: [{ kind: 'image', path: '/tmp/old.png', thumbDataUri: null }],
    });
  });

  it('drops unknown attachment entries instead of crashing the composer', () => {
    assert.deepEqual(deserializeDraft({
      text: 'safe',
      attachments: [null, 42, {}, { kind: 'file' }, { kind: 'wat', path: '/tmp/legacy.png' }],
    }), {
      text: 'safe',
      attachments: [{ kind: 'image', path: '/tmp/legacy.png', thumbDataUri: null }],
    });
  });

  it('drops empty drafts on persist', () => {
    const stored = persistDraftStore({
      a: serializeDraft({ text: 'keep me', attachments: [] }),
      b: serializeDraft({ text: '', attachments: [] }),
    });
    assert.ok(stored.a);
    assert.equal(stored.b, undefined);
    const loaded = loadDraftStore();
    assert.equal(loaded.b, undefined);
  });

  it('caps entries by most recent timestamp', () => {
    const store = {};
    for (let i = 0; i < MAX_DRAFT_ENTRIES + 5; i += 1) {
      store[`session-${i}`] = serializeDraft({ text: `draft-${i}`, attachments: [] });
      store[`session-${i}`].at = i;
    }
    const capped = persistDraftStore(store);
    assert.equal(Object.keys(capped).length, MAX_DRAFT_ENTRIES);
    assert.equal(capped['session-54'].text, 'draft-54');
    assert.equal(capped['session-0'], undefined);
    assert.equal(global.localStorage.getItem(DRAFT_STORE_KEY).includes('session-54'), true);
  });

  it('emptyDraft is blank', () => {
    assert.deepEqual(emptyDraft(), { text: '', attachments: [] });
  });

  // Live-caught 2026-07-27: Pat typed into a brand-new session, and a few
  // seconds later the composer went blank on its own. A new session opens as a
  // provisional `pane:<id>` window and its id upgrades to the real session id
  // the instant the transcript materializes; the draft stayed keyed to the dead
  // id, so the composer read the new one, found nothing, and rebuilt itself
  // empty. The typed message is the thing being protected here.
  describe('renamedDraftStore', () => {
    it('carries a draft from the provisional pane id to the real session id', () => {
      const store = { 'pane:%1': serializeDraft({ text: 'half-written message', attachments: [] }) };
      const next = renamedDraftStore(store, 'pane:%1', 'abc-123');
      assert.equal(next['abc-123'].text, 'half-written message');
      assert.equal(next['pane:%1'], undefined, 'the dead key does not linger');
    });

    it('keeps attachment paths with the text', () => {
      const store = { 'pane:%1': serializeDraft({ text: 'see this', attachments: [{ path: '/tmp/a.png' }] }) };
      const next = renamedDraftStore(store, 'pane:%1', 'abc-123');
      assert.deepEqual(next['abc-123'].paths, ['/tmp/a.png']);
    });

    it('never clobbers a draft already under the destination', () => {
      // Trading one lost message for another is not a fix.
      const store = {
        'pane:%1': serializeDraft({ text: 'from the provisional window', attachments: [] }),
        'abc-123': serializeDraft({ text: 'newer intent', attachments: [] }),
      };
      const next = renamedDraftStore(store, 'pane:%1', 'abc-123');
      assert.equal(next['abc-123'].text, 'newer intent');
      assert.equal(next['pane:%1'], undefined);
    });

    it('is a no-op when there is nothing to move', () => {
      const store = { other: serializeDraft({ text: 'untouched', attachments: [] }) };
      assert.equal(renamedDraftStore(store, 'pane:%1', 'abc-123'), store);
      assert.equal(renamedDraftStore(store, 'abc', 'abc'), store, 'same id is not a move');
    });

    it('tolerates missing arguments instead of throwing mid-launch', () => {
      assert.deepEqual(renamedDraftStore(undefined, 'a', 'b'), {});
      assert.deepEqual(renamedDraftStore({}, null, 'b'), {});
      assert.deepEqual(renamedDraftStore({}, 'a', null), {});
    });

    // SUBSTRATE-3: minting removed the claude launch upgrade, but provider-session-link
    // still upgrades live:<paneId> windows when codex/cursor evidence arrives. The
    // draft must move on that replacesKey too, not only pane:<paneId>.
    it('carries a draft from a live pane key to the linked session id', () => {
      const store = { 'live:w4:p1': serializeDraft({ text: 'typed before the link', attachments: [] }) };
      const next = renamedDraftStore(store, 'live:w4:p1', 'codex-real-id');
      assert.equal(next['codex-real-id'].text, 'typed before the link');
      assert.equal(next['live:w4:p1'], undefined);
    });
  });
});
