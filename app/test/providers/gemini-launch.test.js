'use strict';

// What a Gemini pane needs on disk before agy starts (2026-11-23): the status-line wrapper at a space-free path, the
// per-folder settings file for `--settings`, a sweep of old tee files, and the model a resume reopens on.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  prepareGeminiLaunch, settingsPathFor, wrapperPathFor, wrapperText, pruneTeeFiles, lastGeminiModel, folderKey, CMD_SAFE,
} = require('../../src/main/providers/gemini-launch.js');

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'gemini-launch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const CONV = '32fe68ca-b177-4dba-86f4-6272f59c04b9';

test('one settings file per working folder, whatever the case or trailing slash', () => {
  const cache = path.join(path.sep, 'cache');
  assert.equal(settingsPathFor('C:\\Work\\Demo', cache), settingsPathFor('c:\\work\\demo\\', cache));
  assert.notEqual(settingsPathFor('C:\\work\\one', cache), settingsPathFor('C:\\work\\two', cache));
  assert.match(path.basename(settingsPathFor('C:\\x', cache)), /^settings-[0-9a-f]{12}\.json$/);
  assert.equal(folderKey('C:\\a'), folderKey('c:\\a'));
});

test('on Windows the settings name the wrapper as the status line and trust only this folder', (t) => {
  const cache = tmp(t);
  const cwd = path.join(cache, 'work');
  const result = prepareGeminiLaunch({ cwd, cacheDir: cache, execPath: 'C:\\Program Files\\nodejs\\node.exe', script: 'C:\\app dir\\tee.cjs', electron: false, platform: 'win32' });
  assert.equal(result.statusLine, true);
  assert.equal(result.settingsFile, settingsPathFor(cwd, cache));
  const settings = JSON.parse(fs.readFileSync(result.settingsFile, 'utf8'));
  assert.deepEqual(settings.trustedWorkspaces, [cwd]);
  assert.deepEqual(settings.statusLine, { type: 'command', command: wrapperPathFor(cache) });
  assert.equal(CMD_SAFE.test(settings.statusLine.command), true, 'the command agy hands to cmd /c holds no space');
  // The paths WITH spaces live inside the wrapper, which cmd reads as a script, not as a command line.
  const text = fs.readFileSync(wrapperPathFor(cache), 'utf8');
  assert.match(text, /"C:\\Program Files\\nodejs\\node\.exe" "C:\\app dir\\tee\.cjs"/);
  assert.equal(text.includes('ELECTRON_RUN_AS_NODE'), false, 'plain node needs no switch');
  assert.equal(text.includes('\r\n'), true, 'a .cmd file is written with CRLF');
});

test('under Electron the wrapper sets ELECTRON_RUN_AS_NODE for its own child only', () => {
  const text = wrapperText({ execPath: 'C:\\apps\\harbor.exe', script: 'C:\\x\\tee.cjs', electron: true });
  assert.match(text, /set "ELECTRON_RUN_AS_NODE=1"\r\n"C:\\apps\\harbor\.exe" "C:\\x\\tee\.cjs"/);
});

test('a cache folder whose wrapper path would not survive cmd /c leaves the status line out, never ships it broken', (t) => {
  const root = tmp(t);
  const cache = path.join(root, 'a folder with spaces');
  const result = prepareGeminiLaunch({ cwd: path.join(root, 'w'), cacheDir: cache, platform: 'win32' });
  assert.equal(result.statusLine, false);
  assert.equal(result.wrapper, null);
  const settings = JSON.parse(fs.readFileSync(result.settingsFile, 'utf8'));
  assert.equal('statusLine' in settings, false);
  assert.deepEqual(settings.trustedWorkspaces, [path.join(root, 'w')], 'the trust entry still skips the folder dialog');
  assert.equal(fs.existsSync(wrapperPathFor(cache)), false);
});

test('off Windows there is no cmd wrapper and no status line', (t) => {
  const cache = tmp(t);
  const result = prepareGeminiLaunch({ cwd: '/work', cacheDir: cache, platform: 'linux' });
  assert.equal(result.statusLine, false);
  assert.equal(fs.existsSync(wrapperPathFor(cache)), false);
});

test('a second launch rewrites nothing when nothing changed, and rewrites a wrapper whose interpreter moved', (t) => {
  const cache = tmp(t);
  const args = { cwd: path.join(cache, 'w'), cacheDir: cache, execPath: 'C:\\n\\node.exe', script: 'C:\\s.cjs', electron: false, platform: 'win32' };
  prepareGeminiLaunch(args);
  const first = fs.statSync(wrapperPathFor(cache)).mtimeMs;
  const settingsFirst = fs.statSync(settingsPathFor(args.cwd, cache)).mtimeMs;
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(wrapperPathFor(cache), past, past);
  fs.utimesSync(settingsPathFor(args.cwd, cache), past, past);
  prepareGeminiLaunch(args);
  assert.equal(fs.statSync(wrapperPathFor(cache)).mtimeMs, past.getTime(), 'unchanged wrapper untouched');
  assert.equal(fs.statSync(settingsPathFor(args.cwd, cache)).mtimeMs, past.getTime(), 'unchanged settings untouched');
  assert.ok(first >= 0 && settingsFirst >= 0);
  prepareGeminiLaunch({ ...args, execPath: 'D:\\moved\\node.exe' });
  assert.match(fs.readFileSync(wrapperPathFor(cache), 'utf8'), /D:\\moved\\node\.exe/);
});

test('tee files nobody has written for two weeks are swept, nothing else is', (t) => {
  const dir = tmp(t);
  const now = Date.now();
  const make = (name, ageMs) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, '{}');
    const when = new Date(now - ageMs);
    fs.utimesSync(file, when, when);
    return file;
  };
  const DAY = 24 * 3600 * 1000;
  const oldTee = make(`gemini-${CONV}.json`, 20 * DAY);
  const oldTemp = make(`gemini-${CONV}.json.tmp-123`, 20 * DAY);
  const freshTee = make('gemini-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.json', 1 * DAY);
  const claudeTee = make('11111111-2222-4333-8444-555555555555.json', 90 * DAY);
  const other = make('gemini-notes.json', 90 * DAY);
  assert.equal(pruneTeeFiles(dir, { now }), 2);
  assert.equal(fs.existsSync(oldTee), false);
  assert.equal(fs.existsSync(oldTemp), false);
  for (const kept of [freshTee, claudeTee, other]) assert.equal(fs.existsSync(kept), true, `${path.basename(kept)} is not a stale gemini tee`);
  assert.equal(pruneTeeFiles(path.join(dir, 'missing'), { now }), 0);
});

function writeTranscript(root, lines) {
  const dir = path.join(root, 'brain', CONV, '.system_generated', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'transcript_full.jsonl'), `${lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')}\n`);
}

test('a resume reopens on the model the conversation last answered with', (t) => {
  const root = tmp(t);
  writeTranscript(root, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>\nhi\n</USER_REQUEST>' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', model: 'gemini-4-neon-high', content: 'a' },
    { step_index: 2, source: 'MODEL', type: 'GENERIC', content: 'result' },
    { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', model: 'gemini-4-hydrogen-low', content: 'b' },
    { step_index: 4, source: 'MODEL', type: 'GENERIC', model: 'gemini-not-this-one', content: 'result' },
  ]);
  assert.equal(lastGeminiModel(root, CONV), 'gemini-4-hydrogen-low', 'the newest PLANNER_RESPONSE wins');
});

test('nothing readable means no model is named, never a guess', (t) => {
  const root = tmp(t);
  assert.equal(lastGeminiModel(root, CONV), null, 'no transcript');
  writeTranscript(root, [{ step_index: 0, type: 'USER_INPUT', content: 'x' }, '{torn']);
  assert.equal(lastGeminiModel(root, CONV), null, 'no answer yet');
  writeTranscript(root, [{ step_index: 1, type: 'PLANNER_RESPONSE', model: 'claude-opus-5-5-low', content: 'x' }]);
  assert.equal(lastGeminiModel(root, CONV), null, 'only gemini- slugs are ever passed to --model');
});

test('a long record at the tail does not hide an older model: the read is bounded and skips the cut head line', (t) => {
  const root = tmp(t);
  const big = { step_index: 9, type: 'GENERIC', content: 'x'.repeat(5000) };
  writeTranscript(root, [{ step_index: 1, type: 'PLANNER_RESPONSE', model: 'gemini-4-neon-low', content: 'a' }, big, big]);
  assert.equal(lastGeminiModel(root, CONV, { maxBytes: 4000 }), null, 'outside the window it is simply not found');
  assert.equal(lastGeminiModel(root, CONV), 'gemini-4-neon-low');
});
