'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync, spawn } = require('node:child_process');
const path = require('node:path');
const { SessionClient } = require('../../src/daemon/client.js');
const { composeTaskPrompt } = require('../../src/renderer/tasks/assign-to-claude.cjs');
const { createLaunchActions } = require('../../src/main/actions/launch.js');
const { sessiondChildEnv } = require('../../../bin/harbor-bin.cjs');

const AI = path.join(__dirname, '../../../bin/ai');
const CLAUDE_SESSIONS = path.join(__dirname, '../../../bin/claude-sessions');
const DAEMON = path.join(__dirname, '../../src/daemon/daemon.js');

// Read the command bin/ai WOULD run, without running it.
//
// EVERY invocation names a config file, because bin/ai resolves the app's real
// one otherwise and these assertions would then be measuring whatever is on the
// machine running the suite. An EMPTY config is the honest fixture here: it is
// what a stranger has, and it makes the fallbacks the thing under test.
const EMPTY_CONFIG = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-ai-argv-config-')),
  'config.json',
);
fs.writeFileSync(EMPTY_CONFIG, '{}');
process.on('exit', () => {
  try { fs.rmSync(path.dirname(EMPTY_CONFIG), { recursive: true, force: true }); } catch { /* going away anyway */ }
});

const argv = (args, extraEnv = {}) => execFileSync(process.execPath, [AI, ...args], {
  env: { ...process.env, HARBOR_AI_DRY_RUN: '1', HARBOR_CONFIG_FILE: EMPTY_CONFIG, ...extraEnv },
  encoding: 'utf8',
}).trim();

// THE LAUNCHER IS THE CLAUDE CLI, not a wrapper that shipped with nothing.
// Until 2026-08-07 every one of these read `claude-go`, a bash script on one
// machine's PATH and in no repository, so a stranger's first new-session click
// died on ENOENT with a green suite behind it. The binary is configurable
// (`providers.claude.bin`, `HARBOR_CLAUDE_BIN`) and defaults to `claude`.
const CLAUDE = 'claude --dangerously-skip-permissions';

test('the CLI selector defaults to sessiond and names the retired backend clearly', () => {
  assert.equal(argv([], { HARBOR_SESSION_BACKEND: '' }), CLAUDE);
  assert.equal(argv([], { HARBOR_SESSION_BACKEND: 'sessiond' }), CLAUDE);
  assert.throws(
    () => argv([], { HARBOR_SESSION_BACKEND: 'herdr' }),
    /Herdr backend was retired; use sessiond/,
  );
  assert.throws(
    () => argv([], { HARBOR_SESSION_BACKEND: 'other' }),
    /HARBOR_SESSION_BACKEND must be sessiond/,
  );
});

test('the claude binary comes from config and env, never a hardcoded wrapper', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-claude-bin-'));
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ providers: { claude: { bin: '/opt/claude/bin/claude' } } }));
  try {
    assert.equal(argv([], { HARBOR_CONFIG_FILE: configFile }), '/opt/claude/bin/claude --dangerously-skip-permissions');
    // The env pin outranks the configured value, the same way it does for the
    // model catalog, so a harness never has to rewrite somebody's config.
    assert.equal(
      argv([], { HARBOR_CONFIG_FILE: configFile, HARBOR_CLAUDE_BIN: '/tmp/other-claude' }),
      '/tmp/other-claude --dangerously-skip-permissions',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Live-caught 2026-07-27: every new session paused 5-10 seconds and then typed
// "/effort xhigh" into itself, which spent a turn, rail-titled the session
// "/effort", put a command in the transcript Pat never typed, and wiped whatever
// he had started writing in the meantime. The cause was here: bin/ai parsed
// --effort and the claude branch silently dropped it, so the only way left to
// apply it was to type it in after boot. The claude CLI has taken --effort as a
// LAUNCH flag all along.
test('a claude launch carries --effort through to the CLI', () => {
  assert.equal(argv(['--model', 'opus', '--effort', 'xhigh']), `${CLAUDE} --model opus --effort xhigh`);
});

// AN ACCOUNT IS A CONFIG HOME AND NOTHING ELSE ON THE WIRE. The per-account
// flags this used to assert, one literal flag per account, belonged to the unshipped
// wrapper and named two directories on one machine, the second of which was a
// person's first name. `--home` is set on the child as CLAUDE_CONFIG_DIR and
// works for any account anybody has; it must never reach the CLI's own argv,
// which would fail on an unknown flag.
test('the account travels as a config home, not as a per-account flag', () => {
  assert.equal(
    argv(['--home', '/tmp/some-home', '--model', 'opus', '--effort', 'xhigh']),
    `${CLAUDE} --model opus --effort xhigh`,
  );
  for (const legacy of ['--team', '--plan3', '-t']) {
    assert.throws(() => argv([legacy]), /unknown option/, `${legacy} must no longer be a launcher flag`);
  }
});

test('no effort asked for means no flag invented', () => {
  assert.equal(argv(['--model', 'opus']), `${CLAUDE} --model opus`);
  assert.equal(argv([]), CLAUDE);
});

test('a claude launch carries --session-id through to the CLI when supplied', () => {
  assert.equal(
    argv(['--session-id', '123e4567-e89b-42d3-a456-426614174000']),
    `${CLAUDE} --session-id 123e4567-e89b-42d3-a456-426614174000`,
  );
});

test('no session id supplied means no --session-id flag invented', () => {
  assert.equal(argv([]), CLAUDE);
  assert.equal(argv(['--model', 'opus']), `${CLAUDE} --model opus`);
});

test('configured and YOLO task launches carry the complete prompt as the positional argv', () => {
  const task = { id: 'task-argv', title: 'Prove assignment argv', notes: 'note', dueDate: null, tags: ['test'] };
  const configured = composeTaskPrompt({ task, listName: 'Tests', extraInstructions: 'Keep this verbatim.' });
  const yolo = composeTaskPrompt({ task, listName: 'Tests', yolo: true });
  const common = ['--home', '/tmp/task-home', '--model', 'opus', '--effort', 'xhigh'];
  const shown = (prompt) => `'${prompt.replaceAll("'", "'\\''")}'`;
  assert.equal(
    argv([...common, configured]),
    `${CLAUDE} --model opus --effort xhigh ${shown(configured)}`,
  );
  assert.equal(
    argv([...common, yolo]),
    `${CLAUDE} --model opus --effort xhigh ${shown(yolo)}`,
  );
});

test('fake app launches capture folder, model, effort, home, and task prompt for both assignment paths', async () => {
  const profiles = [{ id: 'plan', configHome: 'C:\\scratch\\claude-plan', isDefault: true }];
  const task = { id: 'task-capture', title: 'Capture launch', notes: '', dueDate: null, tags: [] };
  for (const launchCase of [
    { cwd: 'C:\\dev\\harbor', prompt: composeTaskPrompt({ task, listName: 'Work', extraInstructions: 'configured' }) },
    { cwd: 'C:\\dev', prompt: composeTaskPrompt({ task, listName: 'Work', yolo: true }) },
  ]) {
    let captured;
    const actions = createLaunchActions({
      profiles,
      execFile(command, args, options, callback) {
        captured = { command, args, options };
        callback(null, '', '');
      },
    });
    const result = await actions.newSession({
      account: 'plan', provider: 'claude', model: 'opus', effort: 'xhigh', ...launchCase,
    });
    assert.equal(captured.options.cwd, launchCase.cwd);
    assert.deepEqual(captured.args.slice(1, 7), [
      '--home', profiles[0].configHome, '--model', 'opus', '--effort', 'xhigh',
    ]);
    assert.equal(captured.args.at(-1), launchCase.prompt);
    assert.equal(result.cwd, launchCase.cwd);
  }
});

test('--session-id is refused for codex and cursor while their normal launches still work', () => {
  const sessionId = '123e4567-e89b-42d3-a456-426614174000';
  for (const [provider, allowed] of [
    ['codex', 'codex --dangerously-bypass-approvals-and-sandbox'],
    ['cursor', 'cursor-agent --force'],
  ]) {
    assert.throws(
      () => argv(['--provider', provider, '--session-id', sessionId]),
      /--session-id is claude only/,
    );
    assert.equal(argv(['--provider', provider]), allowed);
  }
});

test('codex still gets effort its own way, not claude flag', () => {
  // Codex takes it as a config override; sending it --effort would fail.
  assert.equal(
    argv(['--provider', 'codex', '--model', 'gpt-5', '--effort', 'high']),
    'codex --dangerously-bypass-approvals-and-sandbox --model gpt-5 -c model_reasoning_effort=high',
  );
});

test('codex resume argv is dry-run exact and CODEX_HOME crosses the daemon env allowlist', () => {
  const id = '019f8250-89cc-73d3-9c1a-30007bced9ff';
  assert.equal(
    argv(['--provider', 'codex', '--resume-id', id, '--home', '/tmp/codex-work']),
    `codex resume --dangerously-bypass-approvals-and-sandbox ${id}`,
  );
  const clean = sessiondChildEnv({ CODEX_HOME: '/tmp/codex-work', CLAUDE_CONFIG_DIR: '/tmp/claude' });
  assert.equal(clean.CODEX_HOME, '/tmp/codex-work');
  assert.equal(clean.CLAUDE_CONFIG_DIR, '/tmp/claude');
  assert.equal(Object.hasOwn(clean, 'CURSOR_HOME'), false);
});

test('codex --home refuses a Claude-owned profile instead of routing to it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-provider-home-'));
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    profiles: [{ id: 'work', provider: 'claude', configHome: path.join(root, '.claude-work') }],
  }));
  try {
    assert.throws(
      () => argv(['--provider', 'codex', '--home', 'work'], { HARBOR_CONFIG_FILE: configFile }),
      /neither a codex profile nor a config home/,
    );
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(probe, message, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch {}
    await sleep(50);
  }
  throw new Error(message);
}

function executable(file, body) {
  fs.writeFileSync(file, body, { mode: 0o700 });
}

test('the same ai launch reaches one real sessiond spawn by default', async (t) => {
  if (process.platform === 'win32') return t.skip('the real-pty bin integration family is not ported to Windows; argv coverage above remains platform-independent');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-ai-backends-'));
  const project = path.join(root, 'project');
  const fakeHome = path.join(root, 'home');
  const fakeBin = path.join(fakeHome, '.local', 'bin');
  const sessionDir = path.join(root, 'sessiond');
  const socketPath = path.join(sessionDir, 'sessiond.sock');
  const userData = path.join(root, 'profile');
  const contextDir = path.join(root, 'context');
  const cacheDir = path.join(root, 'cache');
  const projectsDir = path.join(root, 'projects');
  const configFile = path.join(root, 'config.json');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(contextDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });

  const agentBody = '#!/bin/sh\nprintf \'LEAK=%s CONFIG=%s\\n\' "$HARBOR_SECRET_SHOULD_NOT_LEAK" "$CLAUDE_CONFIG_DIR"\nexec /bin/bash --noprofile --norc\n';
  for (const name of ['claude', 'codex', 'cursor-agent']) executable(path.join(fakeBin, name), agentBody);
  const sessionId = '123e4567-e89b-42d3-a456-426614174000';
  const profileSessionId = '223e4567-e89b-42d3-a456-426614174001';
  const resumeId = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
  const transcript = path.join(root, `${resumeId}.jsonl`);
  fs.writeFileSync(transcript, `${JSON.stringify({
    type: 'last-prompt', lastPrompt: 'resume me', sessionId: resumeId,
  })}\n`);
  const cold = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(transcript, cold, cold);
  fs.writeFileSync(path.join(cacheDir, 'index.json'), JSON.stringify({
    v: 2,
    files: {
      [transcript]: {
        id: resumeId, cwd: project, project: 'project', title: 'resume session',
        home: 'team', mt: fs.statSync(transcript).mtimeMs, sz: fs.statSync(transcript).size,
        last: cold.toISOString(),
      },
    },
  }));
  fs.writeFileSync(configFile, JSON.stringify({
    paths: { cacheDir, projectsDir },
    profiles: [{ id: 'team', configHome: path.join(fakeHome, '.claude-team'), isDefault: true }],
  }));
  const drive = ['--home', path.join(fakeHome, '.claude'), '--model', 'opus', '--effort', 'xhigh', '--session-id', sessionId];
  const baseEnv = {
    ...process.env,
    HOME: fakeHome,
    HARBOR_SECRET_SHOULD_NOT_LEAK: 'forbidden',
    HARBOR_SESSIOND_DIR: sessionDir,
    HARBOR_SESSIOND_SOCKET: socketPath,
    HARBOR_E2E_USER_DATA: userData,
    HARBOR_CONTEXT_DIR: contextDir,
    HARBOR_NO_DAEMON_START: '1',
    HARBOR_CONFIG_FILE: configFile,
  };
  delete baseEnv.HARBOR_SESSION_BACKEND;

  let daemon;
  let client;
  try {
    // No HARBOR_SESSION_BACKEND at all: this is the default path.
    const daemonEnv = { ...baseEnv };
    daemon = spawn(process.execPath, [DAEMON], { env: daemonEnv, stdio: 'ignore' });
    client = new SessionClient({ socketPath });
    await waitUntil(async () => (await client.request('health')).ok, 'isolated sessiond did not start');

    const sessiondResult = execFileSync(process.execPath, [AI, ...drive], { cwd: project, env: daemonEnv, encoding: 'utf8' });
    assert.match(sessiondResult, /started claude in sessiond session/);
    await execFileSync(process.execPath, [AI, '--provider', 'codex', '--resume-id', 'codex-resume-id'], {
      cwd: project, env: daemonEnv, encoding: 'utf8',
    });
    await execFileSync(process.execPath, [AI, '--provider', 'cursor', '--resume-id', 'cursor-resume-id'], {
      cwd: project, env: daemonEnv, encoding: 'utf8',
    });
    const resumePrompt = `Original unanswered question\n${'full detail '.repeat(2000)}`;
    const claudeResume = execFileSync(process.execPath, [CLAUDE_SESSIONS, '--resume-id', resumeId, '--home', 'team', '--prompt', resumePrompt], {
      cwd: project, env: daemonEnv, encoding: 'utf8',
    });
    assert.match(claudeResume, /resumed \(team\) in sessiond session/);

    // LAUNCH with a PROFILE ID, not a path. `ai` used to hand the flag value to
    // the child RAW, so `--home team` became CLAUDE_CONFIG_DIR=team, a RELATIVE
    // path, and claude minted a fresh unauthenticated config home at <cwd>/team
    // (live-caught 2026-08-12: `personal/` and `team/` sitting in the harbor
    // repo root). Resume resolved ids through resolveProfileHome all along;
    // this pins launch to the same resolver, screen-verified below like resume.
    const byProfileId = execFileSync(process.execPath, [AI, '--home', 'team', '--session-id', profileSessionId], {
      cwd: project, env: daemonEnv, encoding: 'utf8',
    });
    assert.match(byProfileId, /started claude in sessiond session/);

    const sessions = (await client.request('list')).sessions;
    const claude = sessions.find((session) => session.agent_session === sessionId);
    assert.ok(claude, 'sessiond must persist the minted Claude session id');
    assert.deepEqual(claude.argv, ['claude', '--dangerously-skip-permissions', '--model', 'opus', '--effort', 'xhigh', '--session-id', sessionId]);
    assert.equal(claude.agent, 'claude');
    assert.equal(claude.cols, 120);
    assert.equal(claude.rows, 60);
    assert.equal(sessions.find((session) => session.agent_session === 'codex-resume-id')?.agent, 'codex');
    assert.equal(sessions.find((session) => session.agent_session === 'cursor-resume-id')?.agent, 'cursor');
    const resumedClaude = sessions.find((session) => session.agent_session === resumeId);
    assert.deepEqual(resumedClaude?.argv, ['claude', '--dangerously-skip-permissions', '--resume', resumeId, resumePrompt]);
    const screen = await client.request('screen', { id: claude.id, scrollback: 20 });
    assert.match(screen.text, /LEAK= CONFIG=/, 'sessiond must use the clean daemon environment allowlist');
    assert.doesNotMatch(screen.text, /forbidden/);
    const resumeScreen = await client.request('screen', { id: resumedClaude.id, scrollback: 20 });
    assert.match(resumeScreen.text, new RegExp(`CONFIG=${path.join(fakeHome, '.claude-team').replaceAll('/', '\\/')}`));
    const profileHomed = sessions.find((session) => session.agent_session === profileSessionId);
    assert.ok(profileHomed, 'the profile-id launch must reach the daemon');
    const profileScreen = await client.request('screen', { id: profileHomed.id, scrollback: 20 });
    assert.match(
      profileScreen.text,
      new RegExp(`CONFIG=${path.join(fakeHome, '.claude-team').replaceAll('/', '\\/')}`),
      'a profile id resolves to the profile\'s ABSOLUTE config home before it reaches the child',
    );
    assert.ok(
      !fs.existsSync(path.join(project, 'team')),
      'a profile id must never become a directory in the launch cwd',
    );
  } finally {
    if (client) {
      try {
        for (const session of (await client.request('list')).sessions) {
          await client.request('terminate', { id: session.id, signal: 'SIGKILL' }).catch(() => {});
        }
      } catch {}
      client.close();
    }
    if (daemon?.exitCode === null) {
      daemon.kill('SIGTERM');
      await Promise.race([new Promise((resolve) => daemon.once('exit', resolve)), sleep(3000)]);
    }
    if (daemon?.exitCode === null) daemon.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The claude CLI binary is a runtime prerequisite for these two specs, not
// something a fresh clone or CI box has: they check flags against the
// installed binary itself rather than assumed docs, which is the point of
// them, but that means they have nothing to check without one. Missing it is
// a named skip, never a failure.
function claudeBinaryMissing() {
  const probe = require('node:child_process').spawnSync('claude', ['--help'], { encoding: 'utf8' });
  return Boolean(probe.error && probe.error.code === 'ENOENT');
}

test('the installed claude CLI really does accept --effort at launch', (t) => {
  // The whole fix rests on this flag existing on the binary that will receive
  // it, so it is checked against the binary rather than assumed from docs.
  //
  // That the flag also TAKES EFFECT was verified live once, on 2026-07-27,
  // rather than assumed from its presence: `claude --model sonnet --effort low
  // -p ...` in a scratch cwd wrote `"effort":"low"` into its transcript, against
  // an effortLevel of "xhigh" in settings.json, so the flag genuinely overrides
  // the configured default. That check is deliberately NOT repeated here,
  // because it costs a real request on Pat's plan every run.
  if (claudeBinaryMissing()) return t.skip('claude CLI is not on PATH; this spec verifies --effort against the real installed binary, not a description of it');
  const help = execFileSync('claude', ['--help'], { encoding: 'utf8' });
  assert.match(help, /--effort <level>/, 'claude --help advertises --effort');
  assert.match(help, /low, medium, high, xhigh, max/, 'and the levels Harbor offers');
});

test('the installed claude CLI really does accept --session-id at launch', (t) => {
  if (claudeBinaryMissing()) return t.skip('claude CLI is not on PATH; this spec verifies --session-id against the real installed binary, not a description of it');
  const help = execFileSync('claude', ['--help'], { encoding: 'utf8' });
  assert.match(help, /--session-id <uuid>/, 'claude --help advertises --session-id');
});
