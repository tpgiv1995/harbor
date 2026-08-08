'use strict';

// Herdr never reports a session id for a codex/cursor pane (live-verified
// 2026-07-25 against the running daemon), which is why those windows had no
// transcript and fell back to the raw terminal. These tests pin the evidence
// rules that name the session instead: argv first, then a session born inside
// the pane's process lifetime in the pane's own cwd, and NO link at all when
// the evidence is ambiguous.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createProviderSessionLinker,
  readCodexHistory,
  readCodexRolloutCwd,
  findCodexRollout,
  assignSessionsToPanes,
  sessionIdFromArgv,
} = require('../../src/main/providers/provider-session-link.js');

const ID_A = '019f8250-4ced-7231-a58e-92665a187bd7';
// Real clocks, minutes apart: the assignment allows a few seconds of skew
// between codex's whole-second stamps and a /proc start time, so fixtures
// spaced by milliseconds would all read as simultaneous.
const T0 = Date.parse('2026-07-25T16:00:00Z');
const MIN = 60_000;
const ID_B = '019f9b1d-02bc-7161-adf5-4aa5930b1621';

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-link-'));
  fs.mkdirSync(path.join(home, '.codex', 'sessions', '2026', '07', '25'), { recursive: true });
  return home;
}

function writeRollout(home, { id, cwd, day = '25', stamp = '2026-07-25T16-09-57', payloadExtra = null }) {
  const dir = path.join(home, '.codex', 'sessions', '2026', '07', day);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${stamp}-${id}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({
    timestamp: '2026-07-25T21:09:57.000Z',
    type: 'session_meta',
    payload: { session_id: id, cwd, originator: 'codex_tui', ...(payloadExtra || {}) },
  })}\n`);
  return file;
}

function writeHistory(home, rows) {
  fs.writeFileSync(
    path.join(home, '.codex', 'history.jsonl'),
    rows.map((row) => `${JSON.stringify(row)}\n`).join(''),
  );
}

test('a resumed pane names its own session in argv; a fresh launch names none', () => {
  assert.equal(sessionIdFromArgv([
    'codex', 'resume', '--dangerously-bypass-approvals-and-sandbox', ID_A,
  ]), ID_A);
  assert.equal(sessionIdFromArgv([
    'cursor-agent', '--force', '--resume', ID_B,
  ]), ID_B);
  assert.equal(sessionIdFromArgv([
    'codex', '--dangerously-bypass-approvals-and-sandbox', '--model', 'gpt-5.6-sol',
    '-c', 'model_reasoning_effort=high',
  ]), null);
});

test('codex history yields each session first prompt time and its recent texts', async () => {
  const home = makeHome();
  writeHistory(home, [
    { session_id: ID_A, ts: 1000, text: 'first prompt in A' },
    { session_id: ID_A, ts: 1200, text: 'second prompt in A' },
    { session_id: ID_B, ts: 1100, text: 'only prompt in B' },
    { ts: 1300, text: 'no session id' },
  ]);
  // A torn or non-JSON line is skipped, never fatal.
  fs.appendFileSync(path.join(home, '.codex', 'history.jsonl'), 'not json at all\n');

  const sessions = await readCodexHistory(path.join(home, '.codex', 'history.jsonl'));
  assert.equal(sessions.get(ID_A).startedMs, 1000 * 1000);
  assert.deepEqual(sessions.get(ID_A).texts, ['first prompt in A', 'second prompt in A']);
  assert.equal(sessions.get(ID_B).startedMs, 1100 * 1000);
  assert.equal(sessions.size, 2);
});

test('a rollout is found by id and reports its own cwd', async () => {
  const home = makeHome();
  writeRollout(home, { id: ID_A, cwd: '/home/you/dev/harbor' });
  const found = await findCodexRollout(ID_A, { home });
  assert.ok(found?.endsWith(`${ID_A}.jsonl`));
  assert.equal(await readCodexRolloutCwd(found), '/home/you/dev/harbor');
  assert.equal(await findCodexRollout(ID_B, { home }), null);
});

test('a session_meta line larger than any fixed head read still yields its cwd', async () => {
  // Codex 0.147.0 ships the entire system prompt inside session_meta
  // (payload.base_instructions.text), and a real rollout's first line measured
  // 18,139 bytes on 2026-08-08. The old reader took one 8KB read, parsed the
  // truncated line, and answered null for EVERY rollout on that version, which
  // unlinked every codex pane from its session. The fixture mirrors the real
  // shape at the real size.
  const home = makeHome();
  writeRollout(home, {
    id: ID_A,
    cwd: '/home/you/dev/harbor',
    payloadExtra: { base_instructions: { text: 'You are Codex. '.repeat(1300) } },
  });
  const found = await findCodexRollout(ID_A, { home });
  assert.equal(await readCodexRolloutCwd(found), '/home/you/dev/harbor');
});

test('a session that began before the pane process existed is never linked to it', async () => {
  const panes = [{ paneId: 'w2:p2', cwd: '/work', startedMs: T0 + 5 * MIN }];
  const links = await assignSessionsToPanes(panes, [
    { id: ID_A, cwd: '/work', startedMs: T0 + 1 * MIN, texts: ['old'] },
  ]);
  assert.equal(links.size, 0);
});

test('the pane whose process started last before the session owns it', async () => {
  const panes = [
    { paneId: 'w1:p1', cwd: '/work', startedMs: T0 + 1 * MIN },
    { paneId: 'w2:p2', cwd: '/work', startedMs: T0 + 4 * MIN },
    { paneId: 'w3:p1', cwd: '/other', startedMs: T0 + 5 * MIN },
  ];
  const links = await assignSessionsToPanes(panes, [
    { id: ID_A, cwd: '/work', startedMs: T0 + 9 * MIN, texts: [] },
  ], { readPaneText: async () => '' });
  // Both /work panes predate the session, so the tie must be broken by the
  // screen; with nothing on either screen there is no link at all.
  assert.equal(links.size, 0);

  const single = await assignSessionsToPanes(
    [panes[0], panes[2]],
    [{ id: ID_A, cwd: '/work', startedMs: T0 + 9 * MIN, texts: [] }],
  );
  assert.deepEqual([...single], [['w1:p1', ID_A]]);
});

test('two panes in one folder: the screen showing the prompt breaks the tie', async () => {
  const panes = [
    { paneId: 'w1:p1', cwd: '/work', startedMs: T0 + 1 * MIN },
    { paneId: 'w2:p2', cwd: '/work', startedMs: T0 + 4 * MIN },
  ];
  const links = await assignSessionsToPanes(panes, [
    { id: ID_A, cwd: '/work', startedMs: T0 + 9 * MIN, texts: ['refactor the parser module'] },
  ], {
    readPaneText: async (paneId) => (paneId === 'w1:p1'
      ? '› Refactor the parser  module\n  working…'
      : '› something else entirely'),
  });
  assert.deepEqual([...links], [['w1:p1', ID_A]]);
});

test('a pane that ran several sessions ends on its most recent one', async () => {
  const panes = [{ paneId: 'w2:p2', cwd: '/work', startedMs: T0 + 1 * MIN }];
  const links = await assignSessionsToPanes(panes, [
    { id: ID_B, cwd: '/work', startedMs: T0 + 8 * MIN, texts: [] },
    { id: ID_A, cwd: '/work', startedMs: T0 + 2 * MIN, texts: [] },
  ]);
  assert.deepEqual([...links], [['w2:p2', ID_B]]);
});

test('a live codex pane is named from history + rollout, stamped onto the pane, and dropped when the pane goes', async () => {
  const home = makeHome();
  const cwd = '/home/you/dev/harbor';
  writeRollout(home, { id: ID_A, cwd });
  // A delegate worker in the SAME folder must never be mistaken for the pane's
  // session: `codex exec` writes a rollout but never a history line.
  writeRollout(home, { id: ID_B, cwd });
  writeHistory(home, [{ session_id: ID_A, ts: (T0 + 2 * MIN) / 1000, text: 'hello from the pane' }]);

  let panes = [{
    pane_id: 'w2:p2', workspace_id: 'w2', agent: 'codex', agent_session: null, cwd,
  }];
  const linked = [];
  const linker = createProviderSessionLinker({
    home,
    listPanes: () => panes,
    paneAgentProcess: async () => ({
      pid: 4242, startedMs: T0 + 1 * MIN, cwd, argv: ['codex', '--model', 'gpt-5.6-sol'],
    }),
  });
  linker.emitter.on('link', (link) => linked.push(link));

  assert.equal(await linker.resolveNow(), true);
  assert.deepEqual(linked.map((l) => [l.paneId, l.sessionId]), [['w2:p2', ID_A]]);
  assert.equal(linker.get('w2:p2'), ID_A);
  const stamped = linker.apply(panes);
  assert.deepEqual(stamped[0].agent_session, {
    agent: 'codex', kind: 'id', source: 'harbor:provider-link', value: ID_A,
  });
  // Idempotent: a second pass reports no change and no second link event.
  assert.equal(await linker.resolveNow(), false);
  assert.equal(linked.length, 1);

  panes = [];
  assert.equal(await linker.resolveNow(), true);
  assert.equal(linker.get('w2:p2'), null);
  linker.close();
});

test('a resumed codex pane links from argv with no history evidence at all', async () => {
  const home = makeHome();
  const linker = createProviderSessionLinker({
    home,
    listPanes: () => [{
      pane_id: 'w4:p1', workspace_id: 'w4', agent: 'codex', agent_session: null, cwd: '/work',
    }],
    paneAgentProcess: async () => ({
      pid: 99, startedMs: T0, cwd: '/work', argv: ['codex', 'resume', ID_B],
    }),
  });
  assert.equal(await linker.resolveNow(), true);
  assert.equal(linker.get('w4:p1'), ID_B);
  linker.close();
});

test('a pane herdr already named is left alone, and claude panes are never touched', async () => {
  const home = makeHome();
  const linker = createProviderSessionLinker({
    home,
    listPanes: () => [
      {
        pane_id: 'w1:p1',
        agent: 'claude',
        agent_session: { kind: 'id', value: 'claude-1' },
        cwd: '/work',
      },
      {
        pane_id: 'w2:p2',
        agent: 'codex',
        agent_session: { kind: 'id', value: ID_A },
        cwd: '/work',
      },
    ],
    paneAgentProcess: async () => { throw new Error('should not be asked'); },
  });
  assert.equal(await linker.resolveNow(), false);
  assert.deepEqual(linker.all(), {});
  linker.close();
});
