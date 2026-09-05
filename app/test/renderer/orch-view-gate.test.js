'use strict';

// Orchestration is optional, so the Orch view must be UNREACHABLE when it is off,
// not merely unadvertised. The setup wizard writes `orchestration.enabled: false`
// correctly, but the tab kept rendering, because hiding it needs a prop threaded
// through Sidebar.jsx and the batch that built the wizard was scoped out of that
// file. That left the one thing this repo's doctrine names explicitly: a skippable
// step into a dead end, since the panel behind the tab has no launcher configured.
//
// Removing the tab alone is not enough. `harbor-view` persists the last view in
// localStorage, so a user who was on Orch when they disabled it would restore
// straight back into the dead panel with no tab to leave by.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { setupState } = require('../../src/main/setup/ipc.js');

const read = (rel) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');
const indexSource = read('src/renderer/index.jsx');
const viewSwitchSource = read('src/renderer/ViewSwitch.jsx');
const sidebarSource = read('src/renderer/sidebar/Sidebar.jsx');

test('setup:state reports orchestration as enabled unless config says otherwise', () => {
  // The schema default is true, so only an explicit false disables it. Anything
  // else (absent config, absent key, a half-written file) must keep the feature.
  assert.equal(setupState({ orchestration: { enabled: false } }).orchestrationEnabled, false);
  assert.equal(setupState({ orchestration: { enabled: true } }).orchestrationEnabled, true);
  assert.equal(setupState({ orchestration: {} }).orchestrationEnabled, true);
  assert.equal(setupState({}).orchestrationEnabled, true);
  assert.equal(setupState(null).orchestrationEnabled, true);
  assert.equal(setupState(undefined).orchestrationEnabled, true);
});

test('setup:state still answers the completion question it already owned', () => {
  const state = setupState({ setup: { completed: true, completedAt: 12 }, orchestration: { enabled: false } });
  assert.equal(state.completed, true);
  assert.equal(state.completedAt, 12);
  assert.equal(state.orchestrationEnabled, false);
});

test('ViewSwitch drops the Orch tab rather than greying it', () => {
  assert.match(viewSwitchSource, /orchEnabled = true/);
  assert.match(viewSwitchSource, /VIEWS\.filter\(\(\[key\]\) => key !== 'orch'\)/);
  // Rendering must walk the filtered list, not the constant.
  assert.match(viewSwitchSource, /\{views\.map\(\(\[key, label, title, glyph\]\) => \(/);
});

test('Sidebar threads the flag through to the switch', () => {
  assert.match(sidebarSource, /orchEnabled = true/);
  assert.match(sidebarSource, /<ViewSwitch[^>]*orchEnabled=\{orchEnabled\}/);
});

test('the renderer makes Orch unreachable, not just unlisted', () => {
  // Reads the real decision rather than assuming.
  assert.match(indexSource, /window\.harbor\.setup\?\.state\?\.\(\)/);
  assert.match(indexSource, /orchestrationEnabled !== false/);
  // Both entry points refuse.
  assert.match(indexSource, /if \(next === 'orch' && !orchEnabled\) return;/);
  assert.match(indexSource, /const openOrch = useCallback\(\(proj\) => \{\s*if \(!orchEnabled\) return;/);
  // A persisted 'orch' view is corrected instead of restoring into the dead panel.
  assert.match(indexSource, /if \(orchEnabled \|\| view !== 'orch'\) return;/);
  assert.match(indexSource, /orchEnabled=\{orchEnabled\}/);
});

test('a missing setup channel leaves orchestration on', () => {
  // Optional chaining on both the namespace and the method: an older preload, or
  // a harness that stubs a partial window.harbor, must not silently hide the view.
  assert.match(indexSource, /window\.harbor\.setup\?\.state\?\./);
  assert.match(indexSource, /useState\(true\);?\s*$/m);
});
