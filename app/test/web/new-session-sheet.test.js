'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { composeServer } = require('../../src/server/compose.js');

const APP_ROOT = path.join(__dirname, '../..');
const WEB_ROOT = path.join(APP_ROOT, 'web');

async function composeFixture(t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'harbor-new-session-sheet-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const recent = path.join(root, 'recent-project');
  const older = path.join(root, 'older-project');
  await Promise.all([recent, older].map((folder) => fs.promises.mkdir(folder, { recursive: true })));

  const launches = [];
  const newSessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const sidebarState = {
    model: {
      projects: [
        {
          label: 'recent-project',
          sessions: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              title: 'Existing session',
              cwd: recent,
              lastActiveMs: 20,
              isLive: false,
            },
          ],
        },
        {
          label: 'older-project',
          sessions: [
            {
              id: '22222222-2222-4222-8222-222222222222',
              title: 'Older session',
              cwd: older,
              lastActiveMs: 5,
              isLive: false,
            },
          ],
        },
      ],
    },
  };

  const sidebar = {
    emitter: new EventEmitter(),
    async start() {},
    close() {},
    getState: () => sidebarState,
    getSessionMeta: async () => ({ cwd: recent }),
  };

  const env = {
    ...process.env,
    HARBOR_NO_DAEMON_START: '1',
    HARBOR_NO_USAGE_FETCH: '1',
    HARBOR_TAILNET_LOGINS: 'none',
    HARBOR_CONTEXT_DIR: path.join(root, 'context'),
    HARBOR_ARTIFACTS_ROOTS: path.join(root, 'artifacts'),
    HARBOR_ARTIFACTS_CACHE: path.join(root, 'artifacts-index.json'),
    HARBOR_TASKS_FILE: path.join(root, 'tasks.json'),
    HARBOR_SESSIOND_DIR: path.join(root, 'sessiond'),
    HARBOR_E2E_FAKE_LAUNCH: '1',
  };
  await Promise.all([
    fs.promises.mkdir(env.HARBOR_CONTEXT_DIR, { recursive: true }),
    fs.promises.mkdir(env.HARBOR_ARTIFACTS_ROOTS, { recursive: true }),
  ]);

  const composed = await composeServer({
    userDataDir: path.join(root, 'user-data'),
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
    onFakeLaunch: (record) => {
      launches.push(record);
      const cwd = record.options?.cwd;
      const now = Date.now();
      sidebarState.model.projects.unshift({
        label: path.basename(cwd || 'new'),
        sessions: [{
          id: newSessionId,
          title: 'Fresh session',
          cwd,
          lastActiveMs: now,
          isLive: true,
          provider: 'claude',
        }],
      });
      sidebar.emitter.emit('update', sidebarState);
    },
  });
  t.after(() => composed.close());
  const address = await composed.listen({ host: '127.0.0.1', port: 0 });
  const httpUrl = `http://127.0.0.1:${address.port}`;
  return {
    composed,
    httpUrl,
    token: composed.token,
    recent,
    older,
    launches,
    newSessionId,
  };
}

test('MOBILE-OVERHAUL-5: NewSessionSheet loads server folders and provider registry', () => {
  const source = fs.readFileSync(path.join(WEB_ROOT, 'src/newsession/NewSessionSheet.jsx'), 'utf8');
  assert.match(source, /new-session:options/);
  assert.match(source, /new-session:folder/);
  assert.match(source, /new-session'/);
  assert.doesNotMatch(source, /useRpc/);
  assert.doesNotMatch(source, /claude-opus|gpt-5/);
});

test('MOBILE-OVERHAUL-5: non-candidate folder is refused while the same sheet succeeds for a candidate', async (t) => {
  const fixture = await composeFixture(t);
  await assert.rejects(
    () => fixture.composed.router.call('new-session', {
      account: 'team',
      folder: path.join(fixture.older, 'not-indexed'),
      provider: 'claude',
      model: 'opus',
      effort: 'xhigh',
    }),
    /not a candidate project folder/,
  );
  assert.equal(fixture.launches.length, 0);

  await fixture.composed.router.call('new-session', {
    account: 'team',
    folder: fixture.recent,
    provider: 'claude',
    model: 'opus',
    effort: 'xhigh',
  });
  assert.equal(fixture.launches.length, 1);
  assert.equal(fixture.launches[0].argv[fixture.launches[0].argv.indexOf('--model') + 1], 'opus');
});
