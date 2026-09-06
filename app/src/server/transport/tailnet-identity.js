'use strict';

const { execFile } = require('node:child_process');

// ---------------------------------------------------------------------------
// Why a request HEADER is allowed to be an authenticator here
// ---------------------------------------------------------------------------
// `tailscale serve` terminates the tailnet connection and stamps the caller's
// identity onto the request it proxies to us. Two measured facts make that
// trustworthy, both verified against this tailnet on 2026-08-02:
//
//   1. Serve OVERWRITES a client-supplied copy. A request sent through the
//      tailnet URL carrying `Tailscale-User-Login: attacker@evil.com` arrived
//      at the listener as the real login. Twice: on a plain GET, and on the
//      WebSocket upgrade.
//   2. The identity rides the WEBSOCKET UPGRADE, which is where harbor-server
//      actually authenticates. Verify that over HTTP/1.1 (`curl --http1.1`):
//      curl negotiates HTTP/2 by default, h2 FORBIDS `Connection: Upgrade`, so
//      an h2 probe lands on the ordinary request handler and proves nothing
//      about the upgrade path. The first run of that test was void for exactly
//      this reason.
//
// So the chain is: Tailscale's control plane authenticates the DEVICE before a
// packet can route to this node at all, serve stamps who it is, and we bind
// loopback so nothing else can reach the port. A bearer token on top of that
// guards an already-authenticated channel, at the price of moving a
// 64-character secret onto a phone by hand, which in practice meant pasting it
// through a chat message to yourself. That is a worse secret-handling story
// than not having the secret.
//
// TWO STRUCTURAL GUARDS, because loopback alone is NOT enough. The header only
// certifies itself when SERVE is the one that wrote it, so we check that the
// connection actually came from serve:
//
//   * The peer must be loopback. `assertSafeBind` also permits binding the
//     tailnet IP directly, and on that path a tailnet peer reaches the port
//     WITHOUT passing through serve and may send any header it likes.
//   * The peer socket must be OWNED BY THE UID TAILSCALED RUNS AS. Loopback on
//     its own was measured to be forgeable on 2026-08-02: a request sent
//     straight to 127.0.0.1:8787 carrying a handwritten
//     `Tailscale-User-Login` was accepted, because the peer really was
//     loopback. Any local process can open that port, including one running as
//     a user that CANNOT read the 0600 token file, so trusting bare loopback
//     would have handed a non-owner a way in that the token denied them. The
//     peer's uid comes from /proc/net/tcp, where a connection's owner cannot be
//     spoofed by the connecting process.
//
// Anything unrecognised falls back to the token: this fails closed.

const LOGIN_HEADER = 'tailscale-user-login';
const NAME_HEADER = 'tailscale-user-name';

// /proc/net/tcp columns: sl local_address rem_address st ... uid ...
const PROC_UID_COLUMN = 7;

function portHex(port) {
  return Number(port).toString(16).toUpperCase().padStart(4, '0');
}

function portOf(addressField) {
  const colon = String(addressField).lastIndexOf(':');
  return colon < 0 ? null : String(addressField).slice(colon + 1).toUpperCase();
}

// The uid that owns the OTHER end of this connection. Identified by the port
// pair, which is unique for an established loopback connection: the peer's
// local port is our remote port and vice versa. Returns null when the owner is
// not unambiguous, which callers must treat as untrusted.
function readPeerUid({ localPort, remotePort, procRoot = '/proc', readFileSync = require('node:fs').readFileSync } = {}) {
  if (!localPort || !remotePort) return null;
  const wantLocal = portHex(remotePort);
  const wantRemote = portHex(localPort);
  const uids = new Set();
  for (const table of ['net/tcp', 'net/tcp6']) {
    let contents;
    try { contents = readFileSync(`${procRoot}/${table}`, 'utf8'); } catch { continue; }
    for (const line of contents.split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length <= PROC_UID_COLUMN) continue;
      if (portOf(parts[1]) !== wantLocal) continue;
      if (portOf(parts[2]) !== wantRemote) continue;
      uids.add(Number(parts[PROC_UID_COLUMN]));
    }
  }
  return uids.size === 1 ? [...uids][0] : null;
}

// The uid tailscaled runs as, discovered rather than assumed, falling back to
// root. A wrong answer here only ever costs a token prompt, never access.
function readTailscaledUids({ procRoot = '/proc', fs = require('node:fs') } = {}) {
  const uids = new Set();
  let entries = [];
  try { entries = fs.readdirSync(procRoot); } catch { return [0]; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (fs.readFileSync(`${procRoot}/${entry}/comm`, 'utf8').trim() !== 'tailscaled') continue;
      const status = fs.readFileSync(`${procRoot}/${entry}/status`, 'utf8');
      const uid = status.match(/^Uid:\s*(\d+)/m)?.[1];
      if (uid !== undefined) uids.add(Number(uid));
    } catch { /* the process exited between readdir and read; skip it */ }
  }
  return uids.size ? [...uids] : [0];
}

function isLoopbackPeer(remoteAddress) {
  if (typeof remoteAddress !== 'string' || !remoteAddress) return false;
  // Node reports an IPv4 peer on a dual-stack socket as `::ffff:127.0.0.1`.
  const addr = remoteAddress.startsWith('::ffff:') ? remoteAddress.slice(7) : remoteAddress;
  return addr === '::1' || addr.startsWith('127.');
}

function headerValue(request, name) {
  const raw = request?.headers?.[name];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Node joins REPEATED headers with ', '. A login cannot contain a comma, so a
  // comma here would mean two identities arrived and we cannot say which one
  // serve wrote. Refuse rather than pick. Serve was measured to replace rather
  // than append, so this is a belt over a proven brace.
  if (trimmed.includes(',')) return null;
  return trimmed;
}

// The identity of the caller, or null when this request did not come through
// `tailscale serve`. Never throws: it runs on every request and on every socket
// upgrade.
function tailnetIdentity(request, { trustedPeerUids = [0], peerUidFor = readPeerUid } = {}) {
  const socket = request?.socket;
  if (!isLoopbackPeer(socket?.remoteAddress)) return null;
  // Loopback says the packet came from this machine. This says it came from
  // TAILSCALED, which is what makes the header self-certifying.
  let uid = null;
  try {
    uid = peerUidFor({ localPort: socket?.localPort, remotePort: socket?.remotePort });
  } catch { return null; }
  if (uid === null || !trustedPeerUids.includes(uid)) return null;
  const login = headerValue(request, LOGIN_HEADER);
  if (!login) return null;
  return { login: login.toLowerCase(), name: headerValue(request, NAME_HEADER) };
}

function normalizeLogins(logins) {
  return new Set(
    (Array.isArray(logins) ? logins : [])
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean),
  );
}

// Returns `(request) => { ok, login, name, reason }`. An empty allowlist means
// tailnet authentication is OFF and every caller falls back to the token, which
// is the honest behaviour when we could not learn who owns this node.
function createTailnetAuthorizer({ allowedLogins = [], trustedPeerUids = null, peerUidFor = readPeerUid } = {}) {
  const allowed = normalizeLogins(allowedLogins);
  const uids = trustedPeerUids || readTailscaledUids();
  return function authorize(request) {
    const identity = tailnetIdentity(request, { trustedPeerUids: uids, peerUidFor });
    if (!identity) return { ok: false, login: null, name: null, reason: 'no tailnet identity on this request' };
    if (!allowed.size) return { ok: false, ...identity, reason: 'tailnet authentication is disabled (no allowed logins)' };
    if (!allowed.has(identity.login)) return { ok: false, ...identity, reason: `tailnet login '${identity.login}' is not allowed` };
    return { ok: true, ...identity, reason: 'tailnet' };
  };
}

// The login that owns THIS node, read from tailscaled. Discovered rather than
// configured so no real address is baked into the repo, and so a fresh install
// on someone else's tailnet allows its own owner and nobody else.
function readSelfLogin({ execFileImpl = execFile, timeout = 5000 } = {}) {
  return new Promise((resolve) => {
    try {
      execFileImpl('tailscale', ['status', '--json'], { timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
        if (error) { resolve(null); return; }
        try {
          const parsed = JSON.parse(String(stdout));
          const login = parsed?.User?.[String(parsed?.Self?.UserID)]?.LoginName;
          resolve(typeof login === 'string' && login.trim() ? login.trim().toLowerCase() : null);
        } catch { resolve(null); }
      });
    } catch { resolve(null); }
  });
}

// `HARBOR_TAILNET_LOGINS` is a comma-separated allowlist; the literal `none`
// disables tailnet auth and restores token-only behaviour. With no override we
// allow the node's own owner.
async function resolveAllowedLogins({ env = process.env, execFileImpl = execFile, logger = console } = {}) {
  const override = String(env.HARBOR_TAILNET_LOGINS || '').trim();
  if (override) {
    if (override.toLowerCase() === 'none') {
      logger.warn?.('harbor-server: tailnet authentication disabled by HARBOR_TAILNET_LOGINS=none; a token is required');
      return [];
    }
    return [...normalizeLogins(override.split(','))];
  }
  const self = await readSelfLogin({ execFileImpl });
  if (!self) {
    logger.warn?.('harbor-server: could not read this node\'s Tailscale login; tailnet authentication is off and a token is required');
    return [];
  }
  return [self];
}

module.exports = {
  LOGIN_HEADER,
  NAME_HEADER,
  isLoopbackPeer,
  readPeerUid,
  readTailscaledUids,
  tailnetIdentity,
  createTailnetAuthorizer,
  readSelfLogin,
  resolveAllowedLogins,
};
