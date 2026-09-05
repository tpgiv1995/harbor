# Repair Harbor from a shell

Harbor will not open. You are at a terminal. Commands below are copy-pasteable, use absolute paths, and are ordered by what to try first.

## On Windows (current machine)

The checkout is `C:\dev\harbor`. Everything here is read-only except where a step says otherwise.

1. **Is the app running?** `Get-Process electron` in PowerShell (or Task Manager); Harbor's processes are Electron ones whose command line names `harbor\app`.

2. **Probe the daemon read-only:**

   ```powershell
   $env:ELECTRON_RUN_AS_NODE = '1'
   & C:\dev\harbor\app\node_modules\electron\dist\electron.exe C:\dev\harbor\bin\harbor-sessiond status
   ```

   `ELECTRON_RUN_AS_NODE=1` keeps the Electron binary behaving as plain Node, which is what the bin script expects.

3. **Read the daemon's own record.** The daemon store is `~/.local/state/harbor/sessiond` (under your user profile) and its log is `sessiond.log` there: the RSS heartbeat and the exit-capture line (pid, code, signal, uptime, clean or crash) are the whole forensic record. On win32 the "socket" is a named pipe derived from the socket path, so the absence of a socket file on disk is normal, not a symptom.

4. **Recovery.** There is no systemd on Windows. The app's own watchdog respawns a dead daemon, so if the app is running the usual repair is to let it; a manual start goes through `bin/harbor-sessiond start`, never anything else. **Never start the daemon from Task Scheduler**: it needs an interactive parent for ConPTY.

---

**Everything below this line is the Linux-era procedure, kept for history; the machine it describes was retired 2026-08-10 and the Herdr backend it falls back to was retired 2026-08-14.**

**Do not** run harness commands against the author's live Herdr unit or default session store unless you mean to. Isolated testing uses `HARBOR_SESSIOND_DIR` pointed at `/tmp/...` and `HARBOR_NO_DAEMON_START=1`.

## 1. Which backend is Harbor using?

```bash
HARBOR_PID=$(pgrep -f "electron.*harbor/app" | head -1)
if [ -z "$HARBOR_PID" ]; then echo "Harbor is not running"; else
  tr '\0' '\n' < "/proc/$HARBOR_PID/environ" | grep HARBOR_SESSION_BACKEND || echo "HARBOR_SESSION_BACKEND unset (default sessiond)"
fi
```

Unset or `sessiond`: follow **Session daemon repair** (section 2), the default. `herdr`: follow **Herdr repair** (section 3), the fallback.

## 2. Session daemon repair (`HARBOR_SESSION_BACKEND=sessiond`, the default)

CLI: `~/dev/harbor/bin/harbor-sessiond`

Default paths: `~/.local/state/harbor/sessiond`, socket `~/.local/state/harbor/sessiond/sessiond.sock`, log `~/.local/state/harbor/sessiond/sessiond.log`.

### 2a. Is the daemon answering?

```bash
~/dev/harbor/bin/harbor-sessiond status
```

Healthy output (verified 2026-08-04):

```text
{
  "ok": true,
  "request": "2ad053ad-8070-40fc-bc78-526110ca9552",
  "sessions": 0
}
```

If this hangs or exits 1 with a timeout message, the socket may be wedged (section 2c).

### 2b. Start or restart the daemon

```bash
~/dev/harbor/bin/harbor-sessiond start
```

Relocated store (safe for experiments):

```text
$ ISO="/tmp/harbor-doc-start-1785830418"
$ mkdir -p "$ISO"
$ HARBOR_SESSIOND_DIR="$ISO" HARBOR_SESSIOND_SOCKET="$ISO/daemon.sock" ~/dev/harbor/bin/harbor-sessiond start --json
{"started":true,"mode":"detached","pid":2269354,"socket":"/tmp/harbor-doc-start-1785830418/daemon.sock"}
```

Production unit: `systemctl --user status harbor-sessiond.service` (may show "could not be found" until first `start` on this machine).

### 2c. Wedged daemon (accepts connections, never answers)

This is the failure that cost eight minutes on 2026-07-26 on Herdr. Sessiond fails fast instead of hanging forever.

Against a socket that listens but never responds (`HARBOR_SESSIOND_REQUEST_TIMEOUT_MS=150` for a quick repro):

```text
$ ~/dev/harbor/bin/harbor-sessiond status 2>&1
health request timed out after 150ms

$ ~/dev/harbor/bin/harbor-sessiond list 2>&1
list request timed out after 150ms

$ ~/dev/harbor/bin/harbor-sessiond logs --lines 5 2>&1
daemon logs request failed: logs request timed out after 150ms; reading /tmp/harbor-doc-wedge2-1785830288/sessiond.log directly
RECOVERY_LOG_LINE
```

Default timeout is 10000 ms:

```text
$ ~/dev/harbor/bin/harbor-sessiond status 2>&1
health request timed out after 500ms
```

**Repair steps when wedged:**

1. Read the log (CLI falls back to the file when the daemon request times out):

   ```bash
   ~/dev/harbor/bin/harbor-sessiond logs --lines 100
   ```

   Or directly:

   ```bash
   tail -100 ~/.local/state/harbor/sessiond/sessiond.log
   ```

2. Stop the stuck unit if systemd started it:

   ```bash
   systemctl --user stop harbor-sessiond.service
   ```

3. If the socket file exists but nothing answers, move it aside (do not delete live Herdr sockets):

   ```bash
   TS=$(date +%s)
   mv ~/.local/state/harbor/sessiond/sessiond.sock \
      "~/.local/state/harbor/sessiond/sessiond.sock.dead-$TS"
   ```

4. Start clean:

   ```bash
   ~/dev/harbor/bin/harbor-sessiond start
   ~/dev/harbor/bin/harbor-sessiond status
   ```

5. Relaunch Harbor:

   ```bash
   ~/.local/bin/harbor --no-focus-steal
   ```

### 2d. List and kill stuck sessions (no GUI)

List:

```bash
~/dev/harbor/bin/harbor-sessiond list
```

Example with running sessions (isolated `sleep` procs, verified 2026-08-04):

```text
{
  "sessions": [
    {
      "id": "a400481e-c085-4d1c-a983-812023939dbd",
      "argv": ["/bin/sleep", "300"],
      "cwd": "/tmp",
      "cols": 80,
      "rows": 40,
      "pid": 2254815,
      "created_at": "2026-08-04T07:57:40.946Z",
      "exit": null
    }
  ]
}
```

Kill by daemon session id:

```bash
~/dev/harbor/bin/harbor-sessiond kill <session-id>
```

Verified output:

```text
{
  "signaled": true,
  "signal": "SIGTERM"
}
```

JSON variants: add `--json` to `status`, `list`, `kill`, `logs`.

### 2e. Roll back to Herdr

```bash
export HARBOR_SESSION_BACKEND=herdr
```

Quit Harbor, launch again. Harbor uses sessiond whenever the variable is unset, so rolling back requires the explicit value.

## 3. Herdr repair (fallback backend)

Herdr remains installed. Liveness authority: `~/dev/harbor/bin/herdr-health.sh` (timed `herdr api snapshot`, not `herdr status`).

### 3a. Is Herdr usable?

```bash
~/dev/harbor/bin/herdr-health.sh
echo "exit: $?"
```

Healthy (2026-08-04):

```text
exit: 0
```

Unhealthy or wedged: exit 1. `herdr status` may still say `running` while real requests hang. Trust `herdr-health.sh`.

```text
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

### 3b. Recover a dead or wedged Herdr daemon

**Only sanctioned recovery starter:**

```bash
~/dev/harbor/bin/herdr-server-clean
```

This moves wedged `herdr.sock` / `herdr-client.sock` aside as `*.dead-<timestamp>` (never deletes them), moves `session.json` aside so a fresh daemon does not auto-resume orphaned panes into double-writers, and starts a daemon that must answer a real request before reporting success.

Unit: `herdr-daemon.service` (`systemctl --user status herdr-daemon.service`).

**Warning:** recovery kills the daemon cgroup. Live panes drop. Sessions resume from transcripts by id; in-flight turns are lost. Do not kill zombie daemon threads while orphaned Claude processes still hold session ids; leave them as outside sessions and adopt on send when Harbor is back.

### 3c. Kill a stuck Claude session without the GUI

When Harbor cannot drive the pane but a Claude process is wedged:

1. Find the session id from the transcript path (`~/.claude/projects/.../<session-id>.jsonl`) or statusline tee `~/.cache/harbor/context/<session-id>.json`.

2. Find the process:

   ```bash
   pgrep -af "claude.*--resume.*<session-id>"
   ```

3. Verify cmdline matches that session id, then signal the **exact pid** from `pgrep` (not a pattern kill across all Claude):

   ```bash
   kill -TERM <pid>
   sleep 2
   kill -KILL <pid>   # only if still alive
   ```

4. Resume from transcript when Harbor is back:

   ```bash
   ~/dev/harbor/bin/claude-sessions --resume-id <session-id>
   ```

   Codex/Cursor:

   ```bash
   ~/dev/harbor/bin/ai --resume-id <session-id> --provider codex
   ~/dev/harbor/bin/ai --resume-id <session-id> --provider cursor
   ```

Cursor sessions whose cwd could not be un-munged have no resume path; they stay read-only in Harbor.

### 3d. Relaunch Harbor

```bash
~/.local/bin/harbor --no-focus-steal
```

## 4. Harbor still dead after daemon recovery

1. Renderer build present: `~/dev/harbor/app/dist/index.html`
2. Daemon log tails:
   - Herdr: `~/.cache/harbor/herdr-daemon.log`
   - Sessiond: `~/.local/state/harbor/sessiond/sessiond.log`
3. Rebuild renderer if needed:

   ```bash
   cd ~/dev/harbor/app && npm run build
   ```

## Command reference (`harbor-sessiond`)

| Command | Purpose |
|---------|---------|
| `start` | Start daemon (systemd unit or detached) |
| `status` | Health probe |
| `list` | Running sessions |
| `kill <id>` | SIGTERM session by daemon id |
| `logs [--lines N]` | Tail log (falls back to file on timeout) |
| `spawn --cwd PATH [--cols N --rows N] -- COMMAND ...` | Spawn via daemon (harness/debug) |
| `serve` | Run daemon in this process |
| `--json` | JSON output on supported commands |

## See also

- `~/dev/harbor/docs/SESSION-DAEMON-CUTOVER.md` (backend selector and rollback)
- `~/dev/harbor/CLAUDE.md` (Herdr wedge, `herdr-health.sh`, isolation rules)
