'use strict';

// The Gemini status tee (2026-11-23): the one place Harbor learns which conversation a pane is and what its agent is
// doing, including a permission menu that writes nothing to the transcript. The payload is agy 1.5.14's real statusLine
// JSON (AGY-FACTS section 2) with an invented account. The last spec runs the script itself, the way agy's `cmd /c`
// wrapper does, windowless.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  buildTeeRecord, writeTeeRecord, teePathFor, statusLine, contextDirFromEnv,
} = require('../../src/main/providers/gemini-status-tee.cjs');

const SCRIPT = path.join(__dirname, '../../src/main/providers/gemini-status-tee.cjs');
const ID = '32fe68ca-b177-4dba-86f4-6272f59c04b9';
const HOME = path.join(path.sep, 'profiles', 'pat');

const payload = (over = {}) => ({
  cwd: 'C:\\work\\demo', session_id: ID, conversation_id: ID,
  transcript_path: 'C:\\profiles\\pat\\.gemini\\antigravity\\brain\\x\\.system_generated\\logs\\transcript.jsonl',
  model: { id: 'Gemini 4 Hydrogen (Low)', display_name: 'Gemini 4 Hydrogen (Low)', effort: 'low' },
  workspace: { current_dir: 'C:\\work\\demo', project_dir: 'C:\\work\\demo' },
  version: '1.5.14',
  context_window: { total_input_tokens: 13760, total_output_tokens: 47, context_window_size: 1048576, used_percentage: 1.31 },
  quota: { 'gemini-5h': { remaining_fraction: 0.87 } },
  agent_state: 'idle', plan_tier: 'Google AI Ultra', email: 'someone@example.invalid', terminal_width: 120, ...over,
});

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'gemini-tee-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('before the first prompt there is no conversation id, so nothing is recorded', () => {
  assert.equal(buildTeeRecord(payload({ conversation_id: '' }), { home: HOME }), null);
  assert.equal(buildTeeRecord(payload({ conversation_id: undefined }), { home: HOME }), null);
  assert.equal(buildTeeRecord(payload({ conversation_id: 'not-a-uuid' }), { home: HOME }), null);
  assert.equal(buildTeeRecord(null, { home: HOME }), null);
  assert.equal(buildTeeRecord('text', { home: HOME }), null);
});

test('the record keeps exactly what Harbor reads and never the account', () => {
  const record = buildTeeRecord(payload(), { home: HOME, now: 1_700_000_000_000 });
  assert.equal(record.conversation_id, ID);
  assert.equal(record.agent_state, 'idle');
  assert.equal(record.tool_confirmation_pending, false);
  assert.equal(record.cwd, 'C:\\work\\demo');
  assert.deepEqual(record.model, { id: 'Gemini 4 Hydrogen (Low)', display_name: 'Gemini 4 Hydrogen (Low)', effort: 'low' });
  assert.equal(record.context_window.used_percentage, 1.31);
  assert.equal(record.context_window.context_window_size, 1048576);
  assert.equal(record.writtenAtMs, 1_700_000_000_000);
  assert.equal(record.writtenAt, new Date(1_700_000_000_000).toISOString());
  const text = JSON.stringify(record);
  assert.equal(text.includes('someone@example.invalid'), false, 'the email is never written');
  assert.equal(text.includes('Google AI Ultra'), false, 'nothing outside the named fields is copied');
  assert.equal('email' in record, false);
  assert.equal('quota' in record, false);
});

test('the transcript path is built from the profile agy runs under, not from the payload\'s wrong one', () => {
  const record = buildTeeRecord(payload(), { home: HOME });
  const folder = path.join(HOME, '.gemini', 'antigravity-cli');
  assert.equal(record.stateDir, folder);
  assert.equal(record.transcriptPath, path.join(folder, 'brain', ID, '.system_generated', 'logs', 'transcript_full.jsonl'));
  assert.equal(record.transcriptPath.includes(`${path.sep}antigravity${path.sep}brain`), false, 'the payload\'s antigravity\\brain path is wrong for the CLI');
  assert.equal(record.home, HOME);
});

test('a pending permission menu is recorded as such (it writes nothing to the transcript)', () => {
  const record = buildTeeRecord(payload({ agent_state: 'tool_use', tool_confirmation_pending: true }), { home: HOME });
  assert.equal(record.agent_state, 'tool_use');
  assert.equal(record.tool_confirmation_pending, true);
  assert.equal(buildTeeRecord(payload({ agent_state: 'working' }), { home: HOME }).tool_confirmation_pending, false);
  assert.equal(buildTeeRecord(payload({ cwd: undefined }), { home: HOME }).cwd, 'C:\\work\\demo', 'the workspace dir backs up a missing cwd');
});

test('the write is atomic: a temp file renamed over the record, never a half-written one', (t) => {
  const dir = tmp(t);
  const record = buildTeeRecord(payload(), { home: HOME });
  const target = writeTeeRecord(dir, record);
  assert.equal(target, teePathFor(dir, ID));
  assert.equal(path.basename(target), `gemini-${ID}.json`);
  assert.deepEqual(fs.readdirSync(dir), [`gemini-${ID}.json`], 'no temp file is left behind');
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).conversation_id, ID);
  // The rename step is the atomic one: prove it by watching the calls and a failing rename cleaning up its temp file.
  const calls = [];
  const fsImpl = {
    mkdirSync: (...a) => { calls.push('mkdir'); fs.mkdirSync(...a); },
    writeFileSync: (file, ...rest) => { calls.push(`write:${path.basename(file).includes('.tmp-') ? 'temp' : 'final'}`); fs.writeFileSync(file, ...rest); },
    renameSync: () => { calls.push('rename'); throw new Error('locked'); },
    rmSync: (...a) => { calls.push('rm'); fs.rmSync(...a); },
  };
  assert.throws(() => writeTeeRecord(dir, record, { fsImpl, pid: 7 }), /locked/);
  assert.deepEqual(calls, ['mkdir', 'write:temp', 'rename', 'rm']);
  assert.equal(fs.existsSync(`${target}.tmp-7`), false);
});

test('the status row keeps agy\'s own footer hints (a custom status line replaces the footer) and carries no secret', () => {
  assert.equal(statusLine(payload()), '? for shortcuts · Gemini 4 Hydrogen (Low)');
  assert.equal(statusLine(payload({ agent_state: 'working' })), 'esc to cancel · Gemini 4 Hydrogen (Low)');
  assert.equal(statusLine(payload({ agent_state: 'tool_use', tool_confirmation_pending: true })), 'esc to cancel · Gemini 4 Hydrogen (Low)');
  assert.equal(statusLine({ agent_state: 'authenticating' }), '? for shortcuts', 'before the first prompt there is no model yet');
  assert.equal(statusLine(null), '');
  assert.equal(statusLine(payload()).includes('example'), false);
});

test('the context dir honours the same relocation switch the Claude tee does', () => {
  assert.equal(contextDirFromEnv({ HARBOR_CONTEXT_DIR: path.join(os.tmpdir(), 'x') }), path.resolve(os.tmpdir(), 'x'));
  assert.equal(contextDirFromEnv({}), path.join(os.homedir(), '.cache', 'harbor', 'context'));
});

test('run as agy runs it: JSON on stdin makes the record, no conversation makes none, bad input never throws', (t) => {
  const dir = tmp(t);
  const home = tmp(t);
  const run = (input) => spawnSync(process.execPath, [SCRIPT], {
    input, encoding: 'utf8', windowsHide: true, env: { ...process.env, HARBOR_CONTEXT_DIR: dir, USERPROFILE: home },
  });
  const first = run(JSON.stringify(payload({ conversation_id: '' })));
  assert.equal(first.status, 0);
  assert.deepEqual(fs.readdirSync(dir), [], 'no conversation yet: nothing written');
  const second = run(JSON.stringify(payload({ agent_state: 'working' })));
  assert.equal(second.status, 0);
  assert.match(second.stdout, /^esc to cancel/);
  const record = JSON.parse(fs.readFileSync(path.join(dir, `gemini-${ID}.json`), 'utf8'));
  assert.equal(record.agent_state, 'working');
  assert.equal(record.home, home, 'the profile is the USERPROFILE agy ran under, which the tee inherits');
  const broken = run('{not json');
  assert.equal(broken.status, 0, 'a failure never draws agy\'s Statusline Error banner');
  assert.equal(run('').status, 0);
});
