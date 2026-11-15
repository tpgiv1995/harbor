'use strict';
// A SESSION BELONGS TO THE HOME IT RAN IN MOST RECENTLY (2026-11-15). The home
// map scored a session by how many traces each home held, so a session that
// moved plans stayed on the plan where it had more prompts: Vox ran on work
// for seven hours, was relaunched on personal, and the rail badge said S for
// five more hours while every turn billed personal. The same map answers
// `meta.home`, which claude-sessions resumes an unattributed session on.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHistoryIndex } = require('../../src/main/providers/history-index.js');

const uuid = (n) => `${String(n).padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd`;
const HOUR = 3_600_000;

function fixture(t) {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'hb-home-recency-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const homes = ['work', 'personal'].map((id) => ({ id, configHome: path.join(tmp, `.claude-${id}`) }));
  for (const home of homes) fs.mkdirSync(path.join(home.configHome, 'session-env'), { recursive: true });
  const options = { projectsDir: path.join(tmp, 'projects'), cacheDir: path.join(tmp, 'cache'), profiles: homes, refreshFloorMs: 0, readOnly: true };
  fs.mkdirSync(options.projectsDir, { recursive: true });
  const prompt = (home, n, at) => fs.appendFileSync(path.join(home.configHome, 'history.jsonl'),
    `${JSON.stringify({ display: `prompt for ${n}`, ...(at == null ? {} : { timestamp: at }), sessionId: uuid(n) })}\n`);
  const started = (home, n, at = null) => {
    const folder = path.join(home.configHome, 'session-env', uuid(n));
    fs.mkdirSync(folder);
    if (at != null) fs.utimesSync(folder, new Date(at), new Date(at));
  };
  return { homes, options, prompt, started, fresh: () => createHistoryIndex(options).buildHomeMap() };
}

test('a session relaunched on another plan belongs to that plan, however many prompts the old one holds', (t) => {
  const { homes: [work, personal], options, prompt, started, fresh } = fixture(t);
  const incremental = createHistoryIndex(options);
  const base = Date.now() - 24 * HOUR;
  started(work, 1, base);
  for (let i = 0; i < 31; i += 1) prompt(work, 1, base + i * 60_000);
  assert.equal(incremental.buildHomeMap()[uuid(1)], 'work', 'one home, its own session');

  // Relaunched on personal: the session-env folder appears at startup, before
  // any prompt reaches personal's history.
  started(personal, 1);
  assert.equal(incremental.buildHomeMap()[uuid(1)], 'personal', 'the relaunch alone moves it');
  prompt(personal, 1, Date.now());
  assert.equal(incremental.buildHomeMap()[uuid(1)], 'personal', 'and its first prompt there keeps it there');
  assert.deepEqual(incremental.buildHomeMap(), fresh(), 'the incremental map agrees with a whole read');

  // Moved back to work: the folder already exists there, so the prompt says it.
  prompt(work, 1, Date.now() + 60_000);
  assert.equal(incremental.buildHomeMap()[uuid(1)], 'work', 'the latest prompt decides a return trip');
  assert.deepEqual(incremental.buildHomeMap(), fresh());
});

test('a later prompt outranks an earlier start, in either direction', (t) => {
  const { homes: [work, personal], prompt, started, fresh } = fixture(t);
  started(work, 2, Date.now() - 3 * HOUR);
  started(personal, 2, Date.now() - 3 * HOUR);
  prompt(personal, 2, Date.now() - 2 * HOUR);
  prompt(work, 2, Date.now() + HOUR);
  prompt(personal, 3, Date.now() + HOUR);
  prompt(work, 3, Date.now() - 2 * HOUR);
  prompt(work, 3, Date.now() - 2 * HOUR);
  const map = fresh();
  assert.equal(map[uuid(2)], 'work');
  assert.equal(map[uuid(3)], 'personal', 'two older prompts lose to one newer one');
});

test('with no times to compare, the most traces still win, and a tie is still no answer', (t) => {
  const { homes: [work, personal], prompt, fresh } = fixture(t);
  prompt(work, 4); prompt(work, 4); prompt(personal, 4);
  prompt(work, 5); prompt(personal, 5);
  const map = fresh();
  assert.equal(map[uuid(4)], 'work');
  assert.equal(Object.hasOwn(map, uuid(5)), false);
});
