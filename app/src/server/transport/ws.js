'use strict';

const { WebSocketServer, WebSocket } = require('ws');
const { authorizeMethod, tokenMatches } = require('./auth.js');

// A per-client outbound queue, bounded by BOTH item count and BYTES.
//
// The item count alone was never a memory bound. A `transcript:update` replace
// payload measures 0.19 to 0.50 MB against Pat's real transcripts, so 256 of
// them is ~125MB retained for ONE client that has stopped draining, and a phone
// that walks out of range without a close frame stops draining permanently.
//
// Payloads are serialized ON ENQUEUE rather than in pump(). That is what makes
// the byte accounting exact instead of estimated, and it removes the second
// stringify that used to happen at send time. The tradeoff is a wasted
// serialize for a frame that is later evicted; frames are the small payloads
// (a screen of ANSI), so the trade is worth it in both directions.
// Which pushes supersede their own predecessors, and what identifies "their
// own". A transcript update is per SESSION, so two sessions updating must not
// collapse into one; the sidebar is a single global snapshot. Every other
// channel returns null and keeps today's append-only behaviour, deliberately:
// `send:status` is a sequence of distinct events, and terminal frames already
// have their own eviction rule.
// ONLY A WHOLE-STATE PAYLOAD MAY SUPERSEDE ITS PREDECESSOR, and `transcript:update`
// is not always one (live-caught by Pat on his phone, 2026-08-07).
//
// The channel carries TWO shapes. `{ replace: blocks }` is the full live block
// list and a newer one genuinely makes an older one redundant. But
// `{ append: [...], changed: [...] }` is a DELTA, emitted by
// providers/transcript.js when new blocks arrive, which is precisely what
// happens when a message is sent. Coalescing those dropped the earlier append
// on the floor: Pat sent a second message about fifteen seconds after the
// first, the queue replaced append A with append B, and the blocks in A were
// never delivered to that client at all. The message HAD landed, so it was in
// the transcript and showed on desktop (which is on IPC and never coalesces);
// on the phone it simply never appeared, and no later event repaired it,
// because an append is only ever sent once.
//
// The flood this was built for is unaffected: the burst measured at 48 updates
// in 20 seconds is the watcher's belt poll re-emitting `replace`, and those
// still collapse to one slot.
function coalesceKey(channel, args) {
  if (channel === 'transcript:update') {
    const payload = args?.[0];
    if (!payload?.sessionId) return null;
    // A `replace` supersedes; an `append` MERGES (see mergePayloads). Both get
    // a key, so both cost one queue slot; what differs is how the slot is
    // combined. Refusing a key to appends, which is what the first version of
    // this fix did, made them accumulate without bound, and an unbounded
    // backlog on a slow link is the exact failure this whole file exists to
    // prevent.
    if (Array.isArray(payload.replace)) return `transcript:update:${payload.sessionId}`;
    if (Array.isArray(payload.append)) return `transcript:update:append:${payload.sessionId}`;
    return null;
  }
  if (channel === 'sidebar:update') return 'sidebar:update';
  return null;
}

// How two payloads sharing a key combine. A whole-state snapshot REPLACES,
// because the newer one already contains everything the older said. A delta
// CONCATENATES, because each carries blocks the other does not, and dropping
// either loses messages permanently (Pat, 2026-08-07: a second message sent
// fifteen seconds after the first never appeared on his phone).
//
// Returns null when the two cannot be combined, and the caller then keeps them
// as separate items rather than guessing.
function mergePayloads(channel, previous, incoming) {
  if (channel !== 'transcript:update') return incoming;
  const a = previous?.args?.[0];
  const b = incoming?.args?.[0];
  if (!a || !b) return incoming;
  if (Array.isArray(b.replace)) return incoming;
  if (!Array.isArray(a.append) || !Array.isArray(b.append)) return null;
  const merged = {
    ...a,
    ...b,
    append: [...a.append, ...b.append],
    changed: [...(a.changed || []), ...(b.changed || [])],
  };
  return { ...incoming, args: [merged, ...incoming.args.slice(1)] };
}

class ClientQueue {
  constructor({ limit = 256, maxBytes = 8 * 1024 * 1024, logger = console, clientId = 'unknown' } = {}) {
    this.limit = limit; this.maxBytes = maxBytes; this.logger = logger; this.clientId = clientId;
    this.items = []; this.droppedFrames = 0; this.bytes = 0; this.coalesced = 0;
  }
  get length() { return this.items.length; }
  _full(incoming) {
    return this.items.length >= this.limit || this.bytes + incoming > this.maxBytes;
  }
  // A SNAPSHOT SUPERSEDES ITS PREDECESSOR, so a backlog of them is waste, not
  // history (live-caught 2026-08-06). `transcript:update` and `sidebar:update`
  // each carry the WHOLE state, and the transcript watcher emits a burst of
  // them per change: measured against Pat's running machine, 48 identical
  // updates for one session in 20 seconds, in bursts of ~13. At 0.19-0.50 MB
  // each that is most of the 8MB cap per burst. A localhost client drains fast
  // enough to survive; his phone over Tailscale did not, and the overflow path
  // below CLOSES a non-frame channel, so the phone connected, flooded,
  // got 1013 "client too slow", reconnected, and flapped. It read as
  // "Disconnected" the instant it connected.
  //
  // Coalescing on a key makes the storm cost one queue slot instead of
  // thirteen, and it is LOSSLESS precisely because these payloads are
  // snapshots: whoever receives the newest has missed nothing. The replacement
  // keeps its predecessor's POSITION so a client cannot see state go backwards
  // relative to other channels.
  enqueue(channel, payload, key = null) {
    const text = JSON.stringify(payload);
    const bytes = Buffer.byteLength(text);
    // The payload is retained so a later item sharing this key can be MERGED
    // into it rather than replacing it.
    if (key) {
      const at = this.items.findIndex((item) => item.key === key);
      if (at >= 0) {
        const combined = mergePayloads(channel, this.items[at].payload, payload);
        if (combined) {
          const mergedText = JSON.stringify(combined);
          const mergedBytes = Buffer.byteLength(mergedText);
          this.bytes += mergedBytes - this.items[at].bytes;
          this.items[at] = { channel, text: mergedText, bytes: mergedBytes, key, payload: combined };
          this.coalesced += 1;
          return true;
        }
      }
    }
    // Evict frames first: they are the one channel whose loss is recoverable,
    // because the next frame redraws the screen anyway.
    while (this._full(bytes)) {
      const frame = this.items.findIndex((item) => item.channel === 'terminal:frame');
      if (frame < 0) break;
      this.bytes -= this.items[frame].bytes;
      this.items.splice(frame, 1);
      this.noteDrop();
    }
    // An empty queue always accepts, even an oversized payload: the byte cap
    // bounds a BACKLOG, and refusing here would permanently disconnect a client
    // whose very first push happens to be large, which is a worse failure than
    // holding it once.
    if (this.items.length && this._full(bytes)) {
      if (channel === 'terminal:frame') { this.noteDrop(); return false; }
      return false;
    }
    this.items.push({ channel, text, bytes, key, payload });
    this.bytes += bytes;
    return true;
  }
  shift() {
    const item = this.items.shift();
    if (item) this.bytes -= item.bytes;
    return item;
  }
  noteDrop() {
    this.droppedFrames += 1;
    this.logger.warn(`harbor-server: client ${this.clientId} dropped terminal frames: ${this.droppedFrames}`);
  }
}

function requestToken(request) {
  const bearer = String(request.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) return bearer;
  return new URL(request.url, 'http://harbor.local').searchParams.get('token');
}

// ---------------------------------------------------------------------------
// Cross-Site WebSocket Hijacking.
// ---------------------------------------------------------------------------
// The browser `WebSocket` constructor is NOT subject to the same-origin
// policy: any page the phone's owner happens to have open in another tab can
// run `new WebSocket('ws://127.0.0.1:8787/ws')` (or the tailnet equivalent),
// and the browser will connect using whatever network position it already
// has, with no prompt and no CORS preflight. The bearer-token check further
// down still gates every MUTATING method, but `remote-safe` methods
// (`sidebar:get-state`, `transcript:open`, ...) require nothing at all by
// design, so without an Origin check any web page the owner visits is a free
// read of every project name, session id, and full conversation transcript
// on the machine. This is checked on the UPGRADE, before `wss.handleUpgrade`
// runs, exactly like the pathname check just above it: a socket that never
// should have been accepted is destroyed before it becomes a live connection.
//
// This is deliberately independent of `assertSafeBind`/the token/tailnet
// auth. Bind address restricts WHERE this process listens; Origin restricts
// WHO is allowed to have asked, which bind address cannot see at all (a
// request that reached this handler already passed the bind check, since the
// socket could not otherwise exist).
//
// The allowlist is the server's OWN origins, derived from the live socket
// rather than hardcoded: `server.address()` returns exactly the host/port
// this process is actually bound to (already vetted by `assertSafeBind`
// before `listen()` ever ran, so trusting it here adds no new exposure), plus
// the fixed loopback aliases a browser may use to reach that same bind
// (127.0.0.1 / localhost / ::1 do not appear in `server.address()` when bound
// to one specific form of it), plus any `selfOriginHosts` the composition
// root discovered belong to this node by another route (setup/mobile.md's
// recommended phone setup fronts a loopback bind with `tailscale serve`,
// which terminates HTTPS at the tailnet's MagicDNS name on port 443, a
// different host AND port than the one this process is listening on, so a
// bind-only check would refuse that exact documented flow).
//
// A MISSING Origin header IS ALLOWED, and that is load-bearing, not an
// oversight: a real browser ALWAYS sends Origin on a WebSocket handshake
// (there is no way for page JS to suppress it), so the attack this guards
// against is impossible without one. Non-browser clients (curl, a native
// app, some installed/standalone PWA shells) send no Origin at all, and
// refusing them would break those legitimate clients while blocking nothing
// a browser-based attacker could not already be blocked from some other way.
// Do NOT "harden" this to require Origin; that trades a real phone for
// stopping an attack that was never reachable through this path.
function isLoopbackHostname(hostname) {
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost';
}

// Parses the `Origin` header into the pieces that matter. Returns null for
// anything that is not a clean `scheme://host[:port]` origin (a real browser
// handshake never sends anything else), so a malformed header refuses rather
// than partially matching something.
function parseOrigin(origin) {
  if (typeof origin !== 'string' || !origin.trim()) return null;
  let url;
  try { url = new URL(origin); }
  catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // Unlike a bare IPv6 address, `URL#hostname` keeps the `[]` wrapper on an
  // IPv6 literal (measured: `new URL('http://[::1]:8787').hostname` is
  // `'[::1]'`, not `'::1'`). Stripped here so it compares equal to both
  // `isLoopbackHostname`'s bare form and `server.address().address`, which
  // Node reports WITHOUT brackets.
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return { hostname: hostname.toLowerCase(), port };
}

// True when `origin` names THIS server. `boundHost`/`boundPort` come from the
// live listening socket; `selfOriginHosts` are extra hostnames (typically the
// Tailscale MagicDNS name) that answer for this server on a port this process
// is not itself bound to, and are therefore matched by hostname alone.
function isSelfOrigin(origin, { boundHost = null, boundPort = null, selfOriginHosts = [] } = {}) {
  const parsed = parseOrigin(origin);
  if (!parsed) return false;
  const port = boundPort === null ? null : String(boundPort);
  if (port !== null && parsed.port === port) {
    if (isLoopbackHostname(parsed.hostname)) return true;
    if (boundHost && parsed.hostname === String(boundHost).toLowerCase()) return true;
  }
  return selfOriginHosts.some((host) => host && parsed.hostname === String(host).toLowerCase());
}

// The one decision this file makes about an Origin header: allow when absent
// (see the comment above), otherwise allow only when it names this server.
function originAllowed(originHeader, ctx) {
  if (!originHeader) return true;
  return isSelfOrigin(originHeader, ctx);
}

// How often to prove a client is still there, and how long a silent socket
// lives. A phone that walks out of range, sleeps, or hands off between cell and
// wifi does NOT send a close frame: the TCP connection is half-open and the
// server sees nothing at all. Without this probe that client's push listener,
// its queue and everything it opened live for the life of the process, which is
// precisely how a vanished viewer used to pin transcripts forever.
const HEARTBEAT_MS = 30_000;

function createWebSocketTransport({
  server, router, token, tailnetAuth = null, path = '/ws',
  queueLimit = 256, queueMaxBytes, onClientGone = null,
  heartbeatMs = HEARTBEAT_MS, logger = console, selfOriginHosts = [],
}) {
  const wss = new WebSocketServer({ noServer: true });
  let nextClient = 0;
  const upgrade = (request, socket, head) => {
    if (new URL(request.url, 'http://harbor.local').pathname !== path) { socket.destroy(); return; }
    // Read fresh off the live socket every time rather than once at transport
    // creation: `listen()` runs AFTER this function returns (composeServer
    // builds the transport, then the caller decides host/port, including
    // tests binding port 0 for a random one), so `server.address()` is the
    // only value that is ever current.
    const bound = server.address();
    if (!originAllowed(request.headers.origin, { boundHost: bound?.address ?? null, boundPort: bound?.port ?? null, selfOriginHosts })) {
      logger.warn?.(`harbor-server: refused websocket upgrade with foreign Origin '${request.headers.origin}'`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  };
  server.on('upgrade', upgrade);
  wss.on('connection', (ws, request) => {
    const clientId = `${request.socket.remoteAddress || 'unknown'}#${++nextClient}`;
    // Either proof of identity is sufficient, and the tailnet one is checked on
    // the UPGRADE request because that is where this socket's identity is
    // decided; `tailscale serve` stamps it there as well as on plain GETs.
    // See transport/tailnet-identity.js for why a header can be trusted at all.
    const viaToken = tokenMatches(requestToken(request), token);
    const tailnet = viaToken ? null : tailnetAuth?.(request) || null;
    const authenticated = viaToken || Boolean(tailnet?.ok);
    if (tailnet?.ok) logger.info?.(`harbor-server: client ${clientId} authenticated as ${tailnet.login} over the tailnet`);
    const queue = new ClientQueue({ limit: queueLimit, maxBytes: queueMaxBytes, logger, clientId });
    let sending = false;
    const pump = () => {
      if (sending || ws.readyState !== WebSocket.OPEN) return;
      const item = queue.shift(); if (!item) return;
      sending = true;
      ws.send(item.text, (error) => {
        sending = false;
        if (error) {
          // A bare ws.close() sends NO close frame payload at all, which is
          // exactly what code 1005 ("no status received") means on the far
          // end: it told Pat nothing broke, when a real socket write error
          // (ECONNRESET, timeout, EPIPE...) caused this (live-caught
          // 2026-08-07, his phone flapping every ~4s with only "1005" to go
          // on). 1011 is the generic "server hit an internal error" code;
          // the reason carries the actual error so the NEXT flap is diagnosable.
          logger.warn?.(`harbor-server: send to ${clientId} failed: ${error?.message || error}`);
          ws.close(1011, String(error?.message || error).slice(0, 123));
        } else pump();
      });
    };
    // A CLIENT IS CLOSED ONCE, AND SAID SO ONCE.
    //
    // The overflow path below both logs and closes, and it ran for EVERY
    // subsequent enqueue: `ws.close()` only starts a handshake, so the socket
    // stays non-OPEN (never draining) while work already in flight keeps
    // arriving, and each arrival failed the same way. One client produced
    // 15,560 identical lines in Pat's journal on 2026-08-08, another 14,052,
    // at ~110 a second. That is not merely noise: it buried the ONE line that
    // said what actually happened, and made a client-side request storm look
    // like a server-side flood, which is where a night of diagnosis went.
    //
    // The verdict is recorded once. Everything after it is dropped in silence,
    // because the socket is already going away and there is nobody to tell.
    let closing = false;
    const enqueue = (channel, payload, key = null) => {
      if (closing) return;
      if (!queue.enqueue(channel, payload, key)) {
        if (channel !== 'terminal:frame') {
          closing = true;
          logger.warn?.(`harbor-server: client ${clientId} overflowed its queue on channel '${channel}' (${queue.length} items, ${queue.bytes} bytes); closing 1013`);
          ws.close(1013, 'client too slow');
        }
        return;
      }
      pump();
    };
    const unsubscribe = router.onPush((channel, ...args) => {
      enqueue(channel, { type: 'push', channel, args }, coalesceKey(channel, args));
    });
    // ONE teardown path for every way a client can leave: a clean close, a
    // dropped socket, and a heartbeat timeout (which calls terminate(), and
    // terminate emits 'close'). Anything this client acquired is released here.
    // Logged unconditionally (2026-08-07): a client can flap for reasons other
    // than the overflow path above (heartbeat timeout, abrupt network drop),
    // and there was previously NO server-side record of any of those, only of
    // a successful tailnet auth. A repeating close is invisible without this.
    ws.once('close', (code, reason) => {
      logger.info?.(`harbor-server: client ${clientId} closed (code ${code}${reason ? `, ${reason}` : ''})`);
      unsubscribe();
      try { onClientGone?.(clientId); }
      catch (error) { logger.warn?.(`harbor-server: releasing resources for ${clientId} failed: ${error?.message || error}`); }
    });
    // Liveness: pong marks the socket alive; a client that misses a whole
    // interval is terminated, which runs the teardown above.
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', async (bytes) => {
      let message;
      try { message = JSON.parse(bytes.toString()); } catch { enqueue('rpc:error', { type: 'response', id: null, error: 'invalid JSON' }); return; }
      const { id = null, method, payload } = message || {};
      try {
        authorizeMethod(method, { authenticated });
        const result = await router.call(method, payload, { source: 'ws', authenticated, clientId });
        enqueue('rpc:response', { type: 'response', id, result });
      } catch (error) { enqueue('rpc:error', { type: 'response', id, error: String(error?.message || error) }); }
    });
  });
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (client.isAlive === false) { client.terminate(); continue; }
      client.isAlive = false;
      try { client.ping(); } catch { /* already going away; terminate next tick */ }
    }
  }, heartbeatMs);
  heartbeat.unref?.();
  return { wss, close: () => new Promise((resolve) => {
    clearInterval(heartbeat);
    server.off('upgrade', upgrade);
    for (const client of wss.clients) client.terminate();
    wss.close(resolve);
  }) };
}

module.exports = {
  ClientQueue, coalesceKey, mergePayloads, createWebSocketTransport,
  parseOrigin, isSelfOrigin, originAllowed,
};
