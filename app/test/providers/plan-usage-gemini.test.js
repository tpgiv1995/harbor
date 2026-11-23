'use strict';

// Gemini (Google's Antigravity CLI) in the plans dropdown: the CLI's own `agy -p /usage --output-format json`
// answer, shaped like the measured agy 1.5.14 output (2026-11-23), read only when the CLI is installed, never while
// usage checks are off, and never with a credential in the result.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createPlanUsageProvider, geminiWindows } = require('../../src/main/providers/plan-usage.js');

const NOW = Date.parse('2026-11-23T05:30:00Z');
const USAGE = {
  conversation_id: '', status: 'SUCCESS', response: '', num_turns: 0,
  command: { name: 'usage', data: { groups: [
    { name: 'Gemini Models', description: 'Models within this group: Gemini 4 Neon, Gemini 4 Hydrogen, Orchestrator (Neon), Gemini 3.8 Flash', buckets: [
      { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.985, reset_time: '2026-11-30T05:16:13Z' },
      { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0.947, reset_time: '2026-11-23T10:16:13Z' },
    ] },
    { name: 'Claude and GPT models', buckets: [
      { id: '3p-weekly', window: 'weekly', remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z' },
      { id: '3p-5h', window: '5h', remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z' },
    ] },
    { name: 'Gemini 4 Argon', buckets: [{ id: 'gemini-argon-wtu-weekly', window: 'weekly', remaining_fraction: 1, reset_time: '2026-11-30T05:33:57Z' }] },
  ] } },
};

function fixture(t, { bin = true, config = true } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'plan-usage-gemini-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agy = path.join(root, 'tools', 'agy.exe');
  const agyHome = path.join(root, 'agy-home');
  if (bin) { fs.mkdirSync(path.dirname(agy), { recursive: true }); fs.writeFileSync(agy, ''); }
  if (config) { fs.mkdirSync(path.join(root, '.harbor'), { recursive: true }); fs.writeFileSync(path.join(root, '.harbor', 'gemini.json'), JSON.stringify({ bin: agy, home: agyHome })); }
  return { root, agy, agyHome };
}
const provider = (root, env, runGeminiUsage) => createPlanUsageProvider({ home: root, env, now: () => NOW, platform: 'win32', profiles: [], runGeminiUsage,
  usageProvider: { getUsage: async () => ({}) } });

test('gemini windows come from the Gemini models group only, as 5-hour and weekly used percentages with reset seconds', () => {
  const w = geminiWindows(USAGE);
  assert.deepEqual(w.map((x) => x.kind), ['fiveHour', 'weekly']);
  assert.equal(Math.round(w[0].usedPct * 10) / 10, 5.3);
  assert.equal(Math.round(w[1].usedPct * 10) / 10, 1.5);
  assert.equal(w[0].resetsAt, Date.parse('2026-11-23T10:16:13Z') / 1000);
  assert.equal(w[1].windowMinutes, 10080);
  assert.equal(geminiWindows({ command: { data: { groups: [] } } }), null);
  assert.equal(geminiWindows({}), null);
});

test('gemini plan reads the configured CLI in its own home and reports the Gemini row', async (t) => {
  const { root, agy, agyHome } = fixture(t);
  const calls = [];
  const p = provider(root, { HARBOR_NO_USAGE_FETCH: '0' }, async (bin, home) => { calls.push([bin, home]); return { error: null, stdout: JSON.stringify(USAGE) }; });
  const plans = (await p.getPlans()).plans;
  const gemini = plans.find((x) => x.provider === 'gemini');
  assert.deepEqual(calls, [[agy, agyHome]]);
  assert.equal(gemini.label, 'Gemini');
  assert.equal(gemini.unavailable, false);
  assert.equal(gemini.windows.length, 2);
  assert.equal(gemini.reason, null);
  // The one-minute cooldown: a second open inside it does not run the CLI again.
  await p.getPlans();
  assert.equal(calls.length, 1);
});

test('gemini plan: no CLI installed means no row; usage checks off means no CLI run', async (t) => {
  const none = fixture(t, { bin: false });
  let ran = 0;
  const run = async () => { ran++; return { error: null, stdout: JSON.stringify(USAGE) }; };
  assert.equal((await provider(none.root, {}, run).getPlans()).plans.some((x) => x.provider === 'gemini'), false);
  const off = fixture(t);
  const plans = (await provider(off.root, { HARBOR_NO_USAGE_FETCH: '1' }, run).getPlans()).plans;
  const gemini = plans.find((x) => x.provider === 'gemini');
  assert.equal(gemini.unavailable, true);
  assert.match(gemini.reason, /disabled/);
  assert.equal(ran, 0);
});

test('gemini plan: a signed-out, broken or slow CLI gives an honest reason and no windows', async (t) => {
  const cases = [
    [{ error: null, stdout: JSON.stringify({ status: 'ERROR', error: 'authentication required' }) }, /signed out/],
    [{ error: null, stdout: 'not json' }, /no usage windows/],
    [{ error: Object.assign(new Error('timeout'), { killed: true }), stdout: '' }, /timed out after 10 seconds/],
  ];
  for (const [answer, reason] of cases) {
    const { root } = fixture(t);
    const gemini = (await provider(root, {}, async () => answer).getPlans()).plans.find((x) => x.provider === 'gemini');
    assert.equal(gemini.unavailable, true);
    assert.deepEqual(gemini.windows, []);
    assert.match(gemini.reason, reason);
  }
});

test('a plan-usage fixture may carry a gemini plan', async (t) => {
  const { root } = fixture(t, { bin: false, config: false });
  const file = path.join(root, 'fixture.json');
  fs.writeFileSync(file, JSON.stringify({ plans: [{ provider: 'gemini', id: 'gemini:default', label: 'Gemini', windows: [{ kind: 'weekly', usedPct: 2 }] }] }));
  const plans = (await createPlanUsageProvider({ home: root, env: { HARBOR_PLAN_USAGE_FIXTURE: file } }).getPlans()).plans;
  assert.equal(plans[0].provider, 'gemini');
});
