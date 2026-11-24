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
//
// ONE KEY, ONE COPY, LATEST WINS (2026-10-21 audit). Concatenating `changed`
// kept every version of a block side by side, so a slow phone's slot grew by a
// whole image-bearing prompt per token tick. The merge now replays the two
// deltas in the order the shared reducer applies them (removed, changed,
// patched, append; first delta, then second) into one copy per key, so the
// merged item applies exactly like the two in sequence and is no bigger than
// the newest state. Keyless blocks are kept as they are, in order.
function mergePayloads(channel, previous, incoming) {
  if (channel !== 'transcript:update') return incoming;
  const a = previous?.args?.[0];
  const b = incoming?.args?.[0];
  if (!a || !b) return incoming;
  if (Array.isArray(b.replace)) return incoming;
  if (!Array.isArray(a.append) || !Array.isArray(b.append)) return null;
  const appended = new Map(); // key -> block, in first-append order (where the reducer draws it)
  const changed = new Map(); // key -> whole block
  const patched = new Map(); // key -> merged patch
  let keyless = 0;
  const keyOf = (block) => (block?.key ? `k:${block.key}` : `n:${keyless++}`);
  const take = (delta) => {
    for (const key of delta.removed || []) {
      appended.delete(`k:${key}`); changed.delete(`k:${key}`); patched.delete(`k:${key}`);
    }
    for (const block of delta.changed || []) {
      const key = keyOf(block);
      if (appended.has(key)) appended.set(key, block);
      else { changed.set(key, block); patched.delete(key); }
    }
    for (const patch of delta.patched || []) {
      const key = keyOf(patch);
      if (appended.has(key)) appended.set(key, { ...appended.get(key), ...patch });
      else if (changed.has(key)) changed.set(key, { ...changed.get(key), ...patch });
      else patched.set(key, { ...patched.get(key), ...patch });
    }
    for (const block of delta.append) {
      const key = keyOf(block);
      appended.set(key, block);
      changed.delete(key); patched.delete(key);
    }
  };
  take(a);
  take(b);
  const removed = [...new Set([...(a.removed || []), ...(b.removed || [])])];
  const merged = { ...a, ...b, append: [...appended.values()], changed: [...changed.values()] };
  delete merged.patched;
  delete merged.removed;
  if (patched.size) merged.patched = [...patched.values()];
  if (removed.length) merged.removed = removed;
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
    this.dropSupersededDeltas(key);
    // The payload is retained so a later item sharing this key can be MERGED
    // into it rather than replacing it.
    if (key) {
      const slot = this.items.find((item) => item.key === key);
      if (slot) {
        const combined = mergePayloads(channel, slot.payload, payload);
        if (combined) {
          const mergedText = JSON.stringify(combined);
          const mergedBytes = Buffer.byteLength(mergedText);
          // THE CAP HOLDS AFTER A MERGE TOO (2026-10-21 audit). This path used
          // to return true before any bound was checked, so one slot could
          // grow without limit (a 1 KiB queue held 18.5 KB in one merged
          // delta). Frames go first, as below; then the empty-queue exception
          // admits one oversized PAYLOAD, never an oversized backlog built by
          // merging: alone, the slot may be as large as the incoming payload
          // by itself and no larger. Otherwise it is refused, which closes the
          // client once with 1013 and its reconnect gets a fresh snapshot.
          while (this.bytes - slot.bytes + mergedBytes > this.maxBytes) {
            const frame = this.items.findIndex((item) => item.channel === 'terminal:frame');
            if (frame < 0) break;
            this.bytes -= this.items[frame].bytes;
            this.items.splice(frame, 1);
            this.noteDrop();
          }
          const fits = this.bytes - slot.bytes + mergedBytes <= this.maxBytes;
          const aloneAndNoBigger = this.items.length === 1 && mergedBytes <= bytes;
          if (!fits && !aloneAndNoBigger) return false;
          this.bytes += mergedBytes - slot.bytes;
          this.items[this.items.indexOf(slot)] = { channel, text: mergedText, bytes: mergedBytes, key, payload: combined };
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
  // A NEWER SNAPSHOT ALSO SUPERSEDES THE DELTAS QUEUED FOR ITS SESSION
  // (2026-10-06, Pat: "messages appear to be sending and receiving twice").
  // A replace takes an older replace's POSITION, which is ahead of any append
  // queued after that older slot. Those appends hold blocks the new replace
  // already contains, so delivering them after it drew each of those blocks a
  // second time. The phone opens every chat twice and each open broadcasts a
  // replace, so a replace overtaking a queued append was routine. Dropping them
  // is lossless: the replace carries every block and the newest header.
  dropSupersededDeltas(key) {
    const prefix = 'transcript:update:';
    if (!key?.startsWith(prefix) || key.startsWith(`${prefix}append:`)) return;
    const deltaKey = `${prefix}append:${key.slice(prefix.length)}`;
    this.items = this.items.filter((item) => {
      if (item.key !== deltaKey) return true;
      this.bytes -= item.bytes;
      this.coalesced += 1;
      return false;
    });
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

// One log line per failure, never a wall: a reason is clipped so a hostile or
// garbled frame cannot write an arbitrarily long line into server.log.
function boundedReason(error) {
  return String(error?.message || error).replace(/\s+/g, ' ').slice(0, 200);
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

// How long a resolved MagicDNS allowlist stays trusted before the next upgrade
// re-asks. Short enough that a server started before Tailscale comes up heals
// itself within a phone reconnect or two; long enough that a busy night of
// reconnects does not shell out to `tailscale status` on every handshake.
// An EMPTY result uses a shorter TTL so recovery after Tailscale comes up is
// not stuck behind the healthy-path cache.
const SELF_ORIGIN_HOSTS_TTL_MS = 30_000;
const SELF_ORIGIN_HOSTS_EMPTY_TTL_MS = 2_000;
// How long the last GOOD host list outlives reads that come back empty (2026-11-24). The resolver answers a
// `tailscale status` timeout with an empty list, not an error, so a loaded machine (a 4.6 s event-loop stall, a 5 s
// status deadline) made this server refuse its own phone as a "foreign Origin" for two and a half minutes. A read that
// failed is not evidence the node lost its name; ten minutes of empty reads is.
const SELF_ORIGIN_HOSTS_STALE_GRACE_MS = 600_000;

// Factored out (2026-09-19) so `server/http/request-guard.js` can ask
// the same question ("what hostnames answer for this server right now") that
// the WebSocket upgrade check asks, without either shelling out to
// `tailscale status` on every single HTTP request or the two callers fighting
// over one shared timer. Each caller gets its OWN cache instance (its own
// `cachedHosts`/`cachedAt` closure state) but both are handed the SAME
// `resolveSelfOriginHosts` closure by compose.js, so they can never disagree
// about what "self" means, only about when they last refreshed it.
function createSelfOriginHostsCache({
  resolveSelfOriginHosts = null,
  initial = [],
  ttlMs = SELF_ORIGIN_HOSTS_TTL_MS,
  emptyTtlMs = SELF_ORIGIN_HOSTS_EMPTY_TTL_MS,
  staleGraceMs = SELF_ORIGIN_HOSTS_STALE_GRACE_MS,
  now: clock = Date.now,
} = {}) {
  let cachedHosts = Array.isArray(initial) ? initial : [];
  let cachedAt = resolveSelfOriginHosts ? 0 : clock();
  let goodAt = cachedHosts.length ? clock() : 0;
  return async function currentSelfOriginHosts() {
    if (typeof resolveSelfOriginHosts !== 'function') return cachedHosts;
    const now = clock();
    const ttl = cachedHosts.length === 0 ? emptyTtlMs : ttlMs;
    if (cachedAt && (now - cachedAt) < ttl) return cachedHosts;
    try {
      const answer = await resolveSelfOriginHosts();
      const next = Array.isArray(answer) ? answer : [];
      if (next.length) { cachedHosts = next; goodAt = clock(); }
      // An empty read keeps the last good list inside the grace (a timed-out status call), and is believed past it.
      else if (!goodAt || clock() - goodAt >= staleGraceMs) cachedHosts = [];
    } catch {
      // Fail closed to whatever we last knew (possibly empty): a discovery
      // error must not widen the allowlist, and must not refuse loopback /
      // bound-host origins that never depended on MagicDNS.
    }
    cachedAt = clock();
    return cachedHosts;
  };
}

function createWebSocketTransport({
  server, router, token, tailnetAuth = null, path = '/ws',
  queueLimit = 256, queueMaxBytes, onClientGone = null,
  heartbeatMs = HEARTBEAT_MS, logger = console, selfOriginHosts = [],
  // Live getter: called on each upgrade (result TTL-cached below). compose.js
  // passes one that re-runs MagicDNS discovery so a server that booted before
  // Tailscale was up starts accepting the Serve Origin without a restart.
  // A static `selfOriginHosts` array still works for tests that pin the list.
  resolveSelfOriginHosts = null,
  selfOriginHostsTtlMs = SELF_ORIGIN_HOSTS_TTL_MS,
  selfOriginHostsEmptyTtlMs = SELF_ORIGIN_HOSTS_EMPTY_TTL_MS,
  // (clientId, channel, args) => boolean: whether this client wants this
  // push at all. Absent means every client gets every push, as before; the
  // composition uses it to send each transcript only to the clients holding it.
  deliverPush = null,
}) {
  const wss = new WebSocketServer({ noServer: true });
  let nextClient = 0;
  const currentSelfOriginHosts = createSelfOriginHostsCache({
    resolveSelfOriginHosts,
    initial: selfOriginHosts,
    ttlMs: selfOriginHostsTtlMs,
    emptyTtlMs: selfOriginHostsEmptyTtlMs,
  });

  const upgrade = (request, socket, head) => {
    if (new URL(request.url, 'http://harbor.local').pathname !== path) { socket.destroy(); return; }
    // The http server drops its own socket error listener when it hands over an
    // upgrade, and the origin check below awaits before ws attaches one, so a
    // client resetting mid-handshake would be an unhandled 'error' that kills
    // the whole server. Guard the gap, then hand the socket to ws.
    const onHandshakeError = (error) => {
      logger.warn?.(`harbor-server: websocket handshake socket error: ${boundedReason(error)}`);
      socket.destroy();
    };
    socket.on('error', onHandshakeError);
    // Bound host/port and MagicDNS hosts are both read fresh off live state
    // rather than captured once at transport creation: `listen()` runs AFTER
    // this function returns (composeServer builds the transport, then the
    // caller decides host/port, including tests binding port 0), and Tailscale
    // may come up after the process started.
    void (async () => {
      const bound = server.address();
      const hosts = await currentSelfOriginHosts();
      if (!originAllowed(request.headers.origin, {
        boundHost: bound?.address ?? null,
        boundPort: bound?.port ?? null,
        selfOriginHosts: hosts,
      })) {
        logger.warn?.(`harbor-server: refused websocket upgrade with foreign Origin '${request.headers.origin}'`);
        socket.destroy();
        return;
      }
      if (socket.destroyed) return;
      socket.off('error', onHandshakeError);
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
    })().catch((error) => {
      logger.warn?.(`harbor-server: websocket upgrade failed: ${error?.message || error}`);
      socket.destroy();
    });
  };
  server.on('upgrade', upgrade);
  // An EventEmitter 'error' with no listener throws, and here that would end
  // every phone's connection at once. Logged, never fatal.
  wss.on('error', (error) => logger.warn?.(`harbor-server: websocket server error: ${boundedReason(error)}`));
  wss.on('connection', (ws, request) => {
    const clientId = `${request.socket.remoteAddress || 'unknown'}#${++nextClient}`;
    // ONE BAD FRAME ENDS ONE CONNECTION, NOT THE SERVER (2026-10-21 audit). The
    // ws receiver emits 'error' for a protocol violation (an unmasked or
    // oversized frame, invalid UTF-8), and with no listener that error
    // terminated node: a two-byte invalid frame from any client dropped every
    // phone and cost a full restart. Said once, bounded, and only this socket
    // goes; its 'close' runs the usual teardown below.
    let socketFailed = false;
    ws.on('error', (error) => {
      if (socketFailed) return;
      socketFailed = true;
      logger.warn?.(`harbor-server: client ${clientId} socket error, closing it: ${boundedReason(error)}`);
      ws.terminate();
    });
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
      if (deliverPush && !deliverPush(clientId, channel, args)) return;
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
  parseOrigin, isSelfOrigin, originAllowed, createSelfOriginHostsCache,
};
