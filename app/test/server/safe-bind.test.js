'use strict';

// THE SERVER MAY BIND LOOPBACK OR A TAILSCALE ADDRESS, AND NOTHING ELSE.
//
// This is security-critical: harbor-server exposes every session on the machine,
// so a bind to 0.0.0.0 would publish them to the local network. The rule was
// previously an exact-membership `Set` containing the author's own tailnet
// address, and the publish-time scrub rewrote that address to the literal
// placeholder '100.x.y.z'. Exact membership against an impossible string matches
// nothing, so the documented direct-tailnet bind became unreachable for
// everybody, and the refusal told the user to bind '100.x.y.z'.
//
// The replacement is a RANGE test over Tailscale's CGNAT block 100.64.0.0/10.
// It has no address in it to anonymize, so the scrub has nothing to break, and
// it works for any user's tailnet rather than one machine's. Because this
// widened what is accepted, the refusals are tested at least as hard as the
// acceptances: 100.63.x and 100.128.x sit immediately outside the block and are
// the boundaries an off-by-one would let through.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { assertSafeBind, isTailscaleCgnat } = require('../../src/server/compose.js');

test('loopback binds are accepted', () => {
  for (const host of ['127.0.0.1', '::1', 'localhost']) {
    assert.equal(assertSafeBind(host), host);
  }
});

test('a Tailscale CGNAT address is accepted anywhere in 100.64.0.0/10', () => {
  // Every address here is synthetic. A REAL tailnet address in a test is what
  // the publish scrub rewrites, and rewriting the old allow-list entry is the
  // bug this file exists for; reintroducing one would reintroduce the bug.
  for (const host of ['100.64.0.0', '100.100.100.100', '100.72.5.9', '100.127.255.255']) {
    assert.equal(assertSafeBind(host), host, `${host} is inside 100.64.0.0/10 and must be bindable`);
  }
});

test('every address outside loopback and the CGNAT block is refused', () => {
  const refused = [
    '0.0.0.0',            // the one that must never work
    '::',
    '192.168.1.10',
    '10.0.0.5',
    '8.8.8.8',
    '100.63.255.255',     // one below the block
    '100.128.0.0',        // one above the block
    '100.200.1.1',
    '1100.64.1.1',        // not four octets
    '100.64.1',           // short
    '100.999.1.1',        // octet out of range
    'evil.example.com',
    '100.x.y.z',          // the placeholder that used to be the ONLY allowed one
  ];
  for (const host of refused) {
    assert.throws(
      () => assertSafeBind(host),
      /refusing unsafe bind address/,
      `${host} must be refused`,
    );
  }
});

test('the refusal names a range a user can act on, not a placeholder', () => {
  // The old message told the reader to use '100.x.y.z', which is not an address.
  let message = '';
  try { assertSafeBind('0.0.0.0'); } catch (err) { message = err.message; }
  assert.match(message, /100\.64\.0\.0\/10/);
  assert.doesNotMatch(message, /100\.x\.y\.z/);
});

test('the range predicate itself is exact at both edges', () => {
  assert.equal(isTailscaleCgnat('100.64.0.0'), true);
  assert.equal(isTailscaleCgnat('100.127.255.255'), true);
  assert.equal(isTailscaleCgnat('100.63.255.255'), false);
  assert.equal(isTailscaleCgnat('100.128.0.0'), false);
  assert.equal(isTailscaleCgnat('99.64.0.0'), false);
  assert.equal(isTailscaleCgnat('101.64.0.0'), false);
});
