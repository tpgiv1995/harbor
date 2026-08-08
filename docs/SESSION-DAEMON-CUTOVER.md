# Session daemon backend

**The cutover is complete.** Harbor's own daemon, `sessiond`, is the default, and
Herdr is the supported fallback. Rolling back is one environment variable.

## The selector

`HARBOR_SESSION_BACKEND` selects the control plane and byte bridge only:

| Value | Meaning |
|-------|---------|
| unset or `sessiond` | Default. Harbor's own daemon owns the session control plane: `bin/harbor-sessiond` and `app/src/daemon/`. |
| `herdr` | Fallback. Herdr owns the session control plane. |
| anything else | Harbor refuses to start (`HARBOR_SESSION_BACKEND must be herdr or sessiond, got ...`). |

It is read in exactly two places, and they must agree: `app/src/main/session-daemon/factory.js` and `bin/harbor-bin.cjs`.

Rollback: set `HARBOR_SESSION_BACKEND=herdr`, then relaunch Harbor. No other step is required.

The default and the rollback both come from `resolveSessionBackend` in `factory.js`:

```js
function resolveSessionBackend(env = process.env) {
  const value = String(env?.[BACKEND_ENV] || 'sessiond').trim().toLowerCase();
  if (value === 'herdr' || value === 'sessiond') return value;
  throw new Error(`${BACKEND_ENV} must be herdr or sessiond, got ${value}`);
}
```

Unset, or explicitly set to `sessiond`, resolves to `sessiond`. Setting `HARBOR_SESSION_BACKEND=herdr` is the only way to get `herdr`. `bin/harbor-bin.cjs` carries the identical function, so the CLI (`bin/ai`, `bin/claude-sessions`) and the app agree.

## What is still Herdr-owned

Even with `HARBOR_SESSION_BACKEND=sessiond` (the default), a few paths are Herdr-specific implementation details rather than shared logic:

- Replay dedupe and subscription settle timers (Herdr protocol compatibility behavior; the sessiond adapter does not need it, see `session-daemon/README.md`)
- Exclusive controller refusal, retry, swap, and transient dialog sizing (same)
- Protocol compatibility checks (`assertDaemonCompat`, `SUPPORTED_PROTOCOLS`) and `herdr-server-clean` wedge recovery, which only run on the Herdr connect path in `connectDaemon`
- `~/dev/harbor/bin/harbor-hydrate` (the TUI sidebar's session restore): calls Herdr's `workspace`/`tab`/`pane` API directly and does not read `HARBOR_SESSION_BACKEND` at all, so it drives Herdr even when the app itself is on sessiond

Launch and resume (`bin/ai`, `bin/claude-sessions`) are **not** on this list. Commit `9efaac7` moved both onto the same selector: a fresh session and a resumed session spawn through sessiond by default, same as the control plane and byte bridge.

Implementation lives under `~/dev/harbor/app/src/daemon/`; repair CLI at `~/dev/harbor/bin/harbor-sessiond`.

## How to tell which backend is live

### 1. Environment on the Harbor process

Find Harbor's Electron pid, then read its environment:

```text
$ pgrep -af "electron.*harbor/app"
1493080 ~/dev/harbor/app/node_modules/electron/dist/electron ~/dev/harbor/app

$ tr '\0' '\n' < /proc/1493080/environ | grep HARBOR_SESSION || echo "unset (default sessiond)"
unset (default sessiond)
```

Unset means `sessiond`, the default. `HARBOR_SESSION_BACKEND=herdr` in that output means Harbor rolled back to Herdr for control and byte bridge.

### 2. Probe the daemon you expect

**Herdr (fallback):** `~/dev/harbor/bin/herdr-health.sh` is the liveness authority. Exit 0 means the daemon answers a real `session.snapshot`-class request. Exit 1 means dead or wedged. Do not trust `herdr status` alone; a wedged daemon can still report `status: running` in milliseconds while real API calls hang (live incident 2026-07-26).

```text
$ ~/dev/harbor/bin/herdr-health.sh
$ echo "exit: $?"
exit: 0

$ timeout 5 herdr status 2>&1 | head -10
client:
  version: 0.7.4
  channel: stable
  protocol: 16

server:
  status: running
  version: 0.7.4
  protocol: 16
  compatible: yes
```

**Sessiond (default):** `~/dev/harbor/bin/harbor-sessiond status` must return quickly with `ok: true`. Default store: `~/.local/state/harbor/sessiond`, socket `~/.local/state/harbor/sessiond/sessiond.sock`.

```text
$ ~/dev/harbor/bin/harbor-sessiond status
{
  "ok": true,
  "request": "2ad053ad-8070-40fc-bc78-526110ca9552",
  "sessions": 0
}
```

## Switching backend for one launch

Harbor starts `sessiond` automatically when it is the active backend: `connectDaemon` in `app/src/main/index.js` pings it first, then runs `harbor-sessiond start` on failure unless `HARBOR_NO_DAEMON_START=1`. Day to day there is nothing to opt into; launching Harbor is enough.

**Roll back to Herdr for one launch:**

```bash
export HARBOR_SESSION_BACKEND=herdr
~/.local/bin/harbor --no-focus-steal
```

Or add `export HARBOR_SESSION_BACKEND=herdr` to your shell profile only while testing. There is no entry in `~/.config/harbor/` for this variable today; it is read from the process environment only.

**Confirm** with the environ probe above and `herdr-health.sh` (Herdr) or `harbor-sessiond status` (sessiond).

To return to sessiond: unset the variable (or `export HARBOR_SESSION_BACKEND=sessiond`), quit Harbor, and launch again. Herdr may keep running in the background; Harbor simply stops using it.

Invalid backend is refused at resolve time regardless of direction:

```text
$ HARBOR_SESSION_BACKEND=other node -e "const {resolveSessionBackend}=require('~/dev/harbor/app/src/main/session-daemon/factory.js'); try { resolveSessionBackend(process.env); } catch(e) { console.error(e.message); }"
HARBOR_SESSION_BACKEND must be herdr or sessiond, got other
```

### Starting sessiond by hand

Not needed for normal use; Harbor starts it. Useful for isolated testing or manual inspection (production unit `harbor-sessiond.service`, `KillMode=process`):

```bash
~/dev/harbor/bin/harbor-sessiond start
```

Isolated harness (does not touch the default store), verified 2026-08-04:

```text
$ ISO="/tmp/harbor-doc-start-1785830418"
$ mkdir -p "$ISO"
$ HARBOR_SESSIOND_DIR="$ISO" HARBOR_SESSIOND_SOCKET="$ISO/daemon.sock" ~/dev/harbor/bin/harbor-sessiond start --json
{"started":true,"mode":"detached","pid":2269354,"socket":"/tmp/harbor-doc-start-1785830418/daemon.sock"}

$ HARBOR_SESSIOND_DIR="$ISO" HARBOR_SESSIOND_SOCKET="$ISO/daemon.sock" ~/dev/harbor/bin/harbor-sessiond status --json
{"ok":true,"request":"5c6ed69a-4cd6-4a3b-af85-055f6fe947ee","sessions":0}
```

## What happens to running sessions on backend switch

Switching `HARBOR_SESSION_BACKEND` or restarting Harbor does **not** move live ptys between daemons. Expect every open terminal pane to drop.

| Outcome | Detail |
|---------|--------|
| Conversation history | Claude, Codex, and Cursor sessions keep their JSONL transcripts on disk. Resume by session id through Harbor or `~/dev/harbor/bin/claude-sessions` / `~/dev/harbor/bin/ai --resume-id`. |
| In-flight turn | Lost, same as adopt-on-send killing a session mid-turn: whatever the agent was doing in the live process stops. |
| Cursor cwd unmunged | No resume path; those sessions stay read-only in Harbor (raw terminal only if a live pane exists). |

Plan backend experiments as **restart Harbor, reopen sessions from the rail**. It is not seamless.

## Session daemon environment

| Variable | Default |
|----------|---------|
| `HARBOR_SESSIOND_DIR` | `~/.local/state/harbor/sessiond` |
| `HARBOR_SESSIOND_SOCKET` | `<HARBOR_SESSIOND_DIR>/sessiond.sock` |
| `HARBOR_SESSIOND_LOG` | `<HARBOR_SESSIOND_DIR>/sessiond.log` |
| `HARBOR_SESSIOND_REQUEST_TIMEOUT_MS` | `10000` |
| `HARBOR_SESSIOND_KEEPER_REQUEST_TIMEOUT_MS` | `10000` |
| `HARBOR_SESSIOND_EXIT_RETENTION_MS` | `300000` (5 min) |
| `HARBOR_SESSIOND_MAX_RECENT_EXITS` | `100` |
| `HARBOR_SESSIOND_LOG_MAX_BYTES` | `5242880` |
| `HARBOR_SESSIOND_UNIT` | `harbor-sessiond.service` (production start) |
| `HARBOR_ALLOW_REAL_SESSION_STORE` | Opt-in for isolated profiles touching the default store |

Repair from a shell when the GUI will not open: `~/dev/harbor/docs/REPAIR-FROM-A-SHELL.md`.

## Related docs

- `~/dev/harbor/app/src/main/session-daemon/README.md` (adapter notes)
- `~/dev/harbor/docs/ARCHITECTURE-v2.md` (daemon plumbing, pre-Slate)
- `~/dev/harbor/CLAUDE.md` (incident-driven rules)
