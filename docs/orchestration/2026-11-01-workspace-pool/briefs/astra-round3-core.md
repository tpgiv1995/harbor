# Workspace-pool core, correction round 3 (two items)

Same worktree and rules as rounds 1 and 2 (`C:\dev\.orch\harbor\lane-pool-1101`, build on 18e6f64). Claude re-ran `npm test -- lane` on 18e6f64: 48 passed, 0 failed, 64 s. The F1 to F9 corrections were reviewed and accepted except as below. Each fix needs a test that fails on 18e6f64; name it in the report with before/after. Return the round report as your final message, update `reports\core.md`, commit.

## G1: env-begin and env-ready must not require a clean tree (Claude's brief was wrong)

Round 2's F9 text said env-begin, env-ready and checkpoint need "the manifest fingerprint and the clean-tree check". That was a mistake for env-begin and env-ready, and you built it as written: `environment()` now calls `ws.cleanTree(slot.path)`.

A worker that edits `package.json` or `requirements*.txt` mid-run and reinstalls must be able to call env-begin and env-ready with uncommitted and untracked work in its slot. `cleanTree` also runs `clearFlags`, which can rewrite the worker's index mid-run.

Fix:
- env-begin and env-ready do `validateSlot` plus the fingerprint only. Fingerprint the manifests as they are on disk, as today.
- No `cleanTree`, no `operations`, no index writes.
- Checkpoint and release keep the clean-tree requirement.

Test: with a modified tracked manifest plus an untracked file in the slot, env-begin and then env-ready succeed. The fingerprint changes with the edited manifest. Checkpoint on the same slot still refuses DIRTY.

## G2: a process's own start time is a one-sided bound

`identity.cjs` records a self identity's `created` as `Date.now() - process.uptime() * 1000`. It's used for lock records, `preparer` and `releaser`. It is later compared with the OS creation time at `START_TOLERANCE_MS` 3,000 either way.

Node's clock starts after process creation and DLL loading. Measured on the Legion: 16 to 21 ms later, five runs. Under heavy disk load that can stretch. A live holder whose gap exceeds 3 s reads as gone. Then:
- `lock()` answers LOCK_STALE.
- `recover-lock` deletes a live lock, and two writers can append the same journal revision.
- An allocate reconcile quarantines a preparation that's still running.

Fix, for identities with `source: 'self'`:
- **Live** when the OS creation time is no later than the recorded start plus 1,000 ms AND no earlier than the recorded start minus 120,000 ms.
- **Gone** when the pid is absent, the boot changed, or the OS creation is more than 1,000 ms after the recorded start. That last case is a reused pid: a reused pid was always created after the original died, so after its recorded start.
- **Unknown** otherwise, for example an OS creation more than 120 s before the recorded start. Per F1, unknown never quarantines and never makes a lock stale.

OS-sourced owners keep the exact comparison.

Tests (inject the OS row; do not rely on timing):
- A self-recorded holder whose OS creation is 10 s before its recorded start is live, for both lock contention and recover-lock.
- A pid whose OS creation is after the recorded start plus 1,000 ms is gone.
- A preparation whose preparer has the 10 s gap is not quarantined by a lease's reconcile.
