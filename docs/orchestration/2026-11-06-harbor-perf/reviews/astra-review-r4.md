All five findings are fixed; I reproduced no new defects in this narrow review of `e387510`.

| Finding | Result | Evidence |
|---|---|---|
| R3-1: recovered client receives older shared snapshot | **FIXED** | The recovered client retains `new`; the older shared response emits no false close. After repeated failures, the client also receives subsequent fresh shared updates. |
| R3-2: same-size, same-mtime replacement bypasses identity | **FIXED** | Both the pending-question reader and home map detect actual replacement files and match cold readers. |
| R3-3: home-history identity loses integer precision | **FIXED** | Injected IDs `9007199254740992` and `9007199254740993` remain distinguishable. The incremental map matches the fresh map. |
| R3-4: transient history-read failure stays memoized | **FIXED** | The recovered file is opened again without another modification. Existing valid ownership survives a transient read failure. |
| R3-5: live Cursor rows repeatedly resend delegation history | **FIXED** | Three unchanged scans send `[100, no rows, no rows]`. Mixed Cursor, pathless, Codex and resumed Claude cases also behave correctly. |

Additional checks passed:

- A 100-nanosecond timestamp change within the same millisecond invalidates the pending-reader and home-history caches.
- Unchanged pending-question polls perform no additional content reads.
- Missing history files contribute an empty result; recreation is detected.
- Failure counters suppress older responses without permanently excluding recovered clients.
- Newly live Claude rows are resent once; unsupported and pathless rows do not trigger repeated handoffs.
- The chained earlier reproductions pass. Both facts-write completion orders retain the newest version.

**Focused tests: 138 passed, zero failures.**

Evidence is in:
- `C:\dev\harbor\docs\orchestration\2026-11-06-harbor-perf\private\astra-scratch\r4-rerun.cjs`
- `C:\dev\harbor\docs\orchestration\2026-11-06-harbor-perf\private\astra-scratch\r4-edges.cjs`

No tracked files were changed, and no live Harbor process was contacted.