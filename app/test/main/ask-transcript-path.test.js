'use strict';

// Reported 2026-07-29, on a screenshot of a question card showing three bare
// option labels and nothing else: the question being asked was not visible on
// the card at all.
//
// The question heading and the option descriptions come ONLY from the session's
// transcript; the pty can contribute option rows and nothing more. So a card
// that cannot find the transcript does not fail loudly, it renders a stripped
// card that looks almost right. The resolver below is where that was decided,
// and these specs pin both halves of the fix.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAskTranscriptResolver } = require('../../src/main/ask-transcript-path.js');

test('the index answer is used when it has one', async () => {
  const resolver = createAskTranscriptResolver({
    getSessionMeta: async () => ({ path: '/store/sess.jsonl' }),
    findTranscript: async () => { throw new Error('must not scan when the index knows'); },
  });
  assert.equal(await resolver.resolve('sess'), '/store/sess.jsonl');
});

// The actual 2026-07-29 failure. A session younger than the index has no
// meta.path, and the old resolver stopped there and returned null forever.
test('a session the index has not caught up to is still found on disk', async () => {
  let scanned = null;
  const resolver = createAskTranscriptResolver({
    getSessionMeta: async () => ({ path: null, cwd: '/home/dev/harbor', provider: 'claude' }),
    findTranscript: async (args) => { scanned = args; return '/store/-home-dev-harbor/sess.jsonl'; },
  });

  assert.equal(await resolver.resolve('sess'), '/store/-home-dev-harbor/sess.jsonl');
  assert.deepEqual(scanned, { provider: 'claude', sessionId: 'sess', cwd: '/home/dev/harbor' });
});

// Not even a meta record: findProviderTranscript scans the project dirs for
// `<id>.jsonl`, which is unique across the store, so no cwd is required.
test('a session with no index entry at all still resolves', async () => {
  const resolver = createAskTranscriptResolver({
    getSessionMeta: async () => null,
    findTranscript: async ({ sessionId, cwd }) => {
      assert.equal(cwd, null, 'no cwd is known, and none is needed');
      return `/store/found/${sessionId}.jsonl`;
    },
  });
  assert.equal(await resolver.resolve('sess'), '/store/found/sess.jsonl');
});

// The half that made the bug permanent rather than transient: the old code
// cached the index's `null`, so the first poll against a session that had not
// yet written its transcript poisoned every later poll for the life of the app.
test('a miss is never cached, so the next poll can succeed', async () => {
  let attempts = 0;
  const resolver = createAskTranscriptResolver({
    getSessionMeta: async () => null,
    findTranscript: async () => {
      attempts += 1;
      // The transcript does not exist yet on the first poll; it does on the
      // second, which is what a brand-new session actually looks like.
      return attempts >= 2 ? '/store/sess.jsonl' : null;
    },
  });

  assert.equal(await resolver.resolve('sess'), null, 'nothing on disk yet');
  assert.equal(await resolver.resolve('sess'), '/store/sess.jsonl', 'and the next poll finds it');
  assert.equal(attempts, 2, 'the miss did not short-circuit the retry');
});

test('a hit IS cached, so a steady poll costs one lookup', async () => {
  let lookups = 0;
  const resolver = createAskTranscriptResolver({
    getSessionMeta: async () => { lookups += 1; return { path: '/store/sess.jsonl' }; },
    findTranscript: async () => null,
  });

  await resolver.resolve('sess');
  await resolver.resolve('sess');
  await resolver.resolve('sess');
  assert.equal(lookups, 1);
});

test('provisional pane and live ids resolve to nothing without touching disk', async () => {
  const resolver = createAskTranscriptResolver({
    getSessionMeta: async () => { throw new Error('must not be consulted'); },
    findTranscript: async () => { throw new Error('must not be consulted'); },
  });
  assert.equal(await resolver.resolve('pane:w1:p2'), null);
  assert.equal(await resolver.resolve('live:abc'), null);
  assert.equal(await resolver.resolve(''), null);
});

// A lookup that throws is a card that vanishes, so neither source may escape.
test('a throwing index or a throwing scan degrades to null, never an exception', async () => {
  const resolver = createAskTranscriptResolver({
    getSessionMeta: async () => { throw new Error('index exploded'); },
    findTranscript: async () => { throw new Error('scan exploded'); },
  });
  assert.equal(await resolver.resolve('sess'), null);
});

// The E2E seam pins a specific file for a harness; it must still win.
test('an explicitly set path is used verbatim', async () => {
  const resolver = createAskTranscriptResolver({
    getSessionMeta: async () => ({ path: '/store/wrong.jsonl' }),
    findTranscript: async () => null,
  });
  resolver.set('sess', '/fixtures/pinned.jsonl');
  assert.equal(await resolver.resolve('sess'), '/fixtures/pinned.jsonl');
  resolver.forget('sess');
  assert.equal(await resolver.resolve('sess'), '/store/wrong.jsonl');
});
