# W3: the four CLIs' full docs and changelogs, as a host app sees them (2026-11-26)

Scope: Claude Code, Codex, Cursor CLI, Antigravity CLI (agy), and the Agent Client Protocol (ACP). Compared against
C:\dev\harbor\docs\orchestration\2026-11-26-oss-survey\REPORT.md (called "REPORT" below) and against Harbor's code.

Marks used: **(verified here)** = I read a file or ran a read-only listing on this machine. **(snippet only)** = from a
search result I did not open. Anything else was read in the page or file named next to it.

## 0. What was crawled, and how

Every page below was opened as a local file; none is from memory. The raw downloads are in
`C:\dev\harbor\docs\orchestration\2026-11-26-oss-survey\deep\w3-raw\` (one folder per CLI, plus the changelog extracts).

| Source | Pages | How |
|---|---|---|
| code.claude.com/docs/en (every page in its `llms.txt`) | 221 of 221 | `.md` twins, plain download |
| Claude CHANGELOG (docs page and GitHub raw file) | all versions; range 2.1.250 to 2.1.332 = 83 versions, 5,759 bullets | `raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md` |
| Codex docs (`developers.openai.com/codex` redirects to `learn.chatgpt.com/docs`) | 207 of 210 | `.md` twins |
| Codex releases 0.150.0 to 0.172.0 (37 stable and patch tags) | 37 of 37 | `github.com/openai/codex/releases/tag/rust-v<ver>` HTML |
| Cursor docs (every page in `cursor.com/llms.txt`, model pages skipped) | 291 | `.md` twins |
| Cursor CLI changelog (`/docs/cli/changelog`), v2026.06.09 to v2026.11.19 | 24 versions, 341 bullets | `.md` twin |
| agy docs (every `/docs/` page in its `llms.txt`) | 123 of 123 | HTML, tags stripped by script |
| agy CHANGELOG 1.4.0 to 1.5.18 | 453 bullets | `raw.githubusercontent.com/google-antigravity/antigravity-cli/main/CHANGELOG.md` |
| agentclientprotocol.com (every page in its `llms.txt`) | 151 of 151 | `.md` twins |

**Deviation from the brief (Firecrawl).** The Firecrawl connector in this session had only `firecrawl_scrape` and
`firecrawl_search`, and no `firecrawl_map`. A scrape returns its text into my context and cannot save to disk, so about
1,000 pages would have cost many times the context. Each site publishes an `llms.txt` index and Markdown twins that plain
HTTP downloads without a block, so I used those. I used Firecrawl once (a search, for who uses ACP; result marked
"snippet only" where I rely on it). God Chrome was not needed and was not used.

**Pages that failed both ways:** none that matter. The only failures were three Codex index entries that return 404 by
plain download: `learn.chatgpt.com/docs.md`, `/resources.md` and `/videos.md` (landing pages, not docs). I did not retry
them in Firecrawl. GitHub's unauthenticated API returned 403 (shared-IP rate limit) and `gh` is not signed in under this
plan, so Codex release notes came from the release pages' HTML instead.

**Reading depth (be careful what "reviewed" means).**
- Codex release notes: every one of the 329 feature and fix bullets read (the PR lists were skipped).
- Cursor changelog: the 300 bullets outside "Self-hosted workers / Cloud Agents / Models / Security" read in full for the
  newest 17 versions (v2026.11.19 to v2026.09.15), keyword-filtered for the older 7.
- Claude (5,759 bullets) and agy (453 bullets): keyword-filtered, then read. Keywords were hook, OSC, status line,
  transcript, session registry, Windows, resume, fork, queue, ask, permission, plan, goal, image, usage, ACP, headless.
  Entries with none of those words were not read. Treat the lists in section 8 as "the ones I found", not as complete.
- Docs: I read the pages that carry a host interface (hooks, status line, agent view, headless, sessions, claude-directory,
  app-server, developer-commands, non-interactive mode, ACP, config reference sections). I did not read pages about
  enterprise admin, plugins, cloud, billing or voice.

## 1. Corrections to REPORT, and answers to its "Not verified" list

1. **Claude's session registry (REPORT section 1).** The docs only say that `sessions/` "holds one small file per running
   session, used to detect concurrent sessions and crashes" and that Claude removes each file on exit
   ([claude-directory](https://code.claude.com/docs/en/claude-directory.md), line 332). They do not document its fields.
   The documented, supported interface is `claude agents --json`
   ([agent-view](https://code.claude.com/docs/en/agent-view.md), "List sessions as JSON"). It lists `cwd`, `kind`
   (`interactive` or `background`), `startedAt`, and, while the process lives, `pid`, `status` (`busy`, `waiting`,
   `idle`) and `waitingFor` (`permission prompt`, `input needed`, `sandbox request`, `worker request`, `dialog open`).
   Background sessions also carry `id` and `state` (`working`, `blocked`, `done`, `failed`, `stopped`). The page says
   `~/.claude/jobs/<id>/state.json` "is not a stable interface". Since: `agents --json` 2.1.145, `waitingFor` 2.1.162,
   `--all`, `id`, `state` 2.1.169 (changelog). **Harbor today:** no reader of either (grep of `app/src` for
   `waitingFor`, `statusUpdatedAt` and `sessions\...json` found only Codex rollout paths).
2. **agy's status line (REPORT section 1: "fields Harbor ignores").** Harbor already uses two of the strongest ones.
   `app/src/main/providers/gemini-status-tee.cjs:47-53` keeps `agent_state` and `tool_confirmation_pending`, and
   `app/src/daemon/dormancy.js:854` and `app/src/main/session-send.js:3248` act on them. What the tee drops (it keeps an
   explicit allow-list) is `task_count`, `pending_input_count`, `subagents[]`, `cycle_mode`, `quota`, `cost`,
   `artifact_count`, `conversation_title`, `sandbox`. All are in the doc table
   ([statusline](https://antigravity.google/docs/cli/statusline)).
3. **agy's transcript layout (REPORT "Not verified": "community write-ups").** Google documents it. Hooks receive
   `transcriptPath`, which "lives in `<app_data_dir>/brain/<conversationId>/.system_generated/logs/transcript.jsonl`",
   and `<app_data_dir>` is `~/.gemini/antigravity-cli` for the CLI
   ([hooks](https://antigravity.google/docs/hooks)). **(verified here, agy 1.5.14):** the folder
   `~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/` holds `transcript.jsonl` (1.2 MB on the newest
   conversation), `transcript_full.jsonl` (2.7 MB, the file Harbor reads) and `chunks/` and `media/`. The docs name only
   the smaller file. The status-line example in the docs shows `~/.gemini/antigravity/brain/...`, which matches Harbor's
   note that the payload's `transcript_path` names the wrong folder for the CLI
   (`gemini-status-tee.cjs:17`). Also present and undocumented: `presence/<conversation id>.lock` (zero-byte files) and
   `conversations/<id>.db` (42 files; changelog 1.5.15 says conversations now stay in `.../antigravity-cli/conversations`
   with no 500-conversation prune). I did not open the lock files; they are a lead for liveness, nothing more.
4. **Cursor hooks in `cursor-agent` (REPORT "Not verified").** Partly answered. The docs' hooks page never says "CLI"; it
   says the desktop app runs hook commands through PowerShell on Windows
   ([hooks](https://cursor.com/docs/hooks.md), line 182). The CLI changelog says hooks run in the CLI: "`afterAgentThought` /
   `afterAgentResponse` events emit in the CLI, and Claude Code-format hook responses are accepted" (listed under
   v2026.06.09 and earlier), "Hooks that fail or point at a command that can't be found are now reported as failed
   instead of silently succeeding" on Windows (v2026.10.15), and dashboard prompt hooks now run in the CLI (v2026.11.17).
   Which events fire in the CLI is not listed. Not tested here.
5. **OSC 7501 in Claude (REPORT section 1).** Claude's own docs describe it only as a terminal feature with causes for
   "no status": version under 2.1.295, running inside tmux, **background sessions never report it** ("Agent view shows
   its status instead"), or `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`
   ([terminal-config](https://code.claude.com/docs/en/terminal-config.md), "See session status in your terminal"). 2.1.326
   changed the reports: background commands, monitors and MCP tasks now count as working; a finished turn was wrongly shown
   after idle compaction; and the folder-trust prompt now reads as waiting on you (anthropics/claude-code#105801).
   Pat's installed 2.1.321 predates all three. Codex's docs do not mention OSC 7501 at all (REPORT's binary check is the only
   evidence). agy documents it in its changelog (1.4.0 added it, 1.5.10 fixed "done" while subagents run).
6. **Codex `codex queue` (REPORT section 7).** Confirmed by Harbor's own measurement, not just the docs: `bin/harbor-msg:27-31`
   records that on 2026-11-18 a message queued into a `--no-daemon` pane "never arrived" while `codex queue` printed
   "Queued message". The docs say the same in other words: queueing then resuming "requires a running local daemon or a
   server selected with `--remote`" ([developer-commands](https://learn.chatgpt.com/docs/developer-commands.md)).
   `bin/harbor-bin.cjs:586-596` explains why every Harbor Codex pane runs `--no-daemon` (0.157.0 turned on
   `daemon_auto_start`).
7. **Claude hooks Harbor does not use.** Harbor installs only `PreToolUse` (matcher `AskUserQuestion`),
   `PermissionRequest` and `Elicitation` (`app/scripts/install-ask-hook.js:32`) and the inbox hook on `SessionStart` and
   `UserPromptSubmit` (`bin/harbor-inbox-hook:3-12`). It reads turn state from the transcript
   (`app/src/shared/claude-turn-state.cjs`). `Stop`, `StopFailure`, `Notification`, `SessionEnd`, `SubagentStart/Stop`,
   `PostToolBatch` and `PostModelSwitch` are unused. Details in section 2.

## 2. Claude Code: host integration surface

Installed here: 2.1.321. Newest: 2.1.332 (2026-11-25). Docs root: https://code.claude.com/docs/en/

| Channel | Documented interface | Since | Windows | Harbor today |
|---|---|---|---|---|
| State and turn signals: hooks | `UserPromptSubmit`, `Stop` (adds `stop_hook_active`, `last_assistant_message`, `background_tasks[]`, `session_crons[]`), `StopFailure`, `SessionStart`, `SessionEnd`, `Notification` (matchers `permission_prompt` after about 6 s, `idle_prompt` after about 60 s, `elicitation_dialog`, `agent_needs_input`, `agent_completed`, `quota_auto_resume_*`), `SubagentStart/Stop`, `PostToolBatch`, `PreModelSwitch/PostModelSwitch`, `CwdChanged`, `FileChanged`. Common stdin fields: `session_id`, `prompt_id`, `transcript_path`, `cwd`, `permission_mode`, `effort.level`, `agent_id`. Command or `http` handler. [hooks](https://code.claude.com/docs/en/hooks.md) | `last_assistant_message` 2.1.47; `StopFailure` 2.1.78; HTTP hooks 2.1.63; `background_tasks` 2.1.145; `quota_auto_resume_*` 2.1.234; `PreModelSwitch` listed on the page, version not found | Hooks run in Git Bash by default; `"shell": "powershell"` exists. 2.1.309 and 2.1.310 fixed PowerShell hooks that failed open on exit 2 or when Git Bash was missing. Stop and notification hooks fire while the turn is still in the CLI; `permission_prompt` waits 6 s, so it is late for a live card | Only the ask hook and inbox hook. State comes from transcript rows |
| State: registry | `claude agents --json [--all] [--cwd]` (fields in section 1). `~/.claude/daemon/roster.json` and `jobs/<id>/state.json` are named but "not a stable interface" ([agent-view](https://code.claude.com/docs/en/agent-view.md)) | 2.1.145 to 2.1.169 | Supervisor stop on Windows is `taskkill /PID <pid>` (same page) | Not read |
| State: terminal | OSC 7501 (see section 1, item 5) | 2.1.295; better 2.1.326 | Not documented for Windows. Harbor's ConPTY result stands (REPORT section 1) | Probed only (`cli-updates.js:250`) |
| Approval channel | `PermissionRequest` hook: input `tool_name`, `tool_input`, `permission_suggestions[]`; output `decision.behavior` `allow`/`deny`, `updatedInput`, `updatedPermissions` (`addRules`, `setMode`, `addDirectories`, destinations `session`, `localSettings`, `projectSettings`, `userSettings`), `message`, `interrupt`. Exit code 2 is not a decision on this event. [hooks](https://code.claude.com/docs/en/hooks.md) | 2.0.45; `updatedInput` re-checked against deny rules 2.1.110; agent-type hooks refused 2.1.280 | Yes (2.1.310 fail-open fix) | **Used** (`bin/harbor-ask-hook`) |
| Question channel | `PreToolUse` on `AskUserQuestion` returning `updatedInput.answers` with `permissionDecision: allow`; `PermissionRequest` needs `updatedInput` for `AskUserQuestion` and `ExitPlanMode`; MCP `Elicitation` and `ElicitationResult` hooks | PreToolUse route 2.1.85; Elicitation 2.1.76; URL-mode 2.1.281 | Same | **Used** (all three) |
| Transcript | `~/.claude/projects/<project>/<session>.jsonl`; subagents in `<session>/subagents/`; spilled tool output in `<session>/tool-results/`; set-aside `*.orphaned-<ts>-<suffix>.jsonl` and `*.jsonl.superseded-<ts>` ([claude-directory](https://code.claude.com/docs/en/claude-directory.md) lines 305-309). Transcripts record each API request's system prompt, tools and parameters. `claude -p --resume` also accepts the absolute path of a `.jsonl` | requests recorded 2.1.300 | Resume on Windows now tolerates drive-letter case and slashes (2.1.325); EBADF message (2.1.282) | **Used** (`transcript.js`) |
| Model and effort | Status line `model.id`, `effort.level`; hooks `effort.level`, `PostModelSwitch` (`from_model`, `to_model`); `/model` and `/effort` are per model since 2.1.251 | 2.1.251 | Same | Status line tee and transcript |
| Usage and limits | Status line `rate_limits.five_hour` and `seven_day` (`used_percentage`, `resets_at`), `rate_limits.spend_limit`, `cost.total_cost_usd`, `prompt_cache` (hit ratio, `warm`, `ttl`, `expires_at`, `last_miss_cause`), `context_window.*`. Notification `quota_auto_resume_fired/stale/disabled` for `autoContinueAtUsageLimit` ([statusline](https://code.claude.com/docs/en/statusline.md)) | `prompt_cache` 2.1.251/2.1.260; `spend_limit` 2.1.251/2.1.284 | Status line command on Windows: docs have a "Windows configuration" section | `usage.js:37-38` reads the two percentages; `prompt_cache` not seen in grep |
| Programmatic send | Cross-session messaging (`ListAgents`, `SendMessage`; env `CLAUDE_CODE_MESSAGING_SOCKET` and `_TOKEN`) ([cross-session-messaging](https://code.claude.com/docs/en/cross-session-messaging.md)); `claude -p` with `--input-format stream-json`; `claude agents` replies arrive as queued messages (2.1.287) | native Windows needs 2.1.234 | Yes | **Used** (inbox hook and `harbor-msg`) |
| Resume and fork | `--resume <id or .jsonl path>`, `--continue`, `/branch`, `/rewind` (checkpoints in `~/.claude/file-history/<session>/`, 100 most recent), `claude --resume <id> --bg` continues under its own id (2.1.257) | various | `/resume` Windows fixes 2.1.325 | Resume yes; rewind is a terminal menu |
| Subagents and background | `SubagentStart/Stop`; Stop-hook `background_tasks[]` (`type` `shell`, `subagent`, `monitor`, `workflow`, `teammate`, `MCP task`); `/tasks`; `<session>/subagents/` transcripts | 2.1.145; `monitor` label 2.1.329 | Same | Team chart and `background-tasks.js` from transcript |
| Plans and to-dos | Plan files in `~/.claude/plans/`; task lists in `~/.claude/tasks/`; `ExitPlanMode` approval via `PermissionRequest` `updatedInput`. TodoWrite and Task* tools are offered only on older models since 2.1.268 (`CLAUDE_CODE_ENABLE_TODO_TOOLS=1` to force) | 2.1.268 | Same | Plan card absent (REPORT section 4) |
| Goals | `/goal` is "a session-scoped prompt-based Stop hook"; `/tasks` lists the goal (2.1.329) ([goal](https://code.claude.com/docs/en/goal.md)) | 2.1.139 | Same | Not shown |
| Images | Pasted images saved in an `images/` folder under `CLAUDE_CODE_TMPDIR` (`image-cache/<session>/` up to 2.1.274). Hook and transcript carry paths and blocks | 2.1.275 move | Windows temp path | `image-store.js` |

Notes a host should keep:
- A hook's `transcript_path` can lag the in-memory conversation. Use `last_assistant_message` from `Stop`, not the file, for
  the final text (hooks page, "Common input fields" and "Stop input").
- `Stop` does not fire on a user interrupt; API errors fire `StopFailure` instead. A host that waits for `Stop` alone
  misses both.
- Stop hooks that continue the turn are capped at 8 in a row (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` raises it).
- `claude agents --json` and background sessions need Claude's supervisor process. Harbor panes are plain interactive
  sessions, so `kind` is `interactive` for them and `state` is absent; only `status` and `waitingFor` apply.

## 3. Codex: host integration surface

Installed here: 0.167.0. Newest stable: 0.172.0 (alphas 0.173 and 0.174 exist). Docs root:
https://learn.chatgpt.com/docs/ (the old `developers.openai.com/codex` address redirects there).

| Channel | Documented interface | Since | Windows | Harbor today |
|---|---|---|---|---|
| State and turn: hooks | `hooks.json` in `$CODEX_HOME` (user), `.codex/` (trusted project), `%ProgramData%\OpenAI\Codex\hooks.json` (system). Events: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `PreModelRequest`, `PostModelRequest`, `SubagentStart`, `SubagentStop`, `Stop` (`last_assistant_message`, `stop_hook_active`), `Interrupt`. Common input: `session_id`, `transcript_path`, `cwd`, `model`, `turn_id`, `permission_mode`. Non-managed hooks must be reviewed and trusted. [hooks](https://learn.chatgpt.com/docs/hooks.md) | `Interrupt` 0.150.0; others version not stated | `commandWindows` / `command_windows` override field; Windows system path above | None |
| State: terminal | OSC 7501 not in the docs. `tui.notification_method = "osc777"` for terminal notifications; external `notify` program receives JSON for `agent-turn-complete` only ([config-advanced](https://learn.chatgpt.com/docs/config-file/config-advanced.md), "Notifications") | osc777 0.168.0 | n/a | Not used |
| State: app-server | `thread/status/changed` with `status.type` and `activeFlags` (example `waitingOnApproval`); `turn/started`, `turn/completed` (`completed`/`interrupted`/`failed`); `thread/tokenUsage/updated`; `serverRequest/resolved` ([app-server](https://learn.chatgpt.com/docs/app-server.md)) | n/a | `windowsSandbox/setupStart` and events exist | None |
| Approval channel | Hook `PermissionRequest` returns `decision.behavior` `allow` or `deny` (any `deny` wins; `updatedInput`, `updatedPermissions` and `interrupt` are reserved and fail closed). App-server: `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` with decisions `accept`, `acceptForSession`, `decline`, `cancel`, or `acceptWithExecpolicyAmendment`; `item/permissions/requestApproval` | hook version not stated | Same | None. Harbor reads approval menus from the screen (`session-send.js`) |
| Question channel | App-server `item/tool/requestUserInput` (with `autoResolutionMs`) and MCP elicitation requests; 0.154.0 added answering "inline while Codex continues working"; async questions `request_user_input_async` (0.153.0) | 0.153.0, 0.154.0 | n/a | None |
| Transcript | Rollout JSONL. The docs do not name a path or format; `hooks` says "the transcript format isn't a stable interface for hooks and may change". Harbor's own reader uses `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` (`provider-history.js:19`). App-server reads history without files: `thread/read`, `thread/turns/list`, `thread/items/list` | paginated rollouts 0.144.0 | Compressed cold rollouts 0.142.0 (off by default) | **Used** (`applyCodexLine`) |
| Model and effort | App-server `model/list`; thread metadata carries `model` and `reasoningEffort` (0.153.0); `turn/start` overrides; `/model` and `/permissions` take inline arguments (0.164.0); effort change mid-conversation on by default (0.165.0) | see left | n/a | Screen and rollout |
| Usage and limits | App-server `account/rateLimits/read` returns `rateLimits.primary` and `secondary` (`usedPercent`, `windowDurationMins`, `resetsAt`) and `rateLimitsByLimitId`; `account/usage/read` for token-activity summaries. Rollout `token_count` events carry `rate_limits` | n/a | n/a | `plan-usage.js:143-146` reads rollouts (a per-profile `app-server` reader was rejected, `usage.js:468-477`) |
| Programmatic send | `codex queue --thread <id|name> --message "..." [--resume] [--remote URL]` (0.149.0 per REPORT; `--resume` 0.166.0 per the release notes); needs the app-server daemon or a `--remote` server. App-server `turn/start`, `turn/steer` (needs `expectedTurnId`), `turn/interrupt`, `thread/inject_items`. `codex exec --json` for one-shot runs; `codex exec --remote <ADDR>` (0.171.0). TUI attach: `codex app-server --listen ws://127.0.0.1:4500` or `unix://PATH`, then `codex --remote <addr>` | see left | 0.154.0: "Windows sessions can now share a background Codex server, with daemon lifecycle commands"; `--listen ws://` is documented as "experimental and unsupported"; Unix-socket support on Windows is not stated | Types into the pty. `codex queue` measured not to work against `--no-daemon` panes |
| Resume and fork | `codex resume`, `codex fork`, `/fork`, `codex exec resume <id|--last>`; app-server `thread/resume`, `thread/fork` (with `lastTurnId`, `ephemeral`), `thread/revert` (history only, "doesn't revert local file changes"; `thread/rollback` removed) | see left | `exec resume` restores saved sandbox (0.172.0) | Resume yes; thread-following pinned (`providers.md:7`) |
| Subagents and background | `collabToolCall` items, `SubagentStart/Stop` hooks, `thread/loaded/list`; `thread/shellCommand`, `thread/backgroundTerminals/clean`; 0.172.0 keeps queued child replies after an interrupt; TUI workspace (default since 0.171.0) shows subagent transcripts beside the chat | 0.171.0 | Windows idle MCP I/O fix 0.168.0 | Not shown |
| Plans and to-dos | Item `plan` and `turn/plan/updated` (`plan[]` of `{step, status}`); "tools.update_plan.enabled" is off by default (0.152.0) | 0.152.0 | n/a | Not shown |
| Goals | App-server `thread/goal/set`, `get`, `clear`, notification `thread/goal/updated` (`objective`, `status`, `tokenBudget`, `tokensUsed`, `timeUsedSeconds`) | goals recover after daemon restart 0.155.0 | n/a | Not shown |
| Images | Input items `image` and `localImage`; item `imageView {path}`; `--image` flag; Windows paste of images and text (0.163.0) | see left | Ctrl+V and Shift+Insert paste fixed 0.163.0 | Pasted-path handling in `session-send.js` |

What changes the picture for Harbor:
- **`codex --remote` is the one hybrid in the four CLIs.** The TUI can attach to an app-server that Harbor itself starts, so
  the pty and a structured event stream describe the same thread. That gives exact state (`waitingOnApproval`), approvals,
  `turn/steer`, `account/rateLimits/read` and plans without screen reading, and keeps the real terminal for the `>_` view.
  Harbor's current rule is the opposite (`--no-daemon`, one pane one process). Untried here; I do not know whether `unix://`
  works on Windows ConPTY. Documented transports: stdio, `ws://` (unsupported), Unix socket ([app-server](https://learn.chatgpt.com/docs/app-server.md), "Protocol").
- The app-server schema calls itself "primarily for development and debugging and may change without notice"
  ([developer-commands](https://learn.chatgpt.com/docs/developer-commands.md), `codex app-server`). The `codex app-server
  generate-ts` style schema export is not described on the pages I read.

## 4. Cursor CLI (`agent`, `cursor-agent`): host integration surface

Newest: v2026.11.19. Reviewed by Harbor to 2026.11.05. Docs root: https://cursor.com/docs/cli/overview.md

| Channel | Documented interface | Since | Windows | Harbor today |
|---|---|---|---|---|
| State and turn: hooks | `hooks.json` at `~/.cursor/` (user), `.cursor/` (project), managed `C:\ProgramData\Cursor\hooks.json`. Events: `sessionStart`, `sessionEnd`, `preToolUse`, `postToolUse`, `postToolUseFailure`, `subagentStart`, `subagentStop`, `beforeShellExecution`, `afterShellExecution`, `beforeMCPExecution`, `afterMCPExecution`, `beforeReadFile`, `afterFileEdit`, `beforeSubmitPrompt`, `preCompact`, `stop`, `afterAgentResponse`, `afterAgentThought`. Common stdin: `conversation_id`, `generation_id`, `model`, `model_params`, `hook_event_name`, `cursor_version`, `workspace_roots`, `transcript_path`. Env `CURSOR_TRANSCRIPT_PATH`. Exit code 2 blocks, "equivalent to `permission: deny`", for Claude compatibility. [hooks](https://cursor.com/docs/hooks.md) | CLI hook list in the changelog under v2026.06.09 and earlier; plugin hooks v2026.08.11; subagent post-tool hooks v2026.10.17 | Windows launch failure now reported as failed (v2026.10.15) | None |
| State: terminal | No OSC 7501 yet (REPORT; forum, snippet only) | n/a | n/a | n/a |
| Approval channel | `beforeShellExecution` / `beforeMCPExecution` return `{"permission": "allow"|"deny"|"ask", "user_message", "agent_message"}` (hooks page, examples at lines 353-375). ACP `session/request_permission` with `allow-once`, `allow-always`, `reject-once` ([acp](https://cursor.com/docs/cli/acp.md)). Since v2026.10.28 a hook that returns `ask` prompts even under Auto-review | see left | Same | None (screen) |
| Question channel | No hook. ACP extension `cursor/ask_question` (blocking; `questions[]` with `options[]`, `allowMultiple`; reply `answered`/`skipped`/`cancelled`). v2026.11.12: agent questions now include context | ACP page | n/a | None |
| Transcript | Headless transcripts "write Claude Code-compatible JSONL" (changelog, under v2026.06.09 and earlier); subagent transcripts in `agent-transcripts/<parent>/subagents/` (v2026.10.17); hooks get `transcript_path`. The docs give no path for the main store | v2026.10.17 | n/a | **Used** (`~/.cursor/projects/*/agent-transcripts`, `provider-history.js`) |
| Model and effort | `--model`, `--list-models`, `agent models`; hooks carry `model_id`, `model_params` (`thinking`, `context`, `effort`); the model catalog refetches every 10 min (v2026.07.20) | v2026.07.20 | n/a | `cursor-model-catalog.js` |
| Usage and limits | `/usage` shows plan meters and on-demand spend (v2026.07.13); headless `result` carries per-turn and total `usage`, with `reasoningTokens` (v2026.10.28). Transcripts carry no token counts (REPORT, forum snippet only). Status-line command exists (v2026.08.11) but the config reference documents only `display.showStatusLineRunningTime` | see left | n/a | Plan meters only |
| Programmatic send | `agent -p` with `--output-format text|json|stream-json`, `--stream-partial-output`; stream events `system/init` (`cwd`, `session_id`, `model`, `permissionMode`), `user`, `assistant`, `tool_call` (`started`, `completed`), `result`. [output-format](https://cursor.com/docs/cli/reference/output-format.md). `agent acp` for a JSON-RPC server. Interactive Enter while the agent works queues and steers at a safe boundary (v2026.08.11) | see left | n/a | Types into the pty |
| Resume and fork | `agent ls`, `agent resume`, `--resume [chatId]`, `--continue`, `agent create-chat`, `/fork` (aliases `/branch`, `/duplicate`), `/rewind` (default on v2026.06.22), `/resume`; resume from any directory (v2026.07.06); `agent persist` and `/detach`, `agent persist attach` (v2026.08.26) | see left | Resume picker faster on network drives | Resume yes |
| Subagents and background | Subagent hooks; ACP `cursor/task`; ACP clients that advertise `subagents` get child sessions (v2026.09.15); jobs pager lists foreground shells and subagents (v2026.06.22) | see left | n/a | Not shown |
| Plans and to-dos | `--plan`, `--mode plan|ask`; ACP `cursor/create_plan` (blocking approval; `plan`, `todos[]` with `pending`, `in_progress`, `completed`, `cancelled`, `phases[]`), `cursor/update_todos` | see left | n/a | Not shown |
| Goals | `/goal` durable goal with active or paused status line, continues across idle and headless runs (v2026.08.11) | v2026.08.11 | n/a | Not shown |
| Images | Inline previews (v2026.08.11); ACP `cursor/generate_image`; `agent` accepts pasted and dropped images (v2026.06.09) | see left | n/a | Pasted-path handling |

Cursor-specific traps for a host (all from the changelog, none tested here):
- ACP mode does not support team-level MCP servers from the dashboard ([acp](https://cursor.com/docs/cli/acp.md), "MCP servers").
- Windows PowerShell 5.1 errors on `&&`; since v2026.11.17 the error text comes back in UTF-8. Shell output uses UTF-8
  since v2026.10.22.
- The Windows updater now gives up after a set time when an agent still runs (v2026.10.28), and auto-update cleanup had
  deleted the version a running session was launched from (fixed v2026.07.13).
- Prompt hooks set up in the team dashboard did not run in the CLI before v2026.11.17 (they ran as empty commands).

## 5. agy (Antigravity CLI): host integration surface

Installed here: 1.5.14. Newest: 1.5.18. Docs root: https://antigravity.google/docs/cli/using

| Channel | Documented interface | Since | Windows | Harbor today |
|---|---|---|---|---|
| State and turn: hooks | `hooks.json` at `.agents/hooks.json` (workspace), `~/.gemini/config/hooks.json` (global; "Hooks in `~/.gemini/antigravity-cli/settings.json` aren't loaded"), plugin `hooks.json`. Events: `SessionStart`, `PreToolUse`, `PostToolUse`, `PreInvocation` (can return `terminationBehavior: "terminate"`), `PostInvocation`, `Stop`. Common stdin (camelCase): `conversationId`, `workspacePaths`, `transcriptPath`, `artifactDirectoryPath`, `modelName`, `lastUserInput`, `hookEventName`, `cwd`, `toolCall.id`. `Stop` adds `executionNum`, `terminationReason`, `error`, `fullyIdle`, `continuation_active`. [hooks](https://antigravity.google/docs/hooks) | `lastUserInput` 1.4.7; `terminationBehavior` 1.4.11; `hookEventName`, `cwd`, `toolCall.id` 1.5.4; `continuation_active` 1.5.6 | 1.5.8 fixed hook commands with double quotes that failed and let a `PreToolUse` hook skip its block | None |
| State: status line | `statusLine.command` gets JSON on stdin at most every 300 ms (5 s limit, disabled after 30 failures; `cmd /c` on Windows). Fields: `conversation_id`, `conversation_title`, `transcript_path`, `model{id,display_name,effort}`, `context_window{...}`, `agent_state` (`idle`, `working`, `tool_use`, `reviewing`, `authenticating`, `initializing`, `error`), `cycle_mode`, `subagents[]{name,role,status}`, `artifact_count`, `pending_input_count` (queued user messages), `tool_confirmation_pending`, `task_count`, `quota{...}`, `cost{total_usd,...}`, `sandbox`, `terminal_width`. [statusline](https://antigravity.google/docs/cli/statusline) | The docs list seven `agent_state` values (adds `reviewing`, `initializing`, `error`). Harbor's tee names four (`gemini-status-tee.cjs:31`) but stores any other string as given (line 48) | Windows runs it through `cmd /c` | **Used**: `agent_state`, `tool_confirmation_pending`, `model`, `context_window`. Dropped: the rest |
| State: terminal | OSC 7501 with a support probe first (1.4.0); 1.5.10 fixed "done" while subagents or background tasks run | 1.4.0 | REPORT verified `AGY_CLI_OSC7501=on` behaviour here | Not used |
| Approval channel | `PreToolUse` returns `decision` `allow`, `deny`, `ask`, `force_ask` or `deny_unless_prior_grant`, plus `reason` and `overwrite` (shallow-merged tool args). There is no "permission request" event: a host sees the dialog only as `tool_confirmation_pending` in the status line. ACP gives real permission requests | 1.5.7 fixed `auto_approve` bypassing admin review | Always-allow rules for `cmd`, `powershell.exe`, `pwsh.exe` fixed 1.5.8 | Reads the flag, answers by typing |
| Question channel | Tool `ask_question` (questions with options, `is_multi_select`); ACP elicitation forms for clients that support them | n/a | n/a | None |
| Transcript | `<app_data_dir>/brain/<conversationId>/.system_generated/logs/transcript.jsonl` per the docs; `transcript_full.jsonl` also on disk **(verified here)**. 1.5.15: all conversations kept in `~/.gemini/antigravity-cli/conversations` (no 500 prune) | 1.5.15 | `.db` per conversation exists here | **Used** (`gemini-store.js`) |
| Model and effort | Status line `model.effort` (`low` to `max`); `/effort`, `/model`; Orchestrator row with Planner and Executor models, saved under `"orchestrator"` in `settings.json` (1.5.14, 1.5.17) | see left | n/a | Tee keeps model and effort |
| Usage and limits | Status line `quota` (`remaining_fraction` or `remaining_amount`, `reset_time`, `reset_in_seconds`), `cost.total_usd` (estimate); `/usage`, `/credits`, `/quota`; quota refreshed during long turns (1.5.16) | 1.5.16 | n/a | `agy-usage.mjs` (REPORT) |
| Programmatic send | `agy -p`, `--output-format text|json|stream-json`, `--json-schema`, `--print-timeout`, `-c`, `--conversation <id>`, `-r` (1.5.16); json result has `status` (`SUCCESS`, `ERROR`, ...), `conversation_id`, `response`; `finished_reason` 1.4.11. `agy acp` (ACP v1, stdio, "Antigravity ACP Server"). `alt+m` sends with the opposite queue setting (1.4.0) | see left | Auto mode needs Windows 11 24H2 for personal accounts (1.4.4) | Types into the pty; print runs use a separate profile |
| Resume and fork | `agy -c`, `/resume`, `/fork` (alias `/branch`; clones history, new id, "clones the conversation thread, not your local Git checkout"), `/rewind` (alias `/undo`), workspace-scoped session list | see left | n/a | Resume yes |
| Subagents and background | `invoke_subagent`, `manage_subagents`, `manage_task` tools; status `subagents[]`, `task_count`; subagents' conversation rows have `parent_conversation_id` in `conversation_summaries.db` (Harbor note `gemini-store.js:24`); `_meta["antigravity.google/root_conversation_id"]` on MCP calls (1.4.4) | see left | n/a | Not shown |
| Plans and to-dos | `plan` mode (Shift+Tab), `cycle_mode: plan`; live `N/M steps` from `update_steps` (1.5.16); artifacts (`implementation_plan.md`, `task.md`, `walkthrough.md`) under the conversation | 1.5.16 | n/a | Not shown |
| Goals | `/goal` ([goal](https://antigravity.google/docs/commands/goal)), swarm board overview shows the swarm goal (1.5.14) | see left | n/a | Not shown |
| Images | Terminal paste or drag-and-drop attaches images (1.4.9); corrupt images now rejected (1.5.18) | 1.4.9 | n/a | Pasted-path handling |

agy notes:
- `agy acp` bugs fixed through 1.5.16 (stalls for 60 s on subagent approvals, turns ending while background tasks run,
  `session/load` cutting replay at 2 s, wrong working directory) show that the ACP path was rough until recently. The open
  quota-drain reports in REPORT section 10 (#1890, #1886) apply to it.
- The ACP guide says third-party models are offered "only" to JetBrains, Android Studio, Zed and Xcode
  ([ide extensions acp](https://antigravity.google/docs/ide/extensions/acp)). The changelog for 1.5.1 says `agy acp` now
  "offer[s] every model available to your account to every ACP client". The two disagree; the changelog is newer.

## 6. Agent Client Protocol (ACP)

Sources: every page of agentclientprotocol.com (151), the adapter READMEs (codex-acp and claude-agent-acp, 2026-11-26),
T3 Code's `docs/user/providers-acp.md`, and one Firecrawl search.

### 6.1 What it is and where it stands

- JSON-RPC 2.0 over stdio (newline-delimited), also a transports working group for HTTP and WebSocket
  ([overview](https://agentclientprotocol.com/protocol/v1/overview.md)). The agent runs as a child process of the client.
- **v1 is stable.** **v2 moved from Draft to Preview on 2026-11-20** ([announcement](https://agentclientprotocol.com/announcements/acp-v2-preview.md)),
  "prompts that don't own the turn, updates patched by ID, structured diffs, flexible permission requests, and extensible
  enums". Zed and JetBrains build against it. T3 Code negotiates v2 Preview and falls back to v1 automatically.
- Stabilised pieces (each has an announcement page): session list (2026-03-09), session resume (2026-04-22), session usage
  (2026-06-05), and on 2026-11-20 subagent sessions, plan operations, and (listed in the index with the same family)
  session close, delete, config options, notices, compaction, elicitation, message ids, request cancellation.

### 6.2 What a host gets, mapped to Harbor's needs

| Harbor need | ACP method or update | Stage |
|---|---|---|
| Create, list, load, resume, close, delete sessions | `session/new`, `session/list`, `session/load` (replays history), `session/resume` (no replay), `session/close`, `session/delete` | stable (v1) |
| Send a message, steer, queue | `session/prompt`. v2: a prompt may be sent in any state and the agent "inserts it right away, or holds it", response returns the `messageId` | v2 preview |
| Turn state | v1: prompt response with a stop reason. **v2: `state_update` with `running`, `requires_action`, `idle`** (idle carries `stopReason`, can carry an error object) plus a `background` list of terminals, tool calls and subagent sessions that run on after the turn ends | v2 preview; the background list is RFD "v2 Background Work" |
| Approval | `session/request_permission` with options (kind `allow-once`, `allow-always`, `reject-once`) | stable |
| Questions | Elicitation forms (stabilised); Cursor adds `cursor/ask_question` | stable |
| Plans | `plan` (checklist) and `plan_update` / `plan_removed` for Markdown plans, opt-in `clientCapabilities.plan` | stable 2026-11-20 |
| Tool calls and diffs | `tool_call` and `tool_call_update` with `kind`, `status`, `content` (diffs, terminal output), `locations` | stable; v2 adds diff file states |
| Modes and model and effort | Session config options with `category` values such as `mode`, `model`, and stabilised `model` and boolean categories; older `session/set_mode` | stable |
| Context and cost | `usage_update` (context tokens, window size, optional cumulative cost) | stable 2026-06-05 |
| Slash commands | `available_commands_update` | stable |
| Subagents | Child sessions announced by `subagent_update` on the parent | stable 2026-11-20 |
| Titles | `session_info_update` | stable |
| Fork, rewind, status | `session/fork` and `session/status` are RFDs, not stable; Codex's adapter has `_session/rewind` and `session/fork` at a cursor as extensions | proposal |

Not in ACP: rate-limit windows and reset times (only context and cost), a transcript file location, image paste into a
running terminal, terminal screen content, the CLI's own slash menus, `/rewind` file restore.

### 6.3 Which of the four speak it

| CLI | ACP | How | Source |
|---|---|---|---|
| Cursor | Native | `agent acp` (hidden command), auth method `cursor_login`, modes `agent`, `plan`, `ask`, extension methods (`cursor/ask_question`, `cursor/create_plan`, `cursor/update_todos`, `cursor/task`, `cursor/generate_image`) | [cursor acp](https://cursor.com/docs/cli/acp.md) |
| agy | Native since 1.5.0 | `agy acp` (v1, stdio); model and thinking-level pickers; steering; cancel; images and embedded resources; `session/list`, `load`, `resume`, `close`; context-window updates (1.5.8); Auto mode (1.5.4) | [agy acp](https://antigravity.google/docs/cli/acp), [ide acp](https://antigravity.google/docs/ide/extensions/acp) |
| Codex | Adapter, not native | `@agentclientprotocol/codex-acp` starts the Codex App Server and translates to ACP. It adds extensions for steering, goals, rewind, background terminal tasks | [README](https://github.com/agentclientprotocol/codex-acp) (opened 2026-11-26) |
| Claude Code | Adapter, not native, and not the CLI | `@agentclientprotocol/claude-agent-acp` is built on the Claude Agent SDK (to-do lists, subagent transcripts, terminals, `/mcp`, goals) | [README](https://github.com/zed-industries/claude-agent-acp) (opened 2026-11-26) |

### 6.4 Who uses it

- Zed, JetBrains IDEs (`~/.jetbrains/acp.json`), Android Studio, Xcode, Neovim plugins, Emacs, Obsidian plugins, a VS Code
  extension: from the clients and agents pages of agentclientprotocol.com and the agy guide.
- Terminal and desktop managers on the ACP clients page: Orca ("native ACP sessions, inline permission approvals, multi-agent
  DAG orchestration, embedded terminals", Windows included), Orca Mobile, Microsoft's Intelligent Terminal (a Windows
  Terminal fork "driving ACP-compatible agent CLIs over stdio"), SpurCode, lucid, Toad, Raven.
- **T3 Code:** supports "any ACP agent" and runs Registry agents on its server, negotiating v2 Preview then v1
  (T3 Code README line 28 and `docs/user/providers-acp.md`). It lists Codex, Claude, Cursor, Grok, OpenCode, Pi and
  Antigravity as separate built-in providers; whether those built-ins use ACP inside is not stated on the pages I read.
- **Paseo:** its README lists Claude Code, Codex, Copilot, OpenCode, Pi, Antigravity and Muse Code through "the same
  interface" and does not mention ACP (grep of the README found no "ACP"). Its site lists 40-plus agents (snippet only).
  I did not establish how Paseo talks to them.

### 6.5 Could Harbor drive some CLIs through ACP instead of typing into a terminal?

**Short answer: yes for Cursor and agy as an opt-in window type, not as a replacement; for Codex use the app-server
(directly or by attaching the TUI); for Claude, no.**

- **What would be gained.** A structured session with no pty typing, no screen scraping and no prompt gate: `state_update`
  (v2) or stop reasons (v1), permission and question requests as data, plans, tool calls with diffs, subagents as child
  sessions, context usage, model and effort pickers, cancel, and steering. These are the bug families in REPORT section 1
  (fake questions, missed prompts). Orca and T3 Code show the pattern works with Windows builds.
- **What would be lost, per CLI.**
  - Cursor: team-dashboard MCP servers (not supported in ACP mode); the interactive menus (`/rewind`, `/fork`, `/resume`
    pickers, `agent persist`); the real terminal for `>_`. The ACP page calls itself "intended for building custom clients".
    It does not say whether ACP sessions write the same `agent-transcripts` files Harbor reads for its rail.
  - agy: the real terminal, `/rewind`, `/fork`, the status-line fields (`task_count`, `quota`) unless the ACP server
    repeats them (it exposes context usage only); known instability up to 1.5.16 and the open quota-drain reports.
    Persisted conversations still land in agy's store, but whether an ACP session and an interactive TUI can share one
    conversation is not documented (issue #1884 in REPORT is the related hazard).
  - Codex through `codex-acp`: it is the app-server underneath, so go to the app-server and skip the adapter. Through the
    app-server Harbor would keep exact approvals, goals, plans, `account/rateLimits/read`, but lose nothing the terminal
    shows if it attaches the TUI with `--remote` (section 3). Risk: `ws://` is "experimental and unsupported", and a
    shared server is the daemon model Harbor deliberately turned off.
  - Claude: the adapter runs the Agent SDK, not the CLI. The pane would no longer be the same program as the one Pat's
    hooks, 15 config homes and `/` menus assume. Billing and plan-limit behaviour of the SDK path on a subscription login
    is not something I verified. Claude already has the structured channels Harbor needs (hooks, `claude agents --json`,
    transcripts), so ACP adds little.
- **What stays true for every route.** ACP has no rate-limit window or reset time and no transcript path, so plan meters
  and the history rail keep their current sources. A host that spawns the ACP process owns its lifetime; Harbor's
  keeper/ConPTY model does not apply to a stdio JSON-RPC child, so it needs its own supervision (and the windowless-launch
  rule in Pat's instructions, with a console-sentinel probe).
- **A small pilot would answer the open questions:** one Cursor or agy window type backed by `agent acp` / `agy acp`, run
  with Harbor's existing launch policy, measuring (a) whether the structured window sees every approval, (b) whether the
  rail still sees the transcript, (c) quota use on agy. I did not build or run any of this.

## 7. Open items this pass answered or narrowed

| REPORT "Not verified" | Result |
|---|---|
| Whether real Claude receives the keeper's OSC 7501 answer through ConPTY | Not answerable from docs; the docs do not describe the query/answer at all (terminal-config says only "nothing to turn on"). Still needs a live test |
| A Claude registry record in the `waiting` state | The docs define `waiting` and the five `waitingFor` strings, and say `claude agents --json` is the supported reader. Not observed live |
| Whether a slow Claude `PermissionRequest` hook blocks the dialog | Docs: "whichever decides first applies" for SDK hosts, and Notification `permission_prompt` fires after about 6 s while a hook is pending. A hook that has not answered does not time out the dialog on the page I read; the hook timeout and "no decision" step-aside are Harbor's own (`harbor-ask-hook` header). Not observed live |
| Which Cursor hooks fire in `cursor-agent` on Windows | Narrowed (section 1, item 4). Not tested |
| agy's subagent record format and artifact layout | Layout documented (section 1, item 3). Subagent rows are in `conversation_summaries.db` (Harbor's note). Artifact folder: `artifactDirectoryPath` is passed to every hook but its location is not stated on the hooks page |

## 8. Changelog entries a host should react to

Handling key (do not read more precision into it than it has):
- **R** = inside a range Harbor's CLI review cycles covered. Per `docs/claude/providers.md` lines 3-31 those cycles ran to
  Claude 2.1.321, Codex 0.167.0, Cursor 2026.11.05 (all on 2026-11-09), and agy 1.5.14 (Gemini provider landed 2026-11-23).
  "R" means reviewed, not necessarily acted on; I did not check each entry against the code unless I say so.
- **N** = newer than the last review. Not handled.
- **Gap** = I looked in Harbor's code and found nothing for it.
- Links: Claude https://code.claude.com/docs/en/changelog.md (headings are versions) and
  https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md; Codex
  `https://github.com/openai/codex/releases/tag/rust-v<version>`; Cursor https://cursor.com/docs/cli/changelog.md;
  agy https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md.

### 8.1 Claude Code (2.1.250 to 2.1.332)

New events, fields and files:
- 2.1.332 N: new `PreSkillShellCommand` hook event. A settings file that names it opens a dialog at start on 2.1.331 and older.
- 2.1.331 N: Stop hooks that read the transcript missed the last reply in Claude Desktop; `SubagentStop` now waits. Use `last_assistant_message`.
- 2.1.329 N: Stop and SubagentStop list a Monitor's script as `monitor`, not `shell`, in `background_tasks`. Also `/tasks` lists scheduled tasks, `/loop` wakeups, the goal and forks.
- 2.1.328 N: `CLAUDE_CODE_DISABLE_DEFERRED_TOOL_RESUME` lets a host stop `--resume` from running a deferred tool call.
- 2.1.326 N: OSC 7501 reports improved (background work counts as working; trust prompt is "waiting"); session debug logs under `~/.claude/child-logs/`; hook failures drawn red in the transcript view; `/rewind` skips some files when the sandbox is on.
- 2.1.323 N: `claude rm` and agent view say a session is removed from the list, not deleted; `subagentStatusLine` setting removed; 30-second hook progress heartbeat in `-p` and SDK runs.
- 2.1.321 R: `claude -p` exits 1 on a lost transcript write (full disk or NFS); stream-json no longer hangs on out-of-memory transcript reads; Windows `FileChanged` hooks stop after a lowercase-drive path (fixed).
- 2.1.317 R: `CLAUDE_CODE_DISABLE_NESTED_SESSION_ID` (a nested `claude -p` reuses the parent's session id and transcript unless set to 1). Gap: Harbor workers that call `claude -p` inside a session should not share a transcript; not checked.
- 2.1.314 R: stream-json host acknowledges prompts containing `<bash-stdout>` and `<local-command-stdout>` tags.
- 2.1.311 R: `--output-format json` and `stream-json` write DEL, C1 and format characters as `\uXXXX`.
- 2.1.304 R: auto-mode session files no longer store the classifier context (smaller transcripts).
- 2.1.300 R: transcripts record each API request's system prompt, tools and parameters (REPORT already notes Harbor accounts for it).
- 2.1.299 R: `UserPromptSubmit` hooks run before skill or slash-command expansion; `queue` records in the transcript can differ from the prompt as sent (`session.append` mod hook); queued stream-json content blocks no longer run together.
- 2.1.295 R: OSC 7501 added; `claude agents` stopped with its supervisor now stops sessions in about a minute on macOS and Linux.
- 2.1.290 R: `claude agents` replies get up to 12 s of retry while a crashed background session restarts; `/model`, `/effort`, `/rename` from agents apply immediately.
- 2.1.287 R: replies from `claude agents` arrive as queued messages; slash commands other than `/stop` wait for the turn to end.
- 2.1.286 R: `/compact`, `/clear`, `/rewind` typed while viewing a background agent's transcript now ask which target.
- 2.1.285 R: resume or compact no longer crashes on a malformed compaction marker or loop-wakeup entry. Gap: Harbor's parser tolerance for malformed entries not checked.
- 2.1.284 R: status line `rate_limits.spend_limit` gains dollar amounts; 2.1.251 added the field itself.
- 2.1.283 R: stream-json `system/init` `plugin_errors` entries carry `path`.
- 2.1.275 R: send-now key (ctrl+enter or ctrl+x ctrl+s) interrupts and sends all queued messages. Harbor parses queue records; sending that key from the window is a gap.
- 2.1.274 R: corrupted transcripts with an "unexpected tool_use_id" 400 now self-heal or end with a `/rewind` hint.
- 2.1.273 R: stream-json and SDK output dropped a subagent's remaining messages after it moved to the background (fixed).
- 2.1.269 R: `permission_denials` in stream-json results now include path-scoped Read, Edit and Write denies.
- 2.1.268 R: `claude auth status --json` adds `configDirectory`; TodoWrite and Task tools offered only on older models unless `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`. Gap: this changes which to-do records appear in transcripts by model.
- 2.1.267 R: resuming a transcript over 5 MB no longer drops parallel tool calls and hook output.
- 2.1.265 R: non-interactive sessions keep the shell working directory across turns.
- 2.1.261 R: `claude -p --resume <file>` with a malformed recorded session id resumes under a fresh id.
- 2.1.260 R: `prompt_cache` gets `last_miss_cause` and `miss_causes` in the status line.
- 2.1.257 R: `claude --resume <id> --bg` continues under the same id instead of copying; `--continue` in `-p` opens a background session.
- 2.1.251 R: `claude --help` lists `attach`, `logs`, `stop`, `respawn`, `rm`; per-session `prompt_cache` object added to the status line; `/effort` saved per model.
- 2.1.250 R: start of the range; no host-facing entry found by my filter.

Windows:
- 2.1.332 N: exit-with-no-output on some company PCs fixed; marketplace add retries when a scanner holds files.
- 2.1.331 N: managed settings in the registry (`HKLM` outranks `managed-settings.json`; non-ASCII values crashed start, fixed); FAT32 and exFAT write prompts; Remote Control showed no steps for a new subagent (Windows).
- 2.1.330 N: Grep and Glob no longer start a console host per ripgrep search (a popup source; relevant to Pat's windowless rule, now fixed upstream); first Bash command slow when Git Bash took 10 to 60 s.
- 2.1.327 N: PowerShell tool asks before more commands and is refused when nothing can answer; `claudeMdExcludes` drive-letter case.
- 2.1.326 N: PowerShell tool refusals extended; Windows paths in replies keep the backslash before `.claude` and `_build`.
- 2.1.325 N, 2.1.323 N: `/resume` and trust handle different drive-letter case and slashes; `.cmd` or `.bat` beside a program's `.exe` no longer runs in its place.
- 2.1.319 R: config saves wait longer on a file another program holds, so a kill during a save is less likely to empty `~/.claude.json`. Relevant to Harbor's restart and kill paths.
- 2.1.317 R, 2.1.310 R, 2.1.309 R: every-tool-refused on some volumes; PreToolUse and PermissionRequest hooks letting a call through when Git Bash is missing; `"shell": "powershell"` hooks failing open.
- 2.1.301 R: stopped background PowerShell commands get a closing `[killed]` line.
- 2.1.282 R: clearer error when a Windows resume cannot read its transcript (EBADF).

### 8.2 Codex (0.150.0 to 0.172.0)

- 0.172.0 N: `codex exec resume` restores saved sandbox permissions, working directory and workspace roots; interrupting a parent turn keeps queued child replies for the next turn; provider errors reported immediately, naming which API spend limit was hit.
- 0.171.0 N: **TUI workspace is on by default** (side conversations, subagent transcripts, document and image previews beside the chat). Harbor reads Codex's screen; a changed layout can break box detection. Also `codex exec --remote <ADDR>`, `/rc` and `/remote`, and a custom status line through `/statusline`.
- 0.170.0 N: Windows file replacement and runtime registration recovery fixes.
- 0.169.0 N: `codex exec` keeps project config and MCP off in untrusted directories (new `--trust`); "Yes, clear context and implement now" hands the approved plan to a fresh session; opt-in multi-tab side chats.
- 0.168.0 N: `tui.notification_method = "osc777"`; steering messages reach a running turn during the final transcript save; Windows idle MCP servers stop holding filesystem I/O; features.tui_workspace introduced.
- 0.167.0 R: provider mismatch on resume leaves a readable chat (Harbor handled, `providers.md:5`); session picker marks unread results.
- 0.166.0 R: `codex queue --resume`; `codex doctor --network-only`; approval and permission settings preserved on resume and fork.
- 0.165.0 R: experimental "attached thread forks" in the app-server API; reasoning-effort changes mid-conversation on by default.
- 0.164.0 R: queued prompts wait for pending permission selections; resuming restores saved thread settings; Windows HTTPS handles proxy Negotiate or NTLM.
- 0.163.0 R: follow-up while Codex responds steers immediately (`turn/steer` in the TUI); `/side` returns to a side conversation; Windows Ctrl+V pastes text and images; OSC 7501 (per REPORT); local commands finish when a child keeps an output pipe open.
- 0.162.0 R, 0.162.1 R: signed PowerShell installer; asynchronous multi-line question crash fixed; background-server feature mismatch fixed.
- 0.161.0 R: Daybreak opt-in; explicit launch permissions survive terminal reconnects.
- 0.160.0 R, 0.159.2 R, 0.159.0 R: console windows from background helpers suppressed on Windows (three separate releases, a popup source); queued messages resume after reconnection; opt-in `instant_interrupt` steering.
- 0.158.0 R: Windows sandbox failures on ordinary Windows 10 paths; command completion events include early output and launch failures.
- 0.157.0 R: **`daemon_auto_start` on and fullscreen transcript on by default** (Harbor pins `--no-daemon` and a TUI setting, `harbor-bin.cjs:586-596`); `f` forks a conversation open in another app.
- 0.156.0 R: `/tui` fullscreen option; worktree sessions on by default; `/usage` analytics dashboard.
- 0.155.0 R: active goals recover after daemon restart; blocked Windows-process escapes from restricted WSL sandboxes.
- 0.154.0 R: worktree support (`--worktree`, `/worktree`); **Windows sessions can share a background Codex server**; resuming a conversation open in another app shows a read-only transcript.
- 0.153.0 R: TUI sessions reconnect after an external app-server drops, keeping queued submissions paused for review; thread metadata carries nullable `model` and `reasoningEffort`; `request_user_input_async`.
- 0.152.0 R: planning tool off by default (`tools.update_plan.enabled`).
- 0.151.0 R: nested subagent token usage counts toward root goal budgets.
- 0.150.0 R: `Interrupt` hook; unnamed terminal tasks get automatic titles; Windows sandbox setup under Unicode user paths.

### 8.3 Cursor CLI (v2026.06.09 to v2026.11.19)

- v2026.11.19 N: Linux login moves to the system keyring; credential files readable only by the user; hooks on self-hosted workers get run details.
- v2026.11.17 N: dashboard prompt hooks now run as prompts in the CLI; PowerShell parse errors return in UTF-8; `CURSOR_LOGIN_SHELL=0` skips login scripts. (REPORT's Smart App Control note is not in the CLI changelog text I have; I did not find it.)
- v2026.11.12 N: agent questions include the context behind them (changes question card text).
- v2026.11.11 N: to-do and question updates no longer fail on a missing closing bracket.
- v2026.11.04 and v2026.11.05 R: Plan mode refuses edits to non-markdown files through a `.md` symlink.
- v2026.10.28 R: headless `usage` gains `reasoningTokens`; a `beforeShellExecution` hook that asks now prompts even in Auto-review; Windows launcher update gives up after a set time when an agent runs.
- v2026.10.22 R: shell output in PowerShell is UTF-8; tool calls show as started while still being written; nested `AGENTS.md` applies on edit.
- v2026.10.17 R: subagent transcripts saved under `agent-transcripts/<parent>/subagents/`; `postToolUse` hooks fire for subagents; unanswered approvals no longer reported as cancelled when a new message arrives. Harbor: "turn_ended often missing" per REPORT.
- v2026.10.15 R: hooks that fail or point at a missing command are reported as failed on Windows.
- v2026.10.08 R: ACP clients get wakeups from watched background shells; ACP sessions stop after a team switch.
- v2026.09.15 R: ACP clients that advertise `subagents` get child sessions; "ask the agent to stop a goal" closes the goal.
- v2026.08.26 R: `agent persist`, `/detach`, `agent persist attach` (REPORT notes docs are thin).
- v2026.08.11 R: durable `/goal`; steering by Enter during a run; inline image previews; custom `statusLine` command throttle; headless runs wait for subagents; timed mode-switch approvals auto-reject after 15 s.
- v2026.07.13 R: auto-update cleanup could delete a running session's own version (fixed); `/usage` shows plan meters.
- v2026.07.06 R: resume picker across directories; subagents keep context across resumes; concurrent agents no longer corrupt `cli-config.json` writes.
- v2026.06.29 R: only new transcript entries saved at each checkpoint (fixes memory growth); `AGENT_CLI_CREDENTIAL_STORE=file`.
- v2026.06.22 R: `/rewind` on by default; prompt history per conversation; jobs list shows foreground shells and subagents.
- v2026.06.09 R: `/fork`, `/update`, `/logs`; hooks accept payloads over stdin; admins can disable headless mode; Composer 2.5 default.

### 8.4 agy (1.4.0 to 1.5.18)

- 1.5.18 N: plugins on a different drive than the config dir now load on Windows; truncated or corrupt images are rejected instead of attached.
- 1.5.17 N: Orchestrator row in `/model` (single-agent when Planner and Executor match); long turns no longer fail with 401 at the one-hour token expiry; fixes to `agy update` output.
- 1.5.16 N: `-r` and `--resume` aliases of `--conversation`; live `N/M steps` checklist in the status line (`update_steps`); quota refreshed during long turns (status-line `quota` stays current); `agy acp` no longer stalls 60 s on a subagent approval or question.
- 1.5.15 N: all conversations kept in `~/.gemini/antigravity-cli/conversations` (no 500 prune); `agy acp` finishes history replay before answering `session/load`, keeps turns open across background tasks, and closes tool calls on `session/cancel`. Gap: Harbor's history index assumes the `brain\` layout.
- 1.5.14 R (installed): `/thinking`; swarm board overview; hook child processes killed as a group on timeout (Linux and macOS only); `AI: Out of credits` status fixed.
- 1.5.13 R: `agy acp` ran shell commands in the editor's directory (fixed); status of json and stream-json results is `SUCCESS` after a retried request.
- 1.5.10 R: OSC 7501 no longer says "done" while subagents or background tasks run; sandbox blocks `AppData\Roaming` reads by default on Windows; memory use bounded in long sessions.
- 1.5.9 R: `!` commands on Windows keep double quotes; scheduled automations on Windows get the whole multi-line prompt; `/resume <id>` accepted.
- 1.5.8 R: hook commands on Windows containing double quotes no longer fail silently (a `PreToolUse` block could be skipped); `agy acp` sends context-window updates; a single corrupted queued-message file no longer blocks later messages.
- 1.5.7 R: default Agent Mode changed from Default to Auto, including headless `-p` runs (changes what prompts appear).
- 1.5.6 R: Stop hook input gains `continuation_active`.
- 1.5.5 R: `agy -p` exits within 30 s if a background task such as title generation hangs.
- 1.5.4 R: hook input gains `hookEventName`, `cwd`, `toolCall.id`; Auto mode in `agy acp`.
- 1.5.3 R: subagent model shown beside its name in rows and `/agents`.
- 1.5.0 R: `agy acp` added; `-p` waits for background tasks (previously a hidden 30-minute limit).
- 1.4.11 R: `PreInvocation` `terminationBehavior`; `finished_reason` in json results.
- 1.4.9 R: image paste through the terminal's paste key and drag-and-drop.
- 1.4.7 R: `lastUserInput` in hook input.
- 1.4.4 R: Auto mode on Windows 11 24H2 and later; `root_conversation_id` metadata on MCP calls.
- 1.4.0 R: OSC 7501 added (with a support probe); `alt+m` sends with the opposite queue setting.

## 9. Limits of this report

- No CLI was run. Every behaviour claim comes from a page, a changelog line or Harbor's own notes, except the
  directory listings in section 1 item 3.
- Claude and agy changelogs were keyword-filtered, so a host-relevant entry with none of my keywords could be missing.
- The "R" marks mean "inside a reviewed range", per Harbor's review records. I did not diff Harbor's code against each entry.
- ACP v2 is Preview as of 2026-11-20; its method names may still change. T3 Code and Paseo internals were not read beyond
  their READMEs and one doc page.
