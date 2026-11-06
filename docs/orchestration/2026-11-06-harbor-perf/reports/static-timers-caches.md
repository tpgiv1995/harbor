# Harbor steady-state waste: static audit of timers, caches and whole-file reads (2026-11-06)

Read-only audit. Paths are under `C:\dev\harbor\app\src`. "Desktop" = Electron main, "server" = phone server (`server/compose.js`). Corpus measured on this machine today: 12,224 transcript files in the history index (`~/.cache/harbor/index.json` = 17.2 MB), 1,724 files in the delegation fold (2.5 MB), 8,638 files / 70,482 candidates in the artifact index (9 MB), 4,486 project dirs, 4.2 MB of `history.jsonl` across 7 homes, 15,777 `session-env` entries in `.claude` alone.

## Structural finding first

**S. The whole rail pipeline runs twice.** `compose.js:140-200` builds its own `createSidebarBridge` (history worker, provider-history, delegation worker, provider linker, ask-inbox, 2 daemon clients), terminal bridge, artifacts cache, image store and transcript provider; desktop main builds the same. Every "both" row below is paid twice, and both history workers write one `index.json`. CONFIRMED. Fix: server runs `HARBOR_INDEX_READ_ONLY=1` now (history-index.js:494 honours it); long term it reads the desktop's model.

## Ranked findings (top 15)

**1. Titler parses the 17 MB index on the main thread every history refresh. Desktop. CONFIRMED.**
`index.js:2759` (`history-refreshed` -> `scheduleTitler`, 1879) re-arms a 15 s timer each time the previous run finished (titlerQueued reset at 1887). `titles.js:287` `loadJson(index.json)` is `readFileSync` + `JSON.parse` (titles.js:123), then builds a 12k-entry Map before knowing whether any session needs a title. About every 30 s while sessions write; 150-300 ms main-thread block and 60-100 MB garbage per run, growing with transcript count. Fix: take rows from `sidebarBridge.getHistoryRows()` (already resident) or skip the run unless the history worker reports an untitled/matured id.

**2. History index rewrites the whole 17 MB `index.json` on any transcript change. Both. CONFIRMED.**
`history-index.js:494-500` calls `saveCache(fresh)` (356-366: `JSON.stringify` of all files, sync write, rename) whenever `pending.length > 0`, i.e. any session appended. Floor is 10 s (`refreshFloorMs`, 250), watcher debounce 5-30 s (`history.js:117-123`), so with 16 live sessions it is every 10-30 s, in two processes. Each worker also keeps `memFiles` and `lastResult` (about 12k objects, est. 60-90 MB) resident. Every refresh also emits a TSV of all ~4.4k sessions (`emit`, 574-610) that main re-parses and re-wraps (`sidebar-bridge.js:485-520`). Fix: persist at most every 5 min and on exit; one writer; read-only in the server.

**3. Image store: 384 MB cap per process, filled with images no block keeps. Both. CONFIRMED mechanism, size SUSPECTED.** `image-store.js:25,55-60` evicts by bytes only. `imageFromPart` (`transcript.js:942-948`) calls `put` (sha1 over a multi-MB string plus `Buffer.from`) for every image line parsed, including lines whose block is then trimmed: `readPrefixState` (keeps 64), `readChunkEndingAt` paging (up to 64 MB chunk, line 54), live appends. Realistic 250-384 MB each, 0.5-0.75 GB across both. Fix: cap 64-96 MB; store `{path, offset, length}` and re-read on demand, or `put` only blocks that survive trimming.

**4. Delegation scan stats about 1,700 files per pass and re-sends every row. Both (idle trigger desktop only). CONFIRMED.**
Pass triggers: each `refreshHistory` (`sidebar-bridge.js:514`), and every `idle`/`done` agent event (`index.js:3208`), so passes scale with turn count across 16 sessions. `delegations-worker.js:123-140` `fsp.stat`s each 48 h transcript (1,724 in the fold), `buildBeaconIndex` lists 7 homes (1,892 beacon files, session-owner.js:36-45). `delegations.js:274` posts all ~4.4k rows (structured clone) every refresh because `latestRows` is a fresh array each time. On any change `delegations-worker.js:102` re-serialises the 2.5 MB fold and writes it. Fix: stat only names the history watcher already reported (`history.js` `reported` set), debounce idle-triggered passes, key `sentRows` on a history version, save the fold at most once a minute.

**5. Daemon `list` is polled 5+ times per second. Both (3 pollers desktop, 2 server). CONFIRMED.**
Every `SessionSubscription` polls `owner.snapshot()` = daemon `list` each 1 s (`session-daemon/client.js:16-48`): sidebar-bridge (`sidebar-bridge.js:599`), terminal-bridge (`terminal-bridge.js:1088`), agent-status (`index.js:3233`, which ignores its pane ids). Daemon side `allStates()` (`daemon.js:227`) does `readdirSync` plus a bigint `statSync` and `JSON.parse` per state file, an exit sort and reap check, on the one daemon thread. Fix: one shared poll per process (fan out the snapshot to all three), 2-3 s, or a daemon push channel.

**6. Per-session keeper holds a 10,000-line scrollback plus per-chunk encode. Daemon x16. CONFIRMED.**
`screen.js:70` `scrollback = 10000`; the largest read anywhere is 200 lines (`terminal-bridge.js:10` BACKFILL_LINES). xterm-headless stores 12 bytes/cell, so about 15-25 MB per keeper at 120-200 cols on top of Node's baseline, times 16. `keeper.js:233` base64-encodes every pty chunk and builds the event object even with zero observers (arguments are evaluated before `event()` loops over observers), then ships both `text` and `bytes`, doubling pipe size; `screen.js:73` chains one promise per chunk with no backpressure. Fix: scrollback 1,000-2,000; compute `bytes` lazily only when `observers.size > 0`.

**7. Per-open-transcript 5 s poll does about 10 fs ops and always emits. Both (every process holding the entry). CONFIRMED.**
`transcript.js:2730` `setInterval(scheduleRead, 5000)` per entry -> `readNew`: open+stat, tee `stat` + `readFile` (2352-2358), `readSessionBeacon` = 7 `stat`s, mostly failures (2408, session-owner.js:47-59), then even when `stat.size === offset` it calls `emitUpdate` (2414), which becomes an IPC push and a per-client `JSON.stringify` + ws enqueue. 16 sessions = about 30 fs ops/s and about 3 pushes/s doing nothing. `readSubagentProgress` (2100-2180) adds a readdir and, for any subagent that is unfinished but quiet (never `settled`), an open+stat+meta.json read every 5 s forever while the parser holds one unfinished delegation. Fix: trust the watcher, poll 30-60 s, cache beacon 30 s, emit only when header/mtime changed, settle quiet subagents.

**8. Desktop transcript open re-streams the whole skipped prefix. Desktop. CONFIRMED.** `transcript.js:2340,2724` -> `readPrefixState` (1823) streams bytes 0..tailStart with readline (343 MB for the big session) and `JSON.parse`s every user/queue/image line (up to 1.3 MB), plus `readOpeningBlock` (up to 16 MB), on every entry creation: window open and every `dropAll` after a renderer reload. 16 windows = 16 scans. Fix: cache the seed per `(path, tailStart, size)`; scan incrementally.

**9. `buildHomeMap` re-reads all `history.jsonl` on nearly every prompt. Both. CONFIRMED.** `history-index.js:642-685`: the memo stamp includes mtime:size of each home's `history.jsonl`, `session-env`, `file-history`, so any prompt or new session invalidates it; the rebuild parses 4.2 MB of JSONL and lists about 19k names, from every `refreshHistory`. Fix: read by offset; drop directory stamps.

**10. Artifact index: 9 MB resident in both processes, stat-assembled on every list. Both. CONFIRMED.** `artifacts.js:353-358` loads the cache at construction (server also lists at boot, compose.js:665). `assembleArtifacts` (435-480) canonicalises up to 70,482 candidates and `stat`s each unique path per call; the Files view calls it every 5 s (`ArtifactsView.jsx:209`); `collectFiles` (393-428) walks 4,486 dirs and rewrites 9 MB each 60 s. Fix: lazy load, 30-60 s poll, skip unchanged writes.

**11. Phone rail push re-serialises the projection per client every 2 s. Server. CONFIRMED.** `compose.js:637-646` fires on every sidebar update (status patches are constant with 16 working sessions); `projectRail` (phone-rail.js:60-100) walks ~4.4k rows, then `ClientQueue.enqueue` (`ws.js:146`) `JSON.stringify`s the model per client, again on merge (156). Fix: send the publisher's deltas; skip when unchanged.

**12. Team provider recomputes on every bridge update, always. Desktop. SUSPECTED (CPU).** `team.js:309-318` (250 ms) -> `recentSubSessions(getHistoryRows())` over all rows, `deriveTeam`, `JSON.stringify` of the team as change key (620); started unconditionally (`index.js:3384`); `team-worker.js:187` tails every live transcript (a third reader beside transcript.js and the delegation worker). Fix: run only while subscribed, or 2 s throttle.

**13. Dormancy transcript lookup uncached on miss. Daemon. SUSPECTED.** `daemon.js:1066-1078`: a session with an `agent_session` but no transcript yet does `readdirSync` of 4,486 dirs plus `existsSync` each, synchronously, on every 60 s sweep. Fix: negative-cache 60 s.

**14. Provider (codex/cursor) writes trigger the whole refresh. Both. SUSPECTED.** `provider-history.js:537-542` recursive watchers -> `scheduleRefresh` (`sidebar-bridge.js` 250 ms) -> items 2, 4, 9 even with no Claude activity; the server also lacks the facts cache (`provider-history.js:160-164`). Fix: 30 s trailing floor for provider changes.

**15. Orchestration summaries poll. Desktop, only while Orch is watched. SUSPECTED, low today.** `delegate.js:594` runs a 10 s interval per watched workspace into `buildOrchSummaries` (`index.js:1648`): all queue files, whole events JSONL, all rows filtered. Event files are under 16 KB today. Fix: drop the poll or use 60 s.

## Collections that grow

- `imageStore.entries` (image-store.js:33): content hash, LRU by bytes only, 250-384 MB per process (item 3).
- History `memFiles`/`lastResult` (history-index.js:253,509): about 12k objects, 60-90 MB per worker, never trimmed.
- Delegation fold (delegations-worker.js:34) 1,724 entries and artifact cache (artifacts.js:351) 8.6k files: aged out by window only.
- `ClientQueue.items` (ws.js:121): bounded 256 items / 8 MB per client.
- Keyed by session/pane/path and never deleted, each under 1 KB, ignore: `statusSeq` (session-send.js:838), `prevStatus` (notify.js), pending-ask cache (pending-ask.js:57), `orchLivenessCache` (index.js:1525), `transcriptDirCache` (daemon.js:1065).

Transcript entries are released on window close and phone disconnect (`clientGone`), so no per-session leak was found. The server's 0.6 to 2.3 GB growth fits S, items 2, 3, 10, 11 and V8 garbage from the 4.4k-row rebuild cycle, not one leaked map.

Left out as cheap: process-intel OS snapshot 2 s (`process-intel.js:9`), ask-inbox sync readdir 1 s (`ask-inbox.js:291`), pane-size sweep 20 s, usage/memory/lag timers. Renderer pollers are out of scope.

## Suggested order

1. Item 1 (few lines). 2. Item 6 scrollback (about 250-400 MB across keepers). 3. Item 3 cap (up to 0.7 GB). 4. S plus 2: server read-only index, then one owner of the rail model. 5. Item 5 shared daemon poll. 6. Items 4, 7, 8, 9 as incremental reads.
