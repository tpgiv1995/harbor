'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sessionModelOptions, sessionEffortOptions } = require('../src/renderer/session-model-options.cjs');
const { newSessionOptions } = require('../src/main/providers/capabilities.js');

test('fresh launch labels the renderer default while keeping other pinned versions collapsed', () => {
  const providerOptions = newSessionOptions({ profiles: [], providers: {} }, { env: {}, homedir: () => '/harbor-test-no-home' }).providers.claude;
  const rows = sessionModelOptions({ provider: 'claude', providerOptions, model: 'claude-opus-4-8', showVersions: false });
  assert.equal(rows.find(row => row.value === 'claude-opus-4-8').label, 'Opus 4.8');
  assert.equal(rows.filter(row => row.value === 'claude-opus-4-8').length, 1);
  assert.equal(rows.some(row => row.value === 'claude-opus-4-7'), false);
});

test('model switch constrains both displayed and submitted effort to that model', () => {
  const providerOptions = { efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    defaultEffort: 'medium', effortsByModel: { older: ['low', 'medium', 'high', 'xhigh'] } };
  assert.equal(sessionEffortOptions({ providerOptions, model: 'astra', effort: 'ultra' }).effort, 'ultra');
  const older = sessionEffortOptions({ providerOptions, model: 'older', effort: 'ultra' });
  assert.deepEqual(older.levels, ['low', 'medium', 'high', 'xhigh']);
  assert.equal(older.effort, 'medium');
  assert.equal(sessionEffortOptions({ providerOptions, model: 'older', effort: 'high' }).effort, 'high');
});

test('Claude account-default effort remains default at submission', () => {
  const providerOptions = { efforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max'] };
  assert.equal(sessionEffortOptions({ providerOptions, model: 'opus', effort: 'default' }).effort, 'default');
});

test('session reconfiguration uses its discovered pinned and cached labels', () => {
  const caps = { models: { versions: [{ id: 'pinned-model', label: 'Pinned model' }], cached: [{ id: 'private-model', label: 'Private model' }] } };
  for (const [model, label] of [['pinned-model', 'Pinned model'], ['private-model', 'Private model']]) {
    assert.equal(sessionModelOptions({ provider: 'claude', caps, model })[0].label, label);
  }
});

test('unknown models remain selectable and expanded versions never duplicate the current model', () => {
  assert.equal(sessionModelOptions({ provider: 'codex', model: 'future-id' })[0].value, 'future-id');
  const rows = sessionModelOptions({ provider:'claude', model:'pinned', showVersions:true,
    providerOptions:{models:[{value:'pinned', label:'Known'}], modelVersions:[{id:'pinned', label:'Pinned'}, {id:'other', label:'Other'}]} });
  assert.deepEqual(rows.map(row => row.value), ['pinned', 'other']);
});
