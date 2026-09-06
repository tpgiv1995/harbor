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

test('cursor cwd recovery matches the run-collapsing munge Windows paths produce', async () => {
  // Cursor's real munge collapses every RUN of non-alphanumerics to one dash:
  // C:\dev\.orch\widget-lane -> C-dev-orch-widget-lane. Until 2026-08-23 the
  // unmunge map was keyed with Claude's per-character munge (C--dev--orch-...),
  // which no Windows cwd ever produces, so every cursor row on a Windows
  // machine listed with cwd null and its munged dir name as its project.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-history-'));
  const cursorRoot = path.join(dir, 'cursor-projects');
  const cursorDir = path.join(cursorRoot, 'C-dev-orch-widget-lane', 'agent-transcripts', CURSOR_ID);
  await fs.mkdir(cursorDir, { recursive: true });
  await fs.writeFile(
    path.join(cursorDir, `${CURSOR_ID}.jsonl`),
    JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'Port the lane.' }] } }),
  );

  const providerHistory = createProviderHistory({ codexRoot: path.join(dir, 'codex-sessions'), cursorRoot });
  const rows = await providerHistory.listSessions({ knownCwds: ['C:\\dev\\.orch\\widget-lane'] });
  const cursor = rows.find((r) => r.provider === 'cursor');
  assert.equal(cursor.cwd, 'C:\\dev\\.orch\\widget-lane', 'Windows cwd unmunged from knownCwds');

  assert.equal(mungeCwd('C:\\dev\\.orch\\widget-lane'), 'C-dev-orch-widget-lane');
  // A dotted username is the point of this fixture, not whose it is.
  assert.equal(mungeCwd('/home/ada.lovelace/dev/widget'), 'home-ada-lovelace-dev-widget');

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

test('configured Codex homes are all scanned and retain owning profile metadata', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-homes-'));
  const homes = [path.join(dir, 'codex-a'), path.join(dir, 'codex-b')];
  const ids = [CODEX_ID, '019f8250-89cc-73d3-9c1a-30007bced900'];
  for (let i = 0; i < homes.length; i += 1) {
    const day = path.join(homes[i], 'sessions', '2026', '08', String(29 + i));
    await fs.mkdir(day, { recursive: true });
    await fs.writeFile(path.join(day, `rollout-stamp-${ids[i]}.jsonl`), [
      JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: { cwd: `/work/${i}` } }),
      JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'user_message', message: `home ${i}` } }),
    ].join('\n'));
  }
  const history = createProviderHistory({
    homedir: dir,
    cursorRoot: path.join(dir, 'no-cursor'),
    metadataFile: path.join(dir, 'metadata.json'),
    profiles: homes.map((configHome, i) => ({ id: `codex-${i}`, provider: 'codex', configHome })),
  });
  const rows = await history.listSessions();
  assert.deepEqual(rows.map((row) => [row.id, row.profileId, row.configHome]), [
    [ids[0], 'codex-0', homes[0]],
    [ids[1], 'codex-1', homes[1]],
  ]);
  await fs.rm(dir, { recursive: true, force: true });
});

test('keeper-linked Cursor cwd survives provider-history reconstruction without asserting liveness', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-metadata-'));
  const cursorRoot = path.join(dir, 'cursor-projects');
  const transcript = path.join(cursorRoot, 'unrecoverable-project', 'agent-transcripts', CURSOR_ID, `${CURSOR_ID}.jsonl`);
  await fs.mkdir(path.dirname(transcript), { recursive: true });
  await fs.writeFile(transcript, JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'Remember cwd' }] } }));
  const options = { codexRoot: path.join(dir, 'no-codex'), cursorRoot, metadataFile: path.join(dir, 'metadata.json') };
  const first = createProviderHistory(options);
  await first.rememberKeeperIdentity({ id: CURSOR_ID, provider: 'cursor', cwd: 'C:\\dev\\durable-cursor' });
  const rebuilt = createProviderHistory(options);
  const row = (await rebuilt.listSessions({ knownCwds: [] }))[0];
  assert.equal(row.cwd, 'C:\\dev\\durable-cursor');
  assert.equal(Object.hasOwn(row, 'live'), false);
  assert.equal(Object.hasOwn(row, 'isLive'), false);
  await fs.rm(dir, { recursive: true, force: true });
});
