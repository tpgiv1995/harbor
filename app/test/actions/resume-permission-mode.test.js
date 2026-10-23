'use strict';

// A resumed session comes back in the permission mode it was left in
// (bin/harbor-bin.cjs, resumeArgv). Every resume used to pass
// --dangerously-skip-permissions, so a session left in plan, manual or
// accept-edits came back in bypass.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.HARBOR_CLAUDE_BIN = 'claude';
process.env.HARBOR_CONFIG_FILE = path.join(os.tmpdir(), 'harbor-resume-mode-missing-config.json');
const { lastPermissionMode, resumeArgv } = require('../../../bin/harbor-bin.cjs');

const line = (obj) => `${JSON.stringify(obj)}\n`;

function transcript(t, rows, extra = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-resume-mode-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'chat.jsonl');
  fs.writeFileSync(file, rows.map(line).join('') + extra);
  return file;
}

test('the newest permission-mode record or user stamp is the mode', (t) => {
  assert.equal(lastPermissionMode(transcript(t, [
    { type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId: 's' },
    { type: 'user', permissionMode: 'bypassPermissions', message: { role: 'user', content: 'plan this' } },
    { type: 'permission-mode', permissionMode: 'plan', sessionId: 's' },
    { type: 'assistant', message: { role: 'assistant', content: [] } },
  ])), 'plan');
  // A `claude -p` run writes no permission-mode record, only the stamp.
  assert.equal(lastPermissionMode(transcript(t, [
    { type: 'queue-operation', operation: 'enqueue' },
    { type: 'user', permissionMode: 'acceptEdits', message: { role: 'user', content: 'ok?' } },
    { type: 'api-request', sessionId: 's' },
    { type: 'assistant', message: { role: 'assistant', content: [] } },
  ])), 'acceptEdits');
});

test('text or a nested key that merely mentions the field is not a mode', (t) => {
  assert.equal(lastPermissionMode(transcript(t, [
    { type: 'permission-mode', permissionMode: 'default', sessionId: 's' },
    { type: 'user', message: { role: 'user', content: 'set "permissionMode":"plan" in the config' } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] }, toolUseResult: { permissionMode: 'plan' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '{"type":"permission-mode","permissionMode":"plan"}' }] } },
  ], '{"type":"permission-mode","permissionMode":"pl')), 'default');
});

test('the read is bounded: a mode older than the tail window is not found', (t) => {
  const filler = line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(64 * 1024) }] } });
  const file = transcript(t, [{ type: 'permission-mode', permissionMode: 'plan', sessionId: 's' }], filler.repeat(Math.ceil((17 * 1024 * 1024) / filler.length)));
  assert.equal(lastPermissionMode(file), null);
  fs.appendFileSync(file, line({ type: 'permission-mode', permissionMode: 'auto', sessionId: 's' }) + filler.repeat(40));
  assert.equal(lastPermissionMode(file), 'auto', 'found past a window that had to grow');
});

test('no record, or no file, means the launch default', (t) => {
  assert.equal(lastPermissionMode(transcript(t, [{ type: 'user', message: { role: 'user', content: 'hi' } }])), null);
  assert.equal(lastPermissionMode(path.join(os.tmpdir(), 'harbor-no-such-transcript.jsonl')), null);
});

test('every mode the CLI names is carried over; bypass, none and unknown words resume as before', () => {
  for (const mode of ['default', 'manual', 'acceptEdits', 'plan', 'auto', 'dontAsk']) {
    assert.deepEqual(resumeArgv('S', null, mode).slice(1),
      ['--permission-mode', mode, '--allow-dangerously-skip-permissions', '--resume', 'S'], mode);
  }
  for (const mode of [null, 'bypassPermissions', 'somethingNew', '--print']) {
    assert.deepEqual(resumeArgv('S', null, mode).slice(1), ['--dangerously-skip-permissions', '--resume', 'S'], String(mode));
  }
  assert.deepEqual(resumeArgv('S', 'hello', 'plan').slice(1),
    ['--permission-mode', 'plan', '--allow-dangerously-skip-permissions', '--resume', 'S', 'hello']);
  assert.deepEqual(resumeArgv('S', 'hello').slice(1), ['--dangerously-skip-permissions', '--resume', 'S', 'hello']);
});
