All round-2 reproducers now pass against `e826501`. Five additional probes still fail, including a new snapshot-ordering regression.

No tracked files were changed, and no live Harbor process was contacted.

## 1. Round-2 retest results

“FIXED” here refers to the original reproducer; remaining cases follow below.

| Finding | Result | Evidence |
|---|---|---|
| N1: stale ownership after history rewrite | **FIXED** | The incremental map removes the original session and matches the fresh map after the same-size rewrite. |
| N2: replacement preserving continuity marks | **FIXED** | The larger atomic replacement is detected by identity; the cached reader now finds `question-middle`. |
| N3: stale prefix metadata after growth | **FIXED** | Through full provider opens, the later rewrite causes a rescan and displays the replacement prompt. |
| N4: resumed session omitted from delegation worker | **FIXED** | The same history array now delivers the newly live parent, matching a fresh worker. |
| N5: failed client stalls healthy polling | **FIXED** | Four additional ticks produce four additional healthy requests while the failing retry remains outstanding. |
| N6: failed folder listing cached as empty | **FIXED** | The recovered listing contributes its session again, including without another input change in the focused test. |
| N7: old facts write overwrites close-time flush | **FIXED** | Version C remains persisted after the delayed version B rename. Additional three-writer tests retain version D in both completion orders. |

The two previously partial original findings, **3 and 4**, pass their round-2 replacement and prefix-open reproductions. The remaining original cases also pass: concurrent menu reads, opening images, joining subscribers, deferred resize repair, late titling, cache capacity and lookup throttling.

## 2. Reproduced defects

### R3-1. Real bug, CONFIRMED: a recovered client receives an older shared snapshot

**Location:** `C:\dev\harbor\app\src\main\session-daemon\client.js:72`, `:96`

The shared fetch captures its healthy-owner list before an owner fails. A private retry can subsequently recover that owner and apply a newer snapshot. When the older shared fetch completes, the recovered owner is no longer in `failing`, so it receives the older snapshot too.

**Reproduction:**

1. Client A fails; the shared fetch proceeds to client B and waits.
2. A’s private retry succeeds with panes `old` and `new`.
3. A receives `pane.created` for `new`.
4. B’s older response arrives containing only `old`.
5. A receives `pane.closed` for `new`.

The final pane set incorrectly contains only `old`.

**Fix:** Exclude owners that failed during a particular shared fetch from that fetch’s eventual fan-out, even if they recover meanwhile. A per-subscription snapshot generation would also prevent older responses from replacing newer state.

### R3-2. Real bug, CONFIRMED: unchanged size/mtime bypasses the new identity checks

**Locations:**

- `C:\dev\harbor\app\src\main\providers\pending-ask.js:177`
- `C:\dev\harbor\app\src\main\providers\history-index.js:307`, `:836`

Both paths can return cached data before checking file identity. The pending reader’s fast path compares only size and modification time; the home-map input stamp likewise omits identity.

**Reproduction with actual scratch files:** Atomically replace each file with different content while preserving its size and modification timestamp. The bigint file IDs confirm that these are different files.

- Pending-question reader: cached result is `null`; a cold reader finds `same-stamp-question`.
- Home map: cached result retains session 1; a cold map contains replacement session 2.

These are remaining fast-path holes, not failures of the newly added growth-path identity comparison.

**Fix:** Include exact file identity in the stamps used before returning cached results. Checking identity only after deciding the file changed leaves replacement undetected.

### R3-3. Real bug, CONFIRMED with injected filesystem IDs: home-history identity still loses integer precision

**Location:** `C:\dev\harbor\app\src\main\providers\history-index.js:343`

Unlike the pending reader, `historyCounts` obtains `dev` and `ino` through ordinary Number-valued stats.

**Reproduction:** Inject exact file IDs `9007199254740992` and `9007199254740993`, returning bigint values if requested. They round to the same Number. Replace the history with a larger file retaining its first 256 bytes.

- Incremental map retains obsolete session 2 and adds session 4.
- Fresh map contains sessions 3 and 4.

The test exercised the real incremental reader through its filesystem injection seam. I did **not** observe an actual inode collision among the scratch files checked on this machine.

**Fix:** Obtain identity with bigint stats, as the pending reader now does. Keep identity exact while converting only bounded byte counts needed for buffer operations.

### R3-4. Real bug, CONFIRMED: a transient history-file read failure remains memoized

**Location:** `C:\dev\harbor\app\src\main\providers\history-index.js:374`, `:856`

`folderIds` sets `homeMapRetry` on transient errors, but `historyCounts` does not. Its catch deletes the contribution and returns an empty map, which the outer function then memoizes as successful.

**Reproduction:** Make the first open of a populated `history.jsonl` throw `EACCES`, then restore access without modifying the file.

- First result: empty map.
- Second result after recovery: still empty.
- Fresh reader: contains the session.
- Open attempts: exactly one, proving the recovered file was never retried.

**Fix:** Apply the retry policy to history-file failures too. Preserve the last good contribution where available and avoid memoizing the overall map until the failed input has been read successfully.

### R3-5. Cost claim wrong, CONFIRMED: live Cursor rows force repeated delegation handoffs

**Location:** `C:\dev\harbor\app\src\main\providers\delegations.js:292`

The resend condition checks all history IDs, while the payload filter deliberately excludes Cursor rows and rows without paths. Such a live ID can never enter `sentIds`, so it forces a resend on every scan.

**Reproduction:** Use one unchanged array containing 100 eligible Claude rows and one live Cursor row. Three scans with the same live IDs send:

```text
100 rows, 100 rows, 100 rows
```

Only the first scan should send the rows.

**Fix:** Restrict the missing-live-ID test to rows the worker can actually receive. Preserve resends for newly live Claude rows, while excluding unsupported providers and pathless rows from that trigger.

## 3. Checked and found sound

- Bigint identity detects the original larger replacement even when both continuity samples match.
- Validated prefix hits now refresh whole-file stamps; the full-open stale-prefix reproduction is resolved.
- Same-size rewrite detection and sampled interior rewrite detection pass.
- Failed folder listings remain retryable and recover without another file changing.
- Newly live, previously excluded Claude rows reach the real delegation worker.
- Healthy polling continues during a slow private retry, with one retry outstanding per failing owner.
- Facts generations preserve the newest saved version across delayed writes and delayed renames in both tested completion orders.
- Concurrent menu discovery still returns the correct question to both callers.
- Opening images remain servable, deferred resize repairs execute, and trailing persistence still triggers titling.
- Lookup throttling still permits immediate binding through the known cwd.

**Focused tests:** 298 passed, zero failed. The defects above were reproduced separately.

Evidence remains under `C:\dev\harbor\docs\orchestration\2026-11-06-harbor-perf\private\astra-scratch\`, principally `r3-rerun.cjs`, `r3-attacks.cjs`, `r3-home-same-stamp.cjs`, and `r3-facts-orders.cjs`.