'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const indexSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/renderer/index.jsx'),
  'utf8',
);

test('stage cull waits for an explicit sidebar model-loaded signal', () => {
  assert.match(indexSource, /const modelReady = sidebarModelLoaded/);
  assert.match(indexSource, /setSidebarModelLoaded\(true\)/);
  assert.doesNotMatch(indexSource, /projects \|\| \[\]\)\.length > 0/);
});

test('restoreTiles dedupes duplicate session ids', () => {
  assert.match(indexSource, /seenSessionIds/);
  assert.match(indexSource, /if \(seenSessionIds\.has\(sessionId\)\) return null/);
});
