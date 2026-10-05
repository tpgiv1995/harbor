'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDialogStore } = require('../../src/renderer/stage/dialog-state.cjs');
const { runStateCue } = require('../../src/shared/session-run-state.cjs');
const { attentionFor, badgeCounts, emptyStore } = require('../../src/renderer/stage/unseen-completions.cjs');
const { planTaskbarBadge } = require('../../src/renderer/stage/taskbar-badge.cjs');

test('model dialog evidence blocks its session and clears without changing another session', () => {
  const store = createDialogStore();
  const session = { id: 'one', isLive: true };
  store.set('one', true);
  store.set('two', true);
  const snapshot = store.getSnapshot();
  store.set('one', true);
  assert.equal(snapshot, store.getSnapshot());
  assert.equal(runStateCue(session, null, { blocked: snapshot.has(session.id) }).kind, 'blocked');
  const descriptor = { ...session, open: true, blocked: snapshot.has(session.id) };
  assert.equal(attentionFor(descriptor, emptyStore()), 'blocked');
  assert.equal(planTaskbarBadge(badgeCounts([descriptor], emptyStore())).kind, 'amber');
  // Selection suppresses the rail pip, but an unanswered selected tile still
  // needs the amber taskbar badge when the user is in another application.
  descriptor.isSelected = true;
  assert.equal(attentionFor(descriptor, emptyStore()), null);
  assert.equal(planTaskbarBadge(badgeCounts([descriptor], emptyStore())).kind, 'amber');
  store.set('one', false);
  assert.equal(store.getSnapshot().has('two'), true);
  assert.notEqual(runStateCue(session, null, { blocked: store.getSnapshot().has(session.id) }).kind, 'blocked');
});
