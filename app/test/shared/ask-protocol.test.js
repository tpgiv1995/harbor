'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const proto = require('../../src/shared/ask-protocol.cjs');

test('hookOutputFor: answers and notes become the tool input; a decline becomes a deny with the reason', () => {
  const input = { questions: [{ question: 'Q?', header: 'H', multiSelect: false, options: [{ label: 'A', description: '' }] }] };
  const allow = proto.hookOutputFor(input, { answers: { 'Q?': 'A' }, annotations: { 'Q?': { notes: 'n' } } });
  assert.equal(allow.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(allow.hookSpecificOutput.permissionDecision, 'allow');
  assert.deepEqual(allow.hookSpecificOutput.updatedInput, { questions: input.questions, answers: { 'Q?': 'A' }, annotations: { 'Q?': { notes: 'n' } } });
  const noNotes = proto.hookOutputFor(input, { answers: { 'Q?': 'A' }, annotations: {} });
  assert.equal('annotations' in noNotes.hookSpecificOutput.updatedInput, false, 'empty annotations are not sent');
  const deny = proto.hookOutputFor(input, { decline: 'later' });
  assert.equal(deny.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(deny.hookSpecificOutput.permissionDecisionReason, 'later');
  assert.equal('updatedInput' in deny.hookSpecificOutput, false);
});

test('heartbeatFresh reads the file clock, and safeId never yields a path-unsafe name', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'hb-ask-proto-'));
  assert.equal(proto.heartbeatFresh(dir), false, 'absent = not alive');
  proto.writeJsonAtomic(proto.heartbeatPath(dir), { pid: 1, at: Date.now() });
  assert.equal(proto.heartbeatFresh(dir), true);
  const old = new Date(Date.now() - proto.HEARTBEAT_STALE_MS - 1000);
  fs.utimesSync(proto.heartbeatPath(dir), old, old);
  assert.equal(proto.heartbeatFresh(dir), false, 'stale = not alive');
  assert.equal(proto.safeId('toolu_01AB/../x'), 'toolu_01AB____x');
  assert.match(proto.safeId(''), /^ask-\d+$/);
});

test('defaultAskDir honours HARBOR_ASK_DIR and otherwise lives under ~/.harbor', () => {
  assert.equal(proto.defaultAskDir({ HARBOR_ASK_DIR: 'C:\\x\\asks' }), 'C:\\x\\asks');
  assert.equal(proto.defaultAskDir({}), path.join(os.homedir(), '.harbor', 'asks'));
});
