'use strict';
// The live work meter runs for a codex window from its rollout alone (no pane
// line to poll). Source assertions, like the other renderer suites; the
// parsed numbers themselves are proven in test/providers/transcript-codex.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');
const tile = read('src/renderer/stage/SessionTile.jsx');

test('the work meter runs for codex without polling the pane, and a steer never restarts it', () => {
  assert.match(tile, /const readsPane = provider === 'claude';/);
  assert.match(tile, /const active = Boolean\(working && \(readsPane \? paneId : provider === 'codex'\)\);/);
  assert.match(tile, /const next = readsPane\s*\n\s*\? await window\.harbor\?\.session\?\.workMeter/, 'only a claude window reads the pane');
  assert.match(tile, /blocks\[i\]\.kind === 'user' && !blocks\[i\]\.queued && !blocks\[i\]\.steer/, 'the meter times the prompt that started the task');
});
