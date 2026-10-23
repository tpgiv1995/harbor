'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const { EventEmitter } = require('node:events');
const { fixture, row, pane, tick, rowsOf } = require('./sidebar-round3-fixture.cjs');

test('panes-changed fires even when a new pane adds no rail row', async (t) => {
  const { bridge, emit } = await fixture(t);
  const updates = []; const sets = [];
  bridge.emitter.on('update', (update) => updates.push(update));
  bridge.emitter.on('panes-changed', () => sets.push(bridge.getLivePaneIds()));
  emit({ event: 'pane.created', data: { pane: { ...pane('unlabelled', null), workspace_id: 'no-label' } } });
  assert.equal(updates.length, 0);
  assert.deepEqual(sets, [['unlabelled']]);
  emit({ event: 'pane.updated', data: { pane: { pane_id: 'unlabelled', terminal_title: 'Still no row' } } });
  assert.equal(sets.length, 1, 'title changes do not rebuild subscriptions');
  emit({ event: 'pane.closed', data: { pane_id: 'unlabelled' } });
  assert.deepEqual(sets.at(-1), []);
  const source = require('node:fs').readFileSync(require.resolve('../../src/main/index.js'), 'utf8');
  assert.match(source, /on\('panes-changed', \(\) => notifier.onBackgroundChanged\(\)\)/);
});
