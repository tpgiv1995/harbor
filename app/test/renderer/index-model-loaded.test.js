'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const indexSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/renderer/index.jsx'),
  'utf8',
);

// 2026-09-04: the stage used to CULL restored tiles whose session was missing
// from whatever sidebar model arrived first, and persist the cull, which
// wiped every open window whenever a boot's model was transiently short
// ("Nothing on the stage" over 14 live sessions). The persisted store is now
// resolved through stage-resolve.cjs on every render: absent tiles hide and
// come back, and nothing about the model ever writes to the store.
test('the stage never culls persisted tiles from a model snapshot', () => {
  assert.match(indexSource, /from '\.\/stage\/stage-resolve\.cjs'/);
  assert.match(indexSource, /resolveStage\(\{/);
  assert.match(indexSource, /pickEviction\(\{/);
  assert.doesNotMatch(indexSource, /const modelReady = sidebarModelLoaded/);
  assert.doesNotMatch(indexSource, /prev\.tiles\.filter\(\(t\) => \{\s*\n\s*const id = String\(t\.sessionId\);/);
});

test('restoreTiles dedupes duplicate session ids', () => {
  assert.match(indexSource, /seenSessionIds/);
  assert.match(indexSource, /if \(seenSessionIds\.has\(sessionId\)\) return null/);
});
