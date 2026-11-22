'use strict';

// THE PHONE TYPES OVER CLAUDE'S DIM SUGGESTION, AS THE DESKTOP DOES (2026-11-20).
// After an idle compaction Claude drew a dim predicted prompt in the box of an
// idle session. The desktop's send engine reads that as an empty box and types
// over it; the phone server's engine had no suggestion read at all, called the
// prediction a typed draft, and refused three phone sends in a row with
// PROMPT_BUSY ("Claude's prompt already has text or an attachment in it").
// Both roots now take their screen reads from session-daemon/send-reads.js.
// The proof is two-sided on one stand-in pane: the old phone wiring (text read
// only) must refuse, and the server's own composed engine must type the message
// once and press Enter.
//
// THE SAME DRIFT, SECOND CASE: THE PHONE ENGINE'S RESUMES WERE NOT GATED. The
// desktop hands its send engine launch actions wrapped in the per-session
// operation gate, so a send that has to resume a session and a resume asked for
// at the same moment launch one resume. The phone server gated its resume
// button and adopt-on-send but gave its send engine the bare launch actions.
// Both roots now take gateLaunchActions (actions/takeover.js).

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { composeServer } = require('../../src/server/compose.js');
const { createSessionSend, createLinkRegistry } = require('../../src/main/session-send.js');
const { daemonSendReads } = require('../../src/main/session-daemon/send-reads.js');
const { projectLabelForCwd } = require('../../src/shared/project-label.cjs');

const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const SUGGESTION = 'tighten the summary the way we discussed';
const MESSAGE = 'send me the newest files please';
const RULE = '─'.repeat(60);

// One idle Claude pane, drawn the way the captured one was: the conversation,
// the idle-compaction notice, then the box. While nothing is typed the box
// shows the suggestion and the keeper reports it as `suggestion` (its cells are
// dim); typing replaces it, and Enter submits the draft and echoes it above.
function suggestionPane({ panes = [{ pane_id: 'pane-1', workspace_id: 'ws-1', agent: 'claude', agent_session: { kind: 'id', value: SESSION_ID } }] } = {}) {
  const pane = { draft: '', echoed: [], typed: [], visibleReads: 0, panes, workspaceLabel: 'sample-project' };
  const screen = () => [
    '  Sample answer text from the previous turn.',
    ...pane.echoed.map((line) => `❯ ${line}`),
    '● Compacted while idle, before the prompt cache expired',
    RULE,
    `❯ ${pane.draft || (pane.echoed.length ? '' : SUGGESTION)}`,
    RULE,
    '  sample  ·  Opus 5.5  ·  sample-project',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  ].join('\n');
  pane.client = {
    snapshot: async () => ({ snapshot: {
      panes: [...pane.panes],
      workspaces: [{ workspace_id: 'ws-1', label: pane.workspaceLabel }],
    } }),
    readPane: async (_paneId, { source } = {}) => {
      if (source === 'visible') pane.visibleReads += 1;
      return {
        read: { text: screen() },
        screen: { suggestion: pane.draft || pane.echoed.length ? null : SUGGESTION },
      };
    },
  };
  pane.bridge = {
    emitter: new EventEmitter(),
    async start() {},
    close() {},
    getState: () => ({ controlledPaneId: 'pane-1' }),
    requestFocusPane: async () => ({ ok: true }),
    ensureDialogSize: async () => ({ ok: true }),
    sendInput: (_paneId, text) => {
      pane.typed.push(text);
      if (text === '\r') {
        if (pane.draft) { pane.echoed.push(pane.draft); pane.draft = ''; }
      } else if (!/^[\x00-\x1f\x7f]/.test(text) || text.startsWith('\x1b[200~')) {
        pane.draft += text.replace(/\x1b\[20[01]~/g, '');
      }
      return { ok: true };
    },
  };
  return pane;
}

async function isolatedEnv(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-compose-send-suggestion-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const contextDir = path.join(root, 'context');
  const artifactsRoot = path.join(root, 'artifacts');
  const userDataDir = path.join(root, 'user-data');
  await Promise.all([contextDir, artifactsRoot, userDataDir].map((dir) => fs.mkdir(dir, { recursive: true })));
  const configFile = path.join(root, 'config.json');
  await fs.writeFile(configFile, JSON.stringify({ version: 1, profiles: [{
    id: 'personal', label: 'Personal', letter: 'P', color: '#437FFE', provider: 'claude',
    configHome: path.join(root, 'homes', 'personal'), email: null, isDefault: true,
  }] }));
  return {
    root,
    userDataDir,
    env: {
      ...process.env,
      HARBOR_NO_DAEMON_START: '1',
      HARBOR_NO_USAGE_FETCH: '1',
      HARBOR_CONTEXT_DIR: contextDir,
      HARBOR_SESSIOND_DIR: path.join(root, 'sessiond'),
      HARBOR_ARTIFACTS_ROOTS: artifactsRoot,
      HARBOR_ARTIFACTS_CACHE: path.join(root, 'artifact-cache.json'),
      HARBOR_TASKS_FILE: path.join(root, 'tasks.json'),
      HARBOR_CONFIG_FILE: configFile,
    },
  };
}

const target = { paneId: 'pane-1', workspaceId: 'ws-1' };

test('the old phone wiring (no suggestion read) refuses a send into a box showing a dim suggestion', async () => {
  const pane = suggestionPane();
  const { snapshot, readPane } = daemonSendReads(pane.client);
  const send = createSessionSend({
    snapshot, readPane,
    terminalBridge: pane.bridge,
    launchActions: {},
    getSessionMeta: async () => ({ cwd: os.tmpdir(), provider: 'claude' }),
    links: createLinkRegistry(),
    projectLabelForCwd: () => 'sample-project',
  });
  await assert.rejects(
    send.send({ sessionId: SESSION_ID, text: MESSAGE, pane: target }),
    (error) => error.code === 'PROMPT_BUSY',
  );
  assert.deepEqual(pane.typed, [], 'nothing typed: the fixture reproduces the phone refusal');
});

// The phone server composed for real around a stand-in daemon and pane.
async function composePhone(t, pane, extra = {}) {
  const isolated = await isolatedEnv(t);
  const sidebar = {
    emitter: new EventEmitter(),
    async start() {},
    close() {},
    getState: () => ({ model: { projects: [] } }),
    getSessionMeta: async () => ({ cwd: isolated.root, provider: 'claude', home: 'personal' }),
  };
  // The workspace a resumed pane opens in carries the session folder's label.
  pane.workspaceLabel = projectLabelForCwd(isolated.root, os.homedir());
  const composed = await composeServer({
    userDataDir: isolated.userDataDir,
    env: isolated.env,
    sidebar,
    sendClient: pane.client,
    terminalBridge: pane.bridge,
    artifacts: { async list() { return { ok: true, artifacts: [] }; }, isServable: () => true },
    icons: { async list() { return { icons: {} }; }, watch() {}, async filePathFor() { return null; }, mimeFor() { return null; } },
    tasks: { read: async () => ({}), mutate: async () => ({}), subscribe() {}, close() {} },
    usage: { getUsage: async () => ({}) },
    capabilities: { get: async () => ({}) },
    workflowRuns: { runsForSession: async () => [] },
    ...extra,
  });
  t.after(() => composed.close());
  return composed;
}

test('the phone server\'s own send engine types over Claude\'s dim suggestion and submits the message', async (t) => {
  const pane = suggestionPane();
  const composed = await composePhone(t, pane);
  const result = await composed.router.call('session:send', { sessionId: SESSION_ID, text: MESSAGE, pane: target });
  assert.notEqual(result?.code, 'PROMPT_BUSY', `refused: ${result?.reason}`);
  assert.equal(result?.ok === false, false, `refused: ${result?.reason}`);
  assert.ok(pane.visibleReads > 0, 'the engine asked the keeper for the box\'s dim cells');
  assert.deepEqual(pane.echoed, [MESSAGE], 'the message was submitted once, without the suggestion');
  assert.equal(pane.typed.filter((text) => text === '\r').length, 1, 'one Enter');
});

test('on the phone server, a send that must resume a session and a resume tapped at once launch one resume', async (t) => {
  const previousTimeout = process.env.HARBOR_FRESH_PANE_TIMEOUT_MS;
  process.env.HARBOR_FRESH_PANE_TIMEOUT_MS = '8000';
  t.after(() => {
    if (previousTimeout === undefined) delete process.env.HARBOR_FRESH_PANE_TIMEOUT_MS;
    else process.env.HARBOR_FRESH_PANE_TIMEOUT_MS = previousTimeout;
  });
  // The session has no pane yet. The tapped resume is still launching when the
  // send decides it must resume too (it waits until the send says "resuming",
  // then a moment more so the send's own resume call is made); then the
  // resumed pane appears, carrying the session id as the daemon reports it.
  const pane = suggestionPane({ panes: [{ pane_id: 'pane-other', workspace_id: 'ws-1', agent: 'claude', agent_session: { kind: 'id', value: 'some-other-session' } }] });
  let sendResuming;
  const sendIsResuming = new Promise((resolve) => { sendResuming = resolve; });
  const resumes = [];
  const resumeSession = async (args) => {
    resumes.push(args.id);
    await sendIsResuming;
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (!pane.panes.some((p) => p.pane_id === 'pane-fresh')) {
      pane.panes.push({ pane_id: 'pane-fresh', workspace_id: 'ws-1', agent: 'claude', agent_session: { kind: 'id', value: args.id } });
    }
    return { ok: true };
  };
  const composed = await composePhone(t, pane, {
    launchActions: { resumeSession, resumeProviderSession: resumeSession },
  });
  composed.router.onPush((channel, payload) => {
    if (channel === 'send:status' && payload?.sessionId === SESSION_ID && payload.phase === 'resuming') sendResuming();
  });
  const tapped = composed.router.call('resume-session', { id: SESSION_ID, detectedHome: 'personal' });
  const sent = composed.router.call('session:send', { sessionId: SESSION_ID, text: MESSAGE, detectedHome: 'personal' });
  const [, result] = await Promise.all([tapped, sent]);
  assert.deepEqual(resumes, [SESSION_ID], 'one resume, shared by the tap and the send');
  assert.equal(result?.ok === false, false, `send refused: ${result?.reason}`);
  assert.deepEqual(pane.echoed, [MESSAGE], 'and the message still went in once');
});
