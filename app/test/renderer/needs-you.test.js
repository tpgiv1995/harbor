'use strict';
// The title bar's "N need you" and the rail filter it opens.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { needsYouIds, attentionFor, badgeCounts, emptyStore } = require('../../src/renderer/stage/unseen-completions.cjs');

const descriptor = (id, extra = {}) => ({ id, open: true, isHistorical: true, activeMs: 1, blocked: false, isSelected: false, excluded: false, ...extra });

test('the SELECTED blocked session still needs you, as the badge says', () => {
  const sessions = [descriptor('a', { blocked: true, isSelected: true }), descriptor('b', { blocked: true }), descriptor('c')];
  assert.equal(attentionFor(sessions[0], emptyStore()), null, 'the attention map drops what you are looking at');
  assert.deepEqual(needsYouIds(sessions), ['a', 'b']);
  assert.equal(badgeCounts(sessions, emptyStore()).blocked, 2, 'and the badge agrees');
});

test('machine-made sessions are not waiting on you; rows not open as windows are', () => {
  assert.deepEqual(needsYouIds([
    descriptor('worker', { blocked: true, excluded: true }),
    descriptor('closed-window', { blocked: true, open: false }),
    null,
  ]), ['closed-window']);
  assert.deepEqual(needsYouIds(undefined), []);
});

test('the App and the rail use needsYouIds, never the selection-blind attention map', () => {
  const app = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.jsx'), 'utf8');
  assert.match(app, /needsYouIds\(attentionDescriptors\)/);
  const rail = fs.readFileSync(path.join(__dirname, '../../src/renderer/sidebar/Sidebar.jsx'), 'utf8');
  const filter = rail.slice(rail.indexOf('if (needsYouOnly) {'), rail.indexOf('return filterProjects(groupedModel, {\n      filter: filter.kind'));
  assert.match(filter, /needsYou\?\.has\?\.\(session\.id\)/);
  assert.doesNotMatch(filter, /attention/);
});
