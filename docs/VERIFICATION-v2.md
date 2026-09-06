# Harbor v2 verification record (MISSION-9)

Date: 2026-07-17. Batch: E2E verification suite per `docs/ARCHITECTURE-v2.md` section 4 and `docs/REQUIREMENTS-v2.md` A9.

## Run command

```bash
cd /home/you/dev/harbor/app
npm run test:e2e
```

Runner: local Linux with `DISPLAY=:0` and `WAYLAND_DISPLAY=wayland-0` (xvfb-run fallback not required for these runs).

## Two consecutive green runs (required)

### Run 1

```
passed: 8, failed: 0
  [ok] 1) app boots, sidebar renders, indexed count matches indexer emit
  [ok] 2) search and time filters change visible set against real corpus
  [ok] 3) resume flow uses injectable exec fake and asserts argv (no real resume)
  [ok] 4) terminal roundtrip in isolated herdr session via terminal-harness
  [ok] 5) orchestration panel renders real queue read-only and mutex refusal path
  [ok] 6) header meters render both accounts (value or unavailable state)
  [ok] 7) notifications module unit-level check
  [ok] perf) cold start and RSS with 7 streaming panes in isolated session
```

Playwright wall time: 38.5s. Exit code: 0.

### Run 2

```
passed: 8, failed: 0
  [ok] 1) app boots, sidebar renders, indexed count matches indexer emit
  [ok] 2) search and time filters change visible set against real corpus
  [ok] 3) resume flow uses injectable exec fake and asserts argv (no real resume)
  [ok] 4) terminal roundtrip in isolated herdr session via terminal-harness
  [ok] 5) orchestration panel renders real queue read-only and mutex refusal path
  [ok] 6) header meters render both accounts (value or unavailable state)
  [ok] 7) notifications module unit-level check
  [ok] perf) cold start and RSS with 7 streaming panes in isolated session
```

Playwright wall time: 38.9s. Exit code: 0.

Machine log: `/home/you/dev/harbor/app/verify/e2e/e2e-run-log.txt`

## What was proven

| # | Requirement surface | Method | Safety |
|---|---------------------|--------|--------|
| 1 | Sidebar boot against real corpus | Playwright Electron launch; `.sidebar-subtitle` indexed count vs `python3 bin/harbor-index.py emit --all` line count within tolerance 8 | Read-only indexer + live daemon snapshot for sidebar only |
| 2 | Search + time filters (R3) | Fill search `harbor`, assert row counts vs indexer-derived model; 7d chip reduces shown set when corpus has older rows | Read-only |
| 3 | Resume argv (R2/S2) | `HARBOR_E2E_FAKE_LAUNCH=1` injectable exec; IPC `session.resume` asserts `--resume-id`, `--home`, `claude-sessions` path | No real resume, no pane spawn |
| 4 | Terminal roundtrip (R4/S4) | Isolated named session `harbor-terminal-harness` via `app/scripts/terminal-harness.js`; focus pane, `echo` marker, resize, close workspace | Never touches live daemon panes |
| 5 | Orchestration panel (R7/A12) | Real `claude-delegate` queue for `harbor` read-only; batch card count matches provider; mutex refusal via test hook `__forceOrchMutex` | `CLAUDE_DELEGATE_DRY_RUN=1`; no worker dispatch |
| 6 | Header meters (R6) | Both `personal` and `team` tiles render value or explicit unavailable | Read-only usage poll |
| 7 | Notifications (R8) | `createNotifier` unit assertions in spec + `app/test/main/notify.test.js` (12 cases) before Playwright | Fake `execFile`, no OS notify-send in CI |
| perf | Cold start + 7-pane RSS (D4) | Stress harness (7 panes), `e2e:get-metrics` after streams attach | Isolated session only |

Indexer reference at run time: 1048 sessions (`emit --all`).

## Performance snapshot

Source: `/home/you/dev/harbor/app/verify/e2e/perf-snapshot.json`

| Metric | Value |
|--------|-------|
| Cold start to interactive | 912 ms |
| Main-process RSS with 7 streaming panes | 226.8 MB |
| Visible terminal panes | 7 |

## Screenshot artifacts

Captured under `/home/you/dev/harbor/app/verify/e2e/` (gitignored; local evidence only):

| File | Scenario |
|------|----------|
| `/home/you/dev/harbor/app/verify/e2e/01-sidebar-boot.png` | Initial sidebar |
| `/home/you/dev/harbor/app/verify/e2e/02-sidebar-search.png` | Search filter |
| `/home/you/dev/harbor/app/verify/e2e/03-sidebar-filter-7d.png` | 7-day chip |
| `/home/you/dev/harbor/app/verify/e2e/04-resume-argv.png` | Post-resume IPC |
| `/home/you/dev/harbor/app/verify/e2e/05-terminal-panes.png` | Isolated harness panes |
| `/home/you/dev/harbor/app/verify/e2e/06-terminal-resized.png` | Terminal resize |
| `/home/you/dev/harbor/app/verify/e2e/07-terminal-closed.png` | Workspace closed |
| `/home/you/dev/harbor/app/verify/e2e/08-orch-panel.png` | Orchestration queue |
| `/home/you/dev/harbor/app/verify/e2e/09-orch-mutex-refusal.png` | Execute mutex blocked |
| `/home/you/dev/harbor/app/verify/e2e/10-header-meters.png` | Dual account meters |
| `/home/you/dev/harbor/app/verify/e2e/11-perf-7panes.png` | 7-pane stress layout |

## Test suite layout

- Playwright spec: `/home/you/dev/harbor/app/test/e2e/harbor.spec.js`
- Config: `/home/you/dev/harbor/app/test/e2e/playwright.config.js`
- Runner (two consecutive runs): `/home/you/dev/harbor/app/scripts/e2e.js`
- Terminal harness: `/home/you/dev/harbor/app/scripts/terminal-harness.js`
- JSON results (last run): `/home/you/dev/harbor/app/test/e2e/results.json`

## VOID / skipped

None. All eight Playwright cases and twelve notify unit tests executed in this environment.

## Known gaps (not covered by this batch)

The orchestrator should re-verify before marking downstream batches done.

- **xvfb-run path**: Not exercised here; runner had a live display. `e2e.js` will wrap Playwright with `xvfb-run -a` when neither `DISPLAY` nor `WAYLAND_DISPLAY` is set.
- **Resume UI click path**: Test 3 drives `window.harbor.session.resume` over IPC, not a sidebar row click (same launch fake, but no click-target coverage).
- **Orchestration kickoff spawn**: Queue render is real and read-only; execute mutex refusal uses `__forceOrchMutex` injection rather than opening a second real execution pane. No end-to-end `kickoffResearch` / `kickoffExecute` pane spawn.
- **New session (+) flows (R5)**: Not in this suite.
- **Copilot key remapping (R10)**: Not in this suite.
- **Single-instance second launch (R9)**: Not in this suite.
- **OS notify-send integration**: Notifier logic is unit-tested with a fake `execFile`; no desktop notification delivery check.
- **Control-channel contention matrix**: Architecture section 4 bridge contention tests are harness-level, not Playwright E2E.
- **Live pane observe/control on the author's daemon**: Terminal interaction is isolated session only; live daemon is snapshot/read for sidebar merge.
- **Custom since date picker, older expander, Windows-era disabled resume**: Sidebar edge cases not individually asserted.
- **GPU/Wayland fallback**: `ELECTRON_DISABLE_GPU=1` is set for tests; NVIDIA/Wayland production workaround not validated here.
- **Screenshot persistence in git**: `app/verify/*` is gitignored; artifacts remain on disk at the paths above.

## Round-2 adversarial pass (2026-07-17 morning)

A second fresh-eyes adversary attacked the round-1 fixes. Confirmed and fixed:
reclaim-takeover could displace the TUI controller (removed; refusal now
retries once plain), 26-char label truncation split project identity and
bypassed the execute mutex (GUI emit now carries full labels), pane streams
now recover from daemon bounces and observer death (reattach + backfill),
closing a controlled pane no longer misfires the denial path (pane-gone),
statusline tee no longer clobbers complete samples with limitless session-
start payloads, workspace-close confirm ignores double-clicks, keystrokes
typed before control acquisition are buffered and flushed, bracketed paste is
locally asserted on attach, plus a bundle of leak/feedback minors.

Known accepted residuals (documented, not defects to hide): physical Copilot
chords and post-reboot restore need the author; TUI-path execute-mutex gap; a toast
can be missed if a completion lands inside a 400ms watcher-rebuild settle
window; a few-ms resync overwrite window; bridge unit tests show first-run
timing sensitivity after heavy file churn (four consecutive greens follow;
the app layer is covered by input buffering).
