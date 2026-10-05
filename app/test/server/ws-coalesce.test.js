'use strict';

// A SLOW CLIENT MUST NOT BE DISCONNECTED FOR RECEIVING A STORM OF SNAPSHOTS
// (live-caught 2026-08-06, on Pat's phone).
//
// He opened Harbor on his phone and it showed "Cannot reach harbor-server",
// then connected for about half a second, then went back to Disconnected, over
// and over. The server log showed four clients authenticating successfully
// within twelve seconds, so the handshake was never the problem: the socket was
// being closed immediately after it opened.
//
// Measured against his running machine with a real WebSocket client: 50 pushes
// in 20 seconds, 48 of them `transcript:update` for ONE session, identical
// content, in bursts of about thirteen every five seconds. The queue's own
// comment already records that such a payload is 0.19 to 0.50 MB, so one burst
// is most of the 8MB cap. A localhost client drains fast enough to survive it.
// A phone over Tailscale does not, and the overflow path closes any channel
// that is not `terminal:frame` with 1013 "client too slow". Flood, close,
// reconnect, flood.
//
// The MOBILE-9 security gate proves a slow client drops terminal FRAMES rather
// than growing unbounded, and it passes, because terminal frames are the one
// channel with an eviction rule. Nothing covered the channel that was actually
// killing him.
//
// The fix is coalescing, not a bigger cap: these payloads are whole-state
// snapshots, so a newer one supersedes an older one and dropping the older is
// lossless. A bigger cap would only move the same failure further out.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { ClientQueue, coalesceKey } = require('../../src/server/transport/ws.js');

const push = (channel, args) => ({ type: 'push', channel, args });

test('a burst of transcript snapshots for one session costs ONE queue slot', () => {
  const queue = new ClientQueue({ limit: 256, maxBytes: 8 * 1024 * 1024 });
  const channel = 'transcript:update';

  for (let i = 0; i < 13; i += 1) {
    const payload = push(channel, [{ sessionId: 'S1', replace: [{ id: 'b', seq: i }], contextTokens: 578693, seq: i }]);
    assert.equal(queue.enqueue(channel, payload, coalesceKey(channel, payload.args)), true);
  }

  assert.equal(queue.length, 1, 'thirteen snapshots of one session must collapse to one');
  // And the survivor is the NEWEST, which is the whole justification.
  assert.match(queue.items[0].text, /"seq":12/);
});

test('two different sessions do NOT collapse into each other', () => {
  const queue = new ClientQueue({ limit: 256, maxBytes: 8 * 1024 * 1024 });
  const channel = 'transcript:update';
  for (const id of ['S1', 'S2', 'S1', 'S2', 'S3']) {
    const payload = push(channel, [{ sessionId: id, replace: [] }]);
    queue.enqueue(channel, payload, coalesceKey(channel, payload.args));
  }
  assert.equal(queue.length, 3, 'one slot per session, not one slot total');
});

test('a coalesced replacement keeps its predecessor\'s position', () => {
  // Otherwise a client can see one channel jump ahead of another and render
  // state that never existed in that order.
  const queue = new ClientQueue({ limit: 256, maxBytes: 8 * 1024 * 1024 });
  const t = push('transcript:update', [{ sessionId: 'S1', replace: [], seq: 1 }]);
  queue.enqueue('transcript:update', t, coalesceKey('transcript:update', t.args));
  queue.enqueue('send:status', push('send:status', [{ phase: 'sent' }]), null);
  const t2 = push('transcript:update', [{ sessionId: 'S1', replace: [], seq: 2 }]);
  queue.enqueue('transcript:update', t2, coalesceKey('transcript:update', t2.args));

  assert.equal(queue.length, 2);
  assert.equal(queue.items[0].channel, 'transcript:update', 'the replacement stays first');
  assert.match(queue.items[0].text, /"seq":2/);
  assert.equal(queue.items[1].channel, 'send:status');
});

test('byte accounting stays exact across a replacement', () => {
  // The cap is a BYTE cap; a replacement that forgot to subtract the old size
  // would leak the queue toward the limit and reintroduce the disconnect.
  const queue = new ClientQueue({ limit: 256, maxBytes: 8 * 1024 * 1024 });
  const small = push('transcript:update', [{ sessionId: 'S1', replace: [], pad: 'x' }]);
  queue.enqueue('transcript:update', small, coalesceKey('transcript:update', small.args));
  const afterSmall = queue.bytes;

  const big = push('transcript:update', [{ sessionId: 'S1', replace: [], pad: 'x'.repeat(5000) }]);
  queue.enqueue('transcript:update', big, coalesceKey('transcript:update', big.args));
  assert.equal(queue.length, 1);
  assert.ok(queue.bytes > afterSmall, 'bytes must follow the new payload');
  assert.equal(queue.bytes, Buffer.byteLength(queue.items[0].text), 'bytes must equal what is actually queued');

  const back = push('transcript:update', [{ sessionId: 'S1', replace: [], pad: 'y' }]);
  queue.enqueue('transcript:update', back, coalesceKey('transcript:update', back.args));
  assert.equal(queue.bytes, Buffer.byteLength(queue.items[0].text), 'and shrink again, not leak');
});

test('the storm that disconnected the phone no longer overflows', () => {
  // The real shape: half-megabyte snapshots, bursts of thirteen, four bursts,
  // against a client that never drains. Before coalescing this exceeded 8MB and
  // returned false, which is what closed the socket.
  const queue = new ClientQueue({ limit: 256, maxBytes: 8 * 1024 * 1024 });
  const channel = 'transcript:update';
  let refused = 0;
  for (let burst = 0; burst < 4; burst += 1) {
    for (let i = 0; i < 13; i += 1) {
      const payload = push(channel, [{ sessionId: 'S1', replace: [], blob: 'x'.repeat(500 * 1024) }]);
      if (!queue.enqueue(channel, payload, coalesceKey(channel, payload.args))) refused += 1;
    }
  }
  assert.equal(refused, 0, 'no push may be refused, because a refusal closes the connection');
  assert.equal(queue.length, 1);
  assert.ok(queue.bytes < 8 * 1024 * 1024);
});

test('channels that are NOT snapshots keep their append-only behaviour', () => {
  // send:status is a sequence of distinct events; collapsing it would lose the
  // phases a user reads to know a send landed.
  assert.equal(coalesceKey('send:status', [{ phase: 'sent' }]), null);
  assert.equal(coalesceKey('terminal:frame', [{ data: 'x' }]), null);
  assert.equal(coalesceKey('sidebar:update', [{}]), 'sidebar:update');
  // A transcript push with no session id has nothing to key on and must not
  // collapse unrelated updates together.
  assert.equal(coalesceKey('transcript:update', [{}]), null);
});

// AN APPEND IS A DELTA AND MUST NEVER BE COALESCED (live-caught by Pat on his
// phone, 2026-08-07).
//
// `transcript:update` carries two shapes. `{ replace: blocks }` is the whole
// live block list, so a newer one makes an older one redundant, which is what
// this file's coalescing exists for. `{ append, changed }` is a DELTA emitted
// when new blocks arrive, i.e. exactly when a message is sent. Coalescing those
// discarded the earlier one: a second message about fifteen seconds after the
// first replaced the first append in the queue, and the blocks in it were never
// delivered. The message itself had landed, so desktop (IPC, no coalescing)
// showed it, and the phone never did, permanently, because an append is only
// sent once and nothing re-sends it.

test('two appends MERGE into one item and neither loses its blocks', () => {
  const first = { args: [{ sessionId: 's1', append: [{ id: 'b1' }], changed: [] }] };
  const second = { args: [{ sessionId: 's1', append: [{ id: 'b2' }], changed: [] }] };

  const queue = new ClientQueue({ clientId: 'append-test' });
  queue.enqueue('transcript:update', first, coalesceKey('transcript:update', first.args));
  queue.enqueue('transcript:update', second, coalesceKey('transcript:update', second.args));

  // ONE slot, so a burst cannot grow the backlog without bound...
  assert.equal(queue.length, 1, 'appends must not accumulate; that is what closes a slow connection');
  // ...and BOTH messages are still in it, which is the half that matters to Pat.
  assert.match(queue.items[0].text, /b1/, 'the first append must survive the merge');
  assert.match(queue.items[0].text, /b2/, 'the second append must survive the merge');
});

test('a replace still supersedes, so the flood this was built for is unaffected', () => {
  const a = { args: [{ sessionId: 's1', replace: [{ id: 'b1' }] }] };
  const b = { args: [{ sessionId: 's1', replace: [{ id: 'b1' }, { id: 'b2' }] }] };

  const queue = new ClientQueue({ clientId: 'replace-test' });
  queue.enqueue('transcript:update', a, coalesceKey('transcript:update', a.args));
  queue.enqueue('transcript:update', b, coalesceKey('transcript:update', b.args));
  assert.equal(queue.length, 1, 'a newer whole-state snapshot supersedes its predecessor');
  assert.equal(queue.coalesced, 1);
});

test('a replace and an append for one session stay separate, in order', () => {
  // They carry different KINDS of truth: the snapshot is everything up to a
  // point, the delta is what came after it. Collapsing them either way loses
  // blocks, so they get different keys and both are delivered.
  const snapshot = { args: [{ sessionId: 's1', replace: [{ id: 'b1' }] }] };
  const delta = { args: [{ sessionId: 's1', append: [{ id: 'b2' }], changed: [] }] };

  const queue = new ClientQueue({ clientId: 'mixed-test' });
  queue.enqueue('transcript:update', snapshot, coalesceKey('transcript:update', snapshot.args));
  queue.enqueue('transcript:update', delta, coalesceKey('transcript:update', delta.args));
  assert.equal(queue.length, 2);
  assert.match(queue.items[0].text, /"replace"/);
  assert.match(queue.items[1].text, /"append"/);
});

test('appends for DIFFERENT sessions never merge into each other', () => {
  const one = { args: [{ sessionId: 's1', append: [{ id: 'a1' }], changed: [] }] };
  const two = { args: [{ sessionId: 's2', append: [{ id: 'a2' }], changed: [] }] };
  const queue = new ClientQueue({ clientId: 'cross-session' });
  queue.enqueue('transcript:update', one, coalesceKey('transcript:update', one.args));
  queue.enqueue('transcript:update', two, coalesceKey('transcript:update', two.args));
  assert.equal(queue.length, 2, 'one slot per session, never one slot total');
});

test('byte accounting stays exact when an append merges', () => {
  const queue = new ClientQueue({ clientId: 'bytes' });
  const first = { args: [{ sessionId: 's1', append: [{ id: 'b1' }], changed: [] }] };
  const second = { args: [{ sessionId: 's1', append: [{ id: 'b2' }], changed: [] }] };
  queue.enqueue('transcript:update', first, coalesceKey('transcript:update', first.args));
  queue.enqueue('transcript:update', second, coalesceKey('transcript:update', second.args));
  const actual = queue.items.reduce((sum, item) => sum + item.bytes, 0);
  assert.equal(queue.bytes, actual, 'a merge that mis-accounts bytes leaks the queue toward its cap');
});
