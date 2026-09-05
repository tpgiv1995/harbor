'use strict';

// What a window knows about its session before the session says anything.
// Pat, 2026-08-02: "i cant even see what model im in for these new sessions".
// A new session writes no transcript until its first message, so the model chip
// had nothing to read and fell back to the bare provider label, for minutes.

const test = require('node:test');
const assert = require('node:assert/strict');

const { mergeLaunchMeta, withLaunchFacts } = require('../../src/renderer/stage/launch-meta.cjs');

test('1) the launch config survives the id upgrade, whichever event carries it', () => {
  const provisional = {
    sessionId: 'pane:7', paneId: 7, cwd: '/home/p/wiki', model: 'opus', effort: 'xhigh',
  };
  // The daemon's pane-to-session pairing knows the real id and nothing about
  // the launch. It can arrive FIRST, and replacing the record wholesale dropped
  // the model exactly when the window still had no transcript to show it from.
  const paired = { sessionId: 'abc-123', paneId: 7, cwd: '/home/p/wiki', replacesKey: 'pane:7' };
  const merged = mergeLaunchMeta(provisional, paired);
  assert.equal(merged.sessionId, 'abc-123');
  assert.equal(merged.model, 'opus');
  assert.equal(merged.effort, 'xhigh');
});

test('2) a null never overwrites a known value, and a new value does', () => {
  const before = { model: 'opus', effort: 'xhigh', modelLabel: 'Opus 5' };
  assert.deepEqual(mergeLaunchMeta(before, { model: null, effort: undefined }), before);
  assert.deepEqual(
    mergeLaunchMeta(before, { model: 'sonnet', modelLabel: 'Sonnet 5' }),
    { model: 'sonnet', effort: 'xhigh', modelLabel: 'Sonnet 5' },
  );
  assert.deepEqual(mergeLaunchMeta(null, { model: 'opus' }), { model: 'opus' });
  assert.deepEqual(mergeLaunchMeta(undefined, undefined), {});
});

test('3) launch facts FILL a session row, and never overwrite a real one', () => {
  const meta = { model: 'opus', modelLabel: 'Opus 5', effort: 'xhigh' };
  const bare = { id: 'abc', title: 'New session' };
  assert.deepEqual(withLaunchFacts(bare, meta), {
    id: 'abc', title: 'New session', model: 'opus', modelLabel: 'Opus 5', effort: 'xhigh',
  });
  // A session that was reconfigured after launch reports its own truth; the
  // argv is history by then.
  const known = { id: 'abc', model: 'haiku', modelLabel: 'Haiku 4.5', effort: 'low' };
  assert.equal(withLaunchFacts(known, meta), known, 'same object: nothing to add');
  // Partial fill: the row knows the model, the launch knows the effort.
  assert.deepEqual(withLaunchFacts({ id: 'abc', model: 'haiku' }, meta), {
    id: 'abc', model: 'haiku', modelLabel: 'Opus 5', effort: 'xhigh',
  });
  assert.equal(withLaunchFacts(bare, null), bare);
  assert.equal(withLaunchFacts(null, meta), null);
});

// SUBSTRATE-3: caller-minted claude ids are real from the first frame, but the
// transcript file and its header still do not exist until the first message.
// launch-meta is what keeps the model chip honest in that gap.
test('4) minted claude still needs launch facts before any transcript header exists', () => {
  const mintedId = '8e5466c1-960d-4e97-b8e3-999edee069dd';
  const launched = {
    sessionId: mintedId,
    paneId: 'w4:p1',
    cwd: '/home/p/wiki',
    provider: 'claude',
    model: 'opus',
    effort: 'xhigh',
    modelLabel: 'Opus 5',
  };
  const merged = mergeLaunchMeta(null, launched);
  assert.equal(merged.sessionId, mintedId);
  assert.equal(merged.model, 'opus');
  assert.deepEqual(withLaunchFacts({ id: mintedId, title: 'New session' }, merged), {
    id: mintedId,
    title: 'New session',
    model: 'opus',
    modelLabel: 'Opus 5',
    effort: 'xhigh',
  });
  // No replacesKey on a minted launch: the merge path for id upgrades is codex-only now.
  assert.equal(launched.replacesKey, undefined);
  // Once the session has spoken, the transcript header outranks launch argv.
  const spoken = { id: mintedId, model: 'sonnet', modelLabel: 'Sonnet 5', effort: 'low' };
  assert.equal(withLaunchFacts(spoken, merged), spoken);
});

// The ACCOUNT is a launch fact too, and leaving it out cost Pat five sessions he
// did not want (2026-08-09). He clicked the rail's `S` to start a session on the
// third plan; the window drew a `T`, the default profile's letter, and kept
// drawing it for 1m46s until his first message finally wrote a transcript and
// the history index handed the row a real home. Measured from his own click
// stream: launch at 15:48:11, first message at 15:49:57, and four more clicks on
// the same button in between, because a badge naming the wrong plan is
// indistinguishable from a button that did nothing.
//
// Harbor knew the whole time. It launched the CLI itself with
// `--home /home/.../.claude-work`, and `session:launched` carries `account`.
// The synthetic-row path (a window whose session the model does not describe at
// all) already filled `home` from it; the FILL path did not, so the badge went
// wrong the moment the daemon's live pane row landed, which is seconds after the
// launch and long before any transcript exists. A profile is resolved with a
// silent fallback to the default (`resolveProfile`), so a missing home does not
// render as blank, it renders as somebody else's plan.
test('5) the account is a launch fact: a window never wears the default plan\'s badge', () => {
  const launched = {
    sessionId: 'abc-123', paneId: 'w4:p1', cwd: '/home/p/harbor',
    provider: 'claude', account: 'work', model: 'opus', effort: 'xhigh',
  };
  const meta = mergeLaunchMeta(null, launched);
  // The row the daemon's pane pairing produces: real, live, and home-less,
  // because `homes[]` is built from the history index and the session is not in
  // it yet.
  const live = { id: 'abc-123', project: 'harbor', isLive: true, home: null };
  assert.equal(withLaunchFacts(live, meta).home, 'work');
  // Same rule as every other launch fact: FILL only. A session whose home the
  // index does know reports its own truth. Its model and effort are set here
  // too, so the only thing this fixture leaves fillable is the home.
  const indexed = {
    id: 'abc-123', project: 'harbor', home: 'team', model: 'opus', effort: 'xhigh',
  };
  assert.equal(withLaunchFacts(indexed, meta), indexed, 'same object: nothing to add');
  // A launch that named no account adds nothing rather than inventing one.
  const anonymous = mergeLaunchMeta(null, { sessionId: 'abc-123', model: 'opus' });
  assert.equal(withLaunchFacts(live, anonymous).home, null);
});
