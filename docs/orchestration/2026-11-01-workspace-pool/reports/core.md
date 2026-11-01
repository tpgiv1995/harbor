# Workspace-pool core, stages 1 and 2

Implementation worktree: `C:\dev\.orch\harbor\lane-pool-1101`.
Branch: `lane-pool-2026-11-01`, based on `f1c1477`.
Round-one implementation commit: `282873f441dcb0df59194bc2e7fcc95dee71a274`; correction baseline: `9bc42834293e358344935c591682de759ae25eea`.

## Correction round 3

Baseline: `18e6f6451db3fd080ce5c3ae2fb4de0b31e45ad5`. G1 and G2 are corrected. The focused baseline run, before production edits, had **0 passed, 7 failed** in 11.397 seconds. The same tests after correction had **7 passed, 0 failed** in 12.067 seconds. Final `npm test -- lane`: **55 passed, 0 failed, 0 skipped, 0 cancelled, 0 todo**, exit 0, **60.093 seconds** on Windows/NTFS. All 55 remain in Harbor's normal gate, now including `round3.test.js` as the fifth lane test file. Round-two spawn-count, real-process, cleanup, concurrency and bounded-storage proofs remain green. Only documentation changed after this full run.

G1: env-begin and env-ready now do only slot validation and the on-disk manifest fingerprint, followed by their state receipt update. They do not call cleanTree, operations or clearFlags and do not write the Git index. Modified tracked manifests and untracked files are permitted. Checkpoint and release retain their clean-tree requirement.

G2: the OS observation for a self-sourced record is live in the inclusive interval from recorded start minus 120,000 ms through recorded start plus 1,000 ms. A newer OS creation is gone (PID reuse); an older observation is unknown. Missing PIDs and changed boots remain gone. Unknown never makes a lock stale or quarantines a lane. OS-sourced owners compare exactly, including a one-millisecond difference. The cheap same-process shortcut recognizes only an exact self-stamp match; it does not compare an OS timestamp against Node's uptime-derived bound.

All G2 regression observations are injected OS rows, not timing-dependent process-start experiments. The prior generic PID-reuse fixture now places its recorded start before the current process's birth; placing it after the birth describes the startup gap that G2 deliberately accepts.

| Test in `C:\dev\.orch\harbor\lane-pool-1101\app\test\lane\round3.test.js` | Before on 18e6f64 | After |
| --- | --- | --- |
| G1 dirty manifest and untracked work permit environment receipts without index writes | Failed: DIRTY | Passed: changed fingerprint, ready receipt, identical index bytes; checkpoint/release still refuse DIRTY |
| G1 environment receipts do not inspect Git operation state | Failed: GIT_OPERATION | Passed: receipts succeed with an index-lock marker; checkpoint still refuses the operation |
| G2 self identity rejects later PID reuse and preserves the unknown earlier range | Failed: later reused PID reported live | Passed: +1,001 ms is gone, +1,000 ms and -120,000 ms are live, -120,001 ms is unknown; absent PID is gone |
| G2 OS-sourced owner creation time comparisons are exact | Failed: one-millisecond mismatch reported live | Passed: exact match live, mismatch gone |
| G2 lock contention retains a live holder with a ten-second startup gap | Failed: LOCK_STALE | Passed: bounded LOCK_BUSY, original lock retained |
| G2 recover-lock refuses to remove a live holder with a ten-second startup gap | Failed: live lock removed | Passed: LOCK_BUSY, original lock retained |
| G2 lease reconciliation retains a live preparer with a ten-second startup gap | Failed: preparing lane quarantined | Passed: preparer and slot stay preparing while another lane leases successfully |

Scope remains the isolated worktree, synthetic fixtures and relocated lane state. No real repository was registered; no real daemon, production pool, live checkout or dependency installation was touched.

## Correction round 2

F1 through F9 are implemented. The final `npm test -- lane` run passed **48 tests, 0 failures, 0 skipped, 0 cancelled, 0 todo**, exit 0, in **115.629 seconds** on the Legion. All tests remain in the lane directory and Harbor's normal gate. The real Windows held-file, process-exit, concurrent-lease and slow-preparation proofs ran.

Before changing production code, `npm test -- lane/round2` ran the new assertions against `9bc4283`: **0 passed, 11 failed**, 66.457 seconds. The worker test helper only added the preparation pause hook. After the changes, that same set passed 11/11; the final full run passed all 48 together.

| Regression test in the round-two suite | Before on 9bc4283 | After |
| --- | --- | --- |
| F1 unknown owner probes do not mutate a running lease | Failed: running became quarantined | Passed: unknown retains running and permits env-begin/release; gone quarantines |
| F2 status spawns zero PowerShell and lease at most two | Failed: empty status spawned PowerShell | Passed: empty/two-running status each launch zero; normal lease stays within two |
| F3 slow preparation permits same-repository status bind and checkpoint | Failed: LOCK_BUSY on bind-session | Passed: real paused preparer stays preparing while all three commands succeed |
| F3 short lock contention waits and then succeeds | Failed: immediate lock refusal | Passed: the next command acquires after the holder releases |
| F4 sealed awaiting-review survives owner exit and releases normally | Failed: status quarantined the completed worker | Passed: checkpoint, exit, status, release without recover |
| F5 executable leases and every resume require an explicit owner | Failed: missing owner was accepted | Passed: write/verify/integration and resume reject; inspect/live keep their default |
| F6 failure before atomic lock publication leaves no lock | Failed: no atomic link publication point | Passed: injected failure leaves no published lock and status proceeds |
| F7 failed first checkout is removed and the slot is reusable | Failed: slot stayed quarantined with its folder | Passed: owned folder/registration removed, slot free, next lane uses it; add timeout is 30 minutes |
| F8 checkpoint replay retains two generations and corrupt newest tail refuses | Failed: no checkpoint/segment manifest | Passed: replay after two rotations, two journal generations retained, newest corruption refuses |
| F8 events rotation keeps only two old files | Failed: no rotated files | Passed: current log plus two old files at the 5 MiB boundary |
| F9 checkpoint and install receipts skip environment walks but release scans | Failed: three unnecessary full walks | Passed: zero walks for those calls; release still scans |

The final instrumented command-body timings were 24.78 ms for empty status, 38.31 ms for status with two running lanes, and 2,612.62 ms for lease. A separate actual CLI timing run, including Node startup and JSON parsing, measured **80.05 ms empty status, 109.51 ms two-running-lane status, and 1,729.49 / 2,440.74 ms for two successive leases**. All timing runs used disposable synthetic repositories and relocated state. Counts measure normal uncontended commands; lock contention can require an OS identity check of its holder.

The first complete corrected run was 48/48 in 150.846 seconds, still over budget. A fixture-cache-only run under load took 186.690 seconds. The final reduction uses one verified test-volume probe per fixture process, skips index writes when no hidden flags exist, and separates the existing independent cases across isolated test files. No tests were excluded, no real-process proof was replaced, and production registration still performs its own CIM check. The full gate now discovers four files: `lifecycle.test.js`, `pool.test.js`, `round2.test.js`, and `workspace.test.js`, all under `C:\dev\.orch\harbor\lane-pool-1101\app\test\lane\`.

## Built

The CLI is `C:\dev\.orch\harbor\lane-pool-1101\bin\harbor-lane`. It delegates to plain CommonJS modules in `C:\dev\.orch\harbor\lane-pool-1101\app\src\shared\lane\`. There are no new dependencies, Electron imports, Python processes, launchers or background watchers.

The implementation registers bounded, permanent, lazy-created Git worktree slots. Slot 00 is reserved for integration; slots 01 through N serve write and detached verification lanes. Pinned object inspection and explicitly live canonical reads allocate no slot. Global/repository locks cover short claim and publication transactions. Preparation runs outside both locks with its own preparer identity and reserved slot. Publication reloads current state and changes only its own fenced lane/slot, preserving other lanes' concurrent updates.

The external state store has a checksum-chained, fsynced journal of changed records. After 2,000 records it writes a checksummed state snapshot holding the last hash, creates a new tail, and atomically publishes their manifest. It retains the current and previous snapshot/segment generations. Load reads the current snapshot and tail; corruption refuses rather than reverting to older state. Events rotate at 5 MiB with two old files. Durable lane/session history remains in the snapshots; retirement is still separate. Locks publish a complete fsynced temporary record with an atomic hard link. Bounded Atomics waits default to 60 seconds (`HARBOR_LANES_LOCK_WAIT_MS` overrides), with OS probe time limited by the remaining deadline. Nothing is freed by age.

New branches are created from a resolved SHA with `switch -c`. Existing branches, prior lane ids and durable lane refs are refused. Release requires an explicit final commit, clean worktree/index/untracked state, no unfinished Git operation, and the expected branch. It records `refs/lanes/<lane-id>/final`, detaches and frees. A sealed awaiting-review lane survives worker exit and releases normally. Only proven owner/preparer loss quarantines; failed probes leave state unchanged. Reconciliation runs only on lease, resume, recover and status. Capability-checked mutations do not sweep machine-wide owners. Recovery still requires clean state and a recorded matching final ref.

Boot identity requires Harbor's existing daemon boot-id module, including its 60-second tolerance and unknown verdict. Own-process lock/preparer identity is computed in-process. External lane identities use one batched Get-Process query for reconciliation, plus the new owner's identity lookup when needed. Status uses boot and signal-zero absence checks without PowerShell; an existing external PID remains unknown until creation-time validation during allocation/recovery. A failed first worktree add rolls back only its previously absent path and registration, then frees the slot. The failed lane id stays recorded; another lease uses a new id. Add, hard reset and switch have 30-minute timeouts.

Resume retains the original slot, restores the recorded tip, refuses a moved branch, and rotates the generation and token. Durable session mappings use provider, absolute config home and session id. Each state mutation checks the lane capability and the slot's current occupant. Old tokens and old generations independently fail.

Preparation validates NTFS volume/root identity, repository metadata identity, exact worktree registration and the administrative backpointer. CIM checks NTFS/serial once during registration; subsequent volume checks compare realpath, dev and ino without a subprocess. Git routing variables are stripped; hooks/fsmonitor are disabled. Applied filters, submodules, nested repositories and sparse worktrees are refused. Hidden flags are inspected once and only flagged entries are rewritten. Cleanup uses lstat without following links and preserves only allowlisted generated directories. Full environment scans run on prepare, release and recover. Checkpoint requires a clean tree; environment receipts use only slot metadata and on-disk manifests, as corrected in round 3.

## CLI contract

Invoke with `node C:\dev\.orch\harbor\lane-pool-1101\bin\harbor-lane <command> <options>`.
All commands emit exactly one JSON object on stdout. Success is `{ "ok": true, "command": "...", "result": ... }`; refusal is `{ "ok": false, "code": "...", "message": "...", "details": ... }`.

In the table, **capability** means `--lane <id> --token <token> --generation <number>`. All paths supplied to registration and session mapping are absolute. `--allowlist` takes a JSON string array; `--runtimes` takes a JSON object of version/option strings. IDs use lowercase letters, digits, underscores and hyphens, at most 64 characters.

| Command | Required options | Optional options and result |
| --- | --- | --- |
| `init-repo` | `--repo --path --pool-root --size` | `--allowlist`, `--max-writes`; registers an existing root, N ordinary slots plus integration slot 00. First registration sets the shared cap, default 4. |
| `lease` | `--repo --lane --base --type`; `--owner-pid` for write/verify/integration | `--branch` required for write/integration, prohibited for other types; optional `--runtimes`. Only inspect/live can default owner to the parent PID. |
| `resume` | capability, `--owner-pid` | Optional `--runtimes`; requires a released lane and its original slot free. Returns renewed capability and restored final tip. |
| `status` | None | Full repository, slot, lane and session registry; reconciles owner loss to quarantine. |
| `checkpoint` | capability, `--final` | Seals clean current commit under the final ref; holds the slot for review. Can seal a repaired quarantined lane without freeing it. |
| `release` | capability, `--final` | Explicit coordinator release after review/merge and quiescence. Records final ref, detaches, frees. |
| `recover` | `--repo --slot --token --generation` | Rechecks a quarantined slot whose owner is provably gone. Frees only with clean state and an already recorded matching final ref. |
| `quarantine` | capability, `--reason` | Explicit hold; preserves the workspace. |
| `env-begin` | capability | Invalidates installation receipt and returns expected fingerprint before caller installation. |
| `env-ready` | capability, `--fingerprint` | Requires a prior begin and a current matching fingerprint; records the caller's successful-install attestation. |
| `bind-session` | capability, `--provider --config-home --session` | Durably binds a Claude, Codex or Cursor session; refuses rebinding to another lane. |
| `resolve-session` | `--provider --config-home --session` | Returns original repository/lane/slot mapping and latest capability. Never identifies work by historical path alone. |
| `recover-lock` | `--name` | Names are `global` or `repo-<repo-id>`. Removes a provably dead owner's lock under a recovery guard. |

Exit codes remain **0** success, **1** unexpected I/O/runtime error, **2** invalid arguments, **3** admission/contention refusal, **4** safety refusal. Capacity still fails immediately. Only short lock acquisition has a bounded wait; there is no standing retry service. Unknown liveness observations alone do not change lane state.

## Round-one proofs retained

The round-one gate was **37/37**, 631.146 seconds. These cases remain in the corrected 48-test gate. Expected lifecycle changes are explicit: the sealed recovery fixture now requests quarantine, while a separate F4 test proves normal completion avoids it; a preparation crash no longer leaves global/repo locks held. Boot tests use the shared helper's unknown and foreign-boot semantics.

The retained tests are in the lane test directory named above:

1. New lanes refuse existing branches and lane ids without moving refs.
2. Release preserves the final ref, detaches, and resume restores the same slot and tip.
3. Resume refuses a moved branch or busy original slot despite other free capacity.
4. Dirty release is refused; live owners retain leases; dead dirty owners quarantine.
5. Recovery refuses a live owner.
6. An explicitly quarantined dead owner with a sealed deliverable can be recovered.
7. A clean but unsealed dead owner stays quarantined with a reason.
8. Real child-process exit during preparation quarantines the slot without leaving global/repo locks held.
9. Two actual CLI processes racing cannot allocate the same slot.
10. Hidden index flags cannot conceal changes or leak across reuse.
11. Allowlisted dependencies survive while ignored output is removed; an external junction target is untouched.
12. A dependency junction into another directory is refused without changing its target.
13. Fingerprints distinguish warm dependencies, lockfile/runtime changes and interrupted installs.
14. Full ordinary capacity refuses immediately; integration slot is reserved.
15. The write cap spans repositories; verification uses a detached ordinary slot.
16. Stale tokens and stale generations independently cannot mutate a newer occupant.
17. Session mapping survives reuse and updates generation on resume.
18. Pinned inspection and explicit live reads allocate no slots.
19. Nested repositories and submodules are refused and preserved.
20. Missing/replaced pool roots refuse allocation without fallback.
21. Inherited Git routing variables cannot write the canonical or foreign index.
22. Unfinished Git operations refuse release without moving HEAD.
23. Journal replay survives snapshot loss and refuses a torn tail.
24. Lock recovery refuses live/unknown owners regardless of age.
25. CLI prints one JSON object and uses documented argument/refusal exits.
26. A real Windows file handle prevents reset; the slot quarantines with a recorded reason.
27. First and later boot identities match; PID creation mismatch and boot change mean gone.
28. Recovery after an actual process exit between detachment and release publication preserves the final ref.
29. Unused configured filters are allowed; filters used by target content are refused.
30. A tracked path cannot masquerade as an allowlisted generated parent.
31. A full lane cycle preserves the canonical checkout's pre-existing staged and unstaged work.
32. A slot gitfile targeting the canonical index is refused before index mutation.
33. Nested bare repositories are preserved and refused.
34. Registration never creates a missing pool root.
35. The real CLI completes registration, environment receipt, session binding, checkpoint, release, lookup, resume and explicit quarantine.
36. Journal entries contain only changed records; replay verifies their checksum chain and refuses corruption.
37. A failed registry snapshot publication leaves the journaled preparation unavailable.

Development failures were investigated, not hidden: the first run refused all 26 original fixtures because the system Git config includes unused LFS filters. The next run passed 23/26 and exposed combined index-flag handling, an inconsistent cached boot-id format, and an LF-versus-CRLF fixture restoration. A focused seven-test recheck passed 7/7 after correction. The expanded gate passed 34/35: Windows refused the adversarial fixture's attempt to overwrite Git's hidden gitfile before the product check ran. The fixture now replaces the gitfile, preserving the intended guard assertion. Four focused checks then passed 4/4, covering the gitfile guard, current dependency fingerprints, journal growth/replay and snapshot failure. The final 37/37 gate covers all of these changes together.

## Boundaries and Claude's wiring decisions

- Select the shared `HARBOR_LANES_DIR`, pilot sizes and machine write cap. All production callers must use one state directory. Quarantined write lanes conservatively consume capacity; integration also counts as a write. Set the cap and scheduling order so integration is not starved, and retain ordinary-slot capacity for executable reviews when workers are awaiting review.
- Pass the actual owner PID for every executable lease and resume. Retain the capability across usage resets, post-agent checks and report capture. Checkpoint before worker exit to enter awaiting-review. A wrapper exit never releases anything.
- Define the coordinator's review, report/evidence and descendant-quiescence checks before it calls release or recover. V1 has no Job Object supervisor and cannot prove the absence of descendants. A live quarantined owner remains held; resolving it is an explicit coordinator action after that owner exits, not age-based reclamation.
- Supply package-manager, Python or other runtime versions and install options through `--runtimes`. Honor `environment.stale` before execution, call env-begin before installation, and env-ready only after success. The core does not run an installer or validate package contents. It hashes supported tracked manifests/lockfiles, not arbitrary untracked dependency inputs; onboarding must account for external inputs in declared runtime/install-option strings.
- Resolve session mappings before resume, then use the returned lane capability. A busy original slot fails fast. Queue retries belong to existing caller events; never add a timer. A quarantined resume needs reviewed cleanup/sealing and explicit recover first.
- Audit hooks/filters and supported repository layouts during onboarding. Core Git operations disable hooks; normal worker Git operations do not. Applied Git filters, submodules, nested repos and sparse worktrees are refused in v1. Journal corruption and an interrupted lock-recovery guard require operator inspection; there is no automated data-discarding repair.

This gate was run on Windows/NTFS. Linux external-process identity was not exercised here. External-process identity on macOS remains unsupported; shared in-process boot identity is portable.

Not done: launcher/orchestration/Harbor adapters, sessiond changes, cdt-app dispatchers, command guard, Dev Drive provisioning, legacy-workspace retirement, dependency installation, evidence export, report-content validation, review/merge execution, Job Object containment, waiter services, periodic scans, or production registration. No live pool or real lane state was created. The live checkout and its node_modules were not edited or installed through. Only lane tests were run; no full suite or renderer build was run, and no real session daemon was contacted.

Design note: `C:\dev\.orch\harbor\lane-pool-1101\docs\claude\lanes.md`.
