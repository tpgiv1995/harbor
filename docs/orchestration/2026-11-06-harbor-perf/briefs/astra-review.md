# Astra brief: adversarial review of Harbor's 2026-11-06 performance fixes

You are the adversarial reviewer. A Claude session wrote and committed the changes below. Your job is to find what is WRONG with them (correctness regressions first, then fixes that do not actually save what they claim, then real performance bugs of the same kind that were missed). Do not praise; report defects with evidence.

## Background (Harbor, and why this work exists)

Harbor (this repo, `C:\dev\harbor`, app code under `app/`) is a Windows Electron desktop app that runs and monitors many Claude Code sessions. It has: an Electron main process (`app/src/main/`), a React renderer (`app/src/renderer/`), its own session daemon "sessiond" (`app/src/daemon/`: `daemon.js` plus one `keeper.js` process per session holding a ConPTY and an xterm-headless screen model), and a phone server (`app/src/server/`, composed in `server/compose.js`) that builds its OWN full copy of the rail pipeline (history worker, transcript provider, sidebar bridge, terminal bridge).

The owner reported that Harbor with about ten sessions makes the machine unusable (commit and memory pressure) while ten sessions in a plain terminal do not. Measured live that day (2026-11-06): Harbor's own CPU about 64% of one core; phone server 1.2 to 2.3 GB; keepers 53 to 194 MB committed each (about 46 MB bare); 7,434 screen reads a minute from six open windows; 719 MB a minute of daemon allocations; 266 daemon `list` requests a minute; the phone server allocating about 648 MB a minute, 61% of it in the history list parse. Real corpus: 12,000 transcripts, a 17 MB index cache (`~/.cache/harbor/index.json`), transcripts up to 352 MB, up to 16 open windows.

Read first: `CLAUDE.md` (root), `docs/claude/performance.md` (the new doctrine written for these fixes; check every claim in it against the code), `docs/claude/conversation.md`, `docs/claude/sessiond.md`, and the run record `docs/orchestration/2026-11-06-harbor-perf/reports/` (a static audit plus two implementation lane reports).

## What to review (git, branch board-agent-write)

- `2e4792c` A raw `>_` terminal view keeps its pane size when another Harbor process (the phone server) sends a dialog resize; the daemon refuses `purpose:'dialog'` resizes while any client observes the pane; the desktop heals a foreign resize.
- `63be28e` Transcript window eviction keeps the newest half (`RECENT_BLOCKS`), cwd-ancestor transcript lookup, throttled store scan.
- `688fea8` AskCard poll deps; per-poll shared screen reads in `session-send.js` (AsyncLocalStorage); incremental pending-question read in `providers/pending-ask.js`.
- `cccc6f2` History list deltas (`history-index.js` `emitDelta`, `history.js` `listAllSessions`/`parseEmitLine`), `codePointSlice`/`codePointLength`, index cache save interval and read-only mode, titler idle-pass skip (`titles.js`), phone server read-only index (`server/compose.js`).
- `337b5c9` Keeper scrollback 2,000 (`daemon/screen.js`), no frame encoding without observers (`daemon/keeper.js`), shared `list` poller (`main/session-daemon/client.js`), dormant-ledger test clock.
- `127ea86` Transcript provider: image store cap 128 MB, deferred images for trimmed blocks, cached and resumable skipped-prefix scan (`getPrefixSeed`), emit-only-on-change for the 5 s poll, tee and beacon caching (`providers/transcript.js`, `providers/image-store.js`).
- `df1315b` Doctrine only.

`git show <sha>` and `git diff 2e4792c~1..df1315b -- app/src` give you the code. Ignore any hunk in other files not listed in those commits.

## What to hunt for, in this order

1. **Correctness regressions.** Equivalence breaks (the delta list must equal the full list in every case: concurrent callers, worker restart, a failed call mid-way, deleted or renamed sessions, duplicate ids, `--since`/`--project` callers); stale state that never refreshes (the titler idle skip, the 30 s beacon cache, the 2-minute index save, the prefix seed cache, emit-only-on-change hiding a real state change such as the working shimmer turning off, a blocked or answered question, context percent); the shared screen-read cache leaking a stale read into a send or settle loop; the shared `list` poller (one owner's failure, a closed client, members joining mid-tick, events per member); the incremental pending-question read missing a question (half-written lines, a question inside the appended bytes but escaped, truncation, rotation, a file replaced with a larger one); keeper changes changing what an observer receives; the dialog-resize refusal leaving a dialog permanently at the wrong size.
2. **Fixes that do not save what they claim.** Show it with a measurement or a precise argument, e.g. a cache keyed so it never hits in real use, work moved rather than removed, a new per-call allocation larger than the one removed.
3. **Missed bugs of the same classes** anywhere in `app/src` (main, server, daemon, renderer): periodic work multiplied by windows, sessions or processes; whole-file reads or whole-list re-sends on a timer; caches that never hit; work done for nobody (no observer, no open window, no phone client); retention (a long string or buffer pinned by a small slice). Rank by measured or estimated cost on the corpus above. The static audit lists items already known and not yet fixed (delegation scan, buildHomeMap, artifacts, team provider, orch poll, dormancy lookup, phone rail push); confirm or refute their cost and add what it missed.

## Rules (hard)

- REVIEW ONLY. Do not edit, create or delete any tracked file, and do not run any git command that writes (no add, commit, stash, checkout, reset, branch). Other sessions have uncommitted work in this tree. Scratch scripts or measurements go only in `docs/orchestration/2026-11-06-harbor-perf/private/astra-scratch/` (gitignored).
- Never touch the live Harbor installation: do not start, stop, signal, attach to or send anything to the running Harbor app, the phone server, the real session daemon, or its keepers, and do not run `bin/harbor-sessiond` or any `harbor-*` CLI against the real store. Tests isolate themselves with `HARBOR_SESSIOND_DIR` / `HARBOR_SESSIOND_SOCKET`; keep it that way.
- You may READ the real corpus (`%USERPROFILE%\.claude\projects\**\*.jsonl`, `%USERPROFILE%\.cache\harbor\index.json`) to measure, never write it. If you construct an index or worker over the real store, pass `readOnly: true`.
- Run only the tests that touch these changes, from `C:\dev\harbor\app`, e.g. `npm test -- main/pending-ask`, `npm test -- providers/history-list-delta`, `npm test -- providers/transcript-perf`, `npm test -- main/session-subscription-shared-poll`, `npm test -- daemon/screen`. Do NOT run the full suite (the coordinator already ran it: 3,073 tests, 0 failures; daemon family 163; bin family 111). One filter per `npm test` call.
- Do not use the browser MCP or god Chrome. Do not open any window on the screen. Every child process you spawn from a script needs `windowsHide: true`.
- Committed fixtures must be synthetic; never copy real transcript content into anything outside the private scratch folder.

## Output

Return the full review as your final message (it is saved to a file; do not write the review to a file yourself). Structure:

1. Findings, most severe first. Each: severity (blocker / real bug / cost claim wrong / minor), file:line, the defect in one or two sentences, a concrete failing scenario or measurement, and the fix you recommend. Mark each CONFIRMED (you reproduced it or measured it) or ARGUED (code reading only).
2. Missed performance bugs, ranked, each with its cost estimate and evidence.
3. Claims in `docs/claude/performance.md` that are wrong or overstated.
4. What you checked and found sound (one line each), so the coordinator knows what was covered.

done_when: every commit above has been read hunk by hunk, the load-bearing equivalence claims (delta list, prefix seed merge, incremental pending-question read, shared poll) have each been attacked with at least one concrete adversarial case, and the review is your final message.
