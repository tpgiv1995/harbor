# Report: launch records (team chart, 2026-11-02)

Status: done. Staged, tested, installed, re-tested on the installed files. Nothing committed, no process killed or restarted, no real worker run, no subagents.

## Files changed (all under C:\tools)

New:
- `team-launch\team-launch.mjs`: `recordLaunch(fields) -> { launch, bind(sessionId), end(exit, signal) }`, plus `launchesFile`, `detectParent`, `titleOf`. End is idempotent and is also armed on process `exit`, so a launcher that calls `process.exit()` still writes its one end line.
- `team-launch\team-launch.test.mjs`: 9 tests (file location rule incl. the shadow-home case, parent detection both ways and null, each record shape, swallowed write failure, end once, exit hook).

Changed (backup beside each as `<file>.bak-20261102-team`):
- `claude-worker\claude-worker.mjs`: record after the spawn; end in `stop()`.
- `astra-run\astra-run.mjs`: record on the first spawn (`runChild` got `onSpawn` and `onText`); bind when the "session id:" banner streams in (late thread id) and again after the run as a fallback; end in `finish()`.
- `cursor-worker\cursor-worker.mjs`: record on the first spawn; end in `finish()` and in the crash handler.
- `cursor-worker\cursor-run.mjs`: record on the first spawn of a print-mode run; end in `end()` with the signal.
- `claude-worker\claude-worker.test.mjs`: one new launch test; the dry-run helper now points `HARBOR_TEAM_LAUNCHES_FILE` at a temp file.
- `lane-adapter\launchers.test.mjs`: `pool()` now always sets `HARBOR_TEAM_LAUNCHES_FILE` to a temp file (otherwise the existing tests would have written to Pat's real file) and gained a `cwd` option; 9 new tests (claude-worker x4, astra-run x2, cursor-worker x2, cursor-run x1). Cursor tests use a fake cursor-agent install (npm-style `.cmd` shim beside a copy of the fake worker, via `LOCALAPPDATA`) and a harbor-lean stub (`HARBOR_LEAN_BIN`).

Stage used: `C:\dev\.orch\harbor\team-chart-1102\_stage\tools`. Install was copy-to-`.new-team` then rename over the live file, after confirming the live files differed from the stage only by these edits.

## Tests

| Suite | Against stage | Against installed |
| --- | --- | --- |
| `node --test team-launch/team-launch.test.mjs` | 9/9 | 9/9 |
| `LANE_TOOLS_ROOT=<stage> node --test lane-adapter/launchers.test.mjs` | 22/22 (13 existing + 9 new) | 22/22 |
| `node --test claude-worker/claude-worker.test.mjs` | 28/28 (27 + 1 new) | with limit-helpers and deny-background: 35/35 |
| `node --test claude-worker/limit-helpers.test.mjs claude-worker/deny-background.test.mjs` | 7/7 | (in the 35) |
| `node astra-run/astra-run.mjs --self-test` | n/a | 9/9 detection cases + sid parse |

Pat's real `~\.harbor\team-launches.jsonl` does not exist after all runs, so no test wrote to it.

## Codex env var finding

`CODEX_THREAD_ID`. Evidence: the string is in the installed `codex.exe` (0.165.0), and a real Codex rollout (`~\.codex\sessions\2026\10\30\rollout-...01a18ee4....jsonl`) lists `CODEX_THREAD_ID`, `CODEX_CI` and `CODEX_TOOL_CALL_ID` among the variable names in the environment of a command Codex ran. Not found as a documented value anywhere, and I could not read a value (that needs a real Codex run, which the brief forbids), so the assumption that it holds the thread id (the same id as the rollout's `session_id`) comes from the name plus Codex's design, not a measurement. `CODEX_SESSION_ID` also appears in the binary but not in any shell env dump, so it is not used. Parent detection is Claude first (`CLAUDE_CODE_SESSION_ID`), then `CODEX_THREAD_ID`, else null, as the brief says.

Caveat: that same rollout's shell env also contains `CLAUDE_CODE_SESSION_ID` (inherited from the Claude session that launched Astra). So a launcher run from inside an Astra shell that was itself started by a Claude session will report the Claude session as parent, not the Codex thread. Only matters if a Codex worker launches workers; the brief's order was kept.

## Decisions to know about

- cursor-run records only print-mode (`-p`) runs. An interactive `cursor-run` is a Cursor session, not a worker, and would appear as a parentless node. One-line change if you want it recorded.
- Cursor records `session: null` and `home: null` (no session id; one seat; the shadow home it runs under is not a config home). Cursor `resume` is true when `--resume` or `--continue` is passed, session still null.
- cursor-run's title is its last positional argument (the print-mode prompt); `model` is read from `--model` or `--model=`.
- A launch is one record set per launcher invocation. astra-run keeps one uuid across usage-limit resets; cursor startup-race retries (EPERM on cli-config.json) keep the first attempt's `childPid`.
- Nothing is written for `--dry-run`, argument refusals, or a launcher that dies before its spawn (no child, no launch).
- No new signal handlers were added. A launcher killed by SIGINT/SIGTERM before Node can run exit handlers writes no end line; the chart should treat a start whose launcher `pid` is dead and has no end as ended.
- All spawns stay `windowsHide: true`; no spawn was added.

## Not done

- Did not run a real claude, codex or cursor worker, so the live end-to-end path (a real session id in the real file) is covered only by the fake-binary tests. The first real launch will show it.
- No git commits (per the brief). The staged copies remain in `C:\dev\.orch\harbor\team-chart-1102\_stage` for cleanup.
