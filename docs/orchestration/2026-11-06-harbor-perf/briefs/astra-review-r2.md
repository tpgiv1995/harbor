Round 2. The coordinator fixed your findings in commit 714d565 (and a42e511 changed the home map, provider facts cache and delegation row handoff, which you saw only partly). Same hard rules as round 1: review only, no tracked-file edits, no git writes, never touch the live Harbor, daemon, keepers or phone server, scratch only under docs/orchestration/2026-11-06-harbor-perf/private/astra-scratch/, focused tests only (one npm test filter per call), no browser.

Do this:
1. For each of your eight real-bug findings and findings 9 and 10, rerun your own reproduction against the current working tree (HEAD 714d565) and say FIXED or NOT FIXED with the evidence. Your scripts are in private/astra-scratch/.
2. Attack the fixes themselves: the pane input generation in session-send.js (readPane / sendPaneInput / getMenu), the shared poller tick in main/session-daemon/client.js, the continuity marks in providers/pending-ask.js, the opening-image settlement and seed merge plus the same-size and interior-sample checks in providers/transcript.js, the rescheduled repair in terminal-bridge.js, onPersisted in history-index.js/history.js, and the store-scan throttle in ask-transcript-path.js.
3. Review a42e511 hunk by hunk (history-index.js buildHomeMap/historyCounts/folderIds, provider-history.js facts save interval and mungeCwdCached, delegations.js row filter) for correctness regressions.

Return the full result as your final message: per finding FIXED / NOT FIXED with evidence, then any new defect (severity, file:line, failing scenario, fix), then what you checked and found sound.
