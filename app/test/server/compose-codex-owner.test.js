'use strict';

// The phone/server composition gets the Codex wiring index.js has: Resume and
// a dormant send from the phone run the owner check, and a Resume launches
// under the session's own account.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { composeServer } = require('../../src/server/compose.js');
// composeServer builds its own session-send, whose send log defaults to the
// user's real ~/.cache/harbor: a dormant send below would write there.
process.env.HARBOR_NO_SEND_LOG = '1';
const { OWNER_CODEX_APP, OWNER_HARBOR_PANE } = require('../../src/main/actions/codex-owner.js');

const ID = '01a14169-2e08-7a93-9102-d8c1505b66c0';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-compose-codex-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, 'user-data');
  const contextDir = path.join(root, 'context');
  const artifactsRoot = path.join(root, 'artifacts');
  const configFile = path.join(root, 'config.json');
  await Promise.all([userDataDir, contextDir, artifactsRoot].map((dir) => fs.mkdir(dir, { recursive: true })));
  await fs.writeFile(configFile, JSON.stringify({
    version: 1,
    profiles: [
      { id: 'personal', label: 'Personal', letter: 'P', color: '#437FFE', provider: 'claude', configHome: path.join(root, 'homes', 'personal'), email: null, isDefault: true },
      { id: 'codex', label: 'Codex', letter: 'C', color: '#7bd3a0', provider: 'codex', configHome: path.join(root, 'homes', 'codex'), email: null, isDefault: false },
      { id: 'codex-2', label: 'Codex 2', letter: 'C', color: '#7bd3a0', provider: 'codex', configHome: path.join(root, 'homes', 'codex2'), email: null, isDefault: false },
    ],
  }, null, 2));
  return {
    root,
    userDataDir,
    env: {
      ...process.env,
      HARBOR_NO_DAEMON_START: '1',
      HARBOR_NO_USAGE_FETCH: '1',
      HARBOR_CONTEXT_DIR: contextDir,
      HARBOR_SESSIOND_DIR: path.join(contextDir, '..', 'sessiond'),
      HARBOR_ARTIFACTS_ROOTS: artifactsRoot,
      HARBOR_ARTIFACTS_CACHE: path.join(root, 'artifact-cache.json'),
      HARBOR_TASKS_FILE: path.join(root, 'tasks.json'),
      HARBOR_CONFIG_FILE: configFile,
    },
  };
}

function providers(root, launched) {
  const codexMeta = { id: ID, provider: 'codex', cwd: root, profileId: 'codex-2', configHome: path.join(root, 'homes', 'codex2'), path: path.join(root, 'missing-rollout.jsonl') };
  return {
    sidebar: {
      emitter: new EventEmitter(), async start() {}, close() {},
      getState: () => ({ model: { projects: [] } }),
      getSessionMeta: async () => codexMeta,
    },
    artifacts: { async list() { return { ok: true, artifacts: [] }; }, isServable: () => false },
    icons: { async list() { return { icons: {} }; }, watch() {}, async filePathFor() { return null; }, mimeFor() { return null; } },
    tasks: { read: async () => ({}), mutate: async () => ({}), subscribe() {}, close() {} },
    terminalBridge: { emitter: new EventEmitter(), async start() {}, close() {}, requestFocusPane: async () => {} },
    usage: { getUsage: async () => ({}) },
    capabilities: { get: async () => ({}) },
    workflowRuns: { runsForSession: async () => [] },
    takeoverHandler: async () => ({}),
    launchActions: {
      resumeSession: async (payload) => { launched.push(['claude', payload]); return { ok: true }; },
      resumeProviderSession: async (payload) => { launched.push(['provider', payload]); return { ok: true }; },
      newSession: async () => ({ ok: true }),
    },
  };
}

test('phone Resume refuses beside a live Codex owner before anything launches, and resumes a gone one under its own account', async (t) => {
  const isolated = await fixture(t);
  const launched = [];
  let owner = { ownerGone: false, kind: 'app', reason: OWNER_CODEX_APP };
  const probed = [];
  const composed = await composeServer({
    userDataDir: isolated.userDataDir, env: isolated.env, ...providers(isolated.root, launched),
    sessionSend: { emitter: new EventEmitter(), paneIdSet: null },
    codexOwnerProbe: async (id) => { probed.push(id); return owner; },
  });
  t.after(() => composed.close());
  await assert.rejects(composed.router.call('resume-session', { id: ID }), /Codex app/);
  assert.deepEqual(probed, [ID]);
  assert.deepEqual(launched, [], 'nothing launched beside the live owner');
  owner = { ownerGone: true };
  await composed.router.call('resume-session', { id: ID });
  assert.deepEqual(launched, [['provider', {
    provider: 'codex', cwd: isolated.root, id: ID, profileId: 'codex-2', configHome: path.join(isolated.root, 'homes', 'codex2'),
  }]]);
});

test('a dormant phone send to a Codex session runs the owner probe the desktop runs', async (t) => {
  const isolated = await fixture(t);
  const launched = [];
  const probed = [];
  const composed = await composeServer({
    userDataDir: isolated.userDataDir, env: isolated.env, ...providers(isolated.root, launched),
    sendClient: { snapshot: async () => ({ panes: [] }), readPane: async () => ({}), close() {} },
    codexOwnerProbe: async (id) => { probed.push(id); return { ownerGone: false, kind: 'app', reason: OWNER_CODEX_APP }; },
  });
  t.after(() => composed.close());
  const result = await composed.router.call('session:send', { sessionId: ID, text: 'from the phone', provider: 'codex' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, OWNER_CODEX_APP);
  assert.deepEqual(probed, [ID]);
  assert.deepEqual(launched, [], 'no codex resume beside the app');
});

test('the server builds its own probe from its daemon snapshot and link registry', async (t) => {
  const isolated = await fixture(t);
  const launched = [];
  const composed = await composeServer({
    userDataDir: isolated.userDataDir, env: isolated.env, ...providers(isolated.root, launched),
    sessionSend: { emitter: new EventEmitter(), paneIdSet: null },
    // A Harbor Codex pane already on this thread (linked through the registry).
    sendClient: { snapshot: async () => ({ snapshot: { panes: [{ pane_id: 'pane-9', workspace_id: 'w1', pid: 999999, agent: 'codex' }] } }), close() {} },
    links: { all: () => ({ [ID]: { paneId: 'pane-9' } }), get: () => null, set() {}, emitter: new EventEmitter() },
  });
  t.after(() => composed.close());
  await assert.rejects(composed.router.call('resume-session', { id: ID }), (error) => error.message === OWNER_HARBOR_PANE);
  assert.deepEqual(launched, []);
});

test('the server hands sessionSend its owner probe and dispatches adopt-on-send by provider', () => {
  const source = fsSync.readFileSync(path.join(__dirname, '../../src/server/compose.js'), 'utf8');
  const send = source.slice(source.indexOf('createSessionSend({'), source.indexOf('const liveAskFor'));
  assert.match(send, /^    codexOwnerProbe,$/m);
  assert.match(source, /meta\?\.provider === 'codex' \? codexTakeover\(\{ sessionId \}\) : claudeTakeover\(\{ sessionId \}\)/);
});
