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

test('unset setting: Balanced, which keeps general work on Claude', (t) => {
  const root = home(t, { '.codex': 100, '.codex-work': 62, '.codex-pro': 41 });
  const r = run(root, { HARBOR_PROVIDER_LEAN_FILE: path.join(root, 'missing.json') });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split(/\r?\n/);
  assert.equal(lines[0], "Heavy lifting: Balanced (default; never set in Harbor's plans menu)");
  assert.match(lines[1], /^GPT seats this week: /);
  for (const part of ['Default 100% (capped)', 'Work 62%', 'Pro 41%']) assert.ok(lines[1].includes(part), part);
  assert.equal(lines[2], 'Cursor this month: unknown (Online usage checks are disabled.)');
  assert.equal(lines[3], "Verdict: Image work: Pro (41% used this week). Simple mechanical work: Claude (Cursor's usage could not be read). Everything else: Claude.");
  assert.equal(lines[4], 'Routing right now:');
  assert.match(r.stdout, /Image work \([^)]*\): GPT seat Pro, CODEX_HOME .*\.codex-pro/);
  assert.match(r.stdout, /Reviewing worker output \([^)]*\): Claude \(A different model catches mistakes the author misses\)/);
  assert.match(r.stdout, /Everything else \(coding, writing, planning, research, data work\): Claude \(Balanced keeps general work on Claude, where it is best done\)/);
});

// 2026-10-18: a Harbor CLI review went to an Astra run because harbor-lean
// answered "GPT seat" for `--task general --large` under Balanced with a roomy
// seat. Pat: under Balanced, "pretty much all else goes to claude".
test('Balanced keeps a large general job on Claude even with a nearly empty GPT seat', (t) => {
  const root = home(t, { '.codex-work': 3 });
  const file = path.join(root, 'lean.json');
  fs.writeFileSync(file, JSON.stringify({ mode: 'balanced', updatedAt: new Date().toISOString() }));
  const r = run(root, { HARBOR_PROVIDER_LEAN_FILE: file }, ['--task', 'general', '--large']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'general (large): Claude (Balanced keeps general work on Claude, where it is best done)');
  const image = run(root, { HARBOR_PROVIDER_LEAN_FILE: file }, ['--task', 'image']);
  assert.match(image.stdout, /^image: GPT seat /);
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
  assert.match(bad.stderr, /unknown task kind "everything"\. Kinds: image, mechanical, build, connected, review, general/);
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

// The 2026-10-08 miss: Studio at 97% with a reset waiting, every other seat
// capped, and the session read "every GPT seat is at least 90% used" and kept
// the work on Claude. Seats now carry their reset credits.
test('a seat holding a reset is shown, flagged, and takes the work (2026-10-13)', (t) => {
  const root = home(t, {});
  const file = path.join(root, 'lean.json');
  fs.writeFileSync(file, JSON.stringify({ mode: 'lean-openai', updatedAt: new Date().toISOString() }));
  const fixture = path.join(root, 'plans.json');
  const updatedAt = new Date(Date.now() - 60000).toISOString();
  const codex = (label, usedPct, resets) => ({ provider: 'codex', id: `codex:${label}`, label, email: `${label.toLowerCase()}@example.com`,
    windows: [{ kind: 'weekly', usedPct, resetsAt: null }], resets, updatedAt, source: 'endpoint' });
  fs.writeFileSync(fixture, JSON.stringify({ generatedAt: updatedAt, plans: [
    codex('Default', 100, { available: 0, nextExpiresAt: null }),
    codex('Studio', 97, { available: 1, nextExpiresAt: Math.floor(Date.parse('2026-10-29T12:00:00Z') / 1000) }),
    codex('Work', 100, null),
  ] }));
  const r = run(root, { HARBOR_PROVIDER_LEAN_FILE: file, HARBOR_PLAN_USAGE_FIXTURE: fixture });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /GPT seats this week: Default 100% \(capped\), 0 resets, read 1m ago; Studio 97%, 1 reset waiting \(next expires Oct 29\), read 1m ago; Work 100% \(capped\), resets unknown, read 1m ago/);
  assert.match(r.stdout, /Reset waiting: Studio is 97% used and has 1 reset\. When it runs out, apply one with (node C:\/tools\/gpt-reset\/gpt-reset\.mjs apply --plan studio@example\.com|the plan's ChatGPT Settings, Usage page), before any of its work goes to Claude\./);
  assert.doesNotMatch(r.stdout, /Reset waiting: (Default|Work)/);
  assert.match(r.stdout, /Everything else: Studio \(97% used this week, 1 reset waiting\)\./);
  const task = run(root, { HARBOR_PROVIDER_LEAN_FILE: file, HARBOR_PLAN_USAGE_FIXTURE: fixture }, ['--task', 'general']);
  assert.match(task.stdout, /^general: GPT seat Studio \(Studio is 97% used but has 1 reset waiting; apply one when it runs out\)\r?\n/);
  const json = JSON.parse(run(root, { HARBOR_PROVIDER_LEAN_FILE: file, HARBOR_PLAN_USAGE_FIXTURE: fixture }, ['--json']).stdout);
  assert.deepEqual(json.seats.map((s) => [s.label, s.weeklyPct, s.resetsAvailable]), [['Default', 100, 0], ['Studio', 97, 1], ['Work', 100, null]]);
  assert.equal(json.seats[1].resetExpiresAt, '2026-10-29T12:00:00.000Z');
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

// A per-project Cursor route for test-backed builds (Pat, 2026-11-23). The
// project and its folders are synthetic and real folders under the test home,
// so `--project` and the current folder both resolve the way a session's would.
function projectHome(t, cursorPct) {
  const root = home(t, { '.codex-work': 62, '.codex-pro': 41 });
  const acme = path.join(root, 'work', 'acme');
  const slot = path.join(root, 'work', '.orch', 'acme', 'slot-3');
  const other = path.join(root, 'work', 'other');
  for (const dir of [path.join(acme, 'app'), slot, other]) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(root, 'lean.json');
  fs.writeFileSync(file, JSON.stringify({ mode: 'balanced', updatedAt: new Date().toISOString(), projects: [
    { id: 'acme', label: 'Acme App', build: 'cursor', enabled: true, folders: [acme, path.join(root, 'work', '.orch', 'acme', 'slot-*')] },
  ] }));
  const env = { HARBOR_PROVIDER_LEAN_FILE: file };
  if (cursorPct !== null) env.HARBOR_PLAN_USAGE_FIXTURE = cursorFixture(root, cursorPct);
  return { root, acme, slot, other, file, env };
}

test('build on an overridden project goes to Cursor, by --project or by the current folder', (t) => {
  const p = projectHome(t, 3);
  const named = run(p.root, p.env, ['--task', 'build', '--project', path.join(p.acme, 'app')]);
  assert.equal(named.status, 0, named.stderr);
  assert.match(named.stdout, /^build: Cursor \(Acme App sends test-backed builds to Cursor/);
  assert.match(named.stdout, /\r?\nRun it (with node C:\/tools\/cursor-worker\/cursor-worker\.mjs --task build|by putting HARBOR_LEAN_TASK=build in front of the cursor-agent command)/);
  const slot = JSON.parse(run(p.root, p.env, ['--task', 'build', '--project', p.slot, '--json']).stdout);
  assert.deepEqual([slot.task, slot.route.side, slot.route.project, slot.project.id, slot.project.enabled], ['build', 'cursor', 'acme', 'acme', true]);
  // No --project: the folder the session runs in.
  const here = spawnSync(process.execPath, [BIN, '--task', 'build'], { cwd: p.acme, encoding: 'utf8',
    env: { ...process.env, USERPROFILE: p.root, HOME: p.root, HARBOR_CONFIG_FILE: path.join(p.root, 'config.json'), HARBOR_NO_USAGE_FETCH: '1', ...p.env } });
  assert.equal(here.status, 0, here.stderr);
  assert.match(here.stdout, /^build: Cursor /);
});

test('build on a project without the override routes as general work', (t) => {
  const p = projectHome(t, 3);
  const r = run(p.root, p.env, ['--task', 'build', '--project', p.other]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'build: Claude (Balanced keeps general work on Claude, where it is best done)');
  const json = JSON.parse(run(p.root, p.env, ['--task', 'build', '--project', p.other, '--json']).stdout);
  assert.equal(json.project, null);
  // The same project switched off in the menu routes the same way.
  const saved = JSON.parse(fs.readFileSync(p.file, 'utf8'));
  saved.projects[0].enabled = false;
  fs.writeFileSync(p.file, JSON.stringify(saved));
  assert.equal(run(p.root, p.env, ['--task', 'build', '--project', p.acme]).stdout.trim(), 'build: Claude (Balanced keeps general work on Claude, where it is best done)');
});

test('build on an overridden project with Cursor at 95% stays off Cursor, and says why', (t) => {
  const p = projectHome(t, 95);
  const r = JSON.parse(run(p.root, p.env, ['--task', 'build', '--project', p.acme, '--json']).stdout);
  assert.deepEqual([r.route.side, r.route.reason], ['claude', 'Cursor is at least 90% used this month. Balanced keeps general work on Claude, where it is best done.']);
});

test('build on an overridden project with Cursor usage unreadable stays off Cursor, and says why', (t) => {
  const p = projectHome(t, null);
  const r = run(p.root, p.env, ['--task', 'build', '--project', p.acme]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "build: Claude (Cursor's usage could not be read. Balanced keeps general work on Claude, where it is best done)");
});

test('the full report names each project override and where its builds go', (t) => {
  const p = projectHome(t, 3);
  const r = run(p.root, p.env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\nProject overrides:\r?\n  Acme App \(on\): test-backed builds go to Cursor \(3% used this month\)\. Folders: .*acme.*slot-\*/);
  const json = JSON.parse(run(p.root, p.env, ['--json']).stdout);
  assert.deepEqual(json.projects.map((x) => [x.id, x.enabled, x.target]), [['acme', true, 'Cursor']]);
  // No overrides: no section.
  const plain = home(t, {});
  assert.doesNotMatch(run(plain, { HARBOR_PROVIDER_LEAN_FILE: path.join(plain, 'missing.json') }).stdout, /Project overrides/);
});
