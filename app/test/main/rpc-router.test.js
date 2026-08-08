'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const LIVE_METHODS = `accounts:read-emails artifacts:list artifacts:open-external artifacts:show-in-folder artifacts:thumb capabilities:cycle-permission-mode capabilities:get capabilities:permission-mode clipboard:read-image clipboard:save-image context-menu:add-to-dictionary context-menu:edit-action context-menu:replace-misspelling context-menu:spell-status daemon:get-banner daemon:retry diag:input e2e:emit-launched e2e:get-launch-calls e2e:get-metrics e2e:mark-interactive e2e:quit e2e:session-owner-pid e2e:set-ask-transcript e2e:set-link links:get new-session new-session:folder new-session:options orchestration:get-data orchestration:kickoff-execute orchestration:kickoff-research orchestration:session-preview orchestration:unwatch orchestration:unwatch-summaries orchestration:watch orchestration:watch-summaries pane:focus perf:stall pick-files pick-folder project-icons:list project-icons:reveal resume-session session:cancel-send session:delete session:interrupt session:menu-answer session:menu-state session:preview session:send session:send-queue session:takeover session:workflow-runs setup:catalog setup:detect setup:login setup:pick-folder setup:preview setup:read-home setup:save setup:state setup:symlink-apply setup:symlink-plan sidebar:get-state tasks:mutate tasks:read tasks:reveal terminal:blur-pane terminal:close-tab terminal:close-workspace terminal:create-tab terminal:create-workspace terminal:focus-pane terminal:focus-tab terminal:focus-workspace terminal:get-state terminal:rename-tab terminal:resize-pane terminal:send-input terminal:set-visible-panes transcript:close transcript:open upload:image usage:get-all voice:token voice:voices whisper:transcribe window:close window:get-bounds window:is-maximized window:menu-action window:minimize window:set-bounds window:toggle-maximize worker:close workflow:run`.split(' ');
const LIVE_PUSH_CHANNELS = `app:update-available context-menu:show daemon:banner links:update orchestration:summaries orchestration:update project-icons:update send:status session:launched setup:open sidebar:update tasks:changed terminal:backfill terminal:control-state terminal:frame terminal:reset terminal:update transcript:update usage:update window:maximize-changed`.split(' ');
const LOCAL_ONLY_METHODS = `artifacts:open-external artifacts:show-in-folder clipboard:read-image clipboard:save-image context-menu:add-to-dictionary context-menu:edit-action context-menu:replace-misspelling context-menu:spell-status pick-files pick-folder project-icons:reveal setup:login setup:pick-folder setup:symlink-apply tasks:reveal window:close window:get-bounds window:is-maximized window:menu-action window:minimize window:set-bounds window:toggle-maximize`.split(' ');
const MUTATING_METHODS = `artifacts:thumb capabilities:cycle-permission-mode daemon:retry new-session orchestration:kickoff-execute orchestration:kickoff-research pane:focus resume-session session:cancel-send session:delete session:interrupt session:menu-answer session:menu-state session:send session:takeover setup:save tasks:mutate terminal:blur-pane terminal:close-tab terminal:close-workspace terminal:create-tab terminal:create-workspace terminal:focus-pane terminal:focus-tab terminal:focus-workspace terminal:rename-tab terminal:resize-pane terminal:send-input terminal:set-visible-panes upload:image voice:token whisper:transcribe worker:close workflow:run`.split(' ');

function mainSources() {
  const root = path.join(__dirname, '../../src/main');
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(target);
    }
  };
  visit(root);
  return files.map((file) => ({ file, source: fs.readFileSync(file, 'utf8') }));
}

function registeredMethodChannels() {
  const channels = new Set();
  for (const { source } of mainSources()) {
    for (const match of source.matchAll(/\bipcMain\.(?:handle|on)\(\s*['"]([^'"]+)['"]/g)) {
      channels.add(match[1]);
    }
    for (const match of source.matchAll(/\bhandle\(\s*['"]([^'"]+)['"]/g)) channels.add(match[1]);
    for (const match of source.matchAll(/\bregisterIpcHandler\([^,]+,[^,]+,\s*['"]([^'"]+)['"]/g)) {
      channels.add(match[1]);
    }
    if (/Object\.entries\(handlers\)/.test(source)) {
      for (const match of source.matchAll(/^\s*['"]([^'"]+)['"]\s*:/gm)) channels.add(match[1]);
    }
  }
  return [...channels].sort();
}

test('router dispatches payload and context and enumerates registration order', async () => {
  const { createRouter } = require('../../src/main/rpc/router.js');
  const router = createRouter();
  router.register('first', (payload, ctx) => ({ payload, ctx }));
  router.register('second', () => 'second');

  const ctx = { source: 'test' };
  assert.deepEqual(await router.call('first', { value: 7 }, ctx), {
    payload: { value: 7 }, ctx,
  });
  assert.deepEqual(router.methods(), ['first', 'second']);
  assert.throws(() => router.register('first', () => {}), /already registered/);
  await assert.rejects(router.call('missing'), /unknown RPC method/);
});

test('router emits named pushes without a transport dependency', () => {
  const { createRouter } = require('../../src/main/rpc/router.js');
  const router = createRouter();
  const received = [];
  const unsubscribe = router.onPush((channel, payload) => received.push([channel, payload]));
  router.emit('sidebar:update', { ready: true });
  unsubscribe();
  router.emit('sidebar:update', { ready: false });
  assert.deepEqual(received, [['sidebar:update', { ready: true }]]);
});

test('channel metadata covers exactly the captured 97 methods and 20 pushes', () => {
  const { METHOD_CHANNELS, PUSH_CHANNELS } = require('../../src/main/rpc/channels.js');
  assert.deepEqual([...METHOD_CHANNELS.map(({ method }) => method)].sort(), LIVE_METHODS);
  assert.deepEqual([...PUSH_CHANNELS].sort(), LIVE_PUSH_CHANNELS);
  assert.equal(new Set(METHOD_CHANNELS.map(({ method }) => method)).size, 97);
  assert.equal(new Set(PUSH_CHANNELS).size, 20);
  assert.ok(METHOD_CHANNELS.every(({ capability }) => (
    ['local-only', 'remote-safe', 'mutating'].includes(capability)
  )));
  assert.deepEqual(
    Object.fromEntries(['local-only', 'remote-safe', 'mutating'].map((capability) => [
      capability,
      METHOD_CHANNELS.filter((entry) => entry.capability === capability).length,
    ])),
    { 'local-only': 22, 'remote-safe': 41, mutating: 34 },
  );
  assert.deepEqual(
    METHOD_CHANNELS.filter(({ capability }) => capability === 'local-only')
      .map(({ method }) => method).sort(),
    LOCAL_ONLY_METHODS,
  );
  assert.deepEqual(
    METHOD_CHANNELS.filter(({ capability }) => capability === 'mutating')
      .map(({ method }) => method).sort(),
    MUTATING_METHODS,
  );
});

test('capability classification fails closed for an untagged method', () => {
  const { buildCapability } = require('../../src/main/rpc/channels.js');
  assert.throws(
    () => buildCapability('phone:untagged'),
    /'phone:untagged' is in 0 capability sets \(none\).*Unclassified is not remote-safe/,
  );
});

test('every IPC registration under src/main has channel metadata', () => {
  const { METHOD_CHANNELS, PUSH_CHANNELS } = require('../../src/main/rpc/channels.js');
  const sources = mainSources();
  assert.deepEqual(
    registeredMethodChannels(),
    METHOD_CHANNELS.map(({ method }) => method).filter((method) => method !== 'upload:image').sort(),
  );
  const indexSource = sources.find(({ file }) => file.endsWith('/index.js')).source;
  const pushed = [...new Set([...indexSource.matchAll(/sendToRenderer\('([^']+)'/g)]
    .map((match) => match[1]))].sort();
  assert.deepEqual(pushed, [...PUSH_CHANNELS].sort());
});

test('IPC transport preserves invoke and one-way registration and forwards pushes', async () => {
  const { createRouter } = require('../../src/main/rpc/router.js');
  const { bindIpcMain } = require('../../src/main/rpc/ipc-transport.js');
  const router = createRouter();
  const registrations = { handle: [], on: [] };
  const ipcMain = {
    handle: (method, handler) => registrations.handle.push([method, handler]),
    on: (method, handler) => registrations.on.push([method, handler]),
  };
  const sent = [];
  const webContents = { send: (...args) => sent.push(args) };
  router.register('sidebar:get-state', (payload, ctx) => ({ payload, source: ctx.source, event: ctx.event }));
  router.register('window:minimize', (payload, ctx) => ({ payload, source: ctx.source, event: ctx.event }));

  bindIpcMain(router, ipcMain, () => webContents);

  const invokeEvent = { id: 'invoke' };
  assert.deepEqual(await registrations.handle[0][1](invokeEvent, { n: 1 }), {
    payload: { n: 1 }, source: 'ipc', event: invokeEvent,
  });
  const sendEvent = { id: 'send' };
  registrations.on[0][1](sendEvent, { n: 2 });
  router.emit('sidebar:update', { ready: true });
  router.emit('usage:update');
  assert.deepEqual(sent, [['sidebar:update', { ready: true }], ['usage:update']]);
});
