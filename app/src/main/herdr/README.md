# herdr bridge (control plane + pane streams)

The Electron main process talks to the stock Herdr 0.7.4 daemon through two
modules. Both are plain Node (CommonJS) with zero dependencies, so they run under
the Electron main process and under `node --test` unchanged.

- `client.js` is the control plane: a newline-delimited JSON request/response
  client over the Unix socket, plus a long-lived `events.subscribe` stream with
  snapshot-seeded replay dedupe.
- `streams.js` is the data plane: a per-pane supervisor that spawns
  `herdr terminal session observe|control` child processes and routes frames and
  input.

Ground truth: `docs/herdr-api.schema.json` (protocol 16, schema_version 1); the client accepts protocols 16 and 17,
`docs/upstream-herdr-docs/socket-api.mdx`, and
`docs/upstream-herdr-docs/persistence-remote.mdx`. Requirements S4, S5, S6, A5,
A6 and ARCHITECTURE-v2 sections 3, 4, 6.

## Transport facts (verified against the running daemon)

1. Normal request/response is **one request per connection**. The server sends
   exactly one response line and then closes the socket. A second request on the
   same socket fails with `EPIPE`. `HerdrClient.request()` therefore opens a
   fresh short-lived connection per call.
2. `events.subscribe` is the exception: after the acknowledgement line the server
   keeps the connection open and pushes event lines. `HerdrSubscription` holds
   that one long-lived connection.
3. Response lines carry `id` plus `result` or `error`. Pushed event lines carry
   `event` and `data` (no `id`). Pane records in `data` carry a monotonic
   `revision`.
4. The socket is selected by `HERDR_SOCKET_PATH` for both the client (connects
   directly) and the observe/control children (the CLI honours the env var). The
   default is `~/.config/herdr/herdr.sock`; tests inject an isolated named
   session socket.

## client.js

```js
const { HerdrClient } = require('./client.js');
const client = new HerdrClient({ socketPath }); // socketPath optional; defaults to the live daemon

await client.ping();                              // { type: 'pong', protocol: 16, ... }
const { snapshot } = await client.assertProtocol(); // throws unless the daemon is 16 or 17 (A6)

// Bootstrap: snapshot first, then subscribe with #1270 replay dedupe seeded
// from that snapshot (S6). Returns { snapshot, subscription }.
const { subscription } = await client.bootstrap({ onEvent: (ev) => update(ev) });
// ev is a deduped { event, data } lifecycle event; subscription.on('raw', ...) for the undeduped stream.
subscription.close();
```

Method wrappers (each is one `request()`): `ping`, `snapshot`, `assertProtocol`,
`bootstrap`, `subscribe`, `createWorkspace`, `listWorkspaces`, `getWorkspace`,
`focusWorkspace`, `reportWorkspaceMetadata`, `createTab`, `listTabs`, `getTab`,
`focusTab`, `renameTab`, `listPanes`, `getPane`, `focusPane`, `closePane`,
`sendText`, `sendKeys`, `sendInput`, `exportLayout`. `request(method, params)`
reaches any of the 85 raw methods directly.

### #1270 replay dedupe

The server replays retained history to every new subscriber (upstream issue
1270). `Deduper` is seeded from `session.snapshot` and drops replays:

- pane events are keyed by `pane_id` + `revision`; an event at or below the
  highest revision already delivered for that pane is dropped;
- `workspace.created` / `tab.created` / `pane.created` for a resource already in
  the snapshot (or already delivered) are dropped by identity.

`Deduper` is exported and unit-tested without a socket.

## streams.js

```js
const { PaneStreamSupervisor } = require('./streams.js');
const sup = new PaneStreamSupervisor({ socketPath }); // EventEmitter

sup.attachObserver(paneId, { cols, rows });   // read-only; idempotent per pane
sup.acquireControl(paneId, { cols, rows }, { takeover: false }); // exclusive; call on focus
sup.sendInput(paneId, 'ls\r');                // string, or { text } / { bytes }
sup.resize(paneId, { cols, rows });           // control channel owns resize
sup.scroll(paneId, { rows: -3 });             // terminal.scroll on the controlled pane
sup.releaseControl(paneId);                   // call on blur
sup.detach(paneId);                           // stop this pane's streams; detach() stops all
```

Events: `frame` `{ paneId, source: 'observe'|'control', bytes, text }`, `closed`
`{ paneId, source, reason }`, `denied` `{ paneId, source, reason, record }`,
`observer-attached`, `control-acquired`, `control-released`, `exit`, `stderr`,
`parse-error`, `error`.

Input submission note: LF (`\n`) does not submit a shell line. Use `\r`
(carriage return) in `sendInput`, or `client.sendKeys(paneId, ['enter'])`.

## Observed ownership semantics (contention matrix)

Verified in `app/test/herdr/bridge.test.js` against an isolated named session:

- **Observers are unlimited and never take ownership.** Two observers on one
  pane received identical frame volume, and an observer kept receiving frames
  the whole time a controller was attached and driving input.
- **Exactly one controller owns input and resize at a time.** A second
  `terminal session control` on a pane that already has a live controller **and
  no `--takeover`** is refused: the child emits a `terminal.closed` record
  carrying `reason: "terminal attach failed: terminal <id> already has an
  attached client; retry with --takeover"` and exits with code 0. The incumbent
  keeps ownership and stays alive.
- **`--takeover` displaces the incumbent.** The incumbent controller's child
  exits cleanly (code 0) and the new controller owns input and resize (confirmed
  by driving input after the takeover). `terminal.resize` from the owning
  controller changes the pane PTY (confirmed by `stty size`).

### Discipline enforced at the API level (S5)

A `PaneStreamSupervisor` controls **at most one pane at a time**.
`acquireControl` for a different pane throws until `releaseControl` is called.
This encodes acquire-on-focus / release-on-blur: the GUI holds control only for
the focused pane and never fights Pat's TUI client for a pane it is not focused
on. When the TUI already controls a focused pane, the GUI surfaces a
"controlled by terminal client" state rather than issuing a `--takeover`
(ARCHITECTURE-v2 section 6). Passing `{ takeover: true }` is a deliberate,
explicit act.

## Safety invariants for tests (S4, A5)

- All mutation runs against a named session
  (`~/.config/herdr/sessions/harbor-bridge-test/herdr.sock`) started with the
  clean-env pattern from `bin/herdr-server-clean`. The live daemon socket is
  read-only territory (snapshot and ping only).
- Teardown stops that named server (`herdr server stop` with `HERDR_SESSION`
  set), never the user daemon, and never `herdr update`. Child processes are
  killed by exact handle, never `pkill -f`.
- The suite records `pgrep -a herdr` before starting and asserts after teardown
  that no herdr process remains that was not in the baseline.

## Running

```bash
cd app
npm test -- herdr    # bridge.test.js (isolated session) + dedupe.test.js (unit)
```
