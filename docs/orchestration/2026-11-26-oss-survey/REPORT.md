# What other agent-manager projects do that Harbor could borrow (2026-11-26)

Pat asked for a look at open-source projects like Harbor, for anything worth borrowing for Claude Code, Codex, Cursor CLI or
Antigravity (`agy`). Two research passes read project READMEs, official docs, changelogs and issues on 2026-11-26. The
claims below that matter most were then checked on this machine (marked **verified here**). Everything else is from the
cited page and was not tested.

The context: that night Harbor showed made-up Gemini questions twice, because it reads the terminal screen to decide
whether a session is working, idle or asking something (commits 0ad932e4 and 68c07905). Most of what follows is about
getting that state from the CLIs themselves instead.

## 1. The CLIs now report their own state in the terminal stream (OSC 7501)

The Program Status Protocol is an escape sequence a program writes to say `idle`, `working`, `done`, `error` or
`blocked`, and a blocked report names its kind: `permission`, `question` or `auth`
([spec rev 0.4, 2026-10-10](https://superlogical.com/rex/docs/build/program-status); tracker
[areweosc7501yet.com](https://areweosc7501yet.com)).

- Format: `ESC ] 7501 ; state=blocked:kind=question:app=antigravity:msg=<base64> ST` (ST is `ESC \` or BEL).
- Handshake: a program may first ask `ESC ] 7501 ; ? ST`; a terminal that supports it answers `ESC ] 7501 ; ? ST`. A program
  that gets no answer treats the protocol as unsupported. Programs may also report without asking.
- Host rules: one record per `id`; when the process exits or a new shell prompt starts, `working` and `blocked` records are
  dropped; an interrupt reports `idle`.

Who emits it:

| CLI | Status | Evidence |
|---|---|---|
| Claude Code | Since 2.1.295 (changelog). Asks first. | **Verified here**: 2.1.321's binary holds "probe: OSC 7501 reply" and "probe: no reply to OSC 7501". |
| Codex | Since rust-v0.163.0 (tracker). | **Verified here**: 0.167.0's `codex.exe` holds the `]7501;state=` writer, including `state=clear`. Handshake behaviour not tested. |
| agy | Since 1.4.0 (tracker). | **Verified here**: 1.5.14 in a ConPTY sends only the query by default; with `AGY_CLI_OSC7501=on` it reported `state=blocked:kind=auth` (scratch profile, not signed in) then `state=idle`, with no handshake. |
| Cursor CLI | Not yet; the team said "looking at it" on 2026-11-02 ([forum](https://forum.cursor.com/t/emit-osc-7501-program-status-in-cursor-agent-idle-working-blocked-done/177003)). | Not checked here. |

Known emitter bugs (from the trackers): agy reports `done` while background subagents still run
([#1560](https://github.com/google-antigravity/antigravity-cli/issues/1560)) and `blocked` after a finished turn
([#1765](https://github.com/google-antigravity/antigravity-cli/issues/1765)); Codex reports a false completion on an MCP
reload ([#62977](https://github.com/openai/codex/issues/62977)).

**Does it survive Windows ConPTY? Verified here** (`osc7501-conpty-host.cjs` with `osc7501-conpty-child.cjs`, the same
node-pty and `useConpty` the keeper uses):
- Output: all three sequences a child wrote (two reports and the query) reached the host intact.
- Input: the host's answer to the query, written into the pty, did NOT reach the child's stdin (a Node child in raw mode).
  So a CLI that waits for the answer may stay silent under Harbor. agy can be switched on without it (above); Claude's case
  needs a test with the real CLI, since it reads other terminal replies (DECRPM) itself.

## 2. What to borrow, ranked

1. **Read OSC 7501 in the sessiond keeper, before any screen reading (medium).** The keeper already holds every pty byte.
   Start with agy (`AGY_CLI_OSC7501=on` in Harbor's launch env), then Codex, then Claude once the handshake is solved (the
   keeper answers the query; test whether real Claude receives it). A `blocked:kind=question` or `permission` report would
   decide "needs your answer" outright, and `working` would rule it out, which is exactly what failed on 2026-11-25. Keep
   the screen reader as the fallback and for Cursor, and treat a report as a hint until each emitter's bugs are measured.
2. **Claude's own session registry (small).** Claude Code 2.1.321 writes `<config home>\sessions\<pid>.json` per running
   session with `status` (`busy`, `waiting`, `idle`), `statusUpdatedAt`, `sessionId` and, when waiting, `waitingFor`
   (`permission prompt`, `input needed`, `dialog open`, ...; [agent view](https://code.claude.com/docs/en/agent-view)).
   `claude agents --json` prints the same. **Verified here**: the files exist and showed `"status":"busy"`. Not seen: a
   `waiting` record with `waitingFor` filled in. Undocumented files, so read them defensively, per config home.
3. **Use the rest of agy's status-line payload (small).** Harbor's tee already receives it. Documented fields Harbor does
   not use yet: `task_count` (background tasks running), `pending_input_count`, `subagents[]` (name, role, status),
   `cycle_mode` ([statusline docs](https://antigravity.google/docs/cli/statusline)). An agy `Stop` hook also gets
   `fullyIdle` ([hooks](https://antigravity.google/docs/hooks.md)).
4. **Answer permissions through hooks instead of keystrokes (medium).**
   - Claude: a `PermissionRequest` hook runs as the dialog is about to show and can return allow or deny
     ([hooks reference](https://code.claude.com/docs/en/hooks)); `http`-type hooks can post straight to a local Harbor
     server. Harbor already does this for AskUserQuestion.
   - Codex: hooks now include `PermissionRequest`, `Stop`, `UserPromptSubmit`, `Interrupt`
     ([docs](https://learn.chatgpt.com/docs/hooks.md)); non-managed hooks must be trusted once through `/hooks`.
   - agy: `PreToolUse` can return `allow`, `deny`, `ask`, `force_ask` (not verified to fire on the confirmation dialog).
   - Parallel Code shows how to do it per launch, without touching the person's own config, and fail-open
     ([claude-settings.ts](https://raw.githubusercontent.com/johannesjo/parallel-code/main/electron/agent-hooks/claude-settings.ts),
     [codex-hooks.ts](https://raw.githubusercontent.com/johannesjo/parallel-code/main/electron/agent-hooks/codex-hooks.ts),
     [hook-script.ts](https://raw.githubusercontent.com/johannesjo/parallel-code/main/electron/agent-hooks/hook-script.ts)).
5. **A state reducer with guards (small)**, from Parallel Code's
   [status.ts](https://raw.githubusercontent.com/johannesjo/parallel-code/main/electron/agent-hooks/status.ts): only
   `working` goes stale (30 min); a waiting state never expires on a timer; a generic permission notice cannot replace an
   open question (it would send the wrong key); a subagent's tool result does not dismiss the parent's prompt. Plus a
   "turn ended with no hook" backstop: two consecutive ready screens 2 s apart
   ([codex-turn-watch.ts](https://raw.githubusercontent.com/johannesjo/parallel-code/main/electron/agent-hooks/codex-turn-watch.ts)),
   which covers Codex errors and usage limits that fire nothing.
6. **One "needs you" list across all sessions (small to medium).** Orca's phone Agent Home gathers every approval and
   question ([docs](https://orca.dev/docs/mobile)); Parallel Code jumps to the next waiting task with Ctrl+Tab. Harbor's
   answer cards live in each window.
7. **Stuck-status escape hatches (small).** Orca checks a heartbeat from the desktop to catch stale statuses on the phone;
   Superset offers a manual Clear Status ([docs](https://docs.paradev.com/agent-status)).
8. **Lane setup helpers (small).** ccmanager's `.worktreeinclude` copies chosen gitignored files (`.env`, local config) into
   a new worktree ([README](https://github.com/kbwo/ccmanager)); Parallel Code links `node_modules` instead of reinstalling.
9. **Orchestration mail with acknowledgements (medium).** Orca's per-run queue is read with `check` and cleared with
   `--ack <deliveryId>`; a worker sends `worker_done` exactly once, carrying task and dispatch ids so a stale retry cannot
   complete the wrong dispatch ([docs](https://orca.dev/docs/cli/orchestration)).
10. **Longer term, a structured session mode (large).** Codex `app-server` speaks JSON-RPC with `turn/started`,
    `thread/status/changed` (with `waitingOnApproval`) and approval requests, and the TUI can attach to it with
    `codex --remote` ([docs](https://learn.chatgpt.com/docs/app-server); flag present in 0.167.0, **verified here**).
    Cursor's `agent acp` has blocking `session/request_permission` and `cursor/ask_question`
    ([docs](https://cursor.com/docs/cli/acp)); agy has `agy acp` since 1.5.0 (no method docs found). All of these own the
    session, so they suit a chat-only window, not the real terminal Harbor keeps. T3 Code and Paseo work this way.

## 3. Looked at and not worth borrowing

- **coder/agentapi**: archived 2026-09-13; it decides "stable" by screen text staying the same across snapshots, a debounce
  rather than real state.
- **Claude Channels**: a research preview limited to Anthropic-allowlisted plugins, needs claude.ai sign-in and Team admin
  approval.
- **Claude Remote Control**: goes through Anthropic's servers; not a local interface.
- **Gemini CLI**: superseded by agy (Google, 2026-05-19); its hooks and ACP flag do not apply to agy.
- Shut down or off target: Terragon (closed January 2026), 1code (archived 2026-07-07), Vibe Kanban's company (closed
  2026-04-10, code continues as community open source), Omnara (now a hosted platform), Crystal (replaced by Nimbalyst).

## 4. Projects compared

Orca (stablyai/orca), Parallel Code (johannesjo/parallel-code), agent-manager (wainmann), ccmanager (kbwo), Superset /
Paradev, T3 Code (pingdotgg/t3code), Paseo (getpaseo), Emdash (generalaction), Nimbalyst, Happy (slopus/happy), Conductor
(closed source, Mac only), Vibe Kanban, opcode, Claude Code UI (siteboon), Toad, Sculptor, uzi, container-use. None runs
its own pty daemon with chat windows built from transcripts the way Harbor does; Orca is closest in scope (all four CLIs,
Windows build, phone app). Star counts and per-project details are in the research notes, not repeated here; Orca's
star count and hook list could not be confirmed from its own docs.

## 5. Not verified

- Whether real Claude Code receives a keeper's OSC 7501 answer through ConPTY (the Node test child did not).
- Whether Codex waits for the handshake before reporting.
- A Claude registry record in the `waiting` state with `waitingFor`.
- Whether a slow Claude `PermissionRequest` hook blocks the dialog, and whether Claude's `Stop` fires on Esc.
- Which Cursor hooks fire in `cursor-agent` on Windows (docs and forum reports disagree).
- Two clients on one Codex app-server thread (only third-party write-ups and an "experimental" label).
