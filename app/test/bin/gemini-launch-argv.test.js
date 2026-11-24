'use strict';

// `bin/ai --provider gemini` (2026-11-23): Google's Antigravity CLI as Harbor's fourth session provider. The argv is read
// with HARBOR_AI_DRY_RUN=1 (nothing starts and nothing is written), against a stand-in binary named by HARBOR_AGY_BIN,
// a config file naming a scratch cache folder, and a scratch USERPROFILE: no real agy, config or profile is touched.
// The last spec checks every flag bin/ai passes against the REAL installed agy's own `--help`, skipped where it is absent.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { sessiondChildEnv, parseAi } = require('../../../bin/harbor-bin.cjs');
const { settingsPathFor } = require('../../src/main/providers/gemini-launch.js');
const { resolveGeminiConfigSync } = require('../../src/main/providers/gemini-config.js');

const AI = path.join(__dirname, '../../../bin/ai');
const CONV = '32fe68ca-b177-4dba-86f4-6272f59c04b9';

const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'harbor-gemini-argv-'));
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* going away anyway */ } });
const cacheDir = path.join(root, 'cache');
const config = path.join(root, 'config.json');
fs.writeFileSync(config, JSON.stringify({ paths: { cacheDir } }));
const fakeAgy = path.join(root, 'tools', 'agy.exe');
fs.mkdirSync(path.dirname(fakeAgy), { recursive: true });
fs.writeFileSync(fakeAgy, '');
const profile = path.join(root, 'profile');
fs.mkdirSync(profile, { recursive: true });
const work = path.join(root, 'work');
fs.mkdirSync(work, { recursive: true });

const run = (args, env = {}) => execFileSync(process.execPath, [AI, ...args], {
  cwd: work,
  env: {
    ...process.env, HARBOR_AI_DRY_RUN: '1', HARBOR_CONFIG_FILE: config, HARBOR_AGY_BIN: fakeAgy,
    USERPROFILE: profile, HOME: profile, ...env,
  },
  encoding: 'utf8', windowsHide: true,
}).trim();
const fails = (args, env) => { try { run(args, env); } catch (error) { return `${error.stderr || ''}${error.message}`; } return null; };

// Brain folder under a scratch profile with one conversation answered on a model.
function seedConversation(home, id, model) {
  const dir = path.join(home, '.gemini', 'antigravity-cli', 'brain', id, '.system_generated', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'transcript_full.jsonl'), `${[
    { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nhi\n</USER_REQUEST>' },
    { step_index: 1, type: 'PLANNER_RESPONSE', model, content: 'ok' },
  ].map((l) => JSON.stringify(l)).join('\n')}\n`);
}

const SETTINGS = (cwd) => settingsPathFor(cwd, cacheDir);
// commandString quotes what shells would split; compare on the argv instead of the quoting.
const words = (text) => text.match(/'[^']*'|\S+/g).map((w) => w.replace(/^'|'$/g, ''));

test('a new Gemini launch is agy with the permission bypass, the per-folder settings file, and nothing else', () => {
  assert.deepEqual(words(run(['--provider', 'gemini'])), [
    fakeAgy, '--dangerously-skip-permissions', '--settings', SETTINGS(work),
  ]);
});

test('a family goes with --effort beside it; a slug goes alone; Default sends neither', () => {
  const tail = (args) => words(run(['--provider', 'gemini', ...args])).slice(4);
  assert.deepEqual(tail(['--model', 'gemini-4-hydrogen', '--effort', 'low']), ['--model', 'gemini-4-hydrogen', '--effort', 'low']);
  assert.deepEqual(tail(['--model', 'gemini-4-hydrogen-low']), ['--model', 'gemini-4-hydrogen-low']);
  assert.deepEqual(tail(['--model', 'gemini-4-hydrogen-low', '--effort', 'low']), ['--model', 'gemini-4-hydrogen-low'], 'the same effort is not a conflict');
  assert.deepEqual(tail(['--effort', 'xhigh']), ['--effort', 'xhigh'], 'effort alone moves agy\'s default family');
  assert.deepEqual(tail([]), []);
});

test('a slug plus a DIFFERENT --effort is refused loudly: agy would silently start its Neon High default', () => {
  const message = fails(['--provider', 'gemini', '--model', 'gemini-4-hydrogen-low', '--effort', 'xhigh']);
  assert.match(message, /already carries the effort low, which conflicts with --effort xhigh/);
  assert.match(message, /pass the family gemini-4-hydrogen with --effort/);
});

test('the initial prompt is -i (interactive), never --prompt, which agy treats as --print and exits after one answer', () => {
  const out = words(run(['--provider', 'gemini', '--model', 'gemini-4-hydrogen', '--effort', 'low', 'say hello']));
  assert.deepEqual(out.slice(-2), ['-i', 'say hello']);
  assert.equal(out.includes('--prompt'), false);
  assert.equal(out.includes('-p'), false);
  assert.equal(out.includes('--print'), false);
});

test('a resume names the conversation with --conversation, and anything not a conversation id is refused', () => {
  seedConversation(profile, CONV, 'gemini-4-hydrogen-low');
  const out = words(run(['--provider', 'gemini', '--resume-id', CONV]));
  assert.deepEqual(out.slice(4, 6), ['--conversation', CONV]);
  assert.match(fails(['--provider', 'gemini', '--resume-id', 'not-a-conversation']), /is not a conversation id/);
  assert.match(fails(['--provider', 'claude', '--resume-id', CONV]), /codex\/cursor\/gemini only/);
});

test('a resume reopens on the model the conversation last answered with, from the profile agy will run under', () => {
  seedConversation(profile, CONV, 'gemini-4-hydrogen-low');
  assert.deepEqual(words(run(['--provider', 'gemini', '--resume-id', CONV])).slice(4), ['--conversation', CONV, '--model', 'gemini-4-hydrogen-low']);
  // Named flags win over the recovery.
  assert.deepEqual(words(run(['--provider', 'gemini', '--resume-id', CONV, '--model', 'gemini-4-neon', '--effort', 'high'])).slice(4),
    ['--conversation', CONV, '--model', 'gemini-4-neon', '--effort', 'high']);
  // A conversation with no record yet names no model at all, said by omission.
  const other = '11111111-2222-4333-8444-555555555555';
  assert.deepEqual(words(run(['--provider', 'gemini', '--resume-id', other])).slice(4), ['--conversation', other]);
});

test('--home is a USERPROFILE root: the conversation is found under it, not under the user\'s own profile', () => {
  const elsewhere = path.join(root, 'elsewhere');
  fs.mkdirSync(elsewhere, { recursive: true });
  const id = '99999999-8888-4777-8666-555555555555';
  seedConversation(elsewhere, id, 'gemini-4-carbon-high');
  assert.deepEqual(words(run(['--provider', 'gemini', '--resume-id', id, '--home', elsewhere])).slice(4), ['--conversation', id, '--model', 'gemini-4-carbon-high']);
  // Without --home the same id is searched under the user's own profile, where it is not.
  assert.deepEqual(words(run(['--provider', 'gemini', '--resume-id', id])).slice(4), ['--conversation', id]);
  assert.match(fails(['--provider', 'gemini', '--home', 'nonsense']), /names neither a gemini profile nor a config home/);
});

test('without agy installed the launch says so instead of failing on a bare name', () => {
  const message = fails(['--provider', 'gemini'], { HARBOR_AGY_BIN: path.join(root, 'nope', 'agy.exe') });
  assert.match(message, /Gemini's CLI \(agy\) was not found/);
});

test('the dry run writes nothing: the per-folder settings file appears only on a real launch', () => {
  run(['--provider', 'gemini']);
  assert.equal(fs.existsSync(SETTINGS(work)), false);
  assert.equal(fs.existsSync(path.join(cacheDir, 'gemini')), false);
});

test('the daemon allowlist passes a Gemini pane its USERPROFILE override, no self-update and the context dir, and only to Gemini panes', () => {
  const source = { USERPROFILE: 'D:\\other-root', HARBOR_CONTEXT_DIR: 'D:\\ctx', CLAUDE_CONFIG_DIR: 'D:\\claude' };
  const gemini = sessiondChildEnv(source, { agent: 'gemini' });
  assert.equal(gemini.USERPROFILE, 'D:\\other-root');
  assert.equal(gemini.AGY_CLI_DISABLE_AUTO_UPDATE, 'true');
  assert.equal(gemini.HARBOR_CONTEXT_DIR, 'D:\\ctx');
  const claude = sessiondChildEnv(source, { agent: 'claude' });
  assert.equal(claude.AGY_CLI_DISABLE_AUTO_UPDATE, undefined, 'the allowlist keeps other variables out of every other child');
  assert.equal(claude.HARBOR_CONTEXT_DIR, undefined);
  assert.equal(gemini.HOME, claude.HOME, 'HOME is untouched: agy ignores it, so a Gemini pane never moves it');
  assert.notEqual(claude.USERPROFILE, 'D:\\other-root', 'another provider\'s child never follows a Gemini root');
  // No override: the pane runs under the profile Harbor itself runs under (USERPROFILE unchanged).
  assert.equal(sessiondChildEnv({}, { agent: 'gemini' }).USERPROFILE, process.env.USERPROFILE);
});

test('the unknown-provider message and the help text name gemini', () => {
  assert.match(fails(['--provider', 'nothing']), /unknown provider: nothing/);
  const help = execFileSync(process.execPath, [AI, '--help'], { env: { ...process.env, HARBOR_CONFIG_FILE: config }, encoding: 'utf8', windowsHide: true });
  assert.match(help, /--provider claude\|codex\|cursor\|gemini/);
  assert.throws(() => parseAi(['--provider', 'gemini', '--effort']), /--effort requires a value/);
});

test('a launch inside a workspace-pool slot is refused for gemini as for the others', () => {
  const lanes = path.join(root, 'lanes');
  const slot = path.join(root, 'pool', 'repo1', 'slot-01');
  fs.mkdirSync(slot, { recursive: true });
  fs.mkdirSync(lanes, { recursive: true });
  fs.writeFileSync(path.join(lanes, 'registry.json'), JSON.stringify({
    repos: { repo1: { id: 'repo1', canonical: path.join(root, 'repo1'), slots: [{ id: 'slot-01', path: slot, lane: 'lane-a', generation: 1 }] } },
    lanes: { 'lane-a': { id: 'lane-a', state: 'running' } }, sessions: {},
  }));
  const result = spawnSync(process.execPath, [AI, '--provider', 'gemini'], {
    cwd: slot, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, HARBOR_AI_DRY_RUN: '1', HARBOR_CONFIG_FILE: config, HARBOR_AGY_BIN: fakeAgy, HARBOR_LANES_DIR: lanes, USERPROFILE: profile },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not start sessions in workspace-pool slot/);
});

test('every flag bin/ai passes is one the REAL agy defines', (t) => {
  const real = resolveGeminiConfigSync({ env: { ...process.env, HARBOR_AGY_BIN: undefined } });
  if (!real) return t.skip('agy is not installed here; this spec checks the flags against its own --help');
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'harbor-agy-help-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const help = spawnSync(real.bin, ['--help'], {
    encoding: 'utf8', windowsHide: true, timeout: 30000, cwd: scratch,
    env: { ...process.env, USERPROFILE: scratch, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
  });
  const text = `${help.stdout}${help.stderr}`;
  for (const flag of ['--dangerously-skip-permissions', '--settings', '--conversation', '--model', '--effort', '-i']) {
    assert.ok(new RegExp(`(^|\\s)${flag}(\\s|,)`, 'm').test(text), `this agy does not define ${flag}, which bin/ai passes`);
  }
  assert.match(text, /--prompt\s+Alias for --print/, '--prompt is --print, which is why a pane uses -i');
});
