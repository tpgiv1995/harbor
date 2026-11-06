Round 4, narrow. Commit e387510 addresses your round-3 findings R3-1 to R3-5. Same hard rules as before (review only, no tracked-file edits, no git writes, never touch the live Harbor, daemon, keepers or phone server, scratch only under docs/orchestration/2026-11-06-harbor-perf/private/astra-scratch/, focused tests only, no browser).

1. Re-run your round-3 reproductions (r3-rerun.cjs, r3-attacks.cjs, r3-home-same-stamp.cjs, r3-facts-orders.cjs) at e387510 and mark each FIXED or NOT FIXED with evidence.
2. Check the five changed spots for regressions: the failures counter in SharedSnapshotPoller (client.js), the bigint stat in pending-ask.js and its mtime string comparison, inputStamp and historyCounts in history-index.js (bigint, mtimeNs, the ENOENT versus other-error split and homeMapRetry), and the rowsOf/usable re-send rule in delegations.js.
3. Report only defects you reproduce, with severity. If everything holds, say so plainly in one line first.

Return the full result as your final message.
