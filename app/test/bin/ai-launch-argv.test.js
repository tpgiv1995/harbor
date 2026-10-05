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
// Codex argv depends on the installed codex VERSION and on the launch home's
// models_cache.json, so both are pinned: an EMPTY codex home (no cache, no
// migrations) and a version that predates the pane controls. Specs that are
// about those controls set their own.
const EMPTY_CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-ai-argv-codex-home-'));
process.on('exit', () => {
  try { fs.rmSync(path.dirname(EMPTY_CONFIG), { recursive: true, force: true }); } catch { /* going away anyway */ }
  try { fs.rmSync(EMPTY_CODEX_HOME, { recursive: true, force: true }); } catch { /* going away anyway */ }
});

const argv = (args, extraEnv = {}) => execFileSync(process.execPath, [AI, ...args], {
  env: {
    ...process.env,
    HARBOR_AI_DRY_RUN: '1',
    HARBOR_CONFIG_FILE: EMPTY_CONFIG,
    CODEX_HOME: EMPTY_CODEX_HOME,
    HARBOR_CODEX_VERSION: '0.155.1',
    ...extraEnv,
  },
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
    ['cursor', 'cursor-agent --force --trust --disable-auto-update'],
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

// CODEX 0.157.0 CHANGED THREE DEFAULTS UNDER A HARBOR PANE (2026-09-25): the
// shared background server auto-starts, the TUI takes the whole alternate
// screen, and a model-migration screen that eats a pasted message and writes
// `model = ...` into config.toml opens for every gpt-5.x model. Each is pinned
// per launch and per resume, ahead of every positional argument.
test('codex >= 0.156.0 panes run without the shared server and keep the inline transcript', () => {
  const pinned = '--no-daemon -c tui.fullscreen_transcript=false';
  const bundledAcks = " -c 'notice.model_migrations={'\\''gpt-5.4-mini'\\''='\\''gpt-6-luna'\\'','\\''gpt-5.4'\\''='\\''gpt-6-sol'\\''}'";
  for (const [version, migrations] of [
    ['0.156.0', ''], ['0.157.0', ''], ['0.158.0', bundledAcks], ['1.0.0', bundledAcks],
  ]) {
    assert.equal(
      argv(['--provider', 'codex', '--model', 'gpt-6-sol', '--effort', 'high'], { HARBOR_CODEX_VERSION: version }),
      `codex --dangerously-bypass-approvals-and-sandbox ${pinned}${migrations} --model gpt-6-sol -c model_reasoning_effort=high`,
    );
    assert.equal(
      argv(['--provider', 'codex', '--resume-id', 'abc-123'], { HARBOR_CODEX_VERSION: version }),
      `codex resume --dangerously-bypass-approvals-and-sandbox ${pinned}${migrations} abc-123`,
    );
  }
});

test('an older or unreadable codex version gets no flag it would reject', () => {
  // An older codex exits on an unknown argument, so a launch that works beats a
  // pinned one that cannot start.
  for (const version of ['0.155.1', '0.99.9', 'not-a-version']) {
    assert.equal(
      argv(['--provider', 'codex'], { HARBOR_CODEX_VERSION: version }),
      'codex --dangerously-bypass-approvals-and-sandbox',
    );
  }
});

test('every migration the launch home lists is acknowledged for that process only', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-ai-codex-migrations-'));
  try {
    fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({
      client_version: '0.157.0',
      models: [
        { slug: 'gpt-6-sol', visibility: 'list' },
        { slug: 'gpt-5.6-sol', visibility: 'list', upgrade: { model: 'gpt-6-sol', migration_markdown: 'Meet GPT-6 Sol' } },
        { slug: 'gpt-5.4', visibility: 'hide', upgrade: { model: 'gpt-6-sol' } },
        // A slug that is not a plain slug never reaches the command line.
        { slug: "evil'=1}", visibility: 'list', upgrade: { model: 'gpt-6-sol' } },
        { slug: 'gpt-5.5', visibility: 'list', upgrade: { id: 'gpt-6-sol' } },
      ],
    }));
    const acks = "-c 'notice.model_migrations={'\\''gpt-5.6-sol'\\''='\\''gpt-6-sol'\\'','\\''gpt-5.4'\\''='\\''gpt-6-sol'\\'','\\''gpt-5.5'\\''='\\''gpt-6-sol'\\''}'";
    // Through --home (the profile's home, which is what the child reads)...
    assert.equal(
      argv(['--provider', 'codex', '--home', home, '--model', 'gpt-5.6-sol'], { HARBOR_CODEX_VERSION: '0.157.0' }),
      `codex --dangerously-bypass-approvals-and-sandbox --no-daemon -c tui.fullscreen_transcript=false ${acks} --model gpt-5.6-sol`,
    );
    // ...and through an inherited CODEX_HOME on a resume, with or without the
    // version pins, because the acknowledgment is an old, stable config key.
    assert.equal(
      argv(['--provider', 'codex', '--resume-id', 'abc-123'], { CODEX_HOME: home, HARBOR_CODEX_VERSION: '0.155.1' }),
      `codex resume --dangerously-bypass-approvals-and-sandbox ${acks} abc-123`,
    );
    // Codex's one in-code migration (a saved gpt-5.4-mini selection) joins the
    // list only once its target is a listed model, which is when codex shows it.
    const { codexMigrationAcks } = require('../../../bin/harbor-bin.cjs');
    assert.doesNotMatch(codexMigrationAcks(home), /gpt-5\.4-mini/);
    const withLuna = JSON.parse(fs.readFileSync(path.join(home, 'models_cache.json'), 'utf8'));
    withLuna.models.push({ slug: 'gpt-6-luna', visibility: 'list' });
    fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify(withLuna));
    assert.match(codexMigrationAcks(home), /,'gpt-5\.4-mini'='gpt-6-luna'\}$/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('reviewed 0.158.0 migrations do not depend on cache validity or identity', () => {
  const { codexMigrationAcks, codexPaneControls, withCodexPaneControls } = require('../../../bin/harbor-bin.cjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-codex-missing-catalog-'));
  const cacheFile = path.join(home, 'models_cache.json');
  const version = [0, 158, 0];
  const expected = "notice.model_migrations={'gpt-5.4-mini'='gpt-6-luna','gpt-5.4'='gpt-6-sol'}";
  try {
    assert.equal(codexMigrationAcks(home, version), expected);
    assert.deepEqual(fs.readdirSync(home), [], 'a missing cache stays missing');
    for (const data of ['{', '{}', '{"models":null}']) {
      fs.writeFileSync(cacheFile, data);
      assert.equal(codexMigrationAcks(home, version), expected);
      assert.equal(fs.readFileSync(cacheFile, 'utf8'), data, 'an unusable cache is never rewritten');
    }
    assert.equal(codexMigrationAcks(home, [0, 157, 1]), null);
    assert.equal(codexMigrationAcks(home, null), null);
    for (const cache of [
      { models: [] },
      { models: [null] },
      { client_version: '0.157.1', models: [] },
      { fetched_at: '2000-01-01T00:00:00Z', models: [] },
      { identity: 'different-provider-fixture', models: [] },
      { models: [{ slug: 'gpt-5.4', visibility: 'hide' }] },
      { models: [{ slug: 'gpt-5.4', upgrade: { model: 'gpt-5.5' } }] },
      { models: [{ slug: 'gpt-6-sol', visibility: 'hide' }] },
    ]) {
      const data = JSON.stringify(cache);
      fs.writeFileSync(cacheFile, data);
      assert.equal(codexMigrationAcks(home, version), expected);
      assert.equal(fs.readFileSync(cacheFile, 'utf8'), data, 'acknowledgments never rewrite the cache');
    }
    const controls = codexPaneControls({ version, codexHome: home });
    for (const argv of [
      ['codex', '--dangerously-bypass-approvals-and-sandbox', '--model', 'gpt-5.4'],
      ['codex', '--dangerously-bypass-approvals-and-sandbox', 'resume', 'fixture-session'],
    ]) assert.ok(withCodexPaneControls(argv, controls).includes(expected));
    assert.equal(codexMigrationAcks(home), null, 'unknown versions keep the cache-backed behavior');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('retired GPT-5.4 selections acknowledge the 0.158.0 built-in migrations on resume', () => {
  const { codexMigrationAcks } = require('../../../bin/harbor-bin.cjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-codex-retired-'));
  try {
    const cache = path.join(home, 'models_cache.json');
    fs.writeFileSync(cache, JSON.stringify({ models: [
      { slug: 'gpt-6-sol', visibility: 'list' },
      { slug: 'openai.gpt-6-sol', visibility: 'list' },
      { slug: 'gpt-6-luna', visibility: 'list' },
    ] }));
    const before = fs.readFileSync(cache, 'utf8');
    const acks = codexMigrationAcks(home);
    assert.ok(acks.includes("'gpt-5.4'='gpt-6-sol'"));
    assert.ok(acks.includes("'openai.gpt-5.4'='openai.gpt-6-sol'"));
    assert.ok(acks.includes("'gpt-5.4-mini'='gpt-6-luna'"));
    const resumed = argv(['--provider', 'codex', '--resume-id', 'retired-session'], {
      CODEX_HOME: home, HARBOR_CODEX_VERSION: '0.158.0',
    });
    assert.match(resumed, /notice\.model_migrations=/);
    assert.match(resumed, /gpt-5\.4/);
    assert.match(resumed, / retired-session$/);
    assert.equal(fs.readFileSync(cache, 'utf8'), before, 'acknowledgments do not alter the catalog');
    assert.equal(fs.existsSync(path.join(home, 'config.toml')), false, 'no persisted model change');
    fs.writeFileSync(cache, JSON.stringify({ models: [{ slug: 'gpt-6-sol', visibility: 'hide' }] }));
    assert.equal(codexMigrationAcks(home), null, 'a hidden or absent target cannot open a migration prompt');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Sessiond has no shell: node-pty's CreateProcess runs PE binaries only, so a
// bare `codex` (npm's codex.cmd) could never start a pane on Windows.
test('a bare provider name resolves the way a shell would, without cmd.exe', () => {
  const { resolveWindowsLaunch } = require('../../../bin/harbor-bin.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-win-launch-'));
  try {
    const npm = path.join(root, 'npm');
    const nodeDir = path.join(root, 'nodejs');
    const tools = path.join(root, 'tools');
    for (const dir of [npm, nodeDir, tools, path.join(npm, 'node_modules', '@openai', 'codex', 'bin'), path.join(npm, 'node_modules', '@x', 'native', 'bin')]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const shim = (target) => `@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*\r\n`;
    fs.writeFileSync(path.join(npm, 'codex'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(npm, 'codex.cmd'), shim('node_modules\\@openai\\codex\\bin\\codex.js'));
    fs.writeFileSync(path.join(npm, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), '');
    fs.writeFileSync(path.join(npm, 'native.cmd'), shim('node_modules\\@x\\native\\bin\\native.exe'));
    fs.writeFileSync(path.join(npm, 'node_modules', '@x', 'native', 'bin', 'native.exe'), '');
    fs.writeFileSync(path.join(npm, 'handoff.cmd'), '@echo off\r\npowershell.exe -NoProfile -File "%~dp0handoff.ps1" %*\r\n');
    fs.writeFileSync(path.join(tools, 'real.exe'), '');
    fs.writeFileSync(path.join(nodeDir, 'node.exe'), '');
    const env = { PATH: [tools, npm, nodeDir].join(';'), PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    const win = { platform: 'win32', env };
    const script = path.join(npm, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    assert.deepEqual(
      resolveWindowsLaunch(['codex', '--no-daemon', 'a & b | c'], win),
      [path.join(nodeDir, 'node.exe'), script, '--no-daemon', 'a & b | c'],
      'an npm shim to a script runs as node <script>, arguments untouched',
    );
    fs.writeFileSync(path.join(npm, 'node.exe'), '');
    assert.equal(resolveWindowsLaunch(['codex'], win)[0], path.join(npm, 'node.exe'), 'a node.exe beside the shim wins, as in the shim');
    assert.deepEqual(resolveWindowsLaunch(['native', '-x'], win), [path.join(npm, 'node_modules', '@x', 'native', 'bin', 'native.exe'), '-x']);
    assert.deepEqual(resolveWindowsLaunch(['real', '-y'], win), [path.join(tools, 'real.exe'), '-y']);
    assert.deepEqual(resolveWindowsLaunch(['handoff', '-z'], win), ['handoff', '-z'], 'a non-npm shim is left alone');
    assert.deepEqual(resolveWindowsLaunch(['missing'], win), ['missing']);
    assert.deepEqual(resolveWindowsLaunch(['C:\\bin\\codex', '-q'], win), ['C:\\bin\\codex', '-q'], 'an explicit path is the user\'s call');
    // ...except the npm shim the setup wizard itself saves, which CreateProcess
    // would run through cmd.exe and re-read a prompt's & | < > ^ % as syntax.
    assert.deepEqual(
      resolveWindowsLaunch([path.join(npm, 'codex.cmd'), 'x & echo y'], win),
      [path.join(npm, 'node.exe'), script, 'x & echo y'],
    );
    assert.deepEqual(resolveWindowsLaunch([path.join(npm, 'codex'), '-q'], win)[1], script, 'an extensionless path with an npm .cmd sibling');
    assert.deepEqual(resolveWindowsLaunch([path.join(npm, 'handoff.cmd'), '-z'], win), [path.join(npm, 'handoff.cmd'), '-z'], 'an explicit non-npm shim is left alone');
    assert.deepEqual(resolveWindowsLaunch(['claude.exe'], win), ['claude.exe']);
    assert.deepEqual(resolveWindowsLaunch(['codex'], { platform: 'linux', env }), ['codex'], 'POSIX keeps the shebang path');
    // The version comes off the npm package on disk, never from running codex:
    // this fake package's "codex.js" is empty and would print nothing.
    if (process.platform === 'win32') {
      const { codexCliVersion } = require('../../../bin/harbor-bin.cjs');
      fs.writeFileSync(path.join(npm, 'node_modules', '@openai', 'codex', 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.157.0' }));
      assert.deepEqual(codexCliVersion('codex', { ...env, HARBOR_CODEX_VERSION: '' }), [0, 157, 0]);
      fs.writeFileSync(path.join(npm, 'node_modules', '@openai', 'codex', 'package.json'), JSON.stringify({ name: 'not-codex', version: '9.9.9' }));
      assert.equal(codexCliVersion('codex', { ...env, HARBOR_CODEX_VERSION: '' }), null, 'a package that is not codex is not believed, and the empty fake prints no version');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// cursor-agent.cmd hands off to powershell -File cursor-agent.ps1, which runs
// versions\<newest by date>\node.exe index.js. Sessiond can start neither hop,
// so a cursor pane never opened on Windows; the launch runs the last hop.
test('cursor\'s cmd -> ps1 -> versions handoff resolves to node + index.js, picked the way its launcher picks', () => {
  const { resolveWindowsLaunch } = require('../../../bin/harbor-bin.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-cursor-launch-'));
  try {
    const home = path.join(root, 'cursor-agent');
    const versions = path.join(home, 'versions');
    fs.mkdirSync(versions, { recursive: true });
    // The launcher's real shape (2026.09.26), byte-for-byte on the lines that matter.
    const cmd = [
      '@echo off',
      'setlocal enabledelayedexpansion',
      'set "CURSOR_INVOKED_AS=%~nx0"',
      'set "SCRIPT_DIR=%~dp0"',
      'if "%SCRIPT_DIR:~-1%"=="\\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"',
      '%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%\\cursor-agent.ps1" %*',
    ].join('\r\n');
    fs.writeFileSync(path.join(home, 'cursor-agent.cmd'), cmd);
    fs.writeFileSync(path.join(home, 'cursor-agent.ps1'), '# launcher\n');
    const install = (name, { runtime = true } = {}) => {
      const dir = path.join(versions, name);
      fs.mkdirSync(dir, { recursive: true });
      if (runtime) for (const file of ['node.exe', 'index.js']) fs.writeFileSync(path.join(dir, file), '');
      return dir;
    };
    install('2026.09.23-86fc751');
    const current = install('2026.09.26-dd393fe');
    // Sorts FIRST as text ('9' > '0') but is September 3rd by date: must lose.
    install('2026.9.3-abc1234');
    install('not-a-version');
    // A build the install stage parked after it failed verification, and the
    // stage's own extraction folder: complete runtimes, newer dates, never picked.
    install('.failed-2026.09.30-feedbee-2026-09-30T21-00-00Z');
    install('.staging-2026.09.30-feedbee');
    fs.writeFileSync(path.join(versions, '47b70424-504d-47a8-b896-e3b043e6192a.zip'), '');
    const env = { PATH: [home].join(';'), PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    const win = { platform: 'win32', env };
    const prompt = 'say "hi" & echo PWNED | more';
    const expected = [path.join(current, 'node.exe'), path.join(current, 'index.js'), '--force', prompt];
    assert.deepEqual(resolveWindowsLaunch(['cursor-agent', '--force', prompt], win), expected, 'bare name: newest by date, arguments untouched');
    assert.deepEqual(resolveWindowsLaunch([path.join(home, 'cursor-agent.cmd'), '--force', prompt], win), expected, 'the explicit .cmd setup may save never reaches cmd.exe');
    assert.deepEqual(resolveWindowsLaunch([path.join(home, 'cursor-agent'), '--force', prompt], win), expected, 'an extensionless path with the .cmd beside it');
    // The newer build-timestamp form the launcher also accepts wins by its date.
    const stamped = install('2026.09.30-14-05-09-0badc0de');
    assert.equal(resolveWindowsLaunch(['cursor-agent'], win)[0], path.join(stamped, 'node.exe'));
    // Mid-extract (cursor self-updates in the background): no runtime yet, so
    // the newest COMPLETE install runs instead of a pane that cannot start.
    install('2026.10.02-feedbee', { runtime: false });
    assert.equal(resolveWindowsLaunch(['cursor-agent'], win)[0], path.join(stamped, 'node.exe'));
    // A launcher sitting INSIDE a version folder runs its own node (the .ps1's first branch).
    fs.writeFileSync(path.join(current, 'cursor-agent.cmd'), cmd);
    fs.writeFileSync(path.join(current, 'cursor-agent.ps1'), '# launcher\n');
    assert.deepEqual(resolveWindowsLaunch([path.join(current, 'cursor-agent.cmd'), '-p'], win), [path.join(current, 'node.exe'), path.join(current, 'index.js'), '-p']);
    // No installed version: left exactly as it was, not guessed.
    fs.rmSync(versions, { recursive: true, force: true });
    assert.deepEqual(resolveWindowsLaunch(['cursor-agent', '--force'], win), ['cursor-agent', '--force']);
    // The handoff target must exist; a lookalike .cmd with no .ps1 is not cursor's.
    fs.mkdirSync(versions);
    install('2026.09.26-dd393fe');
    fs.rmSync(path.join(home, 'cursor-agent.ps1'));
    assert.deepEqual(resolveWindowsLaunch(['cursor-agent'], win), ['cursor-agent']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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

// The codex pins rest on the installed binary having the flag at the version
// bin/ai reads from it, so both come from the binary itself, resolved exactly
// the way a pane launch resolves it.
test('the installed codex CLI advertises --no-daemon wherever bin/ai would pass it', (t) => {
  const { resolveWindowsLaunch, codexCliVersion } = require('../../../bin/harbor-bin.cjs');
  const env = { ...process.env };
  delete env.HARBOR_CODEX_VERSION;
  const version = codexCliVersion('codex', env);
  if (!version) return t.skip('codex CLI is not installed; this spec checks the real binary, not a description of it');
  const [file, ...args] = resolveWindowsLaunch(['codex', '--help'], { env });
  const help = require('node:child_process').spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 15000, env }).stdout || '';
  if (version[0] === 0 && version[1] < 156) return t.skip(`codex ${version.join('.')} predates the pane controls; bin/ai passes none`);
  assert.match(help, /--no-daemon\b/, `codex ${version.join('.')} must advertise --no-daemon`);
});

// The resolution above against the REAL install: the folder it picks must hold a
// cursor that runs and still takes the two flags Harbor's launch and resume use.
test('the installed cursor-agent resolves to a runtime that takes every flag bin/ai passes it', (t) => {
  if (process.platform !== 'win32') return t.skip('the cmd -> ps1 handoff exists only on Windows');
  const { resolveWindowsLaunch, parseAi } = require('../../../bin/harbor-bin.cjs');
  const [file, ...args] = resolveWindowsLaunch(['cursor-agent', '--help'], { env: process.env });
  if (!/node\.exe$/i.test(file)) return t.skip('cursor-agent is not installed with its versions/ launcher here');
  assert.match(args[0], /[\\/]versions[\\/][^\\/]+[\\/]index\.js$/i);
  // A throwaway home: cursor writes a default cli-config.json into a home that
  // has none, and this spec must never touch the real one.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-cursor-flags-'));
  const env = { ...process.env, USERPROFILE: home, HOME: home, NO_OPEN_BROWSER: '1' };
  try {
    const help = require('node:child_process').spawnSync(file, [args[0], '--help'], {
      encoding: 'utf8', windowsHide: true, timeout: 30000, env, cwd: home,
    }).stdout || '';
    assert.match(help, /--resume\b/, 'cursor --help advertises --resume');
    // Every flag bin/ai passes must be one this build defines: an unknown option
    // makes the interactive TUI exit at once ("error: unknown option"), which is a
    // pane that dies on open. A hidden flag (--disable-auto-update) is absent
    // from --help, so it is looked up as an option definition in the bundle.
    // Actually PARSING them is cursor-pane-proof.cjs's job: cursor validates
    // options only after starting its MCP servers (~30 s), too slow for a unit.
    const bundle = fs.readFileSync(args[0], 'utf8');
    for (const flag of parseAi(['--provider', 'cursor']).argv.slice(1)) {
      assert.ok(help.includes(flag) || bundle.includes(`"${flag}"`), `this cursor build does not define ${flag}, which bin/ai passes`);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the installed claude CLI really does accept --session-id at launch', (t) => {
  if (claudeBinaryMissing()) return t.skip('claude CLI is not on PATH; this spec verifies --session-id against the real installed binary, not a description of it');
  const help = execFileSync('claude', ['--help'], { encoding: 'utf8' });
  assert.match(help, /--session-id <uuid>/, 'claude --help advertises --session-id');
});
