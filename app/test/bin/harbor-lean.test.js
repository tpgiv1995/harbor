'use strict';

// bin/harbor-lean is what a Claude session runs before it hands work to a GPT
// seat or to Cursor. The real script runs against a synthetic home: codex homes
// with rollouts carrying weekly rate limits, a pinned setting file, an empty
// Harbor config and (when a test wants one) a Cursor usage fixture, so nothing
// on the machine running the suite is read and Cursor is never called.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BIN = path.resolve(__dirname, '../../../bin/harbor-lean');

function home(t, seats) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'harbor-lean-bin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.now();
  for (const [name, usedPct] of Object.entries(seats)) {
    const day = path.join(root, name, 'sessions', '2026', '10', '05');
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(path.join(root, name, 'auth.json'), '{}');
    const event = { timestamp: new Date(now - 120000).toISOString(), type: 'event_msg', payload: { type: 'token_count', rate_limits: {
      limit_id: 'codex', primary: { used_percent: usedPct, window_minutes: 10080, resets_at: Math.floor(now / 1000) + 86400 },
    } } };
    fs.writeFileSync(path.join(day, 'rollout-2026-10-05T10-00-00-synthetic.jsonl'), `${JSON.stringify(event)}\n`);
  }
  fs.writeFileSync(path.join(root, 'config.json'), '{}');
  return root;
}

function run(root, extraEnv, args = []) {
  // Offline by default: the Cursor usage read is the one network call, and a
  // test must never reach Cursor with the developer's real sign-in.
  const env = { ...process.env, USERPROFILE: root, HOME: root, HARBOR_CONFIG_FILE: path.join(root, 'config.json'), HARBOR_NO_USAGE_FETCH: '1' };
  delete env.CODEX_HOME;
  delete env.HARBOR_PROVIDER_LEAN_FILE;
  delete env.HARBOR_PLAN_USAGE_FIXTURE;
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' });
}

// Cursor's monthly usage the way plan-usage.js would report it.
function cursorFixture(root, usedPct) {
  const file = path.join(root, `cursor-fixture-${usedPct}.json`);
  fs.writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), plans: [
    { provider: 'cursor', id: 'cursor:default', label: 'Cursor', windows: [{ kind: 'monthly', usedPct }] },
  ] }));
  return file;
}

test('unset setting: Balanced, and a capped seat keeps large general jobs on Claude', (t) => {
  const root = home(t, { '.codex': 100, '.codex-work': 62, '.codex-pro': 41 });
  const r = run(root, { HARBOR_PROVIDER_LEAN_FILE: path.join(root, 'missing.json') });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split(/\r?\n/);
  assert.equal(lines[0], "Heavy lifting: Balanced (default; never set in Harbor's plans menu)");
  assert.match(lines[1], /^GPT seats this week: /);
  for (const part of ['Default 100% (capped)', 'Work 62%', 'Pro 41%']) assert.ok(lines[1].includes(part), part);
  assert.equal(lines[2], 'Cursor this month: unknown (Online usage checks are disabled.)');
  assert.equal(lines[3], "Verdict: Image work: Pro (41% used this week). Simple mechanical work: Claude (Cursor's usage could not be read). Large general jobs: Claude (Default is capped). Everything else: Claude.");
  assert.equal(lines[4], 'Routing right now:');
  assert.match(r.stdout, /Image work \([^)]*\): GPT seat Pro, CODEX_HOME .*\.codex-pro/);
  assert.match(r.stdout, /Reviewing worker output \([^)]*\): Claude \(A different model catches mistakes the author misses\)/);
  assert.match(r.stdout, /Everything else \(coding, writing, planning, research, data work\): Claude \(Small and medium general work stays on Claude\)/);
});

test('mechanical work goes to Cursor while its month has room (Pat, 2026-10-05)', (t) => {
  const root = home(t, { '.codex': 100, '.codex-work': 62, '.codex-pro': 41 });
  const file = path.join(root, 'lean.json');
  fs.writeFileSync(file, JSON.stringify({ mode: 'lean-claude', updatedAt: new Date().toISOString() }));
  const roomy = run(root, { HARBOR_PROVIDER_LEAN_FILE: file, HARBOR_PLAN_USAGE_FIXTURE: cursorFixture(root, 3) }, ['--task', 'mechanical']);
  assert.equal(roomy.status, 0, roomy.stderr);
  // The local cursor-worker helper is named only where it exists on disk.
  assert.match(roomy.stdout, /^mechanical: Cursor\r?\nRun it (with node C:\/tools\/cursor-worker\/cursor-worker\.mjs, or put|by putting) HARBOR_LEAN_TASK=mechanical in front of the cursor-agent command\./);
  const report = run(root, { HARBOR_PROVIDER_LEAN_FILE: file, HARBOR_PLAN_USAGE_FIXTURE: cursorFixture(root, 3) });
  assert.match(report.stdout, /Cursor this month: 3%/);
  assert.match(report.stdout, /Simple mechanical work: Cursor \(3% used this month\)\./);
  // Heavily complex "mechanical" work is not fed to Cursor (Pat, 2026-10-05).
  const complex = run(root, { HARBOR_PROVIDER_LEAN_FILE: file, HARBOR_PLAN_USAGE_FIXTURE: cursorFixture(root, 3) }, ['--task', 'mechanical', '--complex']);
  assert.equal(complex.status, 0, complex.stderr);
  assert.equal(complex.stdout.trim(), 'mechanical (complex): Claude (Too complex for Cursor: the changes need judgement or a hard-to-check result. Heavy lifting leans Claude)');
  const full = JSON.parse(run(root, { HARBOR_PROVIDER_LEAN_FILE: file, HARBOR_PLAN_USAGE_FIXTURE: cursorFixture(root, 95) }, ['--task', 'mechanical', '--json']).stdout);
  assert.deepEqual([full.route.side, full.route.reason], ['claude', 'Cursor is at least 90% used this month. Heavy lifting leans Claude.']);
});

test('--task routes one task and names the tag the guard expects', (t) => {
  const root = home(t, { '.codex': 100, '.codex-work': 62, '.codex-pro': 41 });
  const file = path.join(root, 'lean.json');
  fs.writeFileSync(file, JSON.stringify({ mode: 'lean-claude', updatedAt: new Date().toISOString() }));
  const image = run(root, { HARBOR_PROVIDER_LEAN_FILE: file }, ['--task', 'image']);
  assert.equal(image.status, 0, image.stderr);
  assert.match(image.stdout, /^image: GPT seat Pro, CODEX_HOME .*\.codex-pro\r?\nLaunch it with HARBOR_LEAN_TASK=image/);
  const general = JSON.parse(run(root, { HARBOR_PROVIDER_LEAN_FILE: file }, ['--task', 'general', '--large', '--json']).stdout);
  assert.deepEqual([general.task, general.large, general.route.side, general.route.reason], ['general', true, 'claude', 'Heavy lifting leans Claude.']);
  const bad = run(root, { HARBOR_PROVIDER_LEAN_FILE: file }, ['--task', 'everything']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown task kind "everything"\. Kinds: image, mechanical, connected, review, general/);
  // The kinds dropped as merely good are no longer accepted.
  for (const gone of ['visual', 'writing', 'judgement']) assert.equal(run(root, { HARBOR_PROVIDER_LEAN_FILE: file }, ['--task', gone]).status, 2, gone);
});

test('a saved Lean OpenAI sends general work to the emptiest seat; --json carries the same facts', (t) => {
  const root = home(t, { '.codex': 100, '.codex-work': 62, '.codex-pro': 41 });
  const file = path.join(root, 'lean.json');
  fs.writeFileSync(file, JSON.stringify({ mode: 'lean-openai', updatedAt: new Date(Date.now() - 300000).toISOString() }));
  const text = run(root, { HARBOR_PROVIDER_LEAN_FILE: file });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^Heavy lifting: Lean OpenAI \(set 5m ago in Harbor's plans menu\)/);
  assert.match(text.stdout, /Everything else: Pro \(41% used this week\)\./);
  const json = JSON.parse(run(root, { HARBOR_PROVIDER_LEAN_FILE: file }, ['--json']).stdout);
  assert.equal(json.mode, 'lean-openai');
  assert.equal(json.saved, true);
  assert.equal(json.verdict.gpt, 'prefer');
  assert.equal(json.verdict.seat.label, 'Pro');
  assert.deepEqual(json.seats.map((s) => [s.label, s.weeklyPct]).sort(), [['Default', 100], ['Pro', 41], ['Work', 62]]);
  assert.deepEqual([json.cursor.label, json.cursor.monthlyPct], ['Cursor', null]);
});

test('Claude only needs no seats at all', (t) => {
  const root = home(t, {});
  const file = path.join(root, 'lean.json');
  fs.writeFileSync(file, JSON.stringify({ mode: 'claude-only', updatedAt: new Date().toISOString() }));
  const r = run(root, { HARBOR_PROVIDER_LEAN_FILE: file });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /GPT seats this week: none found/);
  assert.match(r.stdout, /Verdict: All work: Claude\./);
});
