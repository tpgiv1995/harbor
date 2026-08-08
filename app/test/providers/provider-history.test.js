'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createProviderHistory, formatLocal, mungeCwd } = require('../../src/main/providers/provider-history.js');

const CODEX_ID = '019f8250-89cc-73d3-9c1a-30007bced9ff';
const CURSOR_ID = '4692b1ae-1af9-4147-879c-65c0b0b48ca2';

async function buildFixtureRoots() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-history-'));
  const codexRoot = path.join(dir, 'codex-sessions');
  const cursorRoot = path.join(dir, 'cursor-projects');

  // Codex rollout in the dated layout, session_meta first (real shape).
  const codexDay = path.join(codexRoot, '2026', '07', '21');
  await fs.mkdir(codexDay, { recursive: true });
  const rollout = [
    JSON.stringify({ timestamp: '2026-07-21T01:35:28.639Z', type: 'session_meta', payload: { session_id: CODEX_ID, cwd: '/home/user/dev/widget', originator: 'codex_exec' } }),
    JSON.stringify({ timestamp: '2026-07-21T01:35:29.000Z', type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }),
    JSON.stringify({ timestamp: '2026-07-21T01:35:30.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Fix the flaky widget test.' } }),
  ].join('\n');
  await fs.writeFile(path.join(codexDay, `rollout-2026-07-21T01-35-28-${CODEX_ID}.jsonl`), rollout);

  // Cursor transcript in the munged-project layout.
  const munged = mungeCwd('/home/user/dev/widget');
  const cursorDir = path.join(cursorRoot, munged, 'agent-transcripts', CURSOR_ID);
  await fs.mkdir(cursorDir, { recursive: true });
  const cursorLines = [
    JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<timestamp>x</timestamp>\n<user_query>\nReview the widget auth flow.\n</user_query>' }] } }),
    JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'Looking now.' }] } }),
  ].join('\n');
  await fs.writeFile(path.join(cursorDir, `${CURSOR_ID}.jsonl`), cursorLines);

  // Noise that must not become rows: a non-uuid dir, a non-rollout file.
  await fs.mkdir(path.join(cursorRoot, munged, 'agent-transcripts', 'not-a-uuid'), { recursive: true });
  await fs.writeFile(path.join(codexDay, 'notes.txt'), 'not a rollout');

  return { dir, codexRoot, cursorRoot };
}

test('lists codex and cursor sessions in harbor-index row shape', async () => {
  const { dir, codexRoot, cursorRoot } = await buildFixtureRoots();
  const providerHistory = createProviderHistory({
    codexRoot,
    cursorRoot,
    projectLabelForCwd: (cwd) => (cwd ? cwd.split('/').pop() : null),
  });

  const rows = await providerHistory.listSessions({ knownCwds: ['/home/user/dev/widget'] });
  assert.equal(rows.length, 2);

  const codex = rows.find((r) => r.provider === 'codex');
  assert.equal(codex.id, CODEX_ID);
  assert.equal(codex.cwd, '/home/user/dev/widget', 'cwd from session_meta');
  assert.equal(codex.project, 'widget');
  assert.equal(codex.title, 'Fix the flaky widget test.');
  assert.match(codex.lastActive, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, 'harbor-index local format');

  const cursor = rows.find((r) => r.provider === 'cursor');
  assert.equal(cursor.id, CURSOR_ID);
  assert.equal(cursor.cwd, '/home/user/dev/widget', 'cwd unmunged from knownCwds');
  assert.equal(cursor.project, 'widget');
  assert.equal(cursor.title, 'Review the widget auth flow.', 'user_query framing stripped by the real parser');

  // metaFor: the transcript-open resolver.
  assert.deepEqual(providerHistory.metaFor(CODEX_ID), {
    provider: 'codex',
    cwd: '/home/user/dev/widget',
    path: path.join(codexRoot, '2026', '07', '21', `rollout-2026-07-21T01-35-28-${CODEX_ID}.jsonl`),
  });
  assert.equal(providerHistory.metaFor('unknown-id'), null);

  await fs.rm(dir, { recursive: true, force: true });
});

test('an unmatchable cursor project still lists, labeled by its munged dir, cwd null', async () => {
  const { dir, codexRoot, cursorRoot } = await buildFixtureRoots();
  const providerHistory = createProviderHistory({ codexRoot, cursorRoot });
  const rows = await providerHistory.listSessions({ knownCwds: [] });
  const cursor = rows.find((r) => r.provider === 'cursor');
  assert.equal(cursor.cwd, null, 'never a guessed cwd');
  assert.equal(cursor.project, 'home-user-dev-widget', 'honest munged label');
  await fs.rm(dir, { recursive: true, force: true });
});

test('missing provider roots produce empty lists, not errors', async () => {
  const providerHistory = createProviderHistory({
    codexRoot: '/nonexistent/codex',
    cursorRoot: '/nonexistent/cursor',
  });
  assert.deepEqual(await providerHistory.listSessions({}), []);
});

test('formatLocal round-trips through the sidebar date parser', () => {
  const { parseLocalDateTime } = require('../../src/shared/date-roll.cjs');
  const now = Date.now();
  const parsed = parseLocalDateTime(formatLocal(now));
  assert.ok(Math.abs(parsed.getTime() - now) < 61_000, 'minute precision');
});
