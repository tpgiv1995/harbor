# Harbor mobile remote surface security

This document describes the security model for Harbor's phone client path: `harbor-server`, the mobile PWA, and the Tailscale tailnet boundary on whatever machine you run `harbor-server` on.

## What is being protected

Harbor's desktop app drives Claude Code sessions that run with `--dangerously-skip-permissions`. Anything that can type into those sessions or kill their owning processes is equivalent to arbitrary code execution on the author's machine.

The remote surface is:

- **WebSocket RPC** at `/ws` on `harbor-server` (mutating methods require a bearer token)
- **HTTP reads** for `/health`, static PWA assets, `/artifacts?path=...`, and `/icons/...`
- **Push events** (sidebar, transcript, terminal frames) over the same WebSocket

`harbor-server` is a separate composition root from the Electron app. It reuses the same RPC channel metadata (`app/src/main/rpc/channels.js`), isolation policies (`app/src/main/isolation.js`), and provider code, but does not load Chromium or native dialogs.

## Authentication boundary

Every RPC method is classified into exactly one capability:

| Capability | Network behavior |
|------------|------------------|
| `mutating` | Requires a valid 64-hex server token (Bearer header or `?token=` on the WebSocket URL) |
| `remote-safe` | Allowed without a token. Reads only, gated by the Origin check below |
| `local-only` | Refused by `harbor-server` even with a valid token |

**"Reads only" is a claim this file used to make and the classification did not
keep.** Until 2026-08-08 four `remote-safe` methods had real side effects:
`session:menu-state` resized a live pty (via `ensureDialogSize`, which attaches
a control child so a dialog fits), `pane:focus` moved focus in the multiplexer
and took exclusive pane control, `daemon:retry` called
`app.relaunch(); app.exit(0)`, and `artifacts:thumb` spawned `pdftoppm`/`ffmpeg`.
Eleven `terminal:*` methods that create or destroy panes, tabs and workspaces
were classified `remote-safe` too; those were never implemented in the headless
composition, so they were latent rather than live, but a later "close this tab
from my phone" feature would have inherited no-auth access to them. All sixteen
are `mutating` now. Anything that reaches `terminalBridge.sendInput`, resizes a
pane, spawns a process, or restarts the app requires the token, however
indirectly it gets there.

The seventeen `remote-safe` methods the server actually implements are now
genuinely reads: `sidebar:get-state`, `session:preview`, `session:send-queue`,
`session:workflow-runs`, `transcript:open`, `transcript:close`, `tasks:read`,
`artifacts:list`, `project-icons:list`, `accounts:read-emails`, `usage:get-all`,
`capabilities:get`, `capabilities:permission-mode`, `links:get`,
`new-session:options`, `new-session:folder`, `voice:voices`.

**Know what that set still exposes without a token.** It includes the full text
of any conversation (`transcript:open`), your personal task list (`tasks:read`),
and the email addresses of your configured accounts (`accounts:read-emails`).
That is deliberate, and the reasoning is that the reachable callers are already
trusted: a browser is refused by the Origin check below, a process on the same
machine could read `~/.claude/projects` directly anyway, and everything else has
to be a peer on your own tailnet. **The exposure that is real is that last one:
another device on your tailnet can read those without the token.** If your
tailnet is not exactly as trusted as the machine Harbor runs on, bind to
loopback and front it with `tailscale serve`, which is the arrangement
`setup/mobile.md` recommends anyway.

Without the Origin check, `remote-safe` would additionally mean any web page
open in any browser on the machine could enumerate every project name, session
id and cwd and read any conversation, with no interaction beyond the page
loading, because the browser `WebSocket` constructor is not subject to the
same-origin policy the way `fetch`/XHR are.

## Origin check (Cross-Site WebSocket Hijacking)

`app/src/server/transport/ws.js` checks the `Origin` header on the HTTP
`upgrade` request, before `wss.handleUpgrade` runs, and destroys the socket on
a mismatch, the same way it already destroys the socket for a wrong pathname.
This is a second, independent gate from the token/tailnet authentication
above: bind address (`assertSafeBind`) restricts WHERE this process listens,
Origin restricts WHO is allowed to have asked, and the token/tailnet check
restricts WHAT an authenticated caller may do. All three apply regardless of
each other.

The allowlist is derived from the live server, never hardcoded:

- **Loopback aliases** (`127.0.0.1`, `localhost`, `::1`), matched only at the
  exact port this process is bound to.
- **The server's own bound host** (`server.address().address`), matched at
  the bound port. This covers a direct tailnet-IP bind
  (`HARBOR_SERVER_HOST=100.x.y.z`); it adds no new exposure because
  `assertSafeBind` already restricted that value to loopback or
  `100.64.0.0/10` before `listen()` ever ran.
- **The Tailscale MagicDNS name**, when `compose.js`'s
  `resolveSelfMagicDnsName` can discover one (`tailscale status --json`,
  reusing the same self-report `transport/tailnet-identity.js` already
  trusts for login discovery). Matched by hostname alone, on any port,
  because `tailscale serve --https=443` (the setup this repo's own
  `setup/mobile.md` recommends) terminates HTTPS at that name on a port this
  process itself is not bound to. A missing `tailscale` binary or a
  `tailscale down` node degrades this to an empty list; loopback and a direct
  tailnet-IP bind are unaffected.

**A missing `Origin` header is allowed**, and that is deliberate, not a gap: a
real browser handshake always carries one, so the attack this check exists
for is not reachable without it, and refusing an absent header would only
ever break a legitimate non-browser client (curl, a native app, some
installed/standalone PWA shells send none) while stopping nothing. Do not
"harden" this to require `Origin`.

The token file lives at `<userData>/server-token`, mode `0600`, generated on first start. Comparison uses `crypto.timingSafeEqual` on the raw bytes, so truncated or wrong-length tokens fail closed.

Mutating methods (16): `new-session`, `resume-session`, `session:takeover`, `session:send`, `session:menu-answer`, `session:interrupt`, `session:delete`, `worker:close`, `terminal:send-input`, `workflow:run`, `orchestration:kickoff-research`, `orchestration:kickoff-execute`, `tasks:mutate`, `setup:save`, `voice:token`, `whisper:transcribe`.

`session:takeover` is especially sensitive: it SIGTERMs and SIGKILLs a process identified from the statusline context tee. On `harbor-server` it is not implemented in the headless composition (callers get an explicit refusal after authentication), but the auth gate still applies so it cannot be reached anonymously.

## Network exposure

`harbor-server` binds only to an allowlisted address, enforced by `assertSafeBind` in `app/src/server/compose.js`:

- `127.0.0.1` / `::1` / `localhost` (local loopback)
- any address in `100.64.0.0/10`, the CGNAT range Tailscale hands to every node on a tailnet (checked as a range, `100.64.x.x` through `100.127.x.x`, not a single literal address, since which address that is depends on the tailnet)

Binding to `0.0.0.0` or any other interface throws at startup, before the server ever listens. Remote phones reach the server through Tailscale Serve on the tailnet interface, not through a public listener.

**Tailscale Funnel is not used.** Funnel would expose the service on the public internet; Harbor's model assumes tailnet-only access.

## HTTP asset boundaries

**Artifacts** (`/artifacts?path=`): served only when `artifacts.isServable(path)` is true. That set contains indexed transcript-named files and sibling assets in the same directory (e.g. a chart next to an HTML report). Traversal (`../`), symlinks whose target lies outside the allowlist, URL-encoding tricks, and paths in a different directory that merely share a filename are refused with 404. The HTTP handler resolves `realpath` and re-checks the allowlist so a symlink parked beside an indexed file cannot serve arbitrary off-tree content.

**Project icons** (`/icons/`): `filePathFor` returns a path only for filenames discovered in the user's icon directory index. Slashes in the filename are rejected. There is no label-to-path map on the server.

## Isolation policies (harness safety)

`harbor-server` applies the same isolation policies as the Electron main process:

- **`resolveSignalPolicy`**: an instance on a non-default `userData` that still reads the real context tee refuses to signal real processes (except signal 0 liveness probes).
- **`resolveLaunchPolicy`**: an isolated profile refuses `bin/claude-sessions` / `bin/ai` shell-outs unless `HARBOR_E2E_FAKE_LAUNCH=1` or `HARBOR_ALLOW_REAL_LAUNCH=1`.
- **`resolveContextDir`**: `HARBOR_CONTEXT_DIR` relocates the statusline tee store for harnesses.

Opt-in env vars: `HARBOR_ALLOW_REAL_SIGNALS`, `HARBOR_ALLOW_REAL_LAUNCH`. These are for deliberate real-machine drives, not production defaults.

## Backpressure

Each WebSocket client has a bounded outbound queue (default 256 frames). When a phone client is slow, **terminal frames are dropped** (oldest first) rather than queued without limit. Non-terminal pushes are refused once the queue is full and the client is closed with code 1013. The desktop Electron app is unaffected; it uses a separate process and transport.

## Residual risks

1. **Token theft on the tailnet**: anyone who can read `server-token` or intercept a phone's WebSocket can drive mutating RPCs. Mitigation: tailnet membership, token file permissions, HTTPS/WSS via Tailscale Serve.
2. **Tailscale Serve misconfiguration**: an accidental Funnel or bind to `0.0.0.0` would widen exposure. The startup allowlist and MOBILE-9 gate check bind address and Funnel status.
3. **Sibling asset rule**: files in the same directory as an indexed artifact are servable even if not individually named in a transcript. A session that writes `report.html` and `malware.html` in the same folder exposes both. This is intentional for multi-file reports but assumes transcript naming is trustworthy.
4. **Headless gaps**: mutating methods not yet implemented in `compose.js` refuse after auth with "not available in the headless composition". They cannot be invoked anonymously, but a future implementation must preserve isolation wiring.
5. **Session daemon coupling**: `harbor-server` uses the same pluggable session backend as the desktop app (`resolveSessionBackend`, default `sessiond`, fallback `herdr`). On the default backend it starts or connects to Harbor's own `sessiond`; on the Herdr backend it starts or connects to Herdr instead. Compromise of whichever daemon is active, on the same host, is outside this boundary.
6. **No rate limiting**: authenticated clients can spam mutating RPCs. Tailnet scope limits who can authenticate; per-method rate limits are not implemented.

## Verification

The MOBILE-9 gate (`app/scripts/e2e-mobile.js`) runs `app/test/e2e/mobile.spec.js` twice consecutively under `xvfb-run` and `dbus-run-session` with isolated `userData`, `HARBOR_CONTEXT_DIR`, `HARBOR_ARTIFACTS_ROOTS`, `HARBOR_ARTIFACTS_CACHE`, and `HARBOR_TASKS_FILE`. It never touches the live Herdr daemon or the real tasks file.

Unit coverage also lives in `app/test/server/` (`server-core.test.js`, `ws-integration.test.js`, `http.test.js`, `ws-origin.test.js`) and `app/test/main/isolation.test.js`. `ws-origin.test.js` proves the Origin check two-sided against a real handshake: a foreign origin is refused before the connection opens, the server's own origin and a missing origin both open and can still call a remote-safe method, and a discovered MagicDNS-style origin is accepted on a port the process is not itself bound to while a different tailnet node's name is not.
