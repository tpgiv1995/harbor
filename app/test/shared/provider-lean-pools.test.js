'use strict';

// CURSOR HAS TWO POOLS, AND A SPENT ONE IS NEVER ROOM (2026-11-24, Carrier Bridge OO 695; Pat: "we've been going off
// of you saying we were at like 5-6% this whole time... thats 100% on you"). Cursor's own usage call reports
// totalPercentUsed (a blended 8.2% that night), autoPercentUsed (Auto and Composer, 0.5%) and apiPercentUsed (the
// frontier models: Opus, Sonnet, GPT, Gemini, Fable, 100%). Harbor showed and routed on the blend, so a team was told
// it had room while every frontier model refused "You've hit your usage limit". The pools are read, worded and routed
// on now: a job runs on the pool of the model it will use (Auto by default).
const test = require('node:test');
const assert = require('node:assert/strict');
const { cursorFromPlans, leanRoute, cursorModelPool, cursorPoolsText } = require('../../src/shared/provider-lean.cjs');
const { formatWindow } = require('../../src/renderer/plan-usage-format.cjs');

const RESET = Date.parse('2026-12-23T01:15:44Z') / 1000;
const window = { kind: 'monthly', usedPct: 8.17, includedPct: 8.17, autoPct: 0.51, apiPct: 100, resetsAt: RESET };
const plan = { provider: 'cursor', label: 'Cursor', windows: [window], keyPresent: true };
const seats = [{ label: 'Codex', weeklyPct: 40, resetsAvailable: 0 }];

test('the reader keeps both pools, and the spent one says so', () => {
  const cursor = cursorFromPlans([plan]);
  assert.equal(cursor.pools.frontier.usedPct, 100);
  assert.equal(cursor.pools.frontier.spent, true);
  assert.equal(cursor.pools.auto.spent, false);
  assert.equal(cursor.resetsAt, RESET);
});

test('a model runs on its own pool: Auto, Composer and Cursor models on one, the named frontier models on the other', () => {
  for (const id of [undefined, '', 'auto', 'composer-2.5', 'cursor-grok-4.5-high']) assert.equal(cursorModelPool(id), 'auto', String(id));
  for (const id of ['claude-opus-5-5-high', 'claude-sonnet-5-thinking-high', 'claude-fable-5-thinking-high', 'gpt-5.6-sol-high', 'gemini-4-neon-high']) {
    assert.equal(cursorModelPool(id), 'frontier', id);
  }
});

test('a job naming a frontier model is not routed to Cursor while that pool is spent, and the reason names what answers', () => {
  const cursor = cursorFromPlans([plan]);
  const frontier = leanRoute('balanced', 'mechanical', seats, { cursor, model: 'claude-opus-5-5-high' });
  assert.notEqual(frontier.side, 'cursor');
  assert.match(frontier.reason, /frontier models \(Opus, Sonnet, GPT, Gemini, Fable\) are spent until Dec 23/);
  assert.match(frontier.reason, /Auto \(no --model\)/);
  // The default job runs on Auto, which has room.
  assert.equal(leanRoute('balanced', 'mechanical', seats, { cursor }).side, 'cursor');
  assert.equal(leanRoute('balanced', 'mechanical', seats, { cursor, model: 'composer-2.5' }).side, 'cursor');
});

test('a last good reading carries the pools too, so a failed live read cannot route onto a spent pool', () => {
  const offline = { provider: 'cursor', label: 'Cursor', windows: [], unavailable: true, keyPresent: true,
    lastGood: { monthlyPct: 8.17, autoPct: 0.51, apiPct: 100, resetsAt: RESET, at: '2026-11-24T05:30:00Z' } };
  const cursor = cursorFromPlans([offline]);
  assert.notEqual(leanRoute('balanced', 'mechanical', seats, { cursor, model: 'gpt-5.6-sol-high' }).side, 'cursor');
  assert.equal(leanRoute('balanced', 'mechanical', seats, { cursor }).side, 'cursor');
});

test('the words never show the blend as room', () => {
  const text = cursorPoolsText(cursorFromPlans([plan]));
  assert.equal(text, 'Auto and Composer <1% used; frontier models (Opus, Sonnet, GPT, Gemini, Fable) 100% used, spent until Dec 23');
  const row = formatWindow(window, Date.parse('2026-11-24T05:30:00Z'));
  assert.doesNotMatch(row.label, /8%/);
  assert.match(row.label, /Frontier spent/);
  assert.equal(row.width, 100, 'the bar shows the fuller pool');
  assert.match(row.tooltip, /Frontier models \(Opus, Sonnet, GPT, Gemini, Fable\) 100% used/);
});
