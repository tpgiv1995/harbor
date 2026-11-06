'use strict';

// SUBSCRIPTIONS ON ONE DAEMON SHARE ONE SNAPSHOT FETCH PER TICK (2026-11-06).
// Every SessionSubscription polled the daemon's `list` on its own 1 s timer;
// one Harbor process makes three subscriptions and the phone server two more,
// which measured 266 `list` requests a minute at the daemon. Two-sided: the
// subscriptions that name their own pollIntervalMs keep a private timer and
// still cost one request each per tick (that is the old behaviour, the
// control), while default-cadence subscriptions on the same daemon cost one.
// Timers are mocked so a second is an instant.

const test = require('node:test');
const { beforeEach, afterEach, mock } = test;
const assert = require('node:assert/strict');

const { SessionDaemonClient, SessionSubscription } = require('../../src/main/session-daemon/client.js');

const tick = (ms) => mock.timers.tick(ms);
const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

function daemonClient(state, socketPath = 'daemon-A') {
  const fake = {
    socketPath,
    requests: 0,
    inflight: 0,
    maxInflight: 0,
    async request(verb) {
      assert.equal(verb, 'list');
      fake.requests += 1;
      fake.inflight += 1;
      fake.maxInflight = Math.max(fake.maxInflight, fake.inflight);
      try {
        if (fake.delay) await fake.delay;
        if (fake.fail) throw new Error(fake.fail);
        return { sessions: state.sessions };
      } finally { fake.inflight -= 1; }
    },
    close() {},
  };
  return { fake, client: new SessionDaemonClient({ client: fake, env: { HOME: 'C:\\Users\\x' } }) };
}

const session = (id, extra = {}) => ({ id, cwd: `C:\\dev\\${id}`, pid: 1, argv: ['claude'], cols: 120, rows: 60, ...extra });

beforeEach(() => mock.timers.enable({ apis: ['setInterval'] }));
afterEach(() => mock.timers.reset());

test('three subscriptions on one daemon cost one list request per tick; their own-interval twins cost three', async () => {
  const state = { sessions: [session('a')] };
  const shared = daemonClient(state);
  const subs = [shared.client.subscribe(), shared.client.subscribe(), shared.client.subscribeAgentStatus()];
  for (let i = 0; i < 4; i += 1) { tick(1000); await settle(); }
  assert.equal(shared.fake.requests, 4, 'one request per tick however many subscriptions listen');
  subs.forEach((sub) => sub.close());

  // The control: the pre-change shape, a private 1 s timer each.
  const control = daemonClient(state, 'daemon-control');
  const own = [1, 2, 3].map(() => control.client.subscribe(null, { pollIntervalMs: 1000 }));
  for (let i = 0; i < 4; i += 1) { tick(1000); await settle(); }
  assert.equal(control.fake.requests, 12, 'a private timer per subscription asks once each per tick');
  own.forEach((sub) => sub.close());
});

test('every subscription gets the result and emits its own events from its own previous panes', async () => {
  const state = { sessions: [session('a')] };
  const { client } = daemonClient(state);
  const early = client.subscribe();
  early.seedFromSnapshot((await client.snapshot()).snapshot);
  const seen = { early: [], late: [] };
  early.on('event', (event) => seen.early.push(event.event));

  // A subscription seeded EMPTY sees the existing pane as new; the seeded one does not.
  const late = client.subscribe();
  late.on('event', (event) => seen.late.push(event.event));
  tick(1000); await settle();
  assert.deepEqual(seen.early, [], 'a seeded subscription does not replay what it already knew');
  assert.deepEqual(seen.late, ['workspace.created', 'tab.created', 'pane.created', 'layout.updated']);

  // A resize reaches both, exactly once each, including the new pane.resized event.
  state.sessions = [session('a', { cols: 90, rows: 30 })];
  tick(1000); await settle();
  assert.deepEqual(seen.early, ['pane.resized']);
  assert.deepEqual(seen.late.slice(4), ['pane.resized']);

  // A session closing reaches both.
  state.sessions = [];
  tick(1000); await settle();
  assert.deepEqual(seen.early.slice(1), ['pane.closed']);
  assert.deepEqual(seen.late.slice(5), ['pane.closed']);
  early.close();
  late.close();
});

test('a closed subscription stops receiving, and the shared poll stops with the last one', async () => {
  const state = { sessions: [session('a')] };
  const { fake, client } = daemonClient(state);
  const one = client.subscribe();
  const two = client.subscribe();
  let heardOne = 0;
  let heardTwo = 0;
  one.on('event', () => { heardOne += 1; });
  two.on('event', () => { heardTwo += 1; });
  tick(1000); await settle();
  assert.equal(heardOne, 4);
  assert.equal(heardTwo, 4);

  one.close();
  state.sessions = [session('a'), session('b')];
  tick(1000); await settle();
  assert.equal(heardOne, 4, 'a closed subscription hears nothing more');
  assert.ok(heardTwo > 4, 'its neighbour still does');
  assert.equal(fake.requests, 2, 'closing one member does not change the request rate');

  two.close();
  const after = fake.requests;
  for (let i = 0; i < 3; i += 1) { tick(1000); await settle(); }
  assert.equal(fake.requests, after, 'no members, no polling');

  // And a later subscription starts a fresh poll.
  const three = client.subscribe();
  tick(1000); await settle();
  assert.equal(fake.requests, after + 1);
  three.close();
});

test('a slow daemon answer is never queued behind: one request in flight at a time', async () => {
  const state = { sessions: [session('a')] };
  const { fake, client } = daemonClient(state);
  const subs = [client.subscribe(), client.subscribe()];
  let release;
  fake.delay = new Promise((resolve) => { release = resolve; });
  for (let i = 0; i < 5; i += 1) { tick(1000); await settle(); }
  assert.equal(fake.requests, 1, 'five ticks while the first answer is outstanding make one request');
  assert.equal(fake.maxInflight, 1);
  fake.delay = null;
  release();
  await settle();
  tick(1000); await settle();
  assert.equal(fake.requests, 2, 'polling resumes once the answer lands');
  subs.forEach((sub) => sub.close());
});

test('a failed fetch is reported to every member, and a member without a listener does not stop the rest', async () => {
  const state = { sessions: [session('a')] };
  const { fake, client } = daemonClient(state);
  const silent = client.subscribe(); // no 'error' listener: emit would throw
  const loud = client.subscribe();
  const errors = [];
  loud.on('error', (error) => errors.push(error.message));
  fake.fail = 'daemon unreachable';
  tick(1000); await settle();
  assert.deepEqual(errors, ['daemon unreachable']);
  fake.fail = null;
  tick(1000); await settle();
  assert.equal(fake.requests, 2, 'the poll carries on after a failure');
  silent.close();
  loud.close();
});

test('subscriptions on different daemons poll separately', async () => {
  const state = { sessions: [session('a')] };
  const first = daemonClient(state, 'daemon-one');
  const second = daemonClient(state, 'daemon-two');
  const subs = [first.client.subscribe(), second.client.subscribe(), first.client.subscribe()];
  tick(1000); await settle();
  assert.equal(first.fake.requests, 1);
  assert.equal(second.fake.requests, 1);
  subs.forEach((sub) => sub.close());
});

test('a subscription built straight on an owner keeps working, and _poll still fetches for itself', async () => {
  let calls = 0;
  const owner = { snapshot: async () => { calls += 1; return { snapshot: { panes: [], workspaces: [], tabs: [], layouts: [] } }; } };
  const sub = new SessionSubscription(owner, { pollIntervalMs: 60_000 });
  await sub._poll();
  assert.equal(calls, 1);
  sub.close();
});

// Astra review 2026-11-06, finding 5: a subscription that joined while a fetch
// was in flight holds a newer seed than that fetch's answer. Serving it the
// older answer reported its newest pane closed.
test('a subscription that joins during a fetch is not served that older answer', async () => {
  const state = { sessions: [session('a')] };
  const { fake, client } = daemonClient(state, 'daemon-join');
  const first = client.subscribe();
  let release;
  fake.delay = new Promise((resolve) => { release = resolve; });
  tick(1000); await settle(); // a fetch is now in flight, answering with pane a only
  const late = new SessionSubscription(client).seedFromSnapshot({ panes: [{ pane_id: 'a' }, { pane_id: 'b' }] });
  const closed = [];
  late.on('event', (event) => { if (event.event === 'pane.closed') closed.push(event.data.pane_id); });
  release(); fake.delay = null; await settle();
  assert.deepEqual(closed, [], 'the late member never sees the older answer');
  state.sessions = [session('a'), session('b')];
  tick(1000); await settle();
  assert.deepEqual(closed, [], 'and the next answer, which has b, closes nothing');
  first.close(); late.close();
});

// Astra review 2026-11-06, finding 8: with one client failing and another
// slow but healthy, each tick launched another unawaited fallback fetch, so
// requests piled up against the slow daemon.
test('a failing client and a slow healthy client never have overlapping fetches', async () => {
  const state = { sessions: [session('a')] };
  const broken = daemonClient(state, 'daemon-pair');
  const healthy = daemonClient(state, 'daemon-pair');
  broken.fake.fail = 'pipe closed';
  const errors = [];
  const a = broken.client.subscribe(); a.on('error', (error) => errors.push(error.message));
  const b = healthy.client.subscribe();
  let release;
  healthy.fake.delay = new Promise((resolve) => { release = resolve; });
  for (let i = 0; i < 3; i += 1) { tick(1000); await settle(); }
  assert.equal(healthy.fake.maxInflight, 1, 'one fetch at a time against the slow client');
  release(); healthy.fake.delay = null; await settle();
  tick(1000); await settle();
  assert.ok(errors.length >= 1 && errors.every((m) => m === 'pipe closed'), 'the broken client still reports its own errors');
  a.close(); b.close();
});

// Astra review round 2, N5: a failing client's slow retry held the shared tick,
// so the healthy client was not asked again until the retry gave up.
test('a slow retry of a broken client never holds up the healthy client', async () => {
  const state = { sessions: [session('a')] };
  const broken = daemonClient(state, 'daemon-stall');
  const healthy = daemonClient(state, 'daemon-stall');
  broken.fake.fail = 'pipe closed';
  const a = broken.client.subscribe(); a.on('error', () => {});
  const b = healthy.client.subscribe();
  tick(1000); await settle(); // the broken client fails once and is now retried on its own
  broken.fake.fail = null;
  let release;
  broken.fake.delay = new Promise((resolve) => { release = resolve; });
  const before = healthy.fake.requests;
  for (let i = 0; i < 4; i += 1) { tick(1000); await settle(); }
  assert.equal(healthy.fake.requests - before, 4, 'the healthy client is asked every tick');
  assert.equal(broken.fake.maxInflight, 1, 'and the broken one never has two retries in flight');
  release(); broken.fake.delay = null; await settle();
  a.close(); b.close();
});

// Astra review round 3: a client that failed during a shared fetch and then
// recovered through its own retry must not be handed the older shared answer.
test('a client that recovers while a shared fetch is out never gets that older answer', async () => {
  const stateA = { sessions: [session('old'), session('new')] };
  const stateB = { sessions: [session('old')] };
  const A = daemonClient(stateA, 'daemon-order');
  const B = daemonClient(stateB, 'daemon-order');
  const a = A.client.subscribe(); a.on('error', () => {});
  const events = [];
  a.on('event', (event) => events.push(`${event.event}:${event.data.pane_id ?? event.data.pane?.pane_id}`));
  const b = B.client.subscribe();
  A.fake.fail = 'pipe closed';
  let release;
  B.fake.delay = new Promise((resolve) => { release = resolve; });
  tick(1000); await settle(); // A fails inside the shared fetch, which then waits on B
  A.fake.fail = null;
  tick(1000); await settle(); // A's own retry answers with old + new
  assert.ok(events.includes('pane.created:new'), 'the retry created the new pane');
  release(); B.fake.delay = null; await settle();
  assert.ok(!events.includes('pane.closed:new'), `the older shared answer closed nothing: ${events.join(', ')}`);
  a.close(); b.close();
});
