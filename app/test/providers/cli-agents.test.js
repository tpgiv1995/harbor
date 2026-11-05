'use strict';

// `claude agents --json` as a status source for every live Claude session,
// including the ones Harbor does not run (shapes from CLI 2.1.301). No test
// here runs a real CLI: every call goes through an injected execFile, and the
// sessions/ directory watch is a fake.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { realTmpDir } = require('../support/real-tmpdir.js');
const {
  createCliAgentsWatcher, parseAgents, resolveCommand,
  SETTLE_MS, FOCUSED_GAP_MS, UNFOCUSED_GAP_MS, FALLBACK_MS,
} = require('../../src/main/providers/cli-agents.js');
const { executablePath } = require('../../src/main/setup/executables.js');

const row = (sessionId, status, extra = {}) => ({ pid: '101', cwd: '/synthetic/proj', kind: 'interactive', startedAt: '1791773875721', sessionId, name: 'claude-05', status, ...extra });

// A fake CLI per home and a fake directory watch, on a clock the test moves.
function harness({ homes = { max: '/home/max', dev: '/home/dev' }, answers = {}, windowState = 'focused', missing = [], unwatchable = [], files = new Set() } = {}) {
  let clock = 1_000_000;
  const calls = [];
  const watches = new Map();
  const world = { windowState, answers };
  const execFileImpl = (file, args, opts, cb) => {
    calls.push({ at: clock, home: opts.env.CLAUDE_CONFIG_DIR, file, args });
    const rows = world.answers[opts.env.CLAUDE_CONFIG_DIR] ?? [];
    if (rows === 'fail') cb(new Error('exit 1'), '');
    else cb(null, JSON.stringify(rows));
  };
  const watchDir = (dir, onChange) => {
    const home = path.dirname(dir);
    if (missing.includes(home)) return { missing: true };
    if (unwatchable.includes(home)) return { missing: false };
    watches.set(home, onChange);
    return { close: () => watches.delete(home) };
  };
  const watcher = createCliAgentsWatcher({
    homes, bin: 'claude', env: {}, platform: 'darwin', execFileImpl, watchDir, fileExists: (file) => files.has(file),
    windowState: () => world.windowState, now: () => clock,
  });
  // The test drives tick() on its own clock; the real interval never runs.
  const start = watcher.start;
  watcher.start = () => {
    const realSetInterval = global.setInterval;
    global.setInterval = () => ({ unref() {} });
    try { start(); } finally { global.setInterval = realSetInterval; }
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return {
    watcher, calls, world, watches,
    advance: async (ms, step = 2_000) => {
      for (let left = ms; left > 0; left -= step) {
        clock += Math.min(step, left);
        await watcher.tick();
        await flush();
      }
    },
    change: (home, eventType = 'change', filename = '777.json') => watches.get(home)?.(eventType, filename),
    callsFor: (home) => calls.filter((call) => call.home === home).length,
    flush,
  };
}

test('the CLI list maps busy/waiting/idle to working/blocked/idle', () => {
  const parsed = parseAgents(JSON.stringify([
    row('a', 'busy'),
    row('b', 'waiting', { waitingFor: 'permission prompt' }),
    row('c', 'idle', { kind: 'background' }),
    row('d', 'something-new'),
    { status: 'busy' },
  ]), '/h');
  assert.deepEqual([...parsed.keys()], ['a', 'b', 'c']);
  assert.equal(parsed.get('a').status, 'working');
  assert.deepEqual({ status: parsed.get('b').status, waitingFor: parsed.get('b').waitingFor }, { status: 'blocked', waitingFor: 'permission prompt' });
  assert.equal(parsed.get('c').kind, 'background');
  assert.equal(parsed.get('a').pid, 101);
  assert.equal(parseAgents('not json', '/h'), null);
});

test('the watcher merges every Claude home, reports only changes, and rides out one failed call', async () => {
  const h = harness({ answers: { '/home/max': [row('a', 'busy')], '/home/dev': [row('b', 'idle')] } });
  let changes = 0;
  h.watcher.on('change', () => { changes += 1; });
  await h.watcher.poll();
  assert.equal(h.watcher.get('a').status, 'working');
  assert.equal(h.watcher.get('b').status, 'idle');
  assert.deepEqual([h.calls[0].file, h.calls[0].args.join(' '), h.calls[0].home], ['claude', 'agents --json', '/home/max']);
  await h.watcher.poll();
  assert.equal(changes, 1, 'an unchanged list is silent');
  h.world.answers['/home/max'] = [row('a', 'waiting', { waitingFor: 'permission prompt' })];
  await h.watcher.poll();
  assert.equal(h.watcher.get('a').status, 'blocked');
  assert.equal(changes, 2);
  h.world.answers['/home/dev'] = 'fail';
  await h.watcher.poll();
  assert.equal(h.watcher.get('b')?.status, 'idle', 'one miss keeps the last answer');
  await h.watcher.poll();
  assert.equal(h.watcher.get('b'), null, 'a second miss drops the home');
  h.watcher.stop();
});

// A fixed timer listed every home every 20 s while the window was merely
// visible: 8,640 CLI starts a day for two homes (about 157 MB peak each).
test('nothing changed, nothing listed: a visible window for a day lists each home only on the fallback', async () => {
  const h = harness({ windowState: 'visible', answers: { '/home/max': [row('a', 'idle')], '/home/dev': [] } });
  h.watcher.start();
  await h.flush();
  assert.equal(h.calls.length, 2, 'start lists every home once');
  await h.advance(24 * 60 * 60 * 1000, 10_000);
  const day = h.calls.length - 2;
  // Only the home that lists a session is re-checked (a crashed CLI leaves its
  // file behind); the empty home waits for its directory to change.
  assert.equal(h.callsFor('/home/dev'), 1);
  assert.equal(day, (24 * 60 * 60 * 1000) / FALLBACK_MS);
  assert.ok(day < 8_640 / 20, `${day} calls`);
  h.watcher.stop();
});

test('a change in one home lists that home once, after the burst settles, and only once per gap', async () => {
  const h = harness();
  h.watcher.start();
  await h.flush();
  await h.advance(FOCUSED_GAP_MS);
  assert.equal(h.calls.length, 2, 'nothing changed since start');
  h.change('/home/max');
  h.change('/home/max', 'rename', '888.json');
  h.change('/home/max');
  await h.watcher.tick();
  assert.equal(h.calls.length, 2, `the burst gets ${SETTLE_MS} ms to settle`);
  await h.advance(2_000);
  assert.equal(h.callsFor('/home/max'), 2, 'one call for the burst');
  assert.equal(h.callsFor('/home/dev'), 1, 'the other home was not listed');
  h.change('/home/max');
  await h.advance(4_000);
  assert.equal(h.callsFor('/home/max'), 2, 'the next change waits out the focused gap');
  await h.advance(FOCUSED_GAP_MS);
  assert.equal(h.callsFor('/home/max'), 3);
  h.watcher.stop();
});

test('unfocused it lists at most once a minute; hidden or minimized never, and focus catches up', async () => {
  const h = harness({ windowState: 'visible' });
  h.watcher.start();
  await h.flush();
  await h.advance(UNFOCUSED_GAP_MS);
  h.change('/home/max');
  await h.advance(4_000);
  assert.equal(h.callsFor('/home/max'), 2, 'the first change after a quiet minute is listed');
  h.change('/home/max');
  await h.advance(UNFOCUSED_GAP_MS - 10_000);
  assert.equal(h.callsFor('/home/max'), 2, 'unfocused: not within a minute');
  await h.advance(10_000);
  assert.equal(h.callsFor('/home/max'), 3);
  h.world.windowState = 'hidden';
  h.change('/home/dev');
  await h.advance(60 * 60 * 1000, 30_000);
  assert.equal(h.callsFor('/home/dev'), 1, 'hidden: nothing, however long');
  h.world.windowState = 'focused';
  await h.watcher.nudge();
  assert.equal(h.callsFor('/home/dev'), 2, 'focus lists the home that changed');
  assert.equal(h.callsFor('/home/max'), 3, 'and not the one that did not');
  await h.watcher.nudge();
  assert.equal(h.callsFor('/home/dev'), 2, 'alt-tabbing again lists nothing');
  h.watcher.stop();
});

test('a rewrite of a Harbor pane\'s own file lists nothing; its exit, and other sessions, still count', async () => {
  const files = new Set([path.join('/home/max', 'sessions', '501.json')]);
  const h = harness({ files });
  h.watcher.setOwnPaneFileTest((pid) => pid === 501);
  h.watcher.start();
  await h.flush();
  await h.advance(FOCUSED_GAP_MS);
  h.change('/home/max', 'change', '501.json');
  h.change('/home/max', 'change', '501.a1b2.key');
  await h.advance(FOCUSED_GAP_MS);
  h.change('/home/max', 'rename', '501.json');
  await h.advance(FOCUSED_GAP_MS);
  assert.equal(h.callsFor('/home/max'), 1, 'the pane reports through OSC 7501, however the platform names the write');
  files.clear();
  h.change('/home/max', 'rename', '501.json');
  await h.advance(4_000);
  assert.equal(h.callsFor('/home/max'), 2, 'the pane\'s CLI exited: its row must go');
  await h.advance(FOCUSED_GAP_MS);
  h.change('/home/max', 'change', '777.json');
  await h.advance(4_000);
  assert.equal(h.callsFor('/home/max'), 3, 'a session outside Harbor changed');
  h.watcher.stop();
});

test('no sessions/ directory: nothing to list; an existing one that cannot be watched keeps the gap cadence', async () => {
  const h = harness({ missing: ['/home/max'], unwatchable: ['/home/dev'] });
  h.watcher.start();
  await h.flush();
  await h.advance(10 * 60 * 1000, 5_000);
  assert.equal(h.callsFor('/home/max'), 1, 'only the start');
  assert.equal(h.callsFor('/home/dev'), 1 + (10 * 60 * 1000) / FOCUSED_GAP_MS);
  h.watcher.stop();
});

test('a home whose CLI keeps failing backs off to the fallback', async () => {
  const h = harness({ homes: { max: '/home/max' }, answers: { '/home/max': 'fail' }, unwatchable: ['/home/max'] });
  h.watcher.start();
  await h.flush();
  await h.advance(60 * 60 * 1000, 5_000);
  // 40 s, 80 s, 160 s, then every 5 minutes.
  assert.ok(h.callsFor('/home/max') <= 1 + 3 + 12, `${h.callsFor('/home/max')} calls in an hour`);
  h.watcher.stop();
});

test('nudge does nothing before start (the Claude provider is off)', async () => {
  const h = harness();
  h.change('/home/max');
  await h.watcher.nudge();
  await h.watcher.tick();
  assert.equal(h.calls.length, 0);
  h.watcher.stop();
});

// Windows: npm installs and paths with spaces. Simulated here (no Windows
// box): the fixtures are real files resolved with platform 'win32', and cmd's
// /s quote rule is modelled below.
function npmShimDir(t) {
  const dir = fs.mkdtempSync(path.join(realTmpDir(), 'harbor-cli-agents-npm-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // What npm's cmd-shim writes for a global install: sh script, .cmd, .ps1.
  for (const name of ['claude', 'claude.cmd', 'claude.ps1']) fs.writeFileSync(path.join(dir, name), 'fixture must never run');
  return dir;
}

test('win32: a bare claude next to npm\'s extensionless sh shim resolves to claude.cmd', async (t) => {
  const dir = npmShimDir(t);
  const env = { PATH: dir, PATHEXT: '.PS1;.COM;.EXE;.BAT;.CMD;.JS', ComSpec: 'C:\\Windows\\system32\\cmd.exe' };
  const cmd = await resolveCommand('claude', { platform: 'win32', env });
  assert.equal(cmd.file, env.ComSpec);
  assert.equal(cmd.verbatim, true);
  assert.ok(cmd.args[3].includes(`"${path.join(dir, 'claude.cmd')}"`), cmd.args[3]);
  const explicit = await resolveCommand(path.join(dir, 'claude'), { platform: 'win32', env });
  assert.ok(explicit.args[3].includes(`"${path.join(dir, 'claude.cmd')}"`), explicit.args[3]);
  const exe = path.join(dir, 'claude.exe');
  fs.writeFileSync(exe, 'fixture must never run');
  assert.deepEqual(await resolveCommand(exe, { platform: 'win32', env }), { file: exe, args: ['agents', '--json'] });
  // Setup's default lookup is unchanged: the bare name still comes first there.
  assert.equal(await executablePath('claude', { platform: 'win32', env }), path.join(dir, 'claude'));
  assert.equal(await executablePath('claude', { platform: 'win32', env, pathextOnly: true }), path.join(dir, 'claude.ps1'));
});

// cmd.exe /s: the FIRST and LAST quote after /c are stripped and what is left
// is run as the command line.
function cmdSlashS(line) {
  const first = line.indexOf('"');
  const last = line.lastIndexOf('"');
  if (first < 0 || last === first) return line;
  return line.slice(0, first) + line.slice(first + 1, last) + line.slice(last + 1);
}

test('win32: a .cmd path with a space survives cmd /s quote stripping', async () => {
  const found = 'C:\\Users\\John Smith\\AppData\\Roaming\\npm\\claude.cmd';
  const cmd = await resolveCommand('claude', { platform: 'win32', env: {}, resolvePath: async () => found });
  assert.deepEqual(cmd.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(cmd.verbatim, true);
  assert.equal(cmdSlashS(cmd.args[3]), `"${found}" agents --json`, 'the path keeps its own quotes after /s');
  assert.equal(cmdSlashS(`"${found}" agents --json`), `${found} agents --json`, 'the single-quoted form loses them');
  const parens = 'C:\\Program Files (x86)\\npm\\claude.cmd';
  const p = await resolveCommand('claude', { platform: 'win32', env: {}, resolvePath: async () => parens });
  assert.equal(cmdSlashS(p.args[3]), `"${parens}" agents --json`);
});

test('a command that failed is resolved again, but not on every call', async () => {
  let clock = 1_000_000;
  const resolved = ['C:\\npm\\claude', 'C:\\npm\\claude.cmd'];
  let resolves = 0;
  const spawned = [];
  const watcher = createCliAgentsWatcher({
    homes: { dev: 'C:\\Users\\pat\\.claude' }, env: {}, platform: 'win32', now: () => clock,
    resolvePath: async () => resolved[Math.min(resolves++, resolved.length - 1)],
    execFileImpl: (file, args, opts, cb) => {
      spawned.push(file);
      if (file === 'C:\\npm\\claude') cb(Object.assign(new Error('spawn UNKNOWN'), { code: 'UNKNOWN' }), '');
      else cb(null, JSON.stringify([row('a', 'busy')]));
    },
  });
  await watcher.poll();
  assert.equal(watcher.get('a'), null);
  clock += 30_000;
  await watcher.poll();
  assert.equal(resolves, 1, 'no PATH walk right after a failure');
  assert.equal(spawned.length, 1, 'and nothing to run');
  clock += FALLBACK_MS;
  await watcher.poll();
  assert.equal(resolves, 2, 'resolved again once the wait is over');
  assert.deepEqual(spawned, ['C:\\npm\\claude', 'cmd.exe']);
  assert.equal(watcher.get('a').status, 'working');
  clock += FALLBACK_MS;
  await watcher.poll();
  assert.equal(resolves, 2, 'a working command stays cached');
  watcher.stop();
});
