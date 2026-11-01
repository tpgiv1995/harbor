Round 3 is committed as **`91c75281f4dade5964fead1042fd223a7e434e44`** in `C:\dev\.orch\harbor\lane-pool-1101`. The worktree is clean.

**Final verification:** `npm test -- lane` passed **55 tests, 0 failed, 0 skipped, 0 cancelled, 0 todo**, in **60.093 seconds** on Windows/NTFS.

G1 is fixed: `env-begin` and `env-ready` validate the slot and fingerprint manifests on disk. They permit unfinished edits and untracked files without inspecting Git operations or writing the index. Checkpoint and release still require a clean tree.

G2 is fixed: self-recorded starts use the inclusive interval from **120 seconds before through 1 second after** the recorded start. Later OS creation means gone; earlier means unknown. Missing PIDs and changed boots remain gone. OS-sourced timestamps compare exactly.

All seven new tests failed against `18e6f64` before production changes, then passed after correction:

| Test | Before | After |
|---|---|---|
| G1 dirty manifest and untracked work permit environment receipts without index writes | DIRTY refusal | Passed; index bytes unchanged |
| G1 environment receipts do not inspect Git operation state | GIT_OPERATION refusal | Passed |
| G2 self identity rejects later PID reuse and preserves the unknown earlier range | Reused PID reported live | Passed, including boundary values |
| G2 OS-sourced owner creation time comparisons are exact | One-millisecond mismatch accepted | Passed |
| G2 lock contention retains a live holder with a ten-second startup gap | LOCK_STALE | Passed; lock retained |
| G2 recover-lock refuses to remove a live holder with a ten-second startup gap | Live lock removed | Passed; recovery refused |
| G2 lease reconciliation retains a live preparer with a ten-second startup gap | Preparation quarantined | Passed; preparation retained |

The G2 tests inject OS observations rather than relying on startup timing. The earlier PID-reuse fixture now records an older original start, consistent with the corrected comparison.

The [updated round report](C:/dev/.orch/harbor/lane-pool-1101/docs/orchestration/2026-11-01-workspace-pool/reports/core.md) is committed with the code. All prior round-two proofs remain green. No live checkout, production pool, real lane state or session daemon was touched.