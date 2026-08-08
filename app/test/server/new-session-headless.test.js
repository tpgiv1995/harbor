'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { WebSocket } = require('ws');
const { composeServer } = require('../../src/server/compose.js');

function call(url, method, payload) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('error', reject);
    ws.once('open', () => ws.send(JSON.stringify({ id: 1, method, payload })));
    ws.once('message', (bytes) => {
      const message = JSON.parse(bytes);
      ws.close();
      resolve(message);
    });
  });
}

async function fixture(t, { fakeLaunch = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-new-session-headless-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const recent = path.join(root, 'recent-project');
  const older = path.join(root, 'older-project');
  await Promise.all([recent, older].map((folder) => fs.mkdir(folder, { recursive: true })));
  const launches = [];
  // Config homes are INJECTED via a config file this fixture writes, never
  // discovered from whatever `~/.claude*` directories happen to exist on the
  // machine running the test. Without this, composeServer's config store sees
  // no prior install under a fresh userDataDir and falls back to the SCHEMA's
  // single 'personal' seed, so 'team' silently resolved to the default
  // profile everywhere except the author's own machine (see
  // test/actions/launch.test.js for the same rule stated at length).
  const profiles = [
    { id: 'personal', label: 'Personal', letter: 'P', color: '#437FFE', provider: 'claude', configHome: path.join(root, '.claude'), email: null, isDefault: true },
    { id: 'team', label: 'Team', letter: 'T', color: '#D68A5A', provider: 'claude', configHome: path.join(root, '.claude-team'), email: null, isDefault: false },
  ];
  const configFile = path.join(root, 'config.json');
  await fs.writeFile(configFile, JSON.stringify({ profiles }, null, 2));
  const sidebar = {
    emitter: new EventEmitter(),
    async start() {},
    close() {},
    getState: () => ({
      model: {
        projects: [
          { sessions: [{ cwd: recent, lastActiveMs: 20 }, { cwd: recent, lastActiveMs: 10 }] },
          { sessions: [{ cwd: older, lastActiveMs: 5 }, { cwd: null, lastActiveMs: 1 }] },
        ],
      },
    }),
    getSessionMeta: async () => ({ cwd: recent }),
  };
  const env = {
    ...process.env,
    HARBOR_NO_DAEMON_START: '1',
    HARBOR_NO_USAGE_FETCH: '1',
    HARBOR_TAILNET_LOGINS: 'none',
    HARBOR_CONTEXT_DIR: path.join(root, 'context'),
    HARBOR_SESSIOND_DIR: path.join(root, 'sessiond'),
    HARBOR_ARTIFACTS_ROOTS: path.join(root, 'artifacts'),
    HARBOR_ARTIFACTS_CACHE: path.join(root, 'artifacts-index.json'),
    HARBOR_TASKS_FILE: path.join(root, 'tasks.json'),
    HARBOR_E2E_FAKE_LAUNCH: fakeLaunch ? '1' : '0',
  };
  await Promise.all([
    fs.mkdir(env.HARBOR_CONTEXT_DIR, { recursive: true }),
    fs.mkdir(env.HARBOR_ARTIFACTS_ROOTS, { recursive: true }),
  ]);
  const composed = await composeServer({
    userDataDir: path.join(root, 'user-data'),
    configFile,
    env,
    sidebar,
    artifacts: { async list() { return { ok: true, artifacts: [] }; }, isServable() { return false; } },
    icons: { async list() { return { icons: {} }; }, watch() {}, async filePathFor() { return null; }, mimeFor() { return null; } },
    tasks: { read: async () => ({}), mutate: async () => ({}), subscribe() {}, close() {} },
    terminalBridge: {
      emitter: new EventEmitter(), async start() {}, close() {}, sendInput: async () => ({ ok: true }),
    },
    sessionSend: {
      emitter: new EventEmitter(),
      send: async () => ({ ok: true }),
      getMenu: async () => null,
      answerMenu: async () => ({ ok: true }),
      getQueueState: () => ({ count: 0 }),
      cancelQueued: () => ({ ok: true }),
    },
    onFakeLaunch: (record) => launches.push(record),
  });
  t.after(() => composed.close());
  const address = await composed.listen({ host: '127.0.0.1', port: 0 });
  const url = `ws://127.0.0.1:${address.port}/ws`;
  return { composed, url, recent, older, launches, root, profiles };
}

test('headless new-session options and candidate folders are available without a native dialog', async (t) => {
  const h = await fixture(t);
  const options = (await call(h.url, 'new-session:options')).result;
  assert.deepEqual(Object.keys(options.providers), ['claude', 'codex', 'cursor']);
  assert.equal(options.providers.claude.models.some(({ value }) => value === 'opus'), true);
  assert.deepEqual(await h.composed.router.call('new-session:folder'), [h.recent, h.older]);
});

test('authenticated new-session launches a candidate folder with the selected provider argv, while anonymous is refused', async (t) => {
  const h = await fixture(t);
  const payload = { account: 'team', folder: h.recent, provider: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh' };

  const anonymous = await call(h.url, 'new-session', payload);
  assert.match(anonymous.error, /authentication required.*new-session/);
  assert.equal(h.launches.length, 0);

  const allowed = await call(`${h.url}?token=${h.composed.token}`, 'new-session', payload);
  assert.equal(allowed.error, undefined);
  // An account travels as its config home and nothing else. There used to be a
  // per-account flag here too, one literal flag per account, which only ever
  // existed for two ids on one machine.
  assert.deepEqual(allowed.result.argv, [
    '--home', path.join(h.root, '.claude-team'),
    '--provider', 'codex', '--model', 'gpt-5.6-sol', '--effort', 'xhigh',
  ]);
  assert.equal(allowed.result.cwd, h.recent);
  assert.deepEqual(h.launches[0].argv, allowed.result.argv);
  assert.equal(h.launches[0].options.cwd, h.recent);
});

test('headless new-session refuses a non-candidate folder and the same launch succeeds for a candidate', async (t) => {
  const h = await fixture(t);
  const payload = { account: 'personal', provider: 'claude', model: 'opus', effort: 'xhigh' };
  const refused = await call(`${h.url}?token=${h.composed.token}`, 'new-session', {
    ...payload,
    folder: path.join(h.older, 'not-indexed'),
  });
  assert.match(refused.error, /not a candidate project folder/);
  assert.equal(h.launches.length, 0);

  const allowed = await call(`${h.url}?token=${h.composed.token}`, 'new-session', { ...payload, folder: h.older });
  assert.equal(allowed.error, undefined);
  assert.equal(h.launches.length, 1);
});

test('a non-default profile still refuses a real launch, while fake launch accepts the same candidate', async (t) => {
  const blocked = await fixture(t, { fakeLaunch: false });
  await assert.rejects(
    blocked.composed.router.call('new-session', { folder: blocked.recent, provider: 'claude' }),
    /refusing to launch a real session.*isolated profile/,
  );
  assert.equal(blocked.launches.length, 0);

  const allowed = await fixture(t, { fakeLaunch: true });
  await assert.doesNotReject(
    allowed.composed.router.call('new-session', { folder: allowed.recent, provider: 'claude' }),
  );
  assert.equal(allowed.launches.length, 1);
});
