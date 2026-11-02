# Brief: worker launchers record who launched them (team chart, 2026-11-02)

Goal: Harbor's Orch view becomes a live team chart. Its reporting lines come from the launches themselves (Pat, SCOPE.md section 8 item 5): every worker launch records the session that launched it. Today `claude-worker`, `astra-run`, `cursor-worker` and `cursor-run` record nothing about their caller. Add one small shared writer and call it from all four.

## The record (the contract Harbor reads; do not change field names)

File: `<real profile>\.harbor\team-launches.jsonl`, where the real profile is `os.userInfo().homedir` (never `os.homedir()`: Cursor workers run with USERPROFILE pointed at a shadow home). `HARBOR_TEAM_LAUNCHES_FILE` (absolute path) overrides it; tests always set it.

One JSON object per line, UTF-8, `\n` terminated, each line written with ONE `fs.appendFileSync` call (create the parent folder if missing). Writing is best effort: any error is swallowed and never changes the launcher's behavior, exit code or output.

start, written right after the child process is spawned:
```
{"v":1,"type":"start","launch":"<uuid minted for this launch>","at":"<ISO time>","launcher":"claude-worker|astra-run|cursor-worker|cursor-run",
 "pid":<launcher process.pid>,"childPid":<spawned child pid or null>,
 "parent":{"provider":"claude","session":"<id>"} or {"provider":"codex","session":"<id>"} or null,
 "child":{"provider":"claude|codex|cursor","session":"<id or null>","resume":<true|false>,"home":"<absolute config home dir or null>",
          "model":"<model or null>","effort":"<effort or null>","cwd":"<absolute working folder>","title":"<first non-empty line of the prompt, at most 160 chars, or null>","lane":"<lane id or null>"}}
```
bind, when the child's session id becomes known after start (astra-run learns the codex thread id late):
```
{"v":1,"type":"bind","launch":"<same uuid>","at":"<ISO>","child":{"session":"<id>"}}
```
end, on every exit path after a start was written (normal exit, child error, signal handlers the launcher already has):
```
{"v":1,"type":"end","launch":"<same uuid>","at":"<ISO>","exit":<code or null>,"signal":"<name or null>"}
```

Parent detection: `CLAUDE_CODE_SESSION_ID` in the launcher's environment means a Claude session launched it (Claude Code sets it in every tool shell). Otherwise, if Codex exposes its thread id to shell commands, use that with provider `codex` (find the real variable name by searching the installed Codex package, the global npm `@openai/codex` package, for a `CODEX_*` env var holding the thread or session id; do not guess a name, and if none exists say so in the report and leave parent null for that case). Otherwise null.

Child facts: take them from what the launcher already resolved (claude-worker mints or receives `--session-id`, knows `--resume`, the config home dir it sets as CLAUDE_CONFIG_DIR, model, effort, `--cd`; cursor has no session id: null). Home is the ABSOLUTE config home directory, not the short name. The title is the first non-empty line of the prompt text (inline or from `--prompt-file`).

## Where the code goes

- New shared module `C:\tools\team-launch\team-launch.mjs` exporting `recordLaunch(fields) -> { bind(sessionId), end(exit, signal) }` (end is idempotent: a second call writes nothing). Plus `team-launch.test.mjs` (node --test) covering: the file location rule (override, real profile), each record shape, parent detection both ways and null, a write failure swallowed, end written once.
- Call it from `C:\tools\claude-worker\claude-worker.mjs`, `C:\tools\astra-run\astra-run.mjs`, `C:\tools\cursor-worker\cursor-worker.mjs`, `C:\tools\cursor-worker\cursor-run.mjs`. Keep each change small; do not restructure the launchers. Every spawn stays `windowsHide: true`.
- Add a launcher-level test for each (extend `claude-worker.test.mjs`, and `C:\tools\lane-adapter\launchers.test.mjs`, which already drives all four launchers with a compiled fake worker binary): run with `HARBOR_TEAM_LAUNCHES_FILE` in a temp folder and a fake `CLAUDE_CODE_SESSION_ID`, assert one start line naming that parent and the child facts, and one end line with the exit code.

## How to change live launchers (they are in use by running work right now)

Follow the recipe in memory `workspace-pool-2026-11-01`: stage a copy of the affected `C:\tools` folders in your own scratch folder, make the change there, run `LANE_TOOLS_ROOT=<stage> node --test C:/tools/lane-adapter/launchers.test.mjs` plus claude-worker's own suite (`node --test <stage>/claude-worker/claude-worker.test.mjs`) and the new team-launch tests against the stage, then install by copying each changed file over the live one with a backup beside it named `<file>.bak-20261102-team`. Only install when every suite is green. Never kill or restart any running process. Never launch a real worker (no real claude, codex or cursor runs); the fake worker binary is what the tests use.

## Done when

All suites green against the stage AND against the installed files, backups exist, and you report: the files changed, the test commands and their pass counts, the Codex env var finding, and anything you could not do. Write the report to `C:\dev\.orch\harbor\team-chart-1102\docs\orchestration\2026-11-02-org-chart-panel-scope\reports\launch-records.md` (create the folder). Do not commit anything in any git repo. Do not start subagents.
