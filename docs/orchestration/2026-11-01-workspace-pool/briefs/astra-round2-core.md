# Workspace-pool core, correction round 2 (Claude's adversarial review)

Same worktree: `C:\dev\.orch\harbor\lane-pool-1101`, branch `lane-pool-2026-11-01`. Build on your two commits (282873f, 9bc4283). Same rules as round 1: synthetic fixtures only, `HARBOR_LANES_DIR` isolation, no live pool, no real lane state, do not touch `C:\dev\harbor` or its node_modules, `windowsHide: true` on every spawn, no timers or standing loops. Run `npm test -- lane` (it is the only suite you run). Return the full round report as your final message (the `-o` file is overwritten by your last message), and update `docs\orchestration\2026-11-01-workspace-pool\reports\core.md` in the worktree and commit it with the code.

Every fix below needs a test that FAILS on 9bc4283 and passes after; name each test in the report with its before/after result.

Measured on the Legion tonight (idle-ish machine, a publish gate running): `harbor-lane status` on an empty store 1.37 to 1.44 s; the CIM boot query alone 0.9 s; `Get-Process` alone 0.47 s. Earlier measurements on this machine put CIM at 3 to 5 s under load (Harbor doctrine, memory win32-process-question-costs). Your full lane gate took 631 s. The lane suite runs inside Harbor's normal gate (`npm test -- --exclude daemon --exclude bin`, also CI on windows-latest and the 6-minute public-publish gate), so its runtime is a cost on every commit.

## F1 (high, correctness): a slow or failed identity probe quarantines live lanes

`identity.cjs` `ownerState` returns `'unknown'` on any PowerShell error or its 15 s timeout, and `pool.cjs` `reconcile` quarantines every active lane whose probe is not `'live'`, on every command (status, bind-session, env-begin, env-ready, checkpoint...). One slow PowerShell call under load quarantines every running lane on the machine. Those lanes then refuse env-begin, env-ready, bind-session and release in the middle of a worker's run, and `recover` refuses because the owner is live. A transient measurement failure must never change state.

Fix: only `'gone'` quarantines. `'unknown'` leaves the lane as it is (record the probe failure in the result or an event if useful). Test: a lane whose owner probe fails (inject the probe failure; do not rely on timing) stays `running` and can still env-begin and release; the same lane quarantines once the probe says `'gone'`.

## F2 (high, cost): PowerShell and CIM on the hot path

Today: the Store constructor probes identity (CIM boot + Get-Process) on every command, including `status`; `checkVolume` runs a CIM disk query several times per lease; reconcile spawns one PowerShell per distinct owner on every command; lock contention spawns another.

Fix, all of:
- Boot identity: no subprocess. Reuse Harbor's `app\src\daemon\boot-id.js` (`currentBootId`, `bootRelation`: `since:<now minus os.uptime()>` with its 60 s tolerance, three-state) by requiring it, not by copying it. A changed boot means gone; `unknown` follows F1.
- Volume identity: on Windows, Node's `fs.statSync(root, { bigint: true }).dev` is the volume serial number. Query CIM for NTFS and the serial once, at `init-repo`; `checkVolume` compares realpath, dev and ino with no subprocess.
- Lock owner record: no subprocess on the uncontended path. Record pid, boot id and the process's own start time computed in-process (`Date.now() - process.uptime() * 1000`). Only on contention, ask the OS for that pid's creation time and compare within a tolerance of a few seconds.
- Lane owners: one PowerShell call per command at most, batched for every owner it needs (`Get-Process -Id a,b,c`). Reconcile only in the commands that allocate or report (lease, resume, recover, status). A lane's own mutations (bind-session, env-begin, env-ready, checkpoint, release, quarantine) already pass its capability check and do not need a machine-wide owner sweep.

Acceptance: `status` on an empty store and on a store with two running lanes spawns zero PowerShell processes. A lease spawns at most two (owner identity plus one batched reconcile). Prove the counts with a test that counts spawns (wrap `spawnSync` or stub the identity module) and report measured timings for status and lease. Get the lane suite under 120 s on the Legion. If a real-process proof truly cannot be made fast, say which and why. Do not move tests out of the gate to hit the number.

## F3 (high, operability): one preparation blocks every lane on the machine

`transaction` holds the global lock, and the repo lock, across `ws.prepare`. A first-time `worktree add` of a 9,386-file repository (cdt-app) takes tens of seconds. During that time every command for every lane (bind-session, env-ready, checkpoint, release, status) fails at once with LOCK_BUSY, exit 3, and callers have no way to wait. With 4 to 8 lanes starting together, most adapter calls hit it.

Fix, both:
- Preparation runs outside the global and repo locks. Claim under the locks: the slot goes to `preparing` with the preparing CLI process's identity recorded as preparer, then save. Prepare holding only that slot's state. Re-take the locks to publish `running`. Reconcile treats `preparing` with a live preparer as busy, untouched. With a gone preparer it is interrupted and goes to quarantine as today. A preparer whose probe is unknown is untouched (F1).
- Lock acquisition waits a bounded time for the short critical sections: default 60 s, overridable by `HARBOR_LANES_LOCK_WAIT_MS`, sleeping between attempts with `Atomics.wait` (no busy CPU), then LOCK_BUSY. This is a bounded wait inside one command, not a standing loop.

Tests:
- A fault-injected slow preparation, using a real child process that holds `preparing`, does not stop a concurrent bind-session, checkpoint or status on another lane of the same repository.
- A crash during preparation still ends in quarantine.

## F4 (medium): the normal finish path lands in quarantine

A worker checkpoints, so its lane is `awaiting-review` with a sealed final ref, and then exits. The next command reconciles that lane to `quarantined`/OWNER_GONE. `release` then refuses, because it only accepts running or awaiting-review. So every normal "worker finishes, coordinator reviews, coordinator releases" path goes through quarantine plus `recover`.

Fix: owner liveness does not apply to a lane in `awaiting-review` whose final ref is recorded and matches; reconcile leaves it alone. Test: checkpoint, owner exits, `status`, then `release` succeeds with no recover.

## F5 (medium): the default owner is often a throwaway shell

`--owner-pid` defaults to `process.ppid`. That is whatever spawned the CLI, often a transient `cmd.exe` or shell wrapper, so the lane is quarantined as OWNER_GONE on the next command. Fix: `--owner-pid` is required for write, verify and integration leases and for resume (INVALID_ARGUMENT without it). The default stays only for inspect and live. Test both.

## F6 (medium): a crash while writing a lock wedges the machine permanently

`lock()` creates the lock with `wx`, then writes it. A crash between those two steps leaves an empty or partial lock. Every command then answers LOCK_UNKNOWN, and `recover-lock` refuses unreadable locks, so it needs a hand deletion. Fix: write the record to a temp file in the same directory, then `fs.linkSync(temp, lockFile)` (atomic create-if-absent with full content), then unlink the temp. An unreadable lock should then be impossible except by outside tampering. Test: fault between temp write and link leaves no lock and the next command proceeds.

## F7 (medium): a timed-out first checkout leaves a slot that can never be used

`git()` uses a 120 s timeout for everything. A first `worktree add` of a 9,386-file repository, or a `reset --hard`, on a loaded machine (Defender scans every write) can exceed that. Git is killed, the slot path exists but was never recorded as created, and every later prepare answers PATH_UNSAFE "Unregistered slot path already exists". Recover cannot fix it either.

Fix:
- Give `worktree add`, `reset --hard` and `switch` a 30-minute timeout.
- When `worktree add` fails, clean up what it created. Prepare proved the path did not exist beforehand, so the leftover is ours: `git worktree remove --force` if it got registered, then `git worktree prune`, else remove the partial folder. The slot returns to free.

Test: fault-inject a failed `worktree add` (for example a fault hook after the folder exists). The slot ends free with no folder left, and the next lease uses it.

## F8 (medium): unbounded growth

`journal.jsonl` is replayed and hashed in full on every command and never compacted. Every state change appends about 1 KB, at an estimated 100 to 300 changes a day. `events.jsonl` gains two lines on every command (lock acquired and released) and never shrinks. Harbor's rule: anything new that writes bulk to disk gets its bound in the same change.

Fix:
- Journal checkpoints: once the journal passes 2,000 records, write a snapshot holding the state plus the last hash. Start a new journal segment chained to that snapshot, and keep the previous segment and its snapshot (two generations). Load reads the newest valid snapshot plus its tail. A torn tail or chain break still refuses, as today.
- Events: rotate `events.jsonl` at 5 MB, keeping two old files.

Tests: replay across a checkpoint; a corrupt newest segment refuses; events rotation keeps two files.

## F9 (low, cost): environment walks on calls that do not need them

`validateEnvironment` walks the whole slot, including the allowlisted environment. cdt-app's `.venv` alone is 29,927 entries. It runs on prepare, checkpoint, release, recover, env-begin and env-ready. Keep the full link scan on prepare, release and recover; env-begin, env-ready and checkpoint need only the manifest fingerprint and the clean-tree check.

## Out of scope this round

Launcher adapters, Harbor identity mapping, the guard, Dev Drive, legacy retirement, registering any real repository. Claude does those after this round.
