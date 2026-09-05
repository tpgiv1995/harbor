# Sessiond rollout runbook: replacing the live daemon with zero session drop

The only sanctioned path for replacing Pat's running sessiond with new code
(2026-08-30, r2-selfheal item 3). The "binary" is source on disk: replacing it
means new code at `C:\dev\harbor` plus a daemon restart that loads it, through
`bin/harbor-sessiond handover`. **Keepers keep running the OLD keeper.js until
each session naturally ends**; the daemon swap never touches them.

**Precondition 0 (protocol):** the new daemon must speak the old keepers'
protocol (verbs unchanged: observe/input/resize/screen/process/terminate/
annotate) and read their state schema. A change that needs new keeper behavior
on LIVE sessions is a session-drain operation, out of scope for zero-drop, and
is planned separately with Pat.

## Preconditions

1. Full unit suite green locally on the Legion, twice consecutively, including
   the `daemon` and `bin` families CI cannot run:
   `cd app && npm test` (or `node scripts/test.js`), twice.
2. The self-heal/handover suites green at the same HEAD, twice:
   `node scripts/test.js daemon/handover`, `daemon/self-heal`,
   `daemon/gate-verdicts`, `bin/handover`.
3. The live isolated dress rehearsal green: `node scripts/drive-selfheal-win.js`
   (from `app/`). It runs BOTH lanes against a throwaway store with a real
   ConPTY session and fails loudly on any pid churn. Zero risk to the real
   store; do not proceed until it prints `BOTH LANES OK`.
4. Work committed; record the prior HEAD as `ROLLBACK_REV=$(git rev-parse HEAD~N)`
   (the commit the live daemon is currently running).
5. Timing judgment: the control plane blips for a few seconds during the swap
   (sends fail honestly and the app banner may flash "connection lost");
   prefer a quiet moment. Harbor does NOT need to be closed: the gate makes
   app races safe, and the app watchdog now heals in place without a relaunch.

## Sequence

From `C:\dev\harbor`, with `ELECTRON_RUN_AS_NODE=1` (use `electron` =
`app\node_modules\electron\dist\electron.exe`):

```
electron bin/harbor-sessiond status --json      # before-picture: pid, sessions
electron bin/harbor-sessiond list --json        # before-list: save it
electron bin/harbor-sessiond spawn --cwd %USERPROFILE% -- %COMSPEC% /k echo canary-ready   # canary (absolute path: spawn hands the keeper an EMPTY env, so a bare `cmd` has no PATH and fails "File not found")
electron bin/harbor-sessiond handover --json    # THE SWAP
electron bin/harbor-sessiond status --json      # healthy, NEW pid
electron bin/harbor-sessiond list --json        # same ids as before, plus the canary
```

The `handover --json` verdict must print `"identical": true` and
`"healthy": true`, with `sessions` equal to the before-list's live count and an
empty `mismatches`. It refuses (nonzero exit, incumbent left running) when the
incumbent is mute (`run: harbor-sessiond recover`), dead (`start`), or when the
yield/release/verify chain cannot complete.

**First rollout note:** the current live daemon predates the `yield` verb.
`handover` detects that ("unsupported verb") and swaps it through its
`shutdown` verb instead, with the same release-wait and parity verification;
the verdict then carries `"yielded": false`. That is expected ONLY on the first
swap; every later handover against new-code daemons must say `"yielded": true`.
The first swap also upgrades the watcher chain: the successor runs under the
new supervising daemon-watch (wedge detection + crash respawn), and it writes
owner.json, which arms the `recover` lane.

Then drive the canary (input -> screen round trip) and kill it:

```
# through the app, or:
electron bin/harbor-sessiond kill <canary-id>
```

The canary makes sends into Pat's real sessions unnecessary by default; whether
to also send into one of his real idle sessions is the operator's judgment
call at execution time, stated in the record either way.

**App check:** the Harbor banner may flash "connection lost" and must return
to ok within ~30s with NO app relaunch (the terminal bridge reconnects on
close; the watchdog's wedge path no longer relaunches).

**Logged evidence** (paste all three JSON outputs plus these lines into the
orchestration record): the `yield:` line, the `daemon exit ... kind=clean`
line, the new `daemon listening` line, and NO `reconciled` line (a clean
handover reconciles zero sessions).

## Verification failure and abort

Sessions are safe throughout: keepers are independent pipe servers holding the
ptys, and no lane signals them. The worst reachable state is "no control
plane" until a daemon binds. **Never touch keepers.**

- Successor never becomes healthy after yield:
  `git checkout ROLLBACK_REV -- app/src/daemon bin/harbor-sessiond`, then
  `electron bin/harbor-sessiond start --json`, then re-verify `list --json`
  against the before-picture.
- Healthy but `identical: false`: same rollback, then bring the mismatch back
  to the bench. Never fix forward against the live store.
- `start` reports `{ started: false, wedgedOwner: true }`: a mute owner holds
  the pipe; run `electron bin/harbor-sessiond recover --json` (two spaced mute
  strikes, identity-verified kill via owner.json, then start). Recover REFUSES
  on any identity mismatch; a refusal means find the holder by hand
  (Process Explorer or Sysinternals handle.exe on the pipe name; a mute daemon answers no verbs, proc-find included), never blind-kill.

## What protects the swap

- The gate's verdict split: a healthy owner exits the successor 3 (never
  fought); a mute owner exits 4 (never unlinked, never bound over).
- `yield` closes the server FIRST (the successor's bind window opens while the
  incumbent drains), exits through the clean-shutdown IPC, so the incumbent's
  daemon-watch records `kind=clean` and retires instead of respawning.
- The successor's startup reconcile asks every keeper a real request and
  writes only to sessions proven dead; live keepers (and their Windows job
  handles, reacquired by name) are untouched.
- Unattended wedges and crashes are the supervisor's job now (daemon-watch
  probes health, kills a wedged child, respawns with a give-up cap), so this
  runbook is only for DELIBERATE code rollouts.
