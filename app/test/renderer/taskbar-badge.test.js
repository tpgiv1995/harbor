'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { planTaskbarBadge, createTaskbarBadgeScheduler } = require('../../src/renderer/stage/taskbar-badge.cjs');

// A manual clock: timers fire only when the test advances time.
function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    setTimer: (fn, ms) => { seq += 1; timers.set(seq, { at: now + ms, fn }); return seq; },
    clearTimer: (id) => { timers.delete(id); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
}

function scheduler(clock, sent) {
  return createTaskbarBadgeScheduler({
    send: (payload) => sent.push(payload),
    render: (plan) => `${plan.kind}:${plan.label}`,
    delayMs: 250,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
}

// The plan is recomputed on every session update; only a real change is worth a native set.
test('an unchanged badge is sent once, however many updates recompute it', () => {
  const clock = fakeClock();
  const sent = [];
  const update = scheduler(clock, sent);
  for (let i = 0; i < 20; i++) { update(planTaskbarBadge({ blocked: 0, finished: 2 })); clock.advance(100); }
  clock.advance(1000);
  assert.deepEqual(sent, ['accent:2']);
});

// 2026-10-04, "i dont get the blue / yellow alert numbers anymore": the App recomputes the plan on
// every transcript update of every open window, and when each recompute restarted the clock, a
// window streaming faster than the delay kept the badge from ever being sent.
test('a streaming window cannot hold back a waiting question', () => {
  const clock = fakeClock();
  const sent = [];
  const update = scheduler(clock, sent);
  update(planTaskbarBadge({}));
  clock.advance(300);
  for (let i = 0; i < 40; i++) { update(planTaskbarBadge({ blocked: 1 })); clock.advance(100); }
  assert.deepEqual(sent, ['clear:', 'amber:1']);
});

test('the badge goes out one delay after the change, not after the updates stop', () => {
  const clock = fakeClock();
  const sent = [];
  const update = scheduler(clock, sent);
  update(planTaskbarBadge({ finished: 1 }));
  clock.advance(100);
  update(planTaskbarBadge({ finished: 1 }));
  clock.advance(100);
  update(planTaskbarBadge({ finished: 1 }));
  clock.advance(49);
  assert.deepEqual(sent, []);
  clock.advance(1);
  assert.deepEqual(sent, ['accent:1']);
});

test('every real change is sent, including clearing and coming back', () => {
  const clock = fakeClock();
  const sent = [];
  const update = scheduler(clock, sent);
  for (const counts of [{ finished: 2 }, { finished: 2 }, { finished: 3 }, { blocked: 1, finished: 3 }, {}, {}, { finished: 1 }]) {
    update(planTaskbarBadge(counts));
    clock.advance(300);
  }
  assert.deepEqual(sent, ['accent:2', 'accent:3', 'amber:1', 'clear:', 'accent:1']);
});

test('the very first plan is always sent, even a clear one', () => {
  const clock = fakeClock();
  const sent = [];
  scheduler(clock, sent)(planTaskbarBadge({}));
  clock.advance(250);
  assert.deepEqual(sent, ['clear:']);
});

test('a burst coalesces to its last state, and a change undone inside the delay sends nothing', () => {
  const clock = fakeClock();
  const sent = [];
  const update = scheduler(clock, sent);
  update(planTaskbarBadge({ finished: 2 }));
  clock.advance(300);
  update(planTaskbarBadge({ blocked: 1, finished: 2 }));
  clock.advance(100);
  update(planTaskbarBadge({ finished: 2 }));
  clock.advance(1000);
  assert.deepEqual(sent, ['accent:2']);
  update(planTaskbarBadge({ finished: 3 }));
  clock.advance(100);
  update(planTaskbarBadge({ finished: 4 }));
  clock.advance(1000);
  assert.deepEqual(sent, ['accent:2', 'accent:4']);
});

test('blocked sessions produce amber and outrank finished sessions', () => {
  assert.deepEqual(planTaskbarBadge({ blocked: 1, finished: 2 }), {
    kind: 'amber',
    count: 1,
    label: '1',
    description: '1 session waiting for your answer; 2 sessions finished',
  });
});

test('finished sessions produce accent only when no session is blocked', () => {
  assert.deepEqual(planTaskbarBadge({ blocked: 0, finished: 2 }), {
    kind: 'accent',
    count: 2,
    label: '2',
    description: '0 sessions waiting for your answer; 2 sessions finished',
  });
});

test('zero attention produces a clear instruction while describing both counts', () => {
  assert.deepEqual(planTaskbarBadge({ blocked: 0, finished: 0 }), {
    kind: 'clear',
    count: 0,
    label: '',
    description: '0 sessions waiting for your answer; 0 sessions finished',
  });
});

test('labels cap at 9+ while descriptions retain the full counts', () => {
  const blocked = planTaskbarBadge({ blocked: 10, finished: 12 });
  assert.equal(blocked.label, '9+');
  assert.equal(blocked.description, '10 sessions waiting for your answer; 12 sessions finished');

  const finished = planTaskbarBadge({ blocked: 0, finished: 27 });
  assert.equal(finished.label, '9+');
  assert.equal(finished.description, '0 sessions waiting for your answer; 27 sessions finished');
});

test('counts are normalized so malformed inputs cannot create a false badge', () => {
  assert.equal(planTaskbarBadge({ blocked: -2, finished: Number.NaN }).kind, 'clear');
  assert.equal(planTaskbarBadge({ blocked: 0, finished: 1.9 }).label, '1');
});
