Round 2 is complete and committed as **`18e6f6451db3fd080ce5c3ae2fb4de0b31e45ad5`** in `C:\dev\.orch\harbor\lane-pool-1101`. The worktree is clean.

**Final verification:** `npm test -- lane` passed **48 tests, 0 failed, 0 skipped, 0 cancelled, 0 todo**, in **115.629 seconds**, meeting the 120-second target. All tests remain in Harbor’s normal gate.

The corrections cover F1 through F9:

- Unknown owner observations leave lane state unchanged. Capability-checked mutations no longer sweep owners.
- Boot identity reuses Harbor’s existing helper. Volume checks use filesystem identity after one registration-time CIM query. External owner checks are batched.
- Preparation runs outside global/repository locks, with its preparing CLI recorded. Claim and publication remain fenced transactions.
- Locks publish complete records atomically and use bounded waits, defaulting to 60 seconds.
- Sealed `awaiting-review` lanes survive owner exit and release normally.
- Executable leases and every resume require `--owner-pid`.
- Add, hard reset and switch have 30-minute deadlines. Failed first checkout creation is rolled back, freeing the slot.
- Journal checkpoints retain two generations; events rotate at 5 MiB with two archives.
- Full environment scans run on prepare, release and recover. Checkpoint and installation receipts use clean-tree and manifest checks.

Before production changes, the new regression suite ran against `9bc4283`: **0 passed, 11 failed**. Every regression now passes:

| Test | Before `9bc4283` | After |
|---|---|---|
| F1 unknown owner probes do not mutate a running lease | Failed: quarantined | Passed |
| F2 status spawns zero PowerShell and lease at most two | Failed: status spawned PowerShell | Passed |
| F3 slow preparation permits same-repository status bind and checkpoint | Failed: LOCK_BUSY | Passed |
| F3 short lock contention waits and then succeeds | Failed: immediate refusal | Passed |
| F4 sealed awaiting-review survives owner exit and releases normally | Failed: quarantined | Passed |
| F5 executable leases and every resume require an explicit owner | Failed: missing owner accepted | Passed |
| F6 failure before atomic lock publication leaves no lock | Failed: publication was not atomic | Passed |
| F7 failed first checkout is removed and the slot is reusable | Failed: quarantined folder remained | Passed |
| F8 checkpoint replay retains two generations and corrupt newest tail refuses | Failed: checkpoints absent | Passed |
| F8 events rotation keeps only two old files | Failed: rotation absent | Passed |
| F9 checkpoint and install receipts skip environment walks but release scans | Failed: three unnecessary walks | Passed |

Actual CLI timings, including Node startup and JSON parsing:

- Empty status: **80.05 ms**
- Status with two running lanes: **109.51 ms**
- Successive leases: **1,729.49 ms** and **2,440.74 ms**

Spawn assertions verified zero PowerShell calls for both status cases and at most two for a normal lease. Contention can additionally validate its lock holder.

The initial corrected full run took 150.846 seconds. The final reduction retained every proof, avoided unnecessary index writes, reused verified test-volume metadata, and distributed independent cases across four isolated test files.

The updated [round report](C:/dev/.orch/harbor/lane-pool-1101/docs/orchestration/2026-11-01-workspace-pool/reports/core.md) is committed with the code.

No production repository was registered. The live checkout, its dependencies, real lane state and session daemon were untouched. Launcher adapters, guards, Dev Drive and legacy retirement remain outside this round.