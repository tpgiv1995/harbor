'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.resolve(__dirname, '../../src/main/index.js'), 'utf8');

// The renderer heap snapshot armed on 2026-09-06 named the OOM leak, and also
// froze the whole app for the write (40s at 1745MB; Pat: "harbor like freezes
// up entirely", twice in one afternoon). A V8 heap snapshot is stop-the-world
// for the renderer, so it is opt-in via HARBOR_HEAP_SNAPSHOT_MB and disarmed
// by default. This pins both halves.
test('the renderer heap snapshot is disarmed unless HARBOR_HEAP_SNAPSHOT_MB names a threshold', () => {
  assert.match(src, /const HEAP_SNAPSHOT_MB = Number\(process\.env\.HARBOR_HEAP_SNAPSHOT_MB\) \|\| 0;/);
  assert.match(src, /let heapSnapshotArmed = HEAP_SNAPSHOT_MB > 0;/);
  assert.match(src, /usedHeapMB < HEAP_SNAPSHOT_MB\) return;/);
  assert.doesNotMatch(src, /let heapSnapshotArmed = true;/);
  assert.doesNotMatch(src, /usedHeapMB < 900\) return;/);
});
