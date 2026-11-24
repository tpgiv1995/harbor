'use strict';

// A slow or failed Tailscale read must not wipe the server's own address list (2026-11-24). The resolver answers a
// `tailscale status` timeout with an EMPTY list, not an error, and the cache took that as "this server has no MagicDNS
// name": from 04:21:52 to 04:24:14 UTC the live phone server refused Pat's phone as a "foreign Origin" while a loaded
// machine (a 4.6 s event-loop stall) made the 5 s status call time out. The last good list now stands for a bounded
// grace while reads come back empty; past it, an empty answer is believed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSelfOriginHostsCache } = require('../../src/server/transport/ws.js');

const HOST = 'harbor-box.example-tailnet.ts.net';

test('an empty Tailscale read keeps the last good host list', async () => {
  const answers = [[HOST], [], []];
  const current = createSelfOriginHostsCache({ resolveSelfOriginHosts: async () => answers.shift() ?? [], ttlMs: 0, emptyTtlMs: 0 });
  assert.deepEqual(await current(), [HOST]);
  assert.deepEqual(await current(), [HOST], 'one timed-out read must not refuse the phone');
  assert.deepEqual(await current(), [HOST]);
});

test('past the grace an empty read is believed, and a fresh good read replaces the list', async () => {
  let clock = 1_000_000;
  const answers = [[HOST], [], [], ['renamed.example-tailnet.ts.net']];
  const current = createSelfOriginHostsCache({
    resolveSelfOriginHosts: async () => answers.shift() ?? [], ttlMs: 0, emptyTtlMs: 0, staleGraceMs: 600_000, now: () => clock,
  });
  assert.deepEqual(await current(), [HOST]);
  clock += 599_000;
  assert.deepEqual(await current(), [HOST], 'inside the grace');
  clock += 2_000;
  assert.deepEqual(await current(), [], 'ten minutes of empty reads: the node really has no name now');
  assert.deepEqual(await current(), ['renamed.example-tailnet.ts.net']);
});

test('a server that never had a name still starts empty', async () => {
  const current = createSelfOriginHostsCache({ resolveSelfOriginHosts: async () => [], ttlMs: 0, emptyTtlMs: 0 });
  assert.deepEqual(await current(), []);
});
