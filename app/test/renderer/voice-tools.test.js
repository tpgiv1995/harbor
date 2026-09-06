'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TOOL_DEFS,
  TOOL_NAMES,
  dispatchVoiceTool,
  resolveSessionRef,
  clampLimit,
} = require('../../src/renderer/voice/voice-tools.cjs');

const SESSIONS = [
  { id: 'aaa-1', project: 'harbor', title: 'Review and fix harbor feedback', state: 'working' },
  { id: 'bbb-2', project: 'example-app', title: 'Resuming CDT App Development', state: 'ready' },
  { id: 'ccc-3', project: 'Notes/Wiki', title: 'Extract voice patterns', state: 'ready' },
];

const deps = (over = {}) => ({
  listSessions: async () => SESSIONS,
  readSession: async (id, limit) => [`last ${limit} from ${id}`],
  sendToSession: async () => ({ ok: true }),
  interruptSession: async () => ({ ok: true }),
  selectSession: async () => {},
  ...over,
});

test('the tool surface is exactly the five safe actions', () => {
  // Deliberately absent: closing windows, killing processes, launching sessions,
  // answering permission dialogs. A misheard word must not be able to destroy
  // work, and each of those has a keyboard-only path already.
  assert.deepEqual(TOOL_NAMES, [
    'harbor_list_sessions',
    'harbor_read_session',
    'harbor_send_to_session',
    'harbor_interrupt_session',
    'harbor_select_session',
  ]);
  for (const tool of TOOL_DEFS) {
    assert.equal(tool.type, 'function');
    assert.equal(tool.parameters.additionalProperties, false, `${tool.name} rejects stray args`);
  }
});

test('an unknown tool is reported, not thrown', async () => {
  assert.deepEqual(await dispatchVoiceTool('harbor_rm_rf', {}, deps()), { error: 'unknown tool harbor_rm_rf' });
});

test('listing sessions passes them through, and says so when none are open', async () => {
  assert.deepEqual((await dispatchVoiceTool('harbor_list_sessions', {}, deps())).sessions, SESSIONS);
  const empty = await dispatchVoiceTool('harbor_list_sessions', {}, deps({ listSessions: async () => [] }));
  assert.deepEqual(empty, { sessions: [], note: 'no session windows are open' });
});

test('a session resolves by id, by project, and by title', () => {
  assert.equal(resolveSessionRef('bbb-2', SESSIONS).session.id, 'bbb-2');
  assert.equal(resolveSessionRef('example-app', SESSIONS).session.id, 'bbb-2');
  assert.equal(resolveSessionRef('Extract voice patterns', SESSIONS).session.id, 'ccc-3');
  assert.equal(resolveSessionRef('  HARBOR  ', SESSIONS).session.id, 'aaa-1', 'case and padding do not matter');
});

test('a partial spoken reference resolves', () => {
  // "tell the harbor one to push" is how he will actually say it.
  assert.equal(resolveSessionRef('harbor feedback', SESSIONS).session.id, 'aaa-1');
  assert.equal(resolveSessionRef('notes', SESSIONS).session.id, 'ccc-3');
});

test('an ambiguous reference is an ERROR with candidates, never a coin flip', async () => {
  // Typing Pat's instruction into the wrong agent costs him real work, so the
  // agent is made to ask instead of guess.
  const two = [
    { id: 'x', project: 'harbor', title: 'one thing', state: 'ready' },
    { id: 'y', project: 'harbor', title: 'another thing', state: 'ready' },
  ];
  const out = resolveSessionRef('harbor', two);
  assert.match(out.error, /matches 2 open sessions/);
  assert.deepEqual(out.candidates.map((c) => c.id), ['x', 'y']);
  assert.equal(out.session, undefined);

  const sent = await dispatchVoiceTool('harbor_send_to_session',
    { session: 'harbor', text: 'go' }, deps({ listSessions: async () => two }));
  assert.match(sent.error, /ask which one/);
  assert.equal(sent.sent, undefined, 'nothing was sent');
});

test('an unmatched reference lists what IS open so the agent can recover', async () => {
  const out = await dispatchVoiceTool('harbor_send_to_session',
    { session: 'the example one', text: 'go' }, deps());
  assert.match(out.error, /no open session matches/);
  assert.deepEqual(out.open.map((s) => s.id), ['aaa-1', 'bbb-2', 'ccc-3']);
});

test('a send delivers the text verbatim to the resolved session', async () => {
  const calls = [];
  const out = await dispatchVoiceTool('harbor_send_to_session',
    { session: 'example-app', text: 'push when the gate is green' },
    deps({ sendToSession: async (id, text) => { calls.push([id, text]); return { ok: true }; } }));
  assert.deepEqual(calls, [['bbb-2', 'push when the gate is green']]);
  assert.equal(out.sent, true);
  assert.equal(out.text, 'push when the gate is green');
});

test('a refused send reports the send path\'s OWN reason, verbatim', async () => {
  // The send path knows things the agent does not, e.g. that the session is
  // parked on a question it has to answer first. Repeating its words is what
  // keeps the spoken explanation true.
  const out = await dispatchVoiceTool('harbor_send_to_session',
    { session: 'harbor', text: 'go' },
    deps({ sendToSession: async () => ({ ok: false, reason: 'the session is asking a question in its window' }) }));
  assert.equal(out.sent, false);
  assert.equal(out.reason, 'the session is asking a question in its window');
});

test('an empty send is refused before it reaches the session', async () => {
  let called = false;
  const out = await dispatchVoiceTool('harbor_send_to_session',
    { session: 'harbor', text: '   ' }, deps({ sendToSession: async () => { called = true; return { ok: true }; } }));
  assert.deepEqual(out, { error: 'nothing to send' });
  assert.equal(called, false);
});

test('reading a session clamps the message count', async () => {
  const seen = [];
  const d = deps({ readSession: async (id, limit) => { seen.push(limit); return []; } });
  await dispatchVoiceTool('harbor_read_session', { session: 'harbor' }, d);
  await dispatchVoiceTool('harbor_read_session', { session: 'harbor', limit: 500 }, d);
  await dispatchVoiceTool('harbor_read_session', { session: 'harbor', limit: -2 }, d);
  assert.deepEqual(seen, [6, 20, 6]);
  assert.equal(clampLimit('9'), 9);
});

test('interrupt and select report honestly', async () => {
  assert.equal((await dispatchVoiceTool('harbor_interrupt_session', { session: 'harbor' }, deps())).interrupted, true);
  const failed = await dispatchVoiceTool('harbor_interrupt_session', { session: 'harbor' },
    deps({ interruptSession: async () => ({ ok: false, reason: 'no live pane to interrupt' }) }));
  assert.equal(failed.interrupted, false);
  assert.equal(failed.reason, 'no live pane to interrupt');

  let selected = null;
  await dispatchVoiceTool('harbor_select_session', { session: 'notes' },
    deps({ selectSession: async (id) => { selected = id; } }));
  assert.equal(selected, 'ccc-3');
});

test('a nameless session reference is refused', async () => {
  assert.match((await dispatchVoiceTool('harbor_read_session', {}, deps())).error, /no session was named/);
});
