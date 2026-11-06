All ten original reproductions now pass. Findings **3 and 4 should remain open** because stronger cases still fail. I also confirmed five further defects.

Reviewed `714d565` and `a42e511`. No tracked files were changed, and no live Harbor process was contacted.

## 1. Original findings

| # | Status | Retest evidence |
|---|---|---|
| 1. Concurrent menu polls | **FIXED** | Both callers now report question index `1`, matching the terminal. Previously they returned `[1,0]`. |
| 2. Lost opening image | **FIXED** | Both the prefix seed and full transcript-open path return the same valid image ID as the pre-regression code. |
| 3. Larger replacement hides a question | **NOT FIXED fully** | The original replacement is detected. An atomic replacement preserving both continuity marks still returns `null`, while a cold reader finds the question. See N2. |
| 4. Rewritten prefix served from cache | **NOT FIXED fully** | The original same-size rewrite causes a miss. After growth with an unchanged prefix boundary, a subsequent same-size rewrite still serves stale content through the full provider-open path. See N3. |
| 5. Mid-fetch subscriber falsely closes a pane | **FIXED** | The joining subscriber receives no false `pane.closed` event. |
| 6. Second foreign resize never repaired | **FIXED** | The original scenario now produces two repairs, including the deferred correction after cooldown. |
| 7. Delayed persistence strands titles | **FIXED** | Verified through the real history worker and provider: one trailing persistence event produces one title call without an unrelated filesystem change. |
| 8. Fallback fetches overlap | **FIXED** | Maximum concurrent healthy-client requests is now `1`, previously `3`. A separate failure-isolation regression remains, N5. |
| 9. Four-entry prefix-cache thrashing | **FIXED** | The original five-file cycle returns five hits. The focused sixteen-file test also passes. |
| 10. Timing-dependent emission assertion | **FIXED** | The transcript suite passes all 102 tests. The assertion still checks the real token patch and rejects a redundant patch. |

The additional missing-transcript reproduction improved from **13,458 access attempts to 4,486** across three polls. A real file appearing under the known cwd was found during the throttle interval without another store scan.

## 2. Remaining and new defects

### N1. Real bug, CONFIRMED: incremental home history retains obsolete ownership after a rewrite

**Location:** `C:\dev\harbor\app\src\main\providers\history-index.js:350`

`historyCounts` accepts a cached contribution whenever the file remains at least as long as `completeTo` and its first 256 bytes match. It does not distinguish a same-size rewrite from unchanged content, despite the outer stamp detecting the changed modification time.

**Reproduction:** Write one history record whose long display text puts its session ID beyond byte 256. Build the map, replace that ID with an equal-length ID, and advance the modification time.

- Current incremental map retains the original session.
- A fresh map contains the replacement session.
- The implementation before `a42e511` refreshes correctly on the same fixture.

This can retain wrong account attribution and omit the replacement session indefinitely.

**Fix:** Record file identity, size and modification metadata for each contribution. Rescan on replacement and same-size modification. Treat growth as incremental only under an established append-only continuity rule.

### N2. Real bug, CONFIRMED: pending-question continuity marks ignore actual file replacement

**Location:** `C:\dev\harbor\app\src\main\providers\pending-ask.js:87`, `:172`

The reader checks two byte samples but never checks file identity. A replacement can preserve both samples while changing records between them.

**Reproduction:** Cache a transcript containing no question. Atomically replace it with a larger file that:

- Preserves the first 256 bytes.
- Preserves the 256 bytes preceding the old stop.
- Adds an unanswered question between those samples.
- Appends ordinary data beyond the old stop.

The filesystem identity changed. The existing reader returns `null`; a cold reader finds `question-middle`.

**Fix:** Compare device/file identity from the opened handle before using the append path, preferably with bigint stats on Windows. Keep the continuity checks for in-place changes, but do not describe samples as proof that replacement did not occur.

### N3. Real bug, CONFIRMED: prefix-cache hits leave whole-file metadata stale

**Location:** `C:\dev\harbor\app\src\main\providers\transcript.js:2116`, `:2124`

`cached.fileSize` and `cached.fileMtimeMs` are updated only when the prefix is extended. They remain stale when the file grows but the requested prefix boundary stays unchanged.

That boundary can remain unchanged during ordinary opens because the tail starts at a record boundary.

**Reproduction through actual transcript opens:**

1. Open a large synthetic transcript and cache its prefix.
2. Append a small record. The aligned prefix boundary stays unchanged, producing a hit.
3. Rewrite a retained prompt without changing the file’s current size, and advance its modification time.
4. Reopen.

The cache produces another hit and displays the old prompt. Clearing the cache displays the replacement. A control scan that starts with the current whole-file metadata correctly rejects the same-size rewrite.

**Fix:** Refresh whole-file size and modification metadata after every validated cache hit, including hits with unchanged `endOffset`. Preserve the documented limitation that unsampled rewrites during growth cannot be proved absent by sampling.

### N4. Real bug, CONFIRMED: delegation filtering loses sessions that become live between history refreshes

**Location:** `C:\dev\harbor\app\src\main\providers\delegations.js:284`

Row eligibility depends on `latestLiveIds`, but row handoff is invalidated only by history-array identity. Once an old Claude row has been filtered out, changing the live set alone cannot put it into the worker’s resident rows.

**Reproduction using real isolated workers:**

- First scan: a 72-hour-old Claude row is not live and is omitted.
- Second scan: reuse the same rows array and mark that session live.
- Result: `parents` remains empty.
- Control: a fresh delegation index given the same row and live ID returns the parent.

A resumed session can therefore lack background and owner evidence until another history refresh replaces the rows array.

**Fix:** Include eligibility changes in handoff invalidation. Send newly eligible rows when the live set changes, even when the history array is unchanged.

### N5. Real bug, CONFIRMED: one slow failed client stalls healthy shared-poll subscribers

**Location:** `C:\dev\harbor\app\src\main\session-daemon\client.js:61`, `:77`

The new global `inflight` flag remains set while the poller awaits every previously failing client. A slow retry on one client prevents the healthy client from being polled again.

**Reproduction:** Establish a healthy `lastGood` owner after another owner fails. On the next tick, let the healthy owner answer immediately and hold the failing owner’s retry. Four additional ticks produce no additional healthy fetches: its request count stays at `2`.

With the default request timeout, one bad client can impose approximately ten-second update gaps on healthy subscribers.

**Fix:** Keep healthy shared polling independent of failing-owner retries. Bound each owner’s requests separately, prevent overlap within that owner, and preserve per-subscription snapshot ordering.

### N6. Real bug, CONFIRMED: a transient directory-read failure becomes a durable empty ownership contribution

**Location:** `C:\dev\harbor\app\src\main\providers\history-index.js:375`, `:385`

When `readdirSync` fails, `folderIds` caches an empty array against the directory’s valid stamp. Later rebuilds reuse that empty result even after access has recovered.

**Reproduction:** Make the first listing of a populated `session-env` directory throw `EACCES`. Restore access and append an unrelated history record to force another home-map rebuild.

- The incremental map still omits the directory’s session.
- A fresh map includes it.

**Fix:** Do not cache a failed listing as a successful empty contribution. Preserve the last good contribution where available and mark the overall memo retryable until the listing succeeds.

### N7. Minor, CONFIRMED: an older asynchronous facts write can overwrite the close-time flush

**Location:** `C:\dev\harbor\app\src\main\providers\provider-history.js:220`, `:235`, `:247`

The trailing writer and synchronous close-time flush are not serialized. An older writer can complete its rename after close has saved newer facts.

**Reproduction:**

1. Persist version A.
2. Let the trailing write for version B reach its rename, then pause it.
3. Refresh to version C and close the provider.
4. Read the cache: version C.
5. Release B’s pending rename.
6. Read the cache again: version B.

The file-stamp validation limits the usual consequence to extra cold-start parsing, but the claim that close leaves the newest facts persisted is false.

**Fix:** Serialize persistence and make the final flush join or supersede an outstanding writer. Prevent an older generation from renaming over a newer saved generation.

## 3. Checked and found sound

- Pane input generations invalidate the second caller’s cached screen across a shared discovery walk.
- Single-walk question delivery and input-driven rereads pass the focused delivery tests.
- Opening-image settlement survives parser eviction and preserves a servable image through full provider opens.
- Ordinary append-only prefix extension and queue-reference equivalence tests pass.
- Interior sampling detects a sampled rewrite even when size and modification time are preserved.
- Mid-fetch subscription joins no longer receive the older fetch result.
- Deferred foreign-resize repairs execute after cooldown without requiring another size event.
- Trailing persistence crosses the worker boundary, emits `history-changed`, and allows the new session to be titled.
- Read-only indexing, ordinary interval saves and explicit flush behavior pass.
- The home map matches full reads for ordinary appends, split lines, deletion, shorter rewrites and directory additions covered by the focused tests.
- The delegation filter preserves currently eligible Claude rows and old Codex rows on initial handoff.
- No regression found in cwd munging memoization for the actual string-valued callers.
- The ask lookup still checks the derived path during throttling.

**Focused tests:** 292 passed, zero failed. The seven defects above were reproduced separately with synthetic scratch fixtures.

All reproduction scripts remain under `C:\dev\harbor\docs\orchestration\2026-11-06-harbor-perf\private\astra-scratch\`, principally `r2-attacks.cjs`, `r2-prefix-open.cjs`, and `r2-persistence.cjs`.