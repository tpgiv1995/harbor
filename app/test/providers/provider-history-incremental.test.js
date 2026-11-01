'use strict';

// A refresh after the first full walk re-checks only the logs the watchers
// reported (2026-11-01: every refresh walked about 6,400 codex and cursor
// logs, in the desktop and again in the phone server, while agents wrote).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createProviderHistory, mungeCwd } = require('../../src/main/providers/provider-history.js');

const IDS = {
  a: '019f8250-89cc-73d3-9c1a-30007bced9f1',
  b: '019f8250-89cc-73d3-9c1a-30007bced9f2',
  c: '019f8250-89cc-73d3-9c1a-30007bced9f3',
  cursor1: '4692b1ae-1af9-4147-879c-65c0b0b48ca1',
  cursor2: '4692b1ae-1af9-4147-879c-65c0b0b48ca2',
};

function rolloutText(id, prompt) {
  return [
    JSON.stringify({ timestamp: '2026-07-21T01:35:28.639Z', type: 'session_meta', payload: { session_id: id, cwd: '/home/user/dev/widget', originator: 'codex_exec' } }),
    JSON.stringify({ timestamp: '2026-07-21T01:35:30.000Z', type: 'event_msg', payload: { type: 'user_message', message: prompt } }),
  ].join('\n');
}

function cursorText(prompt) {
  return JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: `<user_query>\n${prompt}\n</user_query>` }] } });
}

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-history-inc-'));
  const codexRoot = path.join(dir, 'codex-home', 'sessions');
  const cursorRoot = path.join(dir, 'cursor-projects');
  const metadataFile = path.join(dir, 'provider-session-metadata.json');
  const day = path.join(codexRoot, '2026', '07', '21');
  await fs.mkdir(day, { recursive: true });
  const project = mungeCwd('/home/user/dev/widget');
  const rollout = (id) => path.join(day, `rollout-2026-07-21T01-35-28-${id}.jsonl`);
  const cursorFile = (id) => path.join(cursorRoot, project, 'agent-transcripts', id, `${id}.jsonl`);
  await fs.writeFile(rollout(IDS.a), rolloutText(IDS.a, 'First task.'));
  await fs.mkdir(path.dirname(cursorFile(IDS.cursor1)), { recursive: true });
  await fs.writeFile(cursorFile(IDS.cursor1), cursorText('Review the auth flow.'));
  return { dir, codexRoot, cursorRoot, metadataFile, day, project, rollout, cursorFile };
}

// Captures each watcher's listener so a test can report events by hand.
function fakeWatchers({ refuse = [] } = {}) {
  const listeners = new Map();
  const factory = (dir, _opts, listener) => {
    if (refuse.includes(dir)) throw new Error(`cannot watch ${dir}`);
    listeners.set(dir, listener);
    return { on() {}, close() {} };
  };
  const report = (dir, relative) => listeners.get(dir)('rename', relative);
  return { factory, report };
}

const options = (f, watchFactory) => ({
  codexRoot: f.codexRoot,
  cursorRoot: f.cursorRoot,
  metadataFile: f.metadataFile,
  debounceMs: 60_000,
  projectLabelForCwd: (cwd) => (cwd ? cwd.split('/').pop() : null),
  ...(watchFactory ? { watchFactory } : {}),
});

const KNOWN = ['/home/user/dev/widget'];

async function fullListing(f) {
  return createProviderHistory(options(f)).listSessions({ knownCwds: KNOWN });
}

test('after the first walk, a refresh with nothing reported reads no log', async (t) => {
  const f = await fixture();
  const w = fakeWatchers();
  const history = createProviderHistory(options(f, w.factory));
  history.start();
  t.after(() => history.close());
  const first = await history.listSessions({ knownCwds: KNOWN });
  assert.equal(first.length, 2);
  const stat = t.mock.method(fs, 'stat');
  const second = await history.listSessions({ knownCwds: KNOWN });
  const statted = stat.mock.calls.map((call) => String(call.arguments[0]));
  assert.deepStrictEqual(statted.filter((file) => !file.endsWith('session_index.jsonl')), [], 'only the title index is checked');
  assert.deepStrictEqual(second, first);
});

test('reported new, changed and deleted logs list exactly as a fresh full walk does', async (t) => {
  const f = await fixture();
  const w = fakeWatchers();
  const history = createProviderHistory(options(f, w.factory));
  history.start();
  t.after(() => history.close());
  await history.listSessions({ knownCwds: KNOWN });

  const rel = (file, root) => path.relative(root, file);
  await fs.writeFile(f.rollout(IDS.b), rolloutText(IDS.b, 'Second task.'));
  w.report(f.codexRoot, rel(f.rollout(IDS.b), f.codexRoot));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await fs.appendFile(f.rollout(IDS.a), `\n${JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'done' } })}`);
  w.report(f.codexRoot, rel(f.rollout(IDS.a), f.codexRoot));
  await fs.rm(path.dirname(f.cursorFile(IDS.cursor1)), { recursive: true });
  w.report(f.cursorRoot, rel(f.cursorFile(IDS.cursor1), f.cursorRoot));
  await fs.mkdir(path.dirname(f.cursorFile(IDS.cursor2)), { recursive: true });
  await fs.writeFile(f.cursorFile(IDS.cursor2), cursorText('Add the export button.'));
  w.report(f.cursorRoot, rel(f.cursorFile(IDS.cursor2), f.cursorRoot));
  w.report(f.cursorRoot, path.join(f.project, 'worker.log')); // churn: lists nothing

  const incremental = await history.listSessions({ knownCwds: KNOWN });
  assert.deepStrictEqual(incremental, await fullListing(f));
  assert.deepStrictEqual(incremental.map((row) => row.id).sort(), [IDS.a, IDS.b, IDS.cursor2].sort());
});

test('an unreported log stays unseen until a nameless event forces a full walk', async (t) => {
  const f = await fixture();
  const w = fakeWatchers();
  const history = createProviderHistory(options(f, w.factory));
  history.start();
  t.after(() => history.close());
  await history.listSessions({ knownCwds: KNOWN });
  await fs.writeFile(f.rollout(IDS.c), rolloutText(IDS.c, 'Third task.'));
  const before = await history.listSessions({ knownCwds: KNOWN });
  assert.ok(!before.some((row) => row.id === IDS.c), 'incremental mode really skips unreported files');
  w.report(f.codexRoot, null);
  const after = await history.listSessions({ knownCwds: KNOWN });
  assert.ok(after.some((row) => row.id === IDS.c));
  assert.deepStrictEqual(after, await fullListing(f));
});

test('a new day folder forces a full walk', async (t) => {
  const f = await fixture();
  const w = fakeWatchers();
  const history = createProviderHistory(options(f, w.factory));
  history.start();
  t.after(() => history.close());
  await history.listSessions({ knownCwds: KNOWN });
  const nextDay = path.join(f.codexRoot, '2026', '07', '22');
  await fs.mkdir(nextDay, { recursive: true });
  await fs.writeFile(path.join(nextDay, `rollout-2026-07-22T01-00-00-${IDS.c}.jsonl`), rolloutText(IDS.c, 'Next day.'));
  w.report(f.codexRoot, path.join('2026', '07', '22'));
  const rows = await history.listSessions({ knownCwds: KNOWN });
  assert.ok(rows.some((row) => row.id === IDS.c));
});

test('a root that cannot be watched keeps every refresh a full walk', async (t) => {
  const f = await fixture();
  const w = fakeWatchers({ refuse: [f.cursorRoot] });
  const history = createProviderHistory(options(f, w.factory));
  history.start();
  t.after(() => history.close());
  await history.listSessions({ knownCwds: KNOWN });
  await fs.mkdir(path.dirname(f.cursorFile(IDS.cursor2)), { recursive: true });
  await fs.writeFile(f.cursorFile(IDS.cursor2), cursorText('Unwatched root.'));
  const rows = await history.listSessions({ knownCwds: KNOWN });
  assert.ok(rows.some((row) => row.id === IDS.cursor2));
});

test('without started watchers every listing is a full walk (tests and one-shot callers)', async () => {
  const f = await fixture();
  const history = createProviderHistory(options(f));
  await history.listSessions({ knownCwds: KNOWN });
  await fs.writeFile(f.rollout(IDS.c), rolloutText(IDS.c, 'One-shot.'));
  const rows = await history.listSessions({ knownCwds: KNOWN });
  assert.ok(rows.some((row) => row.id === IDS.c));
});
