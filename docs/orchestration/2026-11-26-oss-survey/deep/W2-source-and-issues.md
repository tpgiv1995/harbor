# W2: competitors' source code and their users' top issues (2026-11-26)

Scope: brief `deep/briefs/w2-source-and-issues.md`. This goes one level below `REPORT.md`. Everything here was read through the
GitHub API on 2026-11-26 (read-only, authenticated through git's credential store, token never printed or written). I did not run
any competitor's code. Links point at `main` as read that day; the heads were Orca e1cf636, Parallel Code e132206, T3 Code b5592c6,
Paseo 17c08ed, Paradev 09ce262, Emdash c876989. Orca and T3 Code move many times a day, so line numbers can drift.

Rules used: "(issue text)" or "(code comment)" means the claim is what the author wrote, not something I tested. "Verified here" means
I checked it on this machine or in Harbor's code. Anything from a search snippet is marked; there are none in this file.

## 0. What changes in REPORT.md after this pass

1. Orca's star count is real: the API says 139,007 (`repos/stablyai/orca`). REPORT.md section 15 doubted it. Treat it as correct.
2. Superset is now `ParadevAI/Paradev` (16,707 stars, MIT). Old `superset-sh/superset` URLs redirect.
3. **Paradev's "keep only the most recent terminals live" does not apply to agents.** Their changelog says it "never offloads active
   terminals or running TUIs like vim or a coding agent", and the default is 12 terminals. REPORT.md section 11 and the short-list
   item 10 read as if agent windows could be parked this way. Under Paradev's rule they could not. Source: section 2.5 below.
4. **Parallel Code runs on macOS and Linux only** (README badge, and its hook scripts are `/bin/sh` plus `curl`). The hook contract
   is portable; the scripts are not. Its Arena has no automatic judge: you rate each result 1 to 5 stars and merge one (section 2.2).
5. **T3 Code drives Cursor through `@cursor/sdk` 1.5.0, not through the Cursor CLI or ACP** (`packages/provider-cursor/package.json:56`).
   Claude goes through `@anthropic-ai/claude-agent-sdk`, Codex through `codex app-server`, Antigravity through ACP. It does not host
   terminals for these; it is a chat app that talks to each one's programmatic interface.
6. **OSC 7501 query reply has two spellings.** Spec rev 0.4 (2026-10-10) says the terminal MUST reply `ESC ] 7501 ; ? ST` and MAY add
   `:states=...:kinds=...`; a bare `?` means all five states and all three kinds. Orca replies with the lists; Parallel Code (rev 0.3
   code) replies bare. Either is legal. Spec text: https://www.superlogical.com/rex/docs/build/program-status (opened 2026-11-26).
7. **Harbor already has two things REPORT.md recommends:** a Job Object per session (`app/src/daemon/win-job.js:3`, KILL_ON_JOB_CLOSE,
   held by both daemon and keeper, `daemon.js:50`), and a reader for agy's store including sub-agent rows
   (`app/src/main/providers/gemini-store.js:1-30`: `brain/<uuid>/.system_generated/logs/transcript_full.jsonl`,
   `conversation_summaries.db` with `agent_name 'self'`, `nesting_depth 1`, `parent_conversation_id`). The REPORT.md "not verified" item
   about agy's subagent record format is answered by Harbor's own 2026-11-23 measurement.
8. A hook that holds a Claude `PermissionRequest` open must answer before about two minutes (Orca code comment, section 2.1). Harbor's
   ask hook installs with a 12-hour timeout (`bin/harbor-ask-hook` header). Not tested here; worth one probe.

## 1. Ten-line answer

Highest-value things to copy, in order of how much primary source I found:
1. **Orca's session-search index** (SQLite FTS5, byte-offset incremental append, 20 s reconcile, identifier splitting). Section 2.1.A.
2. **T3 Code's auto-resume after a usage limit** (idempotent command id, reset time stored on the failed run, "Continue where you left off."). Section 2.3.A.
3. **Orca's price table and cost rules** (dedupe key `message.id:requestId`, max-merge of streaming rows, 1h cache-write rate, long-context tiers). Section 2.1.B.
4. **Parallel Code's hook reducer and recorded-session fixtures** (real Claude 2.1.328 and Codex 0.167.0 hook traces as test data). Section 2.2.
5. **Codex hook trust without touching the user's config** (`-c hooks.state={..trusted_hash..}`, hash from `codex app-server` `hooks/list`). Section 2.2.
6. **Orca's rule that hooks outrank OSC 7501 until 2 minutes of hook silence.** Section 2.1.D.
7. **T3 Code's per-turn git checkpoints** (temp `GIT_INDEX_FILE`, `write-tree`) for a per-turn "files changed" card without parsing edits. Section 2.3.B.
8. **Orca's rewind through `forkSession` from the Claude Agent SDK** (`upToMessageId`). Section 2.1.E.
9. **Windows lessons that apply now:** hooks must not wrap in `conhost` (Orca #14837), daemon must not die on one stuck PTY (Orca #10415), keep native crashers out of the main process (Orca #7742), reserved TCP port ranges (Paseo #1552). Section 4.
10. **What users ask for most across 11 repos** (section 3): more CLIs (10 repos), Windows (10), remote or phone (9), state detection and notifications (8), rendering and input corruption (8), slowness (8), lost sessions (8), worktree setup and hooks (8).

---

## 2. Part 1: source, project by project

### 2.1 Orca (stablyai/orca, MIT, 139,007 stars, pushed 2026-11-26)

Stack facts: Electron, `node-pty ^1.1.0`, `@xterm/headless 6.1.0-beta`, `@xterm/addon-serialize` (`package.json:237-245`). The tree has
35,406 files; the relevant code is under `src/main/`, `src/shared/`, `src/renderer/src/`.

#### A. Search inside sessions (the index)

Files: `src/main/ai-vault-search/` (82 non-test files): `storage/session-search-schema.ts`, `indexing/*`, `query/*`.
Doc page: `docs/site/content/docs/agents/session-history.mdx`. The search runs in a child process that owns the database
(`session-search-child-service.ts:1-31`).

Schema ([session-search-schema.ts:12-71](https://github.com/stablyai/orca/blob/main/src/main/ai-vault-search/storage/session-search-schema.ts#L12-L71)):
- `sessions(id, agent, session_id, file_path, codex_home, title, cwd, cwd_key, branch, created_at, updated_at, message_count, resume_command, content_hash, content_hash_count)`.
  `content_hash` is a chained digest of the first N messages so forks of one conversation collapse at query time.
- `files(path, dev, ino, byte_offset, mtime_ms, size_bytes, session_row_id, state, fail_count, failed_mtime_ms, prefix_hash)`.
  `state` is `current`, `due` or `failed`. `prefix_hash` is a SHA-256 of bytes `[0, byte_offset)`, so after a restart the indexer can prove
  the file still starts the same and append instead of rereading.
- `messages(id, session_row_id, role, ts, text_truncated)` plus `messages_fts` as an FTS5 table with four columns:
  `user_text, assistant_text, tool_text, identifiers`, `detail=full`.
- Tokenizer: `unicode61 tokenchars '_.-/+'` (line 15). Comment: keeps paths and C++ intact; `#` is left out so `#123` also matches `123`.
- `SESSION_SEARCH_SCHEMA_VERSION = 8`; a bump discards and rebuilds the whole cache (it is derived data). `PRAGMA automerge 8` on the FTS table (line 108).

Indexing:
- Read decision per file ([session-search-read-decision.ts:15-51](https://github.com/stablyai/orca/blob/main/src/main/ai-vault-search/indexing/session-search-read-decision.ts#L15-L51)):
  skip when the file is older than the retention cutoff; `any` for a new file; `whole` when the cursor identity (dev/ino) changed, the prefix
  hash does not match, or the offset is past the file size; otherwise skip when mtime and size match. A file that failed 3 times is held out
  until its mtime changes (`SESSION_SEARCH_FAILURES_BEFORE_HELD_OUT = 3`).
- Cadence ([session-search-indexer-options.ts:4-9](https://github.com/stablyai/orca/blob/main/src/main/ai-vault-search/indexing/session-search-indexer-options.ts#L4-L9)):
  reconcile every 20,000 ms, look at the 12 most recent files per agent, spend at most a quarter of the interval reading, full sweep every 15th cycle.
  Files untouched for 24 h reuse their stored stat until a sweep (`session-search-indexer.ts:20`).
- Text is stored verbatim; "outbound snippet policy belongs at the transport boundary" (schema comment, line 9).

Query:
- Planner ([session-search-query-planner.ts:1-105](https://github.com/stablyai/orca/blob/main/src/main/ai-vault-search/query/session-search-query-planner.ts)):
  tokens by `[\p{L}\p{N}\p{M}\p{Co}_./+-]+`; a query is "literal" when quoted or when it looks like a code identifier, path or issue number;
  prose drops stop words; at most 48 body terms and 64 terms; every term is quoted so punctuation is not parsed as FTS syntax; identifier
  pieces ("shadow terms") are added as OR terms; conversation scope restricts the match to `{user_text assistant_text}`.
  There is a typo-repair pass (`session-search-typo-repair.ts`) that replans with the original literal mode.
- Snippets: FTS5 `snippet()` with private-use marker characters U+E000/U+E001, 12 tokens, 512 characters
  ([session-search-snippet.ts:15-21](https://github.com/stablyai/orca/blob/main/src/main/ai-vault-search/query/session-search-snippet.ts#L15-L21)).
  It asks for the marked and plain rendering and compares them so message content cannot fake a highlight.
- Ranking ([session-search-hit-ranking.ts:5,51-64](https://github.com/stablyai/orca/blob/main/src/main/ai-vault-search/query/session-search-hit-ranking.ts#L5)):
  FTS5 rank score (not checked whether it is the default bm25) minus `0.02 * ln(1 + message_count)`, ties by newest `updated_at`, then row id for stable cursors; forks folded by `content_hash`.

Harbor check: `app/src/main/providers/history.js:191` still filters on project, title and first prompt only (read again this session).
FTS5 is present in Node 24.19's `node:sqlite` (SQLite 3.53.3), tested here with an in-memory table using Orca's tokenizer string. I did
not test Electron 37's embedded `node:sqlite`; `gemini-store.js:27` says it exists there. One catch from my test: with Orca's tokenizer,
searching `"index.js"` does not find `src/main/index.js`, because the whole path is one token. Orca fixes that with the `identifiers` column
and shadow terms; copying the tokenizer without them would lose path-fragment search.

#### B. Cost, usage and the price table

Files: `src/main/claude-usage/` (22 files), `src/main/codex-usage/` (16 files).
- Parser ([transcript-record-parser.ts:104-170](https://github.com/stablyai/orca/blob/main/src/main/claude-usage/transcript-record-parser.ts#L104-L170)):
  skips any line that does not contain the text `assistant` before parsing JSON (cheap pre-filter on huge transcripts); keeps only
  `type: 'assistant'`; reads `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` and the 1-hour split
  `cache_creation.ephemeral_1h_input_tokens`; drops rows whose four counts sum to 0.
- Dedupe key: `message.id + ':' + requestId`, else `msg:<id>`, else `uuid:<uuid>`. Comment: forks rewrite `sessionId`, so message ids keep
  ownership across files. When the same key repeats (streaming writes several rows), the parser takes the field-wise **maximum**, not the sum
  (`dedupeClaudeUsageTurns`, lines 69-97). This is what stops 15 junctioned Claude homes from counting one transcript 15 times.
- Prices ([claude-model-pricing.ts:23-124](https://github.com/stablyai/orca/blob/main/src/main/claude-usage/claude-model-pricing.ts#L23-L124)):
  USD per million tokens, per model family key `claude-<family>-<major>[-<minor>]`, with five rates (input, output, cache read, 5-minute
  cache write, 1-hour cache write). Examples as written there: opus-5-5 4/20/0.2/5/8; sonnet-5-5 2/10/0.1/2.5/4; haiku-5-5 0.1/0.5/0.01/0.125/0.2
  with a long-context tier above 100,000 prompt tokens; fable-5-2 8/40/0.2/10/16. I did not check these against Anthropic's price page;
  they are Orca's numbers. Unknown models stay unpriced (comment line 55), shown as "unpriced" (`stats/unpriced-cost-label.ts`).
- Cost function ([lines 195-209](https://github.com/stablyai/orca/blob/main/src/main/claude-usage/claude-model-pricing.ts#L195-L209)):
  long-context applies to the whole request when `input + cacheRead + cacheWrite` exceeds the threshold; model ids are normalised by a regex
  that accepts both `opus-4-8` and legacy `3-5-sonnet-20241022` forms and ignores date stamps and `-1m` suffixes (lines 132-158).
- Codex: `codex-usage-token-delta.ts` turns cumulative `total_token_usage` snapshots into deltas, guards against stale regressions
  (`looksLikeStaleRegression`), and treats reasoning tokens as already inside output. `codex-model-pricing.ts` has `LONG_CONTEXT_THRESHOLD_TOKENS = 272_000`
  and per-model input, cached-input and output rates (gpt-5.5 5/0.5/30 with a long tier; gpt-5.6-sol 4/0.4/20, "promotional ... through at least 2026-11-21").
- Cursor has no token counts in transcripts (REPORT.md section 6), so there is nothing to copy there.

Harbor check: `main/providers/transcript.js:1259,1873-1884` already reads the `cache_creation` TTL breakdown, but a grep of `app/src` for
`MODEL_PRICING|priceTable|costUsd|estimateCost` finds nothing, so no dollar figure exists today.

#### C. Automations (scheduler, precheck, missed runs)

Files: `src/main/automations/` (about 70 files). Doc: `docs/site/content/docs/cli/automations.mdx`.
- Tick: a 60 s `setInterval` (`runtime-automation-service.ts:51,130`). Each tick calls `runDueAutomations`
  ([automation-due-runs.ts:9-41](https://github.com/stablyai/orca/blob/main/src/main/automations/automation-due-runs.ts#L9-L41)): for each enabled automation whose
  `nextRunAt <= now`, run one occurrence; a malformed one is recorded and never stops the rest.
- Occurrence ([automation-trigger-runs.ts:44-75](https://github.com/stablyai/orca/blob/main/src/main/automations/automation-trigger-runs.ts#L44-L75)):
  `getLatestAutomationOccurrence(automation, now)` finds the most recent scheduled time; if it is later than grace, record a "missed" run and
  advance; otherwise create a run row, then launch detached and advance `nextRunAt` after the row exists. Only the latest missed occurrence is considered, so a laptop closed for a week produces one missed row, not 168.
- Missed-run rule ([dispatch-refusal.ts:145-157](https://github.com/stablyai/orca/blob/main/src/main/automations/dispatch/dispatch-refusal.ts#L145-L157)):
  late if `now - wakeGateDelay - scheduledFor > missedRunGraceMinutes * 60 s + 2 min`. Grace is per automation (CLI `--missed-run-grace-minutes`).
- Wake gate ([dispatch/automation-wake-settle.ts](https://github.com/stablyai/orca/blob/main/src/main/automations/dispatch/automation-wake-settle.ts)):
  scheduled runs do not start until the machine has been awake a settle period after a wake, so a dark wake does not start an agent that is then frozen.
  The held time is credited against grace (capped at settle time plus one tick). It uses a heartbeat clock that idles out when nothing is enabled.
- Precheck ([dispatch/precheck-runner.ts](https://github.com/stablyai/orca/blob/main/src/main/automations/dispatch/precheck-runner.ts)):
  a shell command run before a scheduled run only. Exit 0 continues; any other exit, error or timeout skips the run and writes a skip row
  (docs lines 41-48). Default timeout 60 s. Output kept as a tail buffer (`MAX_AUTOMATION_PRECHECK_OUTPUT_CHARS`). On Windows a timeout kills the tree with `taskkill /pid N /t /f` through the system32 binary, and only if the child has not already exited, because the pid may be reused.
  "Run now" bypasses the precheck by design.
- Schedule syntax: presets (hourly, daily, weekdays, weekly), cron, or an RRULE subset: `FREQ=HOURLY|DAILY|WEEKLY`, `BYDAY` (weekly only), `BYHOUR`, `BYMINUTE`; `INTERVAL` and `COUNT` are refused (docs line 23).
- Repeated refusals fold into one skip row (`repeatSkip`) so they do not push real history out of retention.

#### D. How Orca reads OSC 7501 and hooks (the part Harbor needs most)

- Scanner ([shared/program-status/osc-scanner.ts:59-150](https://github.com/stablyai/orca/blob/main/src/shared/program-status/osc-scanner.ts#L59-L150)):
  a stateful scanner over the PTY stream that does not strip anything. It carries a partial prefix between chunks, finds `ESC ] 7501 ;`
  frames ended by BEL, `ESC \` or an unconsumed ESC, aborts on CAN or SUB, caps a body at 4,087 bytes, and also watches `ESC ] 133 ; A` (prompt start) and `ESC c` (full reset), because the spec ties record lifetime to those.
- Grammar ([protocol.ts:6-190](https://github.com/stablyai/orca/blob/main/src/shared/program-status/protocol.ts)): key `[a-z]+`, values `[A-Za-z0-9_.,+/=-]*`;
  `msg` base64, at most 2,732 encoded and 2,048 decoded bytes, decoded text with C0/DEL/C1 control characters discards the whole report; `title` 256 / 192;
  `id` up to 8 segments of 32 characters; `progress` 0 to 100 only on `working` and `blocked`; `kind` only on `blocked`; malformed pairs are skipped but a broken cap voids the report.
- Lifetime: `done` and `error` outlive the program; `working` and `blocked` are dropped on prompt start or exit; a `blocked` of kind `permission` or `question` belongs to the turn, `auth` outlives it (`isTurnScopedProgramStatusKind`).
- Who answers the `?` query: a headless xterm per PTY in Orca's terminal daemon, with an OSC 7501 handler that writes the reply into the PTY
  ([daemon/emulation/terminal-view-attribute-responder.ts:103](https://github.com/stablyai/orca/blob/main/src/main/daemon/emulation/terminal-view-attribute-responder.ts#L103)
  and `shared/program-status/query-responder.ts`). The comment on the shared responder says the owning parser "must answer before the DA1 sentinel", because a program that sends `CSI c` right after the query treats a DA1 reply that arrives first as "unsupported" (spec section on waiting). Orca gates replies on the runtime capability `terminal.program-status.v1` because "probing programs change rendering (Claude drops title glyphs)" (`protocol.ts:8`).
  Related hazard from another project: agent-deck #2356 reports DA1/DA2 replies leaking into the session prompt on a session switch in Windows Terminal.
- Projection to agent state ([agent-status-projector.ts:28-78](https://github.com/stablyai/orca/blob/main/src/shared/program-status/agent-status-projector.ts#L28-L78)):
  `app` names map to agent ids (`claude-code` to `claude`), `blocked` of kind permission or question becomes `waiting`, other `blocked` stays `blocked`,
  `done` and `error` of a child are not live child rows. A parent turn stays "held open" while a child is working or waiting.
- **Hooks outrank OSC 7501** ([hook-precedence.ts:7](https://github.com/stablyai/orca/blob/main/src/main/agent-hooks/server/program-status/hook-precedence.ts#L7)):
  `HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS = 2 minutes`. While a hook-sourced row exists, a differing OSC report yields; after 2 minutes of hook silence it may overrule.
  Special cases: OpenCode's OSC idle covers every session in a folder, so only it can overrule a silent hook; agy's `done` can beat its sub-agent's Stop hook (PTY versus HTTP; captured runs woke the parent about 100 ms after the sub-agent's Stop), so a refused done is retried once after 2,000 ms (`ANTIGRAVITY_PARENT_WAKE_GRACE_MS`); a replayed `done` keeps its own time.
  This matches the two emitter bugs REPORT.md section 1 lists (agy `done` while subagents run, Codex false completion).
- Hook installation: Orca writes managed entries into each CLI's global config with an install lock and "managed entry" detection
  (`src/main/agent-hooks/installation/`, 40 files). Windows hook commands went through four shapes over time
  (`commands/windows-*.ts`): see section 4, W1. The held-permission design:
  [claude-permission-hook-hold.ts:7-8](https://github.com/stablyai/orca/blob/main/src/main/agent-hooks/server/claude-permission-hook-hold.ts#L7-L8)
  holds a `PermissionRequest` hook open for 122,000 ms, "past Claude's 2:00 auto-block, inside the script's 126 s curl and the entry's 130 s timeout" (code comment). The reply is
  `{hookSpecificOutput:{hookEventName:'PermissionRequest',decision:{behavior:'allow'|'deny',message}}}`, "never updatedPermissions: an answer covers this one request only".
- Two guards worth knowing: `claude-background-job-guard.ts` (Claude daemon workers and the agents they start, such as `codex exec`, inherit the pane's `ORCA_*` environment and would report as that pane; Orca #9236, #24516 per the file comment) and `cursor-replay-guard.ts` ("Cursor imports Claude hooks; only its native hook may report its events").

#### E. Rewind

Files: `src/main/claude/transcripts/claude-rewind-transcript.ts`, `claude-conversation-fork-worker-entry.ts`, `claude-conversation-fork-boundary.ts`.
Mechanism: read the source JSONL (skipping crash-torn lines), pick a boundary entry id, call `forkSession(sourceSessionId, { upToMessageId, title, sessionStore })`
from `@anthropic-ai/claude-agent-sdk` with an in-memory store, publish the resulting entries as a new session file, resume that session
([fork-worker-entry.ts:31-60](https://github.com/stablyai/orca/blob/main/src/main/claude/transcripts/claude-conversation-fork-worker-entry.ts#L31-L60)).
It runs in a worker thread with an out-of-memory message and a "retry heavy workers" reset. The UI is a per-message "Rewind" action with a confirmation dialog
(`components/native-chat/messages/actions/NativeChatRewindAction.tsx`). This is for Orca's own structured chat mode, not for a terminal pane.
Harbor has no `claude-agent-sdk` dependency (grep of `app/package.json` and `app/src`); I did not read the SDK's `forkSession` source, so what it rewrites in each record is not checked.

#### F. Needs-you

The "Needs you" count in `components/bots/bot-needs-you-published.ts` belongs to Orca's "bots" feature, not to plain agent panes. Agent attention
is `src/renderer/src/attention/` (about 20 files: acknowledgement, auto-ack when the surface is on screen, per-workspace mute, window-foreground tracking).
Nothing there is Harbor-specific enough to copy beyond the idea of acknowledging an attention item when its surface is visible.

### 2.2 Parallel Code (johannesjo/parallel-code, MIT, 1,106 stars, v5.1.0 on 2026-10-29)

macOS and Linux only. Files under `electron/agent-hooks/`.
- **Per-launch injection without touching user config.**
  - Claude: a `--settings` JSON built by `buildClaudeHookSettings`
    ([claude-settings.ts:63-77](https://github.com/johannesjo/parallel-code/blob/main/electron/agent-hooks/claude-settings.ts#L63-L77)).
    The file's comment says hooks from `--settings` merge with the user's hooks (code comment, not tested here), but a `statusLine` there replaces the user's, so it wraps the user's command (`buildStatusLineSetting`).
    Events: SessionStart, UserPromptSubmit, Stop, StopFailure, SubagentStart, SubagentStop, and `matcher '*'` for PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest; Notification matched on `permission_prompt|idle_prompt|agent_needs_input|elicitation_dialog|elicitation_url_dialog`. Timeout 10 s.
  - Codex: `-c hooks.<Event>=[...]` flags per launch for UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, Stop, Interrupt (3 s timeout for Interrupt)
    ([codex-hooks.ts:42-62](https://github.com/johannesjo/parallel-code/blob/main/electron/agent-hooks/codex-hooks.ts#L42-L62)).
    If the user's own args already set `hooks`, it leaves the launch alone.
  - **Trust without a dialog.** It asks Codex which hooks the flags register by spawning `codex app-server` and sending JSON-RPC `initialize`, `initialized`, `hooks/list` ([codex-trust.ts:48-102](https://github.com/johannesjo/parallel-code/blob/main/electron/agent-hooks/codex-trust.ts)).
    Each listed hook with `source: 'sessionFlags'` carries `key` and `currentHash`; the launch then passes `-c hooks.state={"<key>"={trusted_hash="<hash>"}}`. Comment: it must be one inline table, because Codex splits a dotted `-c` path at the dots inside a quoted key and ignores the entry. This answers REPORT.md section 1's note that a non-managed Codex hook must be trusted once. Probe timeout 5 s, retry after a failure 60 s.
- **Hook script** ([hook-script.ts:44-69](https://github.com/johannesjo/parallel-code/blob/main/electron/agent-hooks/hook-script.ts#L44-L69)): prints `{}` first (so a PermissionRequest with empty stdout never reads as a failure), reads stdin fully before any early exit (avoids EPIPE in the agent), re-sources an endpoint file on every run (the loopback port changes per app launch, so an old agent would post to a dead port), exits silently if `CLAUDE_JOB_DIR` is set (background job workers inherit the env), posts with `--connect-timeout 0.5 --max-time 1.5` and always exits 0.
- **Reducer** ([status.ts:309-402](https://github.com/johannesjo/parallel-code/blob/main/electron/agent-hooks/status.ts#L309-L402)):
  wire states are only `working`, `waiting`, `done`; "idle" is never reported by a hook. Mapping ([lines 264-290](https://github.com/johannesjo/parallel-code/blob/main/electron/agent-hooks/status.ts#L264-L290)):
  SessionStart is `done` unless `source === 'compact'`; UserPromptSubmit `working`; PreToolUse `working` unless the tool is AskUserQuestion (waiting, prompt `question`) or ExitPlanMode (waiting, prompt `permission`, "Plan ready for approval"); PostToolUse with `is_interrupt === true` and no `agent_id` is `done` ("Interrupted"), because Esc ends a turn with no Stop; PermissionRequest is `waiting`; Stop and StopFailure `done` with `last_assistant_message` (max 2,000 chars) and background shells still running.
  Guards: tool activity from another agent or a sibling's result never dismisses an open prompt (`isUnrelatedToolActivity`); a generic permission Notification never turns an open question into an approval (`keepsQuestion`); an idle-reminder Notification after a StopFailure keeps the failure; only `working` goes stale (30 min, `AGENT_HOOK_STALE_MS`).
- **Turn watch** ([codex-turn-watch.ts](https://github.com/johannesjo/parallel-code/blob/main/electron/agent-hooks/codex-turn-watch.ts)):
  Codex runs no hook when a turn fails (model error, usage limit). While Codex is `working`, every 2 s it reads the rendered screen; the empty prompt box without the "Working" row on two checks in a row emits a synthetic `StopFailure` "Stopped without a reply".
- **Recorded sessions** (`electron/agent-hooks/sessions/*.json`, README there): each file is one real session: output, typed input, raw hook payloads and pauses, with `{expect: 'active'|'needs_input'|'idle'}` steps. Present: `claude-2.1.312-workflow-run`, `claude-2.1.326-handed-back-subagent`, `claude-2.1.328-approve-then-interrupt`, `claude-2.1.328-question-answered`, `codex-0.167.0-*` (tool turn, patch approved, declined then completed, question answered, approved then interrupted) and `codex-0.167.2-approve-then-interrupt`. Recorded with `PARALLEL_CODE_RECORD_SESSIONS`; the README says to record again when a CLI updates. These are usable as fixtures for Harbor's own reducer, after a licence-aware copy (MIT).
- **OSC 7501** ([program-status.ts](https://github.com/johannesjo/parallel-code/blob/main/electron/agent-hooks/program-status.ts)): rev 0.3 parser; only launches without lifecycle hooks have their reports turned into hook-status updates, so hooks win here too.
- **Arena** (`src/arena/`): `ArenaCompetitor = {id, name, command}` where `command` is a shell template with `{prompt}`; each competitor gets its own worktree and branch; results record time, exit code, captured terminal output, a 1 to 5 star rating and a merge flag; merge offers commit-then-merge when a worktree is dirty (`merge.ts`). 2 to 4 competitors per README. No judge model.
- **Review comments flow**: an annotation is `{id, filePath, startLine, endLine, selectedText, comment}` (`components/review-types.ts`). On submit they become one prompt:
  `Code review feedback for your changes:` then, per annotation, `## <file> (lines a-b)`, a fenced block of the selected text, and the comment ([DiffViewerDialog.tsx:85-96](https://github.com/johannesjo/parallel-code/blob/main/src/components/DiffViewerDialog.tsx#L85-L96)), sent with `sendPrompt`. Staleness rule (`lib/review-eviction.ts:20-32`): an annotation is dropped when a later diff touches its line range or deletes the file. A second path builds a "rework prompt" from reviewer findings and stages it in the input for the person to send, never auto-sent (`store/review.ts:50-58`).

### 2.3 T3 Code (pingdotgg/t3code, MIT, 79,986 stars)

#### A. Provider adapters and usage-limit hold

- Claude: `@anthropic-ai/claude-agent-sdk ^0.3.321` (`apps/server/package.json:38`), adapter `orchestration-v2/Adapters/ClaudeAdapterV2.ts`.
- Codex: its own `effect-codex-app-server` package (JSON-RPC to `codex app-server`), adapter `CodexAdapterV2.ts`; thread revert in `provider/CodexThreadRevert.ts`.
- Cursor: `@cursor/sdk 1.5.0` (`packages/provider-cursor/package.json:56`), with its own worker process (`CursorAgentSdkWorker.ts`).
- Antigravity: ACP over the managed `agy` runtime (`provider/acp/AntigravityAcpSupport.ts`, `effect-acp`, `@t3tools/provider-acp`), in a T3-owned profile directory. Its turn-outcome code reads the agent's own per-conversation SQLite at `<profile>/antigravity-acp/conversations/<uuid>.db` (`AntigravitySessionFiles.ts:57-79`) and decodes protobuf step blobs (step type 17 is an error step, 15 a planner response, 143 `invoke_subagent`; `AntigravityChildWork.ts:19-27`, `AntigravityTurnOutcome.ts:16-19`). Harbor reads agy's JSONL transcript instead, which is simpler.
  This machine's store matches the layout names: `~/.gemini/antigravity-cli/conversations/<uuid>.db`, `brain/<uuid>/`, `annotations/<uuid>.pbtxt` (directory listing only, verified here).
- Also adapters for OpenCode, Pi, Grok, Kiro, Muse, Fx (packages `provider-*`). It runs no terminals for these; it hosts a chat.
- **Usage-limit recovery** ([UsageLimitRecoveryWorker.ts:16-156](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.ts#L16-L156)):
  - Candidate: thread failed, `lastErrorClass === 'usage_limit'`, has a latest run, has `usageLimitResetAt`, not archived, not marked settled, no pending approval or question (lines 24-33). A reset time at or before the run's completion is ignored, so an already-expired window cannot start a loop (lines 36-40).
  - Two steps: first "arm" (store `{runId, resetAt, autoResume, snooze}` on the thread; only if the reset is less than 24 h in the past, `MAX_OVERDUE_ARM_MS`), then at reset time dispatch a message with the fixed text `Continue where you left off.` as `createdBy: 'agent'`.
  - Idempotence: command id `limit-resume:<thread>:<run>:<resetMs>:<requestId>` so a repeated sweep cannot send twice.
  - Scheduling without polling: an event stream marks a "due hint" dirty only on thread, run, runtime-request or provider-session events; the sweep sleeps until `getLimitRecoveryWakeAt` (lines 91-148). Two user settings: `autoResumeLimitedThreads`, `snoozeLimitedThreads`.
  - I did not read how `usageLimitResetAt` is derived per provider (`provider/claudeUsageLimits.ts`, `codexUsageLimits.ts`); not checked.
  Harbor has every account's reset time already (REPORT.md section 6); this gives the state machine and the idempotence rule.

#### B. Diff and review

- Web UI uses `@pierre/diffs` and `@pierre/trees` (`apps/web/package.json:35-36`), with `AnnotatableCodeView.tsx`, `DiffCommentAnnotation.tsx`, `DiffFileTree.tsx`, "hide test files" (`useHideTestFiles.ts`), whitespace toggle, and a checkpoint diff query (`useCheckpointDiff`).
- **Per-turn checkpoints in git** (`apps/server/src/checkpointing/CheckpointStore.ts:10-113`, capture in `vcs/GitVcsDriver.ts` lines about 1274-1944):
  a checkpoint is a commit stored under `refs/t3` (named in issue #26227), built from a temporary index file in the git common dir (`t3-checkpoint-index-<id>`, line 1309) with `add -A` then `write-tree`; a turn that switched branches records a second parent; nested checkouts and submodules are excluded and captured separately; sparse checkout is handled. Diffs are between two refs; restore resets the worktree to a ref.
  Known weakness: in a workspace with 170,000 new files, `git add -A` hit a 30 s timeout on 57 of 59 attempts and leaked `tmp_objdir-bulk-fsync-*` directories (T3 #26227, open, issue text). A second reporter hit it in a folder holding about 130 repos.
- **Diff of the working tree including untracked files without touching the user's index** (`GitVcsDriverCore.ts:4958-5013`): copy the index to a temp `GIT_INDEX_FILE`, run `add --intent-to-add --pathspec-from-file=- --pathspec-file-nul` with `core.splitIndex=false`, `core.sparseCheckout=false`, `--literal-pathspecs`; untracked files are admitted smallest first up to 256 MB total (`REVIEW_UNTRACKED_MAX_BYTES`, line 98). On Windows the empty tree hash uses `NUL` (line 5021).

### 2.4 Paseo (getpaseo/paseo, Apache-2.0 since 2026-08, 25,557 stars, v0.17.4)

(Licence: `LICENSE` now says Apache-2.0; issue #2982 about relicensing from AGPL closed 2026-08-27 after contributors agreed.)
- **Architecture** (`docs/architecture.md`): one daemon, WebSocket clients (mobile, CLI, Electron desktop), optional relay. Agents run through the Claude Agent SDK, Codex app server, ACP (Copilot), OpenCode and Pi. State is file-backed JSON under `$PASEO_HOME/agents/`.
- **Terminals live in a detached worker** that survives daemon restarts and upgrades (`docs/terminal-worker.md`). Points that bear on Harbor's keeper design:
  - The launcher starts the worker `detached`, waits for `ready` on fd 3, prints the pid and exits, so the worker is re-parented and not in the daemon's process tree. Reason: the supervisor's forced kill uses `tree-kill`, which walks parent pids (line 12).
  - Frozen envelope that never changes across versions: 4-byte length plus `v8.serialize` frames, `hello`/`helloAck`, `listTerminals` fields, `shutdown`. A new daemon adopts a worker one protocol version old to drain, shuts down workers two or more versions old, and never runs more than two workers (lines 36-51). Harbor's `docs/claude/sessiond.md` may already cover this; I did not compare.
  - Records at `$PASEO_HOME/terminal-worker/<pid>.json` (owner-only) with a random secret; first frame must be `hello` with the secret; a record retired when its pid is gone or its socket refuses; a "closing" record is never adopted.
  - **Windows notes in that doc:** a read of a record that fails with `EPERM`, `EBUSY` or `EACCES` is retried for 250 ms because the worker renames its new copy over it (line 34); terminal lifecycle operations "never launch PowerShell" (line 30); on Windows every desktop update stops terminals, because a surviving worker running as `Paseo.exe` would lock the folder NSIS replaces (line 80); worker runs from a copied bundle so an update does not pull files from under it (lines 65-72).
  - **ConPTY note (line 57):** "ConPTY renders a console rather than forwarding every program escape sequence unchanged. A program write callback does not establish that its hidden cursor move or input modes reached the worker." Their tests compare replay plus committed output at the capture cut. 10,000 history rows plus the screen are kept in a headless xterm, serialised with `@xterm/addon-serialize` in chunks of at most 64 KiB; live traffic that fills the worker socket beyond 4 MiB disconnects the stalled controller, and reconnect requests a fresh replay.
  - **Size ownership** (`terminal/terminal-size-ownership.ts:1-38`): a client `claim`s the size; later `update` requests from any other client are ignored. Harbor already has exclusive control on focus (`session-daemon/streams.js`); the explicit claim-versus-update split is what Paseo adds for several viewers (desktop plus phone).
- **Relay** (`packages/relay`, docs `relay-endpoint-security.md`): Noise `NK` handshake with per-record counters, legacy NaCl `box` fallback, QR pairing carrying the daemon public key, relay sees only ciphertext, relay disabled until pairing consent, 8 MiB outbound high-water mark on every send path (architecture lines 184-196, 281). The production relay is a separate Elixir service; the Cloudflare one in the repo is legacy. Harbor's phone path is Tailscale, so this is reference only.
- **Per-turn stats** (`server/agent/providers/turn-metrics.ts:19-70`): per model request `{model, tokens{input,output,cacheRead,cacheWrite}, costUsd, durationMs, ttftMs, endedAt}`; tool time with overlapping runs counted once; **a sum is shown only if every step has the value, otherwise null, "so a partial total is never shown"** (`sumAll`). Claude's numbers come from the SDK result (`providers/claude/metrics.ts`); not read further.
- **PR watch**: CHANGELOG line 127 ("Watch PRs and MRs: ask an agent to watch a pull or merge request for new checks, reviews, and comments", PRs #10148, #10279, #10280); fix at line 27 for watchers staying "Running" after a turn ends (#10740). I did not read the implementation.

### 2.5 Paradev, formerly Superset (ParadevAI/Paradev, MIT, 16,707 stars)

Native Windows is not available (README line 34: "Windows: not yet available"; feature requests #499, #3207, #5209, tracker #5603; a community port "SuperWin" #5011). So its code is a Unix reference.
- **PTY daemon** (`packages/pty-daemon/`): `Pty/`, `Server/`, `SessionStore/`, `TerminalModes/`, `protocol/{framing,handoff,messages,version}.ts`. Upgrade handoff hands PTY master fds to a successor process through its stdio array and writes a snapshot of daemon-side bookkeeping (framed file: header, then per session a frame plus the ring-buffer bytes), `SNAPSHOT_VERSION = 1`, transient (`SessionStore/snapshot.ts:1-69`). Unix-only mechanism; no use for ConPTY.
- **Two sockets** (blog https://paradev.com/blog/terminal-daemon-deep-dive, read in full): protocol v1 used one socket; under heavy output (`cat bigfile.log`) a new terminal timed out waiting for `createOrAttach` because its reply queued behind the stream. Protocol v2 gives output its own socket "so the stream socket can back up independently while RPC stays responsive". It broke old daemons, so they recommend version negotiation from the start. Harbor's keeper already splits stream and control (`docs/claude/sessiond.md` per CLAUDE.md); worth confirming a flooded stream cannot delay `createOrAttach`.
- **Cold restore**: a clean end writes `endedAt` to session metadata; on next launch, a session with none means an unclean shutdown, and the app offers to show the old output and start a new shell in the same directory. Disk history is kept per session. A "sticky cache" was needed because React StrictMode mounts twice and the restore flag was already cleared.
- **Headless xterm per session** gives screen snapshots (cursor included) on attach, mode tracking (application mode, bracketed paste, mouse), and cwd from OSC.
- **Spawn storms**: a priority semaphore; active terminal first, background tabs hydrate gradually (10 panes used to spawn at once).
- **Memory policy** ([changelog 2026-07-19](https://paradev.com/changelog/2026-07-19-performance-memory-and-load)): default 12 most recent terminals kept in memory, older ones saved to disk and rebuilt on switch, "the process behind each one keeps running". **Never offloaded: active terminals and running TUIs, a coding agent included.** Measured with 16 background terminals of about 5,000 lines: held in memory 16 to 4, scrollback lines 80,016 to 20,004, renderer heap 581 to 286 MB (-51%), renderer RSS 1,127 to 838 MB (-26%).
- **Port scan** (`packages/port-scanner/src/scanner.ts`): one shared scan per cycle instead of one per terminal (`ps` spawns per cycle 15 to 1), idle terminals every 30 s instead of every 2.5 s, back to fast on output. Per-OS method: `lsof` on macOS and Linux, `netstat -ano` on Windows then process names in parallel with `wmic`, falling back to PowerShell (`scanner.ts:117-330`). Relevant only if Harbor wants "which port is this lane serving".

### 2.6 Emdash (generalaction/emdash, Apache-2.0, 6,310 stars, v1.2.13 on 2026-11-19)

- **Lifecycle hooks written into agent config.** Claude: four hooks (SessionStart, UserPromptSubmit, Notification, Stop) merged into `<CLAUDE_CONFIG_DIR or ~/.claude>/settings.json`
  ([plugins/src/agents/impl/claude/hooks.ts:50-61](https://github.com/generalaction/emdash/blob/main/packages/plugins/src/agents/impl/claude/hooks.ts#L50-L61)).
  Managed entries are recognised by the marker string `EMDASH_HOOK_PORT`, also inside base64 PowerShell `-EncodedCommand` payloads, and stripped before re-adding so user hooks survive (`helpers/hooks.ts:9-32`). A hook version marker `EMDASH_HOOK_CONFIG_VERSION=1` is in the command. POSIX hooks `curl` the loopback server with a per-launch nonce kept off argv; Windows hooks use PowerShell `Invoke-WebRequest` (`hooks.ts:42-90`).
  Claude's Notification payload has no type field in their reading, so they classify by message text (`/permission|approval/i`); the Claude `session_id` "changes when the user switches sessions inside the TUI (`/resume`)", so status events carry it so the runtime resumes the right one (`hooks.ts:13-33`). They also pre-trust a workspace by writing `projects[path].hasTrustDialogAccepted` and `hasCompletedProjectOnboarding` into `.claude.json` (`claude/trust.ts:7-30`).
  User pushback: #1944 asks for a setting to disable automatic hook injection into `.claude/settings.local.json`; #3011 a stray file named `NUL` created in worktrees on Windows by an unquoted `>NUL` under Git Bash.
- **LSP editor** (`packages/core/src/runtimes/lsp/README.md`): the language server runs on the host that holds the worktree; bundled `typescript-language-server` 6.0.1 and Pyright 1.1.414, others (bash, gopls, rust-analyzer, clangd, JSON, YAML, HTML/CSS) used if installed; servers start only when a file of that kind is opened, nothing downloads on open, startup is excluded from host readiness. Supports hover, definition, type definition, references, diagnostics; completion, formatting and workspace edits are not implemented. Harbor has no code editor, so this only matters if it adds one; Orca users ask for the same (#3035, #14872, #961).
- **PR flow**: `core/services/pull-requests/` (client, contract, checkout-drift, repository), a worker refreshes on a fixed interval and the browser store revalidates on `online` with policy `if-stale` (`stores/pull-request-refresh-controller.ts`); `derive-pr-checkout-drift.ts` detects a worktree that no longer matches its PR head. I read only the controller.

---

## 3. Part 2: what users of these tools ask for

### 3.1 Method and limits

- Eleven repos: Orca, Parallel Code, T3 Code, Paseo, Paradev, Emdash, claude-squad, ccmanager, agent-deck, Happy and Vibeyard (`elirantutia/vibeyard`, 1,395 stars; the other "vibeyard" repos are forks or empty).
- Per repo I ran two GitHub searches: `is:issue sort:comments` and `is:issue sort:reactions`, 30 each, open and closed. 660 rows, 11 files in
  `C:\dev\.orch\harbor\oss-deep\w2\c_*.tsv` and `r_*.tsv`. "Reacted" is GitHub's total reaction count, not only thumbs-up.
- I grouped them by reading titles (and bodies for the ones I cite). A repo counts as "raising" a theme when at least one issue in its two top-30 lists fits. Small repos (Vibeyard, Parallel Code, ccmanager) have few reactions, so they say little; claude-squad's tracker mostly records its own abandonment. Counts are repos out of 11. Many Orca and T3 Code bug reports are written by other coding agents on behalf of users, which inflates detail but not counts.

### 3.2 Themes, ranked by number of repos

| Theme | Repos | Evidence (issue links) |
|---|---|---|
| Support more CLIs, or more than one config per CLI | 10 | T3 [#402 Pi](https://github.com/pingdotgg/t3code/issues/402) (198 reactions), [#193 Copilot](https://github.com/pingdotgg/t3code/issues/193) (185), [#539 OpenCode](https://github.com/pingdotgg/t3code/issues/539) (130); Happy [#265](https://github.com/slopus/happy/issues/265) (55), [#394](https://github.com/slopus/happy/issues/394), [#344](https://github.com/slopus/happy/issues/344), [#1213 Pi](https://github.com/slopus/happy/issues/1213); Paseo [#1131 agy](https://github.com/getpaseo/paseo/issues/1131); Orca [#14323 DeepSeek](https://github.com/stablyai/orca/issues/14323), [#2284 custom presets](https://github.com/stablyai/orca/issues/2284); Parallel Code [#152](https://github.com/johannesjo/parallel-code/issues/152); ccmanager [#74 Cursor](https://github.com/kbwo/ccmanager/issues/74), [#38 Gemini](https://github.com/kbwo/ccmanager/issues/38), [#127 Droid](https://github.com/kbwo/ccmanager/issues/127); claude-squad [#125 amp](https://github.com/smtg-ai/claude-squad/issues/125); Emdash [#1678](https://github.com/generalaction/emdash/issues/1678); agent-deck [#2511](https://github.com/asheshgoplani/agent-deck/issues/2511); Vibeyard [#59](https://github.com/elirantutia/vibeyard/issues/59). Harbor covers four CLIs. |
| Windows or WSL support and Windows bugs | 10 | T3 [#192 WSL](https://github.com/pingdotgg/t3code/issues/192) (145 reactions); Paradev [#499](https://github.com/ParadevAI/Paradev/issues/499); claude-squad [#275](https://github.com/smtg-ai/claude-squad/issues/275); Vibeyard [#38](https://github.com/elirantutia/vibeyard/issues/38); agent-deck [#277](https://github.com/asheshgoplani/agent-deck/issues/277); Parallel Code [#9](https://github.com/johannesjo/parallel-code/issues/9); Emdash [#200](https://github.com/generalaction/emdash/issues/200); ccmanager [#164](https://github.com/kbwo/ccmanager/issues/164); Orca and Paseo have many Windows bugs (section 4). |
| Remote host, SSH, phone, relay, self-hosting | 9 | Orca [#6364](https://github.com/stablyai/orca/issues/6364) (75 comments: pasting images into an agent on a remote host), [#11714](https://github.com/stablyai/orca/issues/11714) (mobile pairing via relay); T3 [#16810](https://github.com/pingdotgg/t3code/issues/16810) (504 from relay); Paradev [#1513](https://github.com/ParadevAI/Paradev/issues/1513); Happy [#101 local-network-only](https://github.com/slopus/happy/issues/101), [#246 self-hosting broken](https://github.com/slopus/happy/issues/246), [#1866 hosted server 404](https://github.com/slopus/happy/issues/1866), [#319](https://github.com/slopus/happy/issues/319); Paseo [#5530 Android stalls](https://github.com/getpaseo/paseo/issues/5530), [#2220 timeline exceeds relay message cap on image-heavy sessions](https://github.com/getpaseo/paseo/issues/2220); Emdash [#835](https://github.com/generalaction/emdash/issues/835); agent-deck [#99](https://github.com/asheshgoplani/agent-deck/issues/99); Parallel Code [#13](https://github.com/johannesjo/parallel-code/issues/13), [#11](https://github.com/johannesjo/parallel-code/issues/11). Harbor's Tailscale path avoids the hosted-server and relay failures, which dominate Happy's and T3's lists. |
| Wrong state: idle shown while busy, "running" forever, missed notifications | 8 | ccmanager [#227](https://github.com/kbwo/ccmanager/issues/227), [#73](https://github.com/kbwo/ccmanager/issues/73); agent-deck [#2519](https://github.com/asheshgoplani/agent-deck/issues/2519) (logo matched the spinner), [#3012](https://github.com/asheshgoplani/agent-deck/issues/3012); Orca [#22371](https://github.com/stablyai/orca/issues/22371) (sub-agent menu read as a question); Paseo [#4538](https://github.com/getpaseo/paseo/issues/4538), [#6346 notifyOnFinish is one-shot](https://github.com/getpaseo/paseo/issues/6346); T3 [#36105](https://github.com/pingdotgg/t3code/issues/36105) (agy background commands mark the turn done early), [#780 notifications](https://github.com/pingdotgg/t3code/issues/780) (64 reactions); Parallel Code [#259](https://github.com/johannesjo/parallel-code/issues/259), [#122](https://github.com/johannesjo/parallel-code/issues/122); Paradev [#1461](https://github.com/ParadevAI/Paradev/issues/1461); Emdash [#531](https://github.com/generalaction/emdash/issues/531). The screen-scraping trackers (ccmanager, agent-deck) fail on exactly the cases hooks and OSC 7501 cover. |
| Garbled text, IME and non-Latin input, key sequences | 8 | Orca [#15192](https://github.com/stablyai/orca/issues/15192) and [#11878](https://github.com/stablyai/orca/issues/11878) (Korean), [#20171](https://github.com/stablyai/orca/issues/20171); Paradev [#4601](https://github.com/ParadevAI/Paradev/issues/4601), [#4639](https://github.com/ParadevAI/Paradev/issues/4639) (CJK), [#3794](https://github.com/ParadevAI/Paradev/issues/3794) (WebGL atlas corruption); Emdash [#2401](https://github.com/generalaction/emdash/issues/2401), [#2538](https://github.com/generalaction/emdash/issues/2538); Vibeyard [#160](https://github.com/elirantutia/vibeyard/issues/160) (Cyrillic mojibake), [#95](https://github.com/elirantutia/vibeyard/issues/95); agent-deck [#539](https://github.com/asheshgoplani/agent-deck/issues/539), [#544](https://github.com/asheshgoplani/agent-deck/issues/544) (kitty-protocol reader broke arrow keys); ccmanager [#327](https://github.com/kbwo/ccmanager/issues/327) (Num Lock changes the CSI-u modifier byte); Happy [#613](https://github.com/slopus/happy/issues/613); Parallel Code [#121](https://github.com/johannesjo/parallel-code/issues/121). |
| Slowness, freezes, CPU or memory with many sessions | 8 | Orca [#6795](https://github.com/stablyai/orca/issues/6795), [#6144](https://github.com/stablyai/orca/issues/6144), [#22458](https://github.com/stablyai/orca/issues/22458); Paseo [#7760](https://github.com/getpaseo/paseo/issues/7760), [#6522 heap OOM on a long session](https://github.com/getpaseo/paseo/issues/6522), [#5820](https://github.com/getpaseo/paseo/issues/5820); Paradev [#4634](https://github.com/ParadevAI/Paradev/issues/4634), [#2861](https://github.com/ParadevAI/Paradev/issues/2861); Emdash [#2882](https://github.com/generalaction/emdash/issues/2882) (FTS5 reindex locks the UI); agent-deck [#39](https://github.com/asheshgoplani/agent-deck/issues/39); claude-squad [#215](https://github.com/smtg-ai/claude-squad/issues/215); T3 [#26227 checkpoint timeout](https://github.com/pingdotgg/t3code/issues/26227), [#695](https://github.com/pingdotgg/t3code/issues/695); Vibeyard [#22](https://github.com/elirantutia/vibeyard/issues/22). |
| Lost or unrecoverable sessions after update, restart or reboot | 8 | Paradev [#4763](https://github.com/ParadevAI/Paradev/issues/4763), [#5537](https://github.com/ParadevAI/Paradev/issues/5537), [#3496 auto-resume after restart](https://github.com/ParadevAI/Paradev/issues/3496); Paseo [#3061 daemon restart kills active turns](https://github.com/getpaseo/paseo/issues/3061), [#2574](https://github.com/getpaseo/paseo/issues/2574), [#237](https://github.com/getpaseo/paseo/issues/237); T3 [#2256](https://github.com/pingdotgg/t3code/issues/2256), [#330](https://github.com/pingdotgg/t3code/issues/330); Emdash [#1716](https://github.com/generalaction/emdash/issues/1716), [#3109](https://github.com/generalaction/emdash/issues/3109); claude-squad [#103](https://github.com/smtg-ai/claude-squad/issues/103), [#212](https://github.com/smtg-ai/claude-squad/issues/212); ccmanager [#196](https://github.com/kbwo/ccmanager/issues/196); agent-deck [#3098](https://github.com/asheshgoplani/agent-deck/issues/3098); Happy [#1148](https://github.com/slopus/happy/issues/1148). |
| Per-worktree setup: copy `.env` and ignored files, link `node_modules`, setup and post-create hooks | 8 | Parallel Code [#225](https://github.com/johannesjo/parallel-code/issues/225), [#231](https://github.com/johannesjo/parallel-code/issues/231); Paseo [#1628](https://github.com/getpaseo/paseo/issues/1628); claude-squad [#260](https://github.com/smtg-ai/claude-squad/issues/260); ccmanager [#7](https://github.com/kbwo/ccmanager/issues/7), [#110](https://github.com/kbwo/ccmanager/issues/110), [#294](https://github.com/kbwo/ccmanager/issues/294); agent-deck [#742](https://github.com/asheshgoplani/agent-deck/issues/742); Emdash [#1115](https://github.com/generalaction/emdash/issues/1115); Paradev [#6398](https://github.com/ParadevAI/Paradev/issues/6398), [#7318](https://github.com/ParadevAI/Paradev/issues/7318) (name the workspace and branch); Vibeyard [#110](https://github.com/elirantutia/vibeyard/issues/110). |
| Permission, question and approval handling | 7 | Happy [#635](https://github.com/slopus/happy/issues/635), [#375](https://github.com/slopus/happy/issues/375) (a question shown as a permission request), [#302](https://github.com/slopus/happy/issues/302), [#206](https://github.com/slopus/happy/issues/206); T3 [#37111](https://github.com/pingdotgg/t3code/issues/37111), [#15082](https://github.com/pingdotgg/t3code/issues/15082) (a delegated task's question never reaches its parent), [#21895](https://github.com/pingdotgg/t3code/issues/21895) (a steer cancels tools and reads as a refusal); Emdash [#1671](https://github.com/generalaction/emdash/issues/1671); claude-squad [#151](https://github.com/smtg-ai/claude-squad/issues/151); Orca [#22371](https://github.com/stablyai/orca/issues/22371); Parallel Code [#3](https://github.com/johannesjo/parallel-code/issues/3); Vibeyard [#65](https://github.com/elirantutia/vibeyard/issues/65). Harbor's answer cards already target this. |
| Diff, review, git host integrations | 6 | Orca [#4521 git graph](https://github.com/stablyai/orca/issues/4521), [#9948 blame](https://github.com/stablyai/orca/issues/9948), [#1082 Jujutsu](https://github.com/stablyai/orca/issues/1082); Emdash [#1635 diff since last turn](https://github.com/generalaction/emdash/issues/1635), [#1096 GitLab](https://github.com/generalaction/emdash/issues/1096); Paradev [#2714 GitLab](https://github.com/ParadevAI/Paradev/issues/2714); claude-squad [#144](https://github.com/smtg-ai/claude-squad/issues/144) (checkout commits and pushes on its own); ccmanager [#223](https://github.com/kbwo/ccmanager/issues/223); Parallel Code [#238](https://github.com/johannesjo/parallel-code/issues/238). |
| Multi-repo or multi-root workspaces | 5 | Orca [#1099](https://github.com/stablyai/orca/issues/1099) (124 reactions, 30 comments, still open), [#21118](https://github.com/stablyai/orca/issues/21118), [#7568](https://github.com/stablyai/orca/issues/7568); Paradev [#4018](https://github.com/ParadevAI/Paradev/issues/4018), [#2364](https://github.com/ParadevAI/Paradev/issues/2364); T3 [#1453](https://github.com/pingdotgg/t3code/issues/1453), [#671](https://github.com/pingdotgg/t3code/issues/671); claude-squad [#56](https://github.com/smtg-ai/claude-squad/issues/56); ccmanager [#37](https://github.com/kbwo/ccmanager/issues/37), [#174](https://github.com/kbwo/ccmanager/issues/174). |
| Sub-agents and orchestration visibility | 5 | T3 [#538](https://github.com/pingdotgg/t3code/issues/538) (nested threads, 37 reactions); Paseo [#5163](https://github.com/getpaseo/paseo/issues/5163) (sending a prompt to an agent cancels its running turn and kills its subagents); Orca [#10775](https://github.com/stablyai/orca/issues/10775); Parallel Code [#25](https://github.com/johannesjo/parallel-code/issues/25); ccmanager [#220 Agent Teams](https://github.com/kbwo/ccmanager/issues/220). |
| Pasting images and files | 5 | Orca [#6364](https://github.com/stablyai/orca/issues/6364) (75 comments, the single most-discussed Orca bug), Paseo [#2220](https://github.com/getpaseo/paseo/issues/2220), Parallel Code [#59](https://github.com/johannesjo/parallel-code/issues/59), Emdash [#1901](https://github.com/generalaction/emdash/issues/1901), Happy [#814](https://github.com/slopus/happy/issues/814). Harbor's phone image chip work (memory index) is in this space. |
| Completion alerts and approval pushes | 5 | T3 [#780](https://github.com/pingdotgg/t3code/issues/780) (64 reactions), Paseo [#6346](https://github.com/getpaseo/paseo/issues/6346), Parallel Code [#122](https://github.com/johannesjo/parallel-code/issues/122), Paradev [#1461](https://github.com/ParadevAI/Paradev/issues/1461), Emdash [#531](https://github.com/generalaction/emdash/issues/531). |
| Multiple Claude or Codex accounts, failover on rate limit, usage visibility | 4 | Orca [#11557](https://github.com/stablyai/orca/issues/11557) (40 reactions), [#9496 per-worktree pinning](https://github.com/stablyai/orca/issues/9496), [#20512 automatic failover](https://github.com/stablyai/orca/issues/20512), [#23227 per-project account](https://github.com/stablyai/orca/issues/23227); T3 [#228 usage visibility](https://github.com/pingdotgg/t3code/issues/228) (37), [#7338](https://github.com/pingdotgg/t3code/issues/7338) (usage 3 to 5 times the native app; the reporter later wrote it "now seems to work" after a release); Paseo [#3589](https://github.com/getpaseo/paseo/issues/3589) (usage panel empty when a provider sets its own `CLAUDE_CONFIG_DIR`); Emdash [#1678](https://github.com/generalaction/emdash/issues/1678). This is Harbor's strongest area (15 homes, move-session-to-plan); no competitor has solved failover. |
| Search inside a session or across history | 4 | Paseo [#1920](https://github.com/getpaseo/paseo/issues/1920), agent-deck [#198](https://github.com/asheshgoplani/agent-deck/issues/198), ccmanager [#196](https://github.com/kbwo/ccmanager/issues/196), Vibeyard [#8](https://github.com/elirantutia/vibeyard/issues/8). Few reactions, so it is a want, not a pain. |
| Maintainer trust: abandoned, telemetry, licence | 4 | claude-squad [#250](https://github.com/smtg-ai/claude-squad/issues/250), [#214](https://github.com/smtg-ai/claude-squad/issues/214); Happy [#223](https://github.com/slopus/happy/issues/223) (29 reactions), [#441](https://github.com/slopus/happy/issues/441), [#844](https://github.com/slopus/happy/issues/844); T3 [#4123 telemetry](https://github.com/pingdotgg/t3code/issues/4123); Paseo [#2982](https://github.com/getpaseo/paseo/issues/2982) (122 comments on relicensing). |

Single-repo but large: Orca [#6074 multiple windows](https://github.com/stablyai/orca/issues/6074) (82 reactions, 33 comments); T3 [#231 Steer and Queue follow-up modes](https://github.com/pingdotgg/t3code/issues/231) (77), [#9352 context window indicator hidden by default](https://github.com/pingdotgg/t3code/issues/9352) (45), [#1404 branching](https://github.com/pingdotgg/t3code/issues/1404) (34), [#8879 turn folding hides the substantive answer](https://github.com/pingdotgg/t3code/issues/8879); Orca [#3099 chat-based UI](https://github.com/stablyai/orca/issues/3099) (30), [#7754 embedded VS Code](https://github.com/stablyai/orca/issues/7754) (62), [#3035 LSP](https://github.com/stablyai/orca/issues/3035) (47).

### 3.3 Patterns inside the themes that matter for Harbor

- **Hook injection is a recurring complaint.** Emdash #1944 (disable it), Vibeyard [#56](https://github.com/elirantutia/vibeyard/issues/56) ("hooks break Claude Code terminal immediately after installation"), [#89](https://github.com/elirantutia/vibeyard/issues/89) (forego hooks), [#110](https://github.com/elirantutia/vibeyard/issues/110) (a WorktreeCreate hook installed as an observer breaks worktree creation on Claude Code 2.1.50 and later), Orca #14837. Any Harbor hook must be observe-only, fail open, and removable.
- **Screen-scraped state is the top source of false states** in the two TUI-multiplexers (ccmanager, agent-deck) and also in Orca #22371. Harbor has already hit this (fake-question card, memory index).
- **Daemon restarts that kill agent work** are the sharpest pain across Paseo #3061, Paradev #4763 and Orca's Windows daemon (section 4). Harbor's keeper-per-session design is the answer; the evidence says to keep proving it survives app updates and crashes.
- **Image paste** keeps producing long threads because every layer (terminal, remote host, relay message cap) breaks it differently.

---

## 4. Part 3: Windows issues and fixes that apply to Harbor

Search method: per repo, title search for `windows`, `conpty`, `powershell`, `wsl`, `win32`, `cmd.exe`, `msys` (7 searches each, state any). Counts of matching issues: Orca 297, T3 Code 199, Paseo 102, Emdash 28, Paradev 10 (all feature requests: no Windows build), claude-squad 2, ccmanager 1, Parallel Code 1; agent-deck, Happy and Vibeyard lists were pulled and read. I read the bodies of the ones cited below. Status words are the issue's own.

**W1. Hooks on Windows: shell wrappers are the main hazard.**
- Orca [#14837](https://github.com/stablyai/orca/issues/14837) (closed 2026-08-21): hook entries were `command: conhost.exe` plus an `args` array running `cmd.exe /d /c claude-hook.cmd`, and `curl ... --data-urlencode "payload@-"`. Claude Code 2.1.233 honoured `args`, but the conhost never exited because curl waited on a stdin that never reached end of file, so every hook event blocked the full 10 s timeout and left a `conhost -> cmd -> curl` chain behind. A user's `<nul` patch was overwritten on each Orca update. Fix #14825: one self-contained command, `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand <base64>`; test #15403 asserts the payload arrives, not that the installer wrote an entry.
- Later Orca code comments (`commands/windows-powershell-hook-launcher.ts`, `windows-direct-cmd-hook-command.ts`): antivirus blocks `-WindowStyle Hidden` with `-EncodedCommand` (Orca #16003), so they "omit it and use direct launchers where possible", use absolute forward-slash paths (survive cmd.exe and Git Bash, resist PATH hijack), guard unicode `.cmd` paths (#26382), and ship a native Windows hook executable (`windows-native-hook-executable.ts`). PowerShell 5.1 cannot parse a shell-level `||`.
- Paseo [#3632](https://github.com/getpaseo/paseo/issues/3632) (open): Codex `commandWindows` hooks exit 1 every time because the cmd-style `if defined X (...) else (exit /b 0)` string fails when Codex runs it through PowerShell 5.1.
- Emdash [#3011](https://github.com/generalaction/emdash/issues/3011): unquoted `>NUL` under Git Bash creates a file named `NUL` in the worktree.
- Applies to Harbor: whichever launcher runs a hook must be proven under cmd, PowerShell 5.1 and Git Bash, with stdin read first and closed. Pat's rule 1 rules out the `-WindowStyle Hidden` form, which flashes; the Orca end state (direct native or `.cmd` launcher, no wrapper) is the compatible direction. Harbor's `bin/harbor-ask-hook` is a node script; how settings call it on Windows was not checked here.

**W2. Console windows flashing and stealing focus.** Orca [#20492](https://github.com/stablyai/orca/issues/20492), [#10488](https://github.com/stablyai/orca/issues/10488), [#14828](https://github.com/stablyai/orca/issues/14828), [#27390](https://github.com/stablyai/orca/issues/27390), [#23591](https://github.com/stablyai/orca/issues/23591); T3 [#2537](https://github.com/pingdotgg/t3code/issues/2537), [#32718](https://github.com/pingdotgg/t3code/issues/32718) (`git.exe` without `windowsHide`); Happy [#985](https://github.com/slopus/happy/issues/985), [#1725](https://github.com/slopus/happy/issues/1725) (`where agy` on every keep-alive), [#343](https://github.com/slopus/happy/issues/343), [#1729](https://github.com/slopus/happy/issues/1729); Paseo [#3333](https://github.com/getpaseo/paseo/issues/3333).
Cause (Orca #20492): a GUI-subsystem main process owns no console, so each console-subsystem child gets a new visible conhost. Sites named across the threads: `ssh`, `git`, `netstat`, `icacls`, `gh`, `wsl`, `where`, the agent-browser binary, a PowerShell cookie-import, a PowerShell process-table scan (Orca's daemon ran `Get-CimInstance Win32_Process ... | ConvertTo-Json` about every 2.2 s, 81 spawns in 3 minutes, removed by #15749), the Codex background server (fixed upstream in Codex 0.159.2, [openai/codex#44768](https://github.com/openai/codex/issues/44768)). Applies to Harbor: this is its rule 1; the list above is a ready sibling checklist for a spawn audit, not something I ran.
Trade-off from T3 [#12498](https://github.com/pingdotgg/t3code/issues/12498): `windowsHide` becomes `CREATE_NO_WINDOW`, which makes Windows create a hidden `conhost.exe` per child (about 10.5 ms of a 30 ms git read); their PR #19288 uses `DETACHED_PROCESS` for git reads, and `LC_ALL=C` saves another 11 ms of locale setup (34-37 ms to 11-12 ms). Pat's rule forbids `DETACHED_PROCESS` for Python; for Node the same test would need the sentinel probe first.

**W3. The terminal daemon must outlive one bad PTY and its own crashes.**
- Orca [#10415](https://github.com/stablyai/orca/issues/10415): daemon died with `uncaught-exception-fatal` on "Timed out waiting for PTY process exit" or `write EAGAIN`, taking every session with it; an update that bumped the protocol stranded live sessions on the old daemon. Fix #15755: the daemon joins a kill-on-close Job Object, and teardown is one `TerminateJobObject` on a handle held since spawn instead of a probe that can time out. It was still reproducible on 1.4.188 per a later comment, and the issue closed.
- Orca [#16797](https://github.com/stablyai/orca/issues/16797) (open) and [#36262](https://github.com/stablyai/orca/issues/36262) (closed after the reporter saw no more restarts from 1.4.245): the daemon vanished with no shutdown log entry, 8 silent deaths in a day, often while the window was backgrounded or the display off; Windows Event Viewer showed nothing. A traversal guard (#22411) landed but "daemon exits are not yet confirmed fixed". Lesson: log a heartbeat and the exit reason from outside the daemon, because the process leaves no trace.
- Orca [#7742](https://github.com/stablyai/orca/issues/7742) (closed): the main process died because the native file watcher `@parcel/watcher` crashed under many worktrees; the daemon died with it, the ConPTY pipe broke, and PowerShell's next console read hit a FailFast `0xE9`. Fix #7757: run the watcher in its own process. Harbor uses plain `fs.watch` per its CLAUDE.md, but it has the same class of risk from any native module in the main process; its daemon is already separate.
- Applies to Harbor: it already has a Job Object per session and a separate daemon; the new information is "do not let a PTY exit timeout throw to the process level" and "record why the daemon left".

**W4. Spawning CLIs: shims and extensions.** Emdash [#1703](https://github.com/generalaction/emdash/issues/1703) (node-pty cannot spawn extensionless or `.cmd` files, error 193; fix: resolve to the real executable), [#1667](https://github.com/generalaction/emdash/issues/1667); Happy [#980](https://github.com/slopus/happy/issues/980), [#1016](https://github.com/slopus/happy/issues/1016) (codex via a shim gives ENOENT or an `initialize` timeout); T3 [#7360](https://github.com/pingdotgg/t3code/issues/7360) (every provider "not found" though on the user PATH), [#2163](https://github.com/pingdotgg/t3code/issues/2163); Paseo [#6235](https://github.com/getpaseo/paseo/issues/6235) (`pi.cmd`), [#9882](https://github.com/getpaseo/paseo/issues/9882) (a Microsoft Store (MSIX) launcher reported unavailable). REPORT.md already notes Cursor's `agent.cmd` under PowerShell 5.1.

**W5. Git on Windows.** Paseo [#5645](https://github.com/getpaseo/paseo/issues/5645) (open): on timeout the daemon killed only `Git\cmd\git.exe`, the launcher; the real `mingw64\bin\git.exe` kept running, about 400 MB and one core each, until `fatal: Out of memory`. Kill the whole tree. T3 [#26227](https://github.com/pingdotgg/t3code/issues/26227): bound the cost of any per-turn `git add -A`. Paseo [#8771](https://github.com/getpaseo/paseo/issues/8771): every `.git` change triggered a full reconciliation of all checkouts. Orca [#11363](https://github.com/stablyai/orca/issues/11363): git over `\\wsl.localhost\...` paths took 25 to 33 s and the desktop lagged; Orca answered with a WSL-hosted server.

**W6. Ports.** Paseo [#1552](https://github.com/getpaseo/paseo/issues/1552) (open): the default `127.0.0.1:6767` failed with `EACCES` or `EADDRINUSE` because Windows reserved that range (with WSL mirrored networking the range is shared); fix: configurable port outside the reserved ranges. **Verified here:** Harbor's server default is 8787 (`app/src/server/compose.js:902`); `netsh interface ipv4 show excludedportrange protocol=tcp` on this machine on 2026-11-26 lists 5357, 50000-50059, 57213-57312, 60424-60936 and 60983-61082, so 8787 is outside them today. The ranges move after reboots and WSL changes.

**W7. Junctions, symlinks and path forms.** T3 [#27057](https://github.com/pingdotgg/t3code/issues/27057): junctions created to `~/.gemini/.../skills` dangled when the target did not exist, and agy's `session/new` failed with `-32603`; four machines hit it. T3 [#14325](https://github.com/pingdotgg/t3code/issues/14325): symlinks fail with `EPERM` without Developer Mode. Paseo [#3582](https://github.com/getpaseo/paseo/issues/3582): mapped drives break transcript lookup that canonicalises the cwd with realpath. Paradev [#3557](https://github.com/ParadevAI/Paradev/issues/3557): `core.symlinks=false` checks symlinks out as plain files. Applies to Harbor: it shares transcripts across 15 homes by junctions (CLAUDE.md); any code that creates a junction should verify the target exists first.

**W8. Cost and usage double counting through shared folders.** T3 [#7858](https://github.com/pingdotgg/t3code/issues/7858): a transcript folder visible from Windows and WSL was counted twice (284 sessions instead of 142) because the "same source" fingerprint could not match across the OS boundary. Orca avoids this at the record level with the `message.id:requestId` key (section 2.1.B). Harbor's junctioned homes put the same files under several `~/.claude*` paths, so a future cost view must dedupe by record, not by file path.

**W9. TUI rendering after hide and show.** Orca [#7240](https://github.com/stablyai/orca/issues/7240) (open, "pending_repro"): a full-screen Claude Code pane shows overlapping text after the tab is hidden and re-shown; Ctrl+L, a drag-select or a resize fixes it. Orca [#19333](https://github.com/stablyai/orca/issues/19333): agent panes take 2.3 to 2.5 s to first paint on Windows while shell panes take 0.5 s. This matches the Harbor `>_` toggle case and REPORT.md section 11's "resend the size after attach"; a hidden-then-shown resize nudge is the cheap test.

**W10. Housekeeping bugs that cost users disk and CPU.**
- T3 [#9650](https://github.com/pingdotgg/t3code/issues/9650): disposable agy health probes extracted a PyInstaller one-file binary into a new `%TEMP%\_MEI*` folder each run; force-stopping on Windows skips PyInstaller's cleanup; one user reported 785 GB. **Verified here:** `%LOCALAPPDATA%\Temp` holds 0 `_MEI*` folders on 2026-11-26, so Harbor's agy runs are not leaving them (Harbor's agy usage checks already use `AGY_CLI_DISABLE_AUTO_UPDATE`, REPORT.md section 10).
- T3 [#28196](https://github.com/pingdotgg/t3code/issues/28196): the server's trace log became Defender's most scanned file and rotated history out in about two hours. Harbor keeps JSONL perf logs under `~/.cache/harbor/perf`; keep them small or excluded from scans.
- T3 [#5900](https://github.com/pingdotgg/t3code/issues/5900) and [#4182](https://github.com/pingdotgg/t3code/issues/4182): a PowerShell/WMI port-discovery probe re-spawned every 3 s drove CPU. Harbor's memory note "win32 process-question costs: CIM queries take 3-5 s" is the same class.
- Updaters: T3 [#25450](https://github.com/pingdotgg/t3code/issues/25450) (uninstall of old files fails while the main process outlives the window), Paseo [#5663](https://github.com/getpaseo/paseo/issues/5663), Orca [#7725](https://github.com/stablyai/orca/issues/7725) (staging directories grow to several GB).

**W11. Security software.** Orca [#23383](https://github.com/stablyai/orca/issues/23383): a Windows CLI launcher binary quarantined as malware by an enterprise EDR; [#6487](https://github.com/stablyai/orca/issues/6487): blocked by Smart App Control for lack of a signature. Relevant only if Harbor ever ships unsigned helper executables.

Not found in any of these trackers: a fix for ConPTY reflow desync (REPORT.md cites microsoft/terminal #15976 for that).

---

## 5. Questions in REPORT.md section 15, answered or narrowed

| REPORT.md "not verified" | Result |
|---|---|
| Whether real Claude receives a keeper's OSC 7501 answer through ConPTY | Still open. New facts: the spec allows a bare `?` reply; Orca answers from a headless xterm inside its daemon and says it must beat the DA1 sentinel; agent-deck #2356 shows DA replies leaking into prompts on Windows Terminal. I did not test whether ConPTY answers DA1 before a keeper could. |
| A Claude registry record in the `waiting` state | Not addressed by these sources. |
| Whether a slow `PermissionRequest` hook blocks the dialog | Partly: Orca holds one for 122 s because of a 2:00 auto-block (code comment, not tested). Harbor's 12-hour hook timeout was not exercised against that. |
| Which Cursor hooks fire in cursor-agent on Windows | Not answered. Corroboration only: "Cursor imports Claude hooks" (Orca `cursor-replay-guard.ts`), and Orca/Grok guards skip when stdin is absent (#24907). |
| agy subagent record format and artifact layout | Harbor's own `gemini-store.js` already documents it (JSONL transcript, `conversation_summaries.db` rows). T3 Code reads a different store (per-conversation `.db`, protobuf steps), not needed. |
| Several star counts and dates | Orca 139,007; T3 79,986; Happy 24,842; Paseo 25,557; Paradev 16,707; claude-squad 8,870; Emdash 6,310; Vibeyard 1,395; agent-deck 1,308; ccmanager 1,281; Parallel Code 1,106 (API, 2026-11-26). |
| Competitor features read from docs, not code | This file reads the code for Orca, Parallel Code, T3 Code, Paseo, Paradev and Emdash for the mechanisms named in section 1. Paseo PR watch, Emdash PR flow, T3 usage-limit derivation and Claude SDK `forkSession` internals were not read. |

## 6. What I did not do

- No competitor code was run; no Harbor code was changed. Local checks were: Node 24.19 `node:sqlite` FTS5 in memory, `netsh` excluded port ranges, a directory listing of `~/.gemini/antigravity-cli` and `%LOCALAPPDATA%\Temp\_MEI*`, and greps of Harbor's `app/src` and `bin`.
- Issue counts and the 660-row lists come from GitHub search ordering; a few repos have fewer than 30 issues with any comments, so those lists include zero-comment rows.
- Claude Code behaviour (hooks merge via `--settings`, the 2:00 auto-block, `is_interrupt`, `background_tasks` fields) is quoted from competitors' code comments and not tested against Claude 2.1.321.
- Scratch files (raw lists, helper scripts without credentials): `C:\dev\.orch\harbor\oss-deep\w2\`.
