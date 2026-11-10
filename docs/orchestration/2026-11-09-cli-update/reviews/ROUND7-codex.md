Round 7 is implemented on cli-1109-codex. Commit: f8ca3e7ae184408feb99a20ee80b82cc55a2ca5c.

Changes:

- Warning rows no longer invalidate writable-composer evidence. The existing 50-column clipped-draft fixture and an 80-column warnings frame both bind the new chat. Provisional pane: and live: sends reach the existing delivery gate on warnings, startup, empty and incomplete screens. Positive child/side detection still refuses; different-prefix real UUIDs still refuse.
- Side detection accepts the cut footer's Side from marker in the last three non-empty rows below the current prompt. Lesson: scanning those rows without respecting the current prompt mistakes historical quoted footer text for a live side chat. The existing negative quote test remains unchanged and passes.
- A root mismatch starts a title recheck without awaiting it; recheck errors are swallowed. Refusals keep Your text is kept. Child and side messages give their actual terminal exit actions; ordinary root mismatch explains the link update.
- Restore emits session:launched only for pane:<id> and live:<id> replacements, through desktop and phone wiring. It restores the route without rewriting unchanged metadata, refreshing history, or renaming a real-id window.
- A cached writer notice remains visible to apply() while recheckTitle waits for fresh evidence. The pane stays hidden during the pending read, then binds when the fresh read proves it writable.

Validation: 319 passed, 0 failed, 0 skipped, 0 cancelled. One filter per command, sequential, with isolated homes and daemon stores. Every new sender spec injects a scratch send log. Counts:

| Suite | Passed | Skipped |
| --- | ---: | ---: |
| codex-ordinary-pane.test.js | 12 | 0 |
| codex-thread-following.test.js | 10 | 0 |
| codex-thread-recovery.test.js | 17 | 0 |
| compose-provider-homes.test.js | 5 | 0 |
| compose-providers.test.js | 7 | 0 |
| provider-link-events.test.js | 4 | 0 |
| provider-session-link.test.js | 19 | 0 |
| session-send.test.js | 234 | 0 |
| sidebar-bridge-boot.test.js | 3 | 0 |
| sidebar-bridge.test.js | 8 | 0 |

Nine regression checks fail against the d7e2779f implementations and pass with the fixes. Logs: _astra/round7/red-final-*.log and _astra/round7/final-*.log. Build passed in 10.30 seconds with existing dependency directive and chunk-size warnings: _astra/round7/build.log.

Native proof used scratch Codex 0.167.0 through bin/ai, the real isolated daemon/keeper/linker/sender, and the loopback Responses fixture, with zero paid turns. Child and side views at 80 and 50 columns refused both root and provisional sends with zero writes, then accepted sends after returning to the parent. At 50 columns the side footer actually ends at ctrl+; detection still holds. The /new first send used one paste and one Enter and appeared exactly once in the new rollout. Fork and picker-resume followups reached their selected roots. Evidence: _astra/round7/child80, _astra/round7/child50, _astra/round7/side-final80, _astra/round7/side-final50, _astra/round7/navigation-final80 and _astra/round7/evidence-summary.json. Captured child frames also pass the final parser.

Headless renderer proof used the built renderer and actual preload with synthetic state and mocked IPC. Both provisional key types upgraded, drafts survived, Send dispatched to the restored root/pane, and an existing history window kept its key and draft. Six screenshots inspected; zero page errors. Evidence: _astra/round7/restore-window-proof.json and _astra/round7/restore-*.png.

Config SHA-256 values, in briefing order, all match the new baseline:

1. D10AF7C56E398EA816FEF2EDC79655D765BB77576038F226B10AC6E44DC3B05B
2. 5D12B58C3EECE8EC398B164A26813B7EF9FDB46EDC707604321FA1831EB5F698
3. 1A22CB0C86635C545B1BCBBE251558512F548F0564160C1077333CCA952A2584

All authored writes stayed in this worktree. No live install, real-daemon access, config edits, visible windows or push. The real send log was neither read nor measured. Coordinator-owned files, keeper and launcher are unchanged. Final delta: _astra/round7/delta.patch, based on d7e2779f and checked read-only against the port; result in _astra/round7/apply-check.json.

Remaining limits: finding 4 remains. After a restart, an ordinary provisional rekey can still rename a history-only A window when no live pane owns A; main cannot know which history windows the renderer holds. This is separate from the restore path fixed here. No broader protocol change was made. Mid-redraw c continuation can still refuse safely without typing, as permitted. No full unit/daemon gate, installed desktop, physical phone, or widths below 50 were driven this round. Warning rows were validated with the existing captured fixture and synthetic frame, not a newly induced native warning. Final integration and installed proof remain with the coordinator.
