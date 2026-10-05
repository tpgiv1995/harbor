'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('installed change refreshes only that provider then invalidates renderer options, failures also notify', async () => {
  const { createProviderModelRefresh } = require('../../src/main/providers/provider-model-refresh.js');
  const calls = [];
  const catalogs = Object.fromEntries(['claude', 'codex', 'cursor'].map((provider) => [provider, {
    refresh: async (args) => { calls.push([provider, args]); return { ok: true }; },
  }]));
  const refresh = createProviderModelRefresh({ catalogs, env: {}, notify: (payload) => calls.push(['notify', payload]) });
  for (const provider of Object.keys(catalogs)) {
    await refresh({ provider, installed: 'new', source: 'external' });
    assert.equal(calls.at(-2)[0], provider);
    assert.equal(calls.at(-1)[0], 'notify');
  }
  catalogs.cursor.refresh = async () => { throw Error('offline'); };
  await refresh({ provider: 'cursor', installed: 'newer' });
  assert.equal(calls.at(-1)[1].provider, 'cursor');
  const disabled = createProviderModelRefresh({ catalogs, env: { HARBOR_E2E: '1' }, notify: () => assert.fail('disabled') });
  const count = calls.length;
  await disabled({ provider: 'codex', installed: 'newer' });
  assert.equal(calls.length, count);
});

test('open options subscriber refetches and rejects late stale answers; closing unsubscribes', async () => {
  const { watchProviderOptions } = require('../../src/renderer/provider-options.cjs');
  let listener;
  let closed = false;
  const pending = [];
  const seen = [];
  const api = { session: {
    newOptions: () => new Promise((resolve) => pending.push(resolve)),
    onModelsChanged: (fn) => { listener = fn; return () => { closed = true; }; },
  } };
  const stop = watchProviderOptions({ api, onOptions: (options) => seen.push(options) });
  assert.equal(pending.length, 1);
  listener();
  pending[1]('fresh');
  await new Promise((resolve) => setImmediate(resolve));
  pending[0]('stale');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ['fresh']);
  stop();
  assert.equal(closed, true);
});

test('boot discoveries wait for startup gate and coalesce to the newest version', async () => {
  const { createProviderModelRefresh } = require('../../src/main/providers/provider-model-refresh.js');
  const versions = [];
  const refresh = createProviderModelRefresh({ env: {}, defer: true,
    catalogs: { cursor: { refresh: async ({ version }) => { versions.push(version); return { ok: true }; } } }, notify: () => {} });
  await refresh({ provider: 'cursor', installed: 'old' });
  await refresh({ provider: 'cursor', installed: 'new' });
  assert.deepEqual(versions, []);
  assert.deepEqual(await refresh.start(), ['cursor']);
  assert.deepEqual(versions, ['new']);
  await refresh({ provider: 'cursor', installed: 'newer' });
  assert.deepEqual(versions, ['new', 'newer']);
});

test('a configured CLI catalog is discovered even when stock install metadata is absent', async () => {
  const { createProviderModelRefresh } = require('../../src/main/providers/provider-model-refresh.js');
  let calls = 0;
  const refresh = createProviderModelRefresh({ env: {}, catalogs: {
    cursor: { refresh: async () => { calls += 1; return { ok: true }; } },
  }, notify: () => {} });
  await refresh({ provider: 'cursor', installed: null });
  assert.equal(calls, 1);
});

test('returning to an open model menu rereads an externally updated catalog', async () => {
  const {watchProviderOptions}=require('../../src/renderer/provider-options.cjs');
  const focusTarget=new EventTarget();let revision=1;const seen=[];
  const stop=watchProviderOptions({focusTarget,api:{session:{newOptions:async()=>revision}},onOptions:r=>seen.push(r)});
  await new Promise(r=>setImmediate(r));revision=2;focusTarget.dispatchEvent(new Event('focus'));
  await new Promise(r=>setImmediate(r));assert.deepEqual(seen,[1,2]);
  stop();revision=3;focusTarget.dispatchEvent(new Event('focus'));
  await new Promise(r=>setImmediate(r));assert.deepEqual(seen,[1,2]);
});
