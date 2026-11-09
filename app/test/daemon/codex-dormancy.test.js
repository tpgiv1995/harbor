'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { awaitingAnswer, sweepDormancy, resolveDormancyPolicy, HOUR_MS } = require('../../src/daemon/dormancy.js');

const chooser = 'Here are a few ways I can help:\nChoosing a rewrite sends it in a new chat.\n› 1. Overview\n  2. Recovery\n  enter select · esc back';
const selections = [
  'c continue in new chat · n start fresh · esc other chats',
  'c continue in new chat · n start fresh\n  · esc other chats',
  'n start fresh · esc other chats',
  'r retry   f fork   ←/esc command center   ⌃c/q exit   ⌃t\n  transcript',
  'r retry   f fork   esc/ctrl+c/q exit   ctrl+t transcript',
  'r retry   f fork   esc command center   ⌃c/q exit   ← transcript',
  'c continue in new chat · n start\n  fresh · esc other\n  chats',
  'r retry   f fork   ←/esc command\n  center   ⌃c/q exit   ⌃t transcript',
  'arrows/hjkl/w/b/e move · 0/$/g/G ends · v/space/V mark · / find · enter/q/esc close',
  'v mark · enter/q close',
  'y/ctrl+c copy · enter copy & latest · esc clear · q close',
  'enter copy · q close',
  'Find: sample\nenter accept · esc cancel',
];
const idle = 'Completed synthetic response\n› Ask Codex to do anything\n  GPT-6-Sol low · ~/project';

test('Codex recourse and selection await input, while an idle composer can sleep', () => {
  for (const screen of [chooser, ...selections]) {
    assert.equal(awaitingAnswer(screen, 'codex'), true, screen);
    assert.equal(awaitingAnswer(screen, 'other'), false, 'Codex-specific chrome stays provider-scoped');
    assert.equal(awaitingAnswer(screen + '\n' + 'old output\n'.repeat(30) + idle, 'codex'), false, 'old overlays do not keep a session alive forever');
  }
  assert.equal(awaitingAnswer(idle, 'codex'), false);
  assert.equal(awaitingAnswer('Please read the transcript', 'codex'), false);
  assert.equal(awaitingAnswer('› Please read the transcript\n  GPT-6-Sol low · ~/project', 'codex'), false);
});

test('dormancy sweep preserves Codex choices and read-only notices and still sleeps an idle pane', async () => {
  const now = Date.now(), watch = new Map(), ended = [];
  const screens = { choice: chooser, provider: selections[1], writer: selections[3], idle };
  const states = Object.keys(screens).map(id => ({ id, agent: 'codex', keeper_pid: 1, exit: null, last_activity_at: new Date(now - 2 * HOUR_MS).toISOString() }));
  for (let i = 0; i < 4; i++) await sweepDormancy({
    states, now: now + i * 60_000, policy: resolveDormancyPolicy({}), watch,
    readCpu: () => 1_000_000,
    readScreen: async state => screens[state.id],
    terminate: async state => { ended.push(state.id); }, log: () => {},
  });
  assert.deepEqual(ended, ['idle']);
});
