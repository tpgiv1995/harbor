'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  isLoopbackPeer,
  tailnetIdentity,
  createTailnetAuthorizer,
  readSelfLogin,
  resolveAllowedLogins,
} = require('../../src/server/transport/tailnet-identity.js');

const OWNER = 'owner@example.com';

// A request as `tailscale serve` delivers it: proxied over loopback, with the
// identity stamped on by serve itself.
function served({ login = OWNER, name = 'Node Owner', remoteAddress = '127.0.0.1', headers = {} } = {}) {
  const merged = { host: 'node.example.ts.net', ...headers };
  if (login !== null) merged['tailscale-user-login'] = login;
  if (name !== null) merged['tailscale-user-name'] = name;
  return { headers: merged, socket: { remoteAddress, localPort: 8787, remotePort: 54321 } };
}

// Stand-ins for the /proc/net/tcp lookup: who owns the other end of the socket.
const AS_TAILSCALED = () => 0;
const AS_ANOTHER_LOCAL_USER = () => 1000;
const UNKNOWN_OWNER = () => null;

function authorizerFor(peerUidFor, allowedLogins = [OWNER]) {
  return createTailnetAuthorizer({ allowedLogins, trustedPeerUids: [0], peerUidFor });
}

test('a loopback peer is recognised in every form node reports one', () => {
  assert.equal(isLoopbackPeer('127.0.0.1'), true);
  assert.equal(isLoopbackPeer('127.0.0.53'), true);
  assert.equal(isLoopbackPeer('::1'), true);
  assert.equal(isLoopbackPeer('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackPeer('100.x.y.z'), false);
  assert.equal(isLoopbackPeer(''), false);
  assert.equal(isLoopbackPeer(undefined), false);
});

test('a served request yields the identity serve stamped on it', () => {
  assert.deepEqual(tailnetIdentity(served(), { trustedPeerUids: [0], peerUidFor: AS_TAILSCALED }), { login: OWNER, name: 'Node Owner' });
});

test('the login is compared case-insensitively', () => {
  const authorize = authorizerFor(AS_TAILSCALED);
  assert.equal(authorize(served({ login: 'Owner@Example.COM' })).ok, true);
});

// The two sides of the guard. A refusal alone would pass just as well if the
// authorizer were simply broken, so the allowed case must succeed on the SAME
// headers that the refused case carries.
test('an allowed owner is authenticated, and the identical headers from a NON-loopback peer are not', () => {
  const authorize = authorizerFor(AS_TAILSCALED);

  const throughServe = authorize(served());
  assert.equal(throughServe.ok, true);
  assert.equal(throughServe.login, OWNER);
  assert.equal(throughServe.reason, 'tailnet');

  // Same headers, but the peer reached the port directly instead of through
  // serve, so nothing overwrote what the client sent. `assertSafeBind` permits
  // binding the tailnet IP, which is exactly how this arises.
  const direct = authorize(served({ remoteAddress: '100.x.y.z' }));
  assert.equal(direct.ok, false);
  assert.equal(direct.login, null);
  assert.match(direct.reason, /no tailnet identity/);
});

test('a login outside the allowlist is refused', () => {
  const authorize = authorizerFor(AS_TAILSCALED);
  const verdict = authorize(served({ login: 'someone-else@example.com' }));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /not allowed/);
});

test('an empty allowlist fails closed, so an unknown owner cannot open the door', () => {
  const authorize = authorizerFor(AS_TAILSCALED, []);
  const verdict = authorize(served());
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /disabled/);
});

test('a request with no identity header is refused', () => {
  const authorize = authorizerFor(AS_TAILSCALED);
  assert.equal(authorize(served({ login: null })).ok, false);
  assert.equal(authorize({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }).ok, false);
});

test('two identities joined into one header are refused rather than guessed', () => {
  // Node joins repeated headers with ', '. Serve was measured to REPLACE a
  // client-supplied copy, so this should be unreachable; if it ever is
  // reachable, picking either value would be a coin flip on an authenticator.
  const authorize = authorizerFor(AS_TAILSCALED);
  const verdict = authorize(served({ login: `attacker@evil.com, ${OWNER}` }));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.login, null);
});

test('a malformed request never throws, because this runs on every upgrade', () => {
  const authorize = authorizerFor(AS_TAILSCALED);
  for (const bad of [null, undefined, {}, { headers: null }, { headers: {}, socket: null }]) {
    assert.equal(authorize(bad).ok, false);
  }
});

test('the owning login is read from tailscale status, not configured', async () => {
  const status = JSON.stringify({
    Self: { UserID: 12345 },
    User: { 12345: { LoginName: 'Discovered@Example.com' } },
  });
  const execFileImpl = (_cmd, _args, _opts, cb) => cb(null, status, '');
  assert.equal(await readSelfLogin({ execFileImpl }), 'discovered@example.com');
});

test('an unreadable or unparseable tailscale status yields no login instead of throwing', async () => {
  assert.equal(await readSelfLogin({ execFileImpl: (_c, _a, _o, cb) => cb(new Error('no tailscale')) }), null);
  assert.equal(await readSelfLogin({ execFileImpl: (_c, _a, _o, cb) => cb(null, 'not json', '') }), null);
});

test('HARBOR_TAILNET_LOGINS overrides discovery, and `none` turns tailnet auth off', async () => {
  const execFileImpl = () => assert.fail('discovery must not run when an override is set');
  assert.deepEqual(
    await resolveAllowedLogins({ env: { HARBOR_TAILNET_LOGINS: 'a@x.com, B@X.com' }, execFileImpl, logger: { warn() {} } }),
    ['a@x.com', 'b@x.com'],
  );
  assert.deepEqual(
    await resolveAllowedLogins({ env: { HARBOR_TAILNET_LOGINS: 'none' }, execFileImpl, logger: { warn() {} } }),
    [],
  );
});

test('with no override the node owner is allowed, and a failed lookup allows nobody', async () => {
  const ok = (_c, _a, _o, cb) => cb(null, JSON.stringify({ Self: { UserID: 7 }, User: { 7: { LoginName: OWNER } } }), '');
  assert.deepEqual(await resolveAllowedLogins({ env: {}, execFileImpl: ok, logger: { warn() {} } }), [OWNER]);

  const broken = (_c, _a, _o, cb) => cb(new Error('tailscaled down'));
  assert.deepEqual(await resolveAllowedLogins({ env: {}, execFileImpl: broken, logger: { warn() {} } }), []);
});

// The hole found by driving the LIVE server on 2026-08-02: a handwritten
// identity header sent straight to 127.0.0.1:8787 was accepted, because the
// peer genuinely was loopback. Any local process can open that port, including
// one running as a user that cannot read the 0600 token file, so bare loopback
// would have granted a non-owner exactly what the token denied them.
test('a forged header from another local user is refused, and the identical header from tailscaled is not', () => {
  const forged = authorizerFor(AS_ANOTHER_LOCAL_USER)(served());
  assert.equal(forged.ok, false, 'a non-tailscaled local peer must not be able to assert an identity');
  assert.match(forged.reason, /no tailnet identity/);

  // Two-sided: the SAME request, owned by tailscaled, must still work. Without
  // this the refusal above would pass just as well if the feature were dead.
  assert.equal(authorizerFor(AS_TAILSCALED)(served()).ok, true);
});

test('an owner that cannot be determined is untrusted, not assumed', () => {
  assert.equal(authorizerFor(UNKNOWN_OWNER)(served()).ok, false);
});

test('a peer-uid lookup that throws is untrusted rather than fatal', () => {
  const explodes = () => { throw new Error('/proc is not readable'); };
  assert.equal(authorizerFor(explodes)(served()).ok, false);
});

test('the peer uid is read from /proc by matching the port pair', () => {
  const { readPeerUid } = require('../../src/server/transport/tailnet-identity.js');
  // Our side: localPort 8787, remotePort 54321. The PEER's row therefore has
  // local port D431 (54321) and remote port 2253 (8787).
  const table = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:D431 0100007F:2253 01 00000000:00000000 00:00000000 00000000     0        0 12345',
    '   1: 0100007F:BEEF 0100007F:CAFE 01 00000000:00000000 00:00000000 00000000  1000        0 12346',
  ].join('\n');
  const readFileSync = (file) => { if (file.endsWith('net/tcp')) return table; throw new Error('ENOENT'); };
  assert.equal(readPeerUid({ localPort: 8787, remotePort: 54321, readFileSync }), 0);

  // No matching row means the owner is unknown, which callers treat as untrusted.
  assert.equal(readPeerUid({ localPort: 9999, remotePort: 1111, readFileSync }), null);
  assert.equal(readPeerUid({ localPort: null, remotePort: null, readFileSync }), null);
});
