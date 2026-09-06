'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { composeServer } = require('../../src/server/compose.js');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-compose-providers-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, 'user-data');
  const contextDir = path.join(root, 'context');
  const artifactsRoot = path.join(root, 'artifacts');
  const artifactsCache = path.join(root, 'artifact-cache.json');
  const tasksFile = path.join(root, 'tasks.json');
  const configFile = path.join(root, 'config.json');
  await Promise.all([
    fs.mkdir(userDataDir, { recursive: true }),
    fs.mkdir(contextDir, { recursive: true }),
    fs.mkdir(artifactsRoot, { recursive: true }),
  ]);
  // A hermetic 3-profile config, written directly rather than left to
  // discovery: composeServer's configStore falls back to legacyConfig(),
  // which DISCOVERS profiles from whatever `.claude*` directories exist on
  // the real machine's real home. Reading that here would make this test
  // pass or fail by whose machine it runs on (and, before this fixture
  // existed, it silently pinned one developer's own three account names into
  // the usage:get-all assertion below). Writing the config file directly
  // means composeServer's configStore.load() reads it straight off disk and
  // never has to discover anything.
  await fs.writeFile(configFile, JSON.stringify({
    version: 1,
    profiles: [
      {
        id: 'personal', label: 'Personal', letter: 'P', color: '#437FFE',
        provider: 'claude', configHome: path.join(root, 'homes', 'personal'),
        email: null, isDefault: true,
      },
      {
        id: 'team', label: 'Team', letter: 'T', color: '#d68a5a',
        provider: 'claude', configHome: path.join(root, 'homes', 'team'),
        email: null, isDefault: false,
      },
      {
        id: 'plan3', label: 'Plan 3', letter: 'S', color: '#F962BA',
        provider: 'claude', configHome: path.join(root, 'homes', 'plan3'),
        email: null, isDefault: false,
      },
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
      HARBOR_ARTIFACTS_CACHE: artifactsCache,
      HARBOR_TASKS_FILE: tasksFile,
      HARBOR_CONFIG_FILE: configFile,
    },
  };
}

function baseProviders(root, transcriptPath) {
  const sidebar = {
    emitter: new EventEmitter(),
    async start() {},
    close() {},
    getState: () => ({ model: [] }),
    getSessionMeta: async () => ({ path: transcriptPath, cwd: root, provider: 'claude', home: 'personal' }),
  };
  return {
    sidebar,
    artifacts: { async list() { return { ok: true, artifacts: [] }; }, isServable: () => true },
    icons: { async list() { return { icons: {} }; }, watch() {}, async filePathFor() { return null; }, mimeFor() { return null; } },
    tasks: { read: async () => ({}), mutate: async () => ({}), subscribe() {}, close() {} },
  };
}

test('headless composition exposes the phone providers and preserves explicit fail-closed methods', async (t) => {
  const isolated = await fixture(t);
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const transcriptPath = path.join(isolated.root, `${sessionId}.jsonl`);
  await fs.writeFile(path.join(isolated.env.HARBOR_CONTEXT_DIR, `${sessionId}.json`), JSON.stringify({
    used_percentage: 27,
  }));
  await fs.writeFile(transcriptPath, [
    JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-08-02T12:00:00.000Z', message: { role: 'user', content: 'Phone-visible prompt' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: '2026-08-02T12:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Phone-visible answer' }] } }),
  ].join('\n') + '\n');

  const calls = [];
  const sessionSend = {
    emitter: new EventEmitter(),
    send: async (payload) => ({ ok: true, sent: payload.text }),
    getMenu: async (payload) => ({ kind: 'question', question: 'Deploy?', paneId: payload.pane.paneId }),
    answerMenu: async (payload) => ({ ok: true, action: payload.action }),
    getQueueState: (session) => ({ count: 1, session }),
    cancelQueued: (session, sendId) => ({ ok: true, session, sendId }),
    readPermissionMode: async (paneId) => ({ mode: 'acceptEdits', paneId }),
    cyclePermissionMode: async (paneId, workspaceId) => ({ mode: 'plan', paneId, workspaceId }),
  };
  const terminalBridge = {
    emitter: new EventEmitter(),
    async start() {},
    close() {},
    sendInput: async (paneId, text) => ({ ok: true, paneId, text }),
  };
  const composed = await composeServer({
    userDataDir: isolated.userDataDir,
    env: isolated.env,
    ...baseProviders(isolated.root, transcriptPath),
    sessionSend,
    terminalBridge,
    usage: { getUsage: async (id) => ({ id, fiveHour: 12 }) },
    capabilities: { get: async (id) => ({ sessionId: id, models: { cached: [] } }) },
    workflowRuns: { runsForSession: async (id) => ({ runs: [{ runId: `run-${id}` }] }) },
    accounts: { readEmails: async () => ({ personal: 'phone@example.test' }) },
    artifactThumbs: { thumbFor: async (payload) => { calls.push(payload); return '/tmp/thumb.png'; } },
    links: { all: () => ({ [sessionId]: { paneId: 'pane-1' } }) },
    launchActions: {
      resumeSession: async (payload) => ({ kind: 'claude', payload }),
      resumeProviderSession: async (payload) => ({ kind: 'provider', payload }),
      newSession: async () => ({ ok: true }),
    },
    takeoverHandler: async (payload) => ({ adopted: payload.sessionId }),
    voice: {
      voices: () => ['marin'],
      mintToken: async (payload) => ({ ok: true, voice: payload.voice, token: 'ephemeral' }),
    },
    whisperTranscriber: async (payload) => ({ ok: true, text: `heard-${payload.mimeType}` }),
  });
  t.after(() => composed.close());

  const updates = [];
  composed.router.onPush((channel, payload) => { if (channel === 'transcript:update') updates.push(payload); });
  assert.deepEqual(await composed.router.call('transcript:open', { sessionId, window: { blocks: 20 } }), { ok: true, sessionId });
  const blocks = updates.at(-1).replace;
  assert.equal(updates.at(-1).header.contextPct, 27);
  assert.equal(blocks.some((block) => JSON.stringify(block).includes('Phone-visible prompt')), true);
  assert.equal(blocks.some((block) => JSON.stringify(block).includes('Phone-visible answer')), true);
  assert.deepEqual(await composed.router.call('transcript:close', { sessionId }), { ok: true });

  assert.deepEqual(await composed.router.call('session:menu-state', { pane: { paneId: 'pane-1' } }), {
    kind: 'question', question: 'Deploy?', paneId: 'pane-1',
  });
  assert.deepEqual(await composed.router.call('session:menu-answer', { pane: { paneId: 'pane-1' }, action: 'yes' }), { ok: true, action: 'yes' });
  assert.deepEqual(await composed.router.call('session:send', { sessionId, text: 'follow up' }), { ok: true, sent: 'follow up' });
  assert.deepEqual(await composed.router.call('session:send-queue', { sessionId }), { count: 1, session: sessionId });
  assert.deepEqual(await composed.router.call('session:cancel-send', { sessionId, sendId: 7 }), { ok: true, session: sessionId, sendId: 7 });
  assert.deepEqual(await composed.router.call('session:interrupt', { paneId: 'pane-1' }), { ok: true, paneId: 'pane-1', text: '\x1b' });
  assert.deepEqual(await composed.router.call('usage:get-all'), {
    personal: { id: 'personal', fiveHour: 12 },
    team: { id: 'team', fiveHour: 12 },
    plan3: { id: 'plan3', fiveHour: 12 },
  });
  assert.deepEqual(await composed.router.call('capabilities:get', { sessionId }), { ok: true, capabilities: { sessionId, models: { cached: [] } } });
  assert.deepEqual(await composed.router.call('session:workflow-runs', { sessionId }), { runs: [{ runId: `run-${sessionId}` }] });
  assert.deepEqual(await composed.router.call('links:get'), { [sessionId]: { paneId: 'pane-1' } });
  assert.deepEqual(await composed.router.call('accounts:read-emails'), { personal: 'phone@example.test' });
  assert.deepEqual(await composed.router.call('artifacts:thumb', { path: transcriptPath, mtimeMs: 1, kind: 'pdf' }), { ok: true, thumbPath: '/tmp/thumb.png' });
  assert.deepEqual(calls, [{ path: transcriptPath, mtimeMs: 1, kind: 'pdf' }]);

  assert.deepEqual(await composed.router.call('capabilities:permission-mode', { paneId: 'pane-1' }), { mode: 'acceptEdits', paneId: 'pane-1' });
  assert.deepEqual(await composed.router.call('capabilities:cycle-permission-mode', { paneId: 'pane-1', workspaceId: 'ws-1' }), { ok: true, mode: 'plan', paneId: 'pane-1', workspaceId: 'ws-1' });
  assert.deepEqual(await composed.router.call('resume-session', { id: sessionId, detectedHome: 'personal' }), { kind: 'claude', payload: { id: sessionId, detectedHome: 'personal' } });
  assert.deepEqual(await composed.router.call('session:takeover', { sessionId }), { adopted: sessionId });
  assert.deepEqual(await composed.router.call('voice:voices'), ['marin']);
  assert.deepEqual(await composed.router.call('voice:token', { voice: 'marin' }), { ok: true, voice: 'marin', token: 'ephemeral' });
  assert.deepEqual(await composed.router.call('whisper:transcribe', { buffer: [1], mimeType: 'audio/webm' }), { ok: true, text: 'heard-audio/webm' });

  await assert.rejects(
    composed.router.call('daemon:get-banner'),
    /RPC method 'daemon:get-banner' is not available in the headless composition/,
  );
  await assert.rejects(
    composed.router.call('terminal:get-state'),
    /RPC method 'terminal:get-state' is not available in the headless composition/,
  );
});
