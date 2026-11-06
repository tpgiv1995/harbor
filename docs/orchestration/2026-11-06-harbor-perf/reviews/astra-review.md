Found eight reproducible defects, an overstated cache benefit, and a test that still expects the old behavior. The review is pinned to `df1315b`. Another session committed `a42e511` during review; its changes are distinguished below.

No tracked files were changed, and no running Harbor process was contacted.

## 1. Findings

### 1. Real bug, CONFIRMED: concurrent menu polls return stale question state

**Location:** `C:\dev\harbor\app\src\main\session-send.js:806`, `:3443`, `:3543`

A second `getMenu` call can join the first call’s discovery promise. The first call’s keystrokes invalidate only its own AsyncLocalStorage cache, so the second call’s supposedly fresh read after the walk returns its cached, pre-walk screen.

**Reproduction:** Start discovery on question 2, pause after its first left-arrow, and start another menu poll. After the walk restores question 2:

- Before `688fea8`: both callers report index `1`.
- After `688fea8`: callers report indexes `1` and `0`.
- The actual dialog remains at index `1`.

**Fix:** Bypass or invalidate cached reads whenever awaiting a discovery walk, including another caller’s walk. Prefer a pane mutation generation that invalidates every active poll observing that pane.

### 2. Real bug, CONFIRMED: deferred parsing destroys an opening image

**Location:** `C:\dev\harbor\app\src\main\providers\transcript.js:1967`, `:2506`

`settlePrefixImages` considers images in `conversation.blocks` and `images`, but the separately retained `opening` can already have been evicted from `conversation.blocks`. Its deferred image is never committed. The resulting `{id:null}` then overwrites the usable opening image through `Object.assign(seeded, block)`.

**Reproduction:** A synthetic transcript with 310 image prompts followed by enough assistant output to require prefix seeding. Through the actual provider-open path:

- At `63be28e`, the opening image has a valid content ID.
- At `127ea86`, the same opening image has `id:null`.

The stale-image check also makes this seed repeatedly rescan without repairing it.

**Fix:** Include `state.opening` explicitly in image settlement, independently of parser retention. Verify every emitted image reference is servable before replacing the separately seeded opening.

### 3. Real bug, CONFIRMED: a larger replacement transcript can hide a pending question indefinitely

**Location:** `C:\dev\harbor\app\src\main\providers\pending-ask.js:150`

Growth is treated as proof of append-only writing. Neither file identity nor continuity is checked before reading from the old offset.

**Reproduction:** Read a transcript with no pending question, then overwrite it with a larger transcript containing an unanswered question before the old offset. The existing reader returns `null`; a new reader finds `ask-1`. Subsequent ordinary appends need not repair the cached answer.

**Fix:** Track file identity and continuity evidence, and reset on replacement or detected rewriting. Do not promise equivalence for arbitrary rewrites without a reliable append-only generation signal or a conservative full-tail fallback.

### 4. Real bug, CONFIRMED: the prefix cache serves rewritten content as unchanged

**Location:** `C:\dev\harbor\app\src\main\providers\transcript.js:2083`

The cache compares device/inode and the first and last 4 KB, but ignores changes elsewhere in the covered range. It does not even reject a same-size file whose modification time changed.

**Reproduction:** Cache a 100-prompt file, replace prompt 70 with equal-length text while preserving both sampled ends, then reopen. The cached result reports `mode:"hit"` and retains the old prompt; an uncached scan returns the replacement.

**Fix:** Record size and modification metadata and reject same-size rewrites. For extension, either validate the covered range or establish a trustworthy append-only contract. End samples alone cannot support the documented rewrite-equivalence guarantee.

### 5. Real bug, CONFIRMED: joining a shared poll can falsely close a newly created pane

**Location:** `C:\dev\harbor\app\src\main\session-daemon\client.js:70`

The result is delivered to the membership set at completion, including subscriptions created after the request began. Those subscribers can already have a newer bootstrap snapshot.

**Reproduction:** Begin a shared fetch containing pane A. Join another subscription seeded with A and newly created B. Complete the older fetch: the new subscription emits `pane.closed` for B.

**Fix:** Capture eligible subscriptions when the fetch begins, and exclude subscribers seeded after that fetch’s generation. A subscriber must never receive a snapshot older than its bootstrap state.

### 6. Real bug, CONFIRMED: a second foreign resize during cooldown is never healed

**Location:** `C:\dev\harbor\app\src\main\terminal-bridge.js:392`, `:416`

The cooldown returns without scheduling another attempt. The subscription emits resize events only when dimensions change, so a stable wrong size generates no subsequent opportunity to heal.

**Reproduction:** Heal one foreign resize, report the restored dimensions, then report another wrong size during cooldown. After waiting beyond the cooldown, the resize count remains one.

The added test asserts that the second resize waits, but closes the bridge before checking whether it ever resumes.

**Fix:** Schedule the outstanding correction for the remaining cooldown. Apply the same retry rule when healing is deferred by an active resync or observer resize.

### 7. Real bug, CONFIRMED: delayed index persistence can strand automatic titles

**Location:** `C:\dev\harbor\app\src\main\providers\history-index.js:556`; `C:\dev\harbor\app\src\main\providers\titles.js:315`; `C:\dev\harbor\app\src\main\index.js:2759`

The titler consumes the disk index, while `history-refreshed` now announces changes that may exist only in memory. The trailing cache write does not schedule another titler pass.

**Reproduction:** Establish an idle titler pass, add a new session during the save interval, refresh history, and run the scheduled titler before persistence. It skips against the old index. After the trailing write, the new session is on disk but title calls remain zero. An explicitly requested later pass names it.

**Fix:** Give the titler the current in-memory index or schedule it after successful trailing persistence. A disk cache used by another subsystem is not merely a cold-start optimization.

### 8. Real bug, CONFIRMED: shared-poll failure handling loses the in-flight bound

**Location:** `C:\dev\harbor\app\src\main\session-daemon\client.js:64`

Fallback `_poll()` calls are launched without awaiting them, then the shared poller clears `inflight`. Every subsequent tick can launch another fallback against a slow healthy client.

**Reproduction:** One failing owner and one healthy owner whose response is delayed. Three ticks produce three simultaneous requests against the healthy owner. The failing owner remains the selected primary.

**Fix:** Await fallback work, group subscriptions by owner, and select a functioning owner for subsequent ticks. Preserve generation ordering so overlapping responses cannot overwrite newer state.

### 9. Cost claim wrong, CONFIRMED: four cached prefixes do not cover a restored stage

**Location:** `C:\dev\harbor\app\src\main\providers\transcript.js:1896`

The “scanned once per file” description omits the four-entry limit, despite the target workload allowing sixteen windows.

**Measurement:** Two sequential passes over five unchanged synthetic files produced ten scans, zero hits, and five misses on the second pass. A sixteen-window restoration can retain at most four prefixes.

**Fix:** Size the metadata cache for the supported restored-window set, within its byte budget, or explicitly qualify the benefit. Benchmark repeated multi-window restoration rather than repeatedly opening one file.

### 10. Minor, CONFIRMED: an unchanged-update test now fails depending on filesystem timing

**Location:** `C:\dev\harbor\app\test\providers\transcript.test.js:1467`

The test still requires two emissions after repeated usage records. When the second write leaves the header unchanged, the new suppression correctly omits that emission.

**Observed:** The focused transcript suite failed with `1 !== 2` at this assertion. Its other 101 tests passed.

**Fix:** Control the modification timestamp and test suppression explicitly. Separately test a header-only change. Updating only the settled-subagent assertion missed this sibling expectation.

## 2. Missed performance bugs, ranked

Costs below describe `df1315b`. Estimates are distinguished from measurements.

1. **The phone server still runs the full pipeline without a connected phone. ARGUED, structural.**  
   `C:\dev\harbor\app\src\server\compose.js:209`, `:663` constructs and starts its own history, delegation, terminal, ask and artifact services unconditionally. Read-only indexing removes duplicate writes, not duplicate resident indexes, scans or polling. The image-store allowance alone remains another 128 MB. Gate optional work on demand or consume the desktop’s published state.

2. **Missing-transcript question polls bypass the new store-scan throttle. CONFIRMED.**  
   `C:\dev\harbor\app\src\main\ask-transcript-path.js:40` calls the shared finder without throttling; the throttle exists only in transcript initialization. Three resolver polls against a synthetic 4,486-directory store made **13,458 access attempts**. Sixteen missing UUIDs can therefore generate 71,776 attempts per polling round. Share throttling and in-flight searches across consumers while preserving cheap direct-path checks on every retry.

3. **Recent and visible menu reads still fetch the same daemon screen twice. ARGUED, exact call path.**  
   `C:\dev\harbor\app\src\main\session-send.js:2182` requests both views; `C:\dev\harbor\app\src\main\session-daemon\client.js:344` fetches both fields in either request and chooses the source locally. With sixteen no-dialog windows and negligible latency, the duplicate costs about **1,371 extra screen RPCs/minute**. Working meters add up to another 960 reads/minute. Share the underlying screen response within a poll, with mutation invalidation, rather than caching already-selected text by source.

4. **Artifact listing remains a large repeated filesystem sweep. ARGUED; audit mechanism confirmed.**  
   `C:\dev\harbor\app\src\main\providers\artifacts.js:435` canonicalizes all cached candidates and stats every unique candidate per sequential list. `C:\dev\harbor\app\src\renderer\artifacts\ArtifactsView.jsx:209` requests this every five seconds. At the supplied corpus size, that is **845,784 candidate visits/minute**, plus unique-path stats. Collection also walks project directories and rewrites the cache. Correction to the audit: collection is triggered by listing and staleness, not an unconditional sixty-second timer.

5. **Delegation refresh still rechecks the recent corpus. ARGUED; audit mechanism confirmed.**  
   `C:\dev\harbor\app\src\main\providers\delegations-worker.js:37`, `:122` stats each eligible transcript and gathers beacon evidence on every pass. Using the supplied 1,724-file corpus and three refreshes/minute in two processes gives roughly **10,344 transcript stats/minute**, before idle-triggered passes and beacon stats. The 2.5 MB fold can also be rewritten on changed passes. `a42e511` subsequently changes row handoff; that work is outside this review.

6. **Quiet history deltas still regenerate every row in the worker. CONFIRMED on the real corpus.**  
   `C:\dev\harbor\app\src\main\providers\history-index.js:626`, `:645`, `:682` rebuilds and escapes all lines before comparing them. Read-only measurement over **12,250 rows**: quiet calls took **125 to 152 ms**, performed **576,754 string replacements**, and processed **62.8 million input characters**, despite zero changed rows. The full line set was 15.5 MB; the delta wire payload was 478 KB. Cache formatted rows against their actual inputs. The transport savings are real, but worker formatting remains.

7. **Home-map invalidation rereads all homes in the reviewed baseline. ARGUED; audit confirmed at `df1315b`.**  
   `C:\dev\harbor\app\src\main\providers\history-index.js:727` rebuilds from every history file and both directory inventories when one input changes. The supplied corpus implies about **25.2 MB of history parsing and 114,000 directory-name visits/minute** at three refreshes in two processes. `a42e511` adds incremental handling here, so this is a baseline finding, not a claim that the latest checkout still has the same cost.

8. **Phone rail pushes discard deltas and rebuild projections. ARGUED; audit confirmed.**  
   `C:\dev\harbor\app\src\server\compose.js:640` drops the desktop delta and projects the full model every two seconds during updates. Projection walks all rows, then transport serializes the projected result per client. At 12,250 rows, projection alone visits roughly **367,500 rows/minute**, including when no client needs the result. Avoid projecting without subscribers and preserve usable deltas across the mobile transport.

9. **Team recomputation remains independent of subscribers. ARGUED; audit qualified.**  
   `C:\dev\harbor\app\src\main\providers\team.js:533`, `:630`, `:658` recomputes on bridge updates, scans history for recent subsessions, derives the team and serializes its change key. At two updates/second and 12,250 history rows, that is approximately **24,500 history-row visits/second**. This is event-driven with a 250 ms coalescing delay, not a continuous four-Hz timer. The transcript worker is incremental; its existence alone does not prove repeated whole-file reads.

10. **Lower-priority repeated work remains in three paths. ARGUED.**
    - `C:\dev\harbor\app\src\main\providers\transcript.js:2355`: quiet unfinished subagents still cause directory, metadata and transcript checks on parent refreshes. Cache metadata and use watchers. Do **not** permanently settle a quiet child, as the static audit suggests; quiet children can resume.
    - `C:\dev\harbor\app\src\daemon\daemon.js:1065`: an eligible missing transcript can cause roughly 4,486 synchronous existence checks per dormancy lookup. This is conditional on dormancy evaluation, not every active session every minute.
    - `C:\dev\harbor\app\src\main\providers\delegate.js:594`: watched orchestration queues retain ten-second polling and whole event-file reads. With the reported sub-16 KB files, this is currently small: about 96 KB/minute per watched event file, plus queue and summary work.

## 3. Wrong or overstated performance-doctrine claims

In `C:\dev\harbor\docs\claude\performance.md` at `df1315b`:

- **“The cache only spares a cold start re-parsing” is false.** The titler consumes the persisted index; delayed saves affect behavior.
- **Prefix scans are not “once per file.”** The four-entry limit causes repeat scans across larger working sets.
- **“Exact merge” and “full rescan on any doubt” overstate rewrite protection.** Unsampled middle rewrites are accepted as hits.
- **Deferred images are not always preserved for retained blocks.** An evicted-but-retained opening can be emitted with an unusable image ID.
- **The screen-cache safety explanation misses shared discovery promises.** One caller’s input does not invalidate another waiting caller’s cache.
- **The shared poll’s one-request discipline does not survive fallback.** Healthy fallback requests can overlap across ticks.

The history transport reduction, no-observer frame-encoding reduction, and modeled scrollback reduction are supported. Their post-deployment aggregate CPU or commit savings were not measured in this review.

## 4. Checked and found sound

- History deltas matched full lists through concurrent calls, a lost reply, filtering, duplicate IDs, renames, deletion and reordering.
- Stale worker epochs request full answers.
- Ordinary append-only prefix extension and queue-reference merging passed the equivalence fixtures.
- Split pending-question lines are found when completed; appended answers clear questions.
- Input performed by the same menu poll disables its cache; single-walk delivery tests passed.
- Closed shared-poll subscriptions stop receiving events; normal sharing and error isolation passed.
- The newest-half eviction and cwd-ancestor lookup tests passed.
- Idle transcript suppression still emits clock-driven shimmer, owner-liveness and context changes in the focused tests.
- The isolated keeper test confirmed zero frame encoding without observers and unchanged observed frame contents.
- The isolated daemon tests confirmed dialog-resize refusal while observed and release after unobserve or disconnect.

**Focused test result:** 244 tests, 243 passed, one failure described above. No full suite or live application drive was run. Reproduction scripts and logs are confined to `C:\dev\harbor\docs\orchestration\2026-11-06-harbor-perf\private\astra-scratch\`.