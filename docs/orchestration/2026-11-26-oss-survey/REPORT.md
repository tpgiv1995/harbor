# What Harbor could borrow from similar projects and from the four CLIs (2026-11-26)

Pat asked for a thorough look at open-source projects like Harbor, and at the four CLIs themselves, for anything worth
borrowing, across the whole product. Seven research passes read project docs, changelogs, release notes and issue trackers
on 2026-11-26:
- the first two covered state detection;
- the next five covered, in turn, a feature comparison with similar apps, Claude Code and Codex features, Cursor CLI and
  Antigravity (agy) features, the tools people build around the CLIs, and orchestration practice plus reliability lessons.

Claims about Harbor or this machine were checked here and are marked **verified here**. Everything else comes from the
cited page and was not tested.

Versions: installed here are Claude Code 2.1.321, Codex 0.167.0, agy 1.5.14 and Harbor's daemon on node-pty 1.1.0. The
latest published are Claude 2.1.332, Codex 0.172.0, agy 1.5.18 and Cursor CLI v2026.11.19.

## The short list (the ten most worth doing)

1. **Get session state from the CLIs, not the screen** (medium). Claude Code, Codex and agy announce working, done or
   blocked (and on what) in the terminal stream; Claude also keeps a per-session status file. This ends the
   fake-question and missed-prompt family of bugs. Section 1.
2. **A changes and review pane** (large; a per-turn "files changed" card first, small). It shows what each agent changed,
   and line comments go back to the agent as one message. Every strong competitor has it; Harbor has no diff view at all.
   Section 2.
3. **Search inside every conversation** (medium). Today the session search matches project, title and first prompt only.
   Section 5.
4. **Plan, task-list and goal panels** (small to medium). Plan approval draws only in the terminal, and the to-do list
   shows as a bare "Updated todos" row. All four CLIs now have `/goal`. Section 4.
5. **Auto-resume after a usage limit, plus the "roomiest plan" picker** (small). Harbor knows every account's reset time
   but resumes nothing by itself. Section 6.
6. **Cost per session and per project, and where each plan meter will be at reset** (small to medium). Section 6.
7. **Rewind and fork** (medium to large). Undo a bad turn, or branch a conversation; Claude, Codex, Cursor and agy all
   have both. Section 3.
8. **One "needs you" list and a jump-to-next key, plus approve or deny from the phone** (small to medium). Section 8.
9. **Orchestration guard rails** (small each): a test gate before a lane lands, a wall-clock and stall cap per worker,
   one owner per file, at most 3 to 5 workers per run, and never parallelising sequential work. Section 9.
10. **Memory and speed with many windows** (medium). Keep only the most recent windows' terminals live, virtualise long
    chats, and resend the size after attach. One comparable app halved its renderer memory this way. Section 11.

## 1. Session state from the CLIs themselves

**The terminal reports (OSC 7501).** The Program Status Protocol is an escape sequence a program writes to report its
state ([spec rev 0.4](https://superlogical.com/rex/docs/build/program-status), [tracker](https://areweosc7501yet.com)):
- the states are `idle`, `working`, `done`, `error` and `blocked`, and a blocked report names its kind (`permission`,
  `question` or `auth`);
- a report looks like `ESC ] 7501 ; state=blocked:kind=question:app=antigravity:msg=<base64> ST`;
- a program may first ask `ESC ] 7501 ; ? ST`, and a supporting terminal answers `ESC ] 7501 ; ? ST`.

| CLI | Status | Evidence |
|---|---|---|
| Claude Code | Since 2.1.295. It asks first. | **Verified here**: the 2.1.321 binary contains "probe: OSC 7501 reply" and "probe: no reply to OSC 7501". |
| Codex | Since 0.163.0. | **Verified here**: the 0.167.0 binary contains the `]7501;state=` writer. Whether it asks first was not tested. |
| agy | Since 1.4.0. | **Verified here**: by default it only asks; with `AGY_CLI_OSC7501=on` it reported `blocked:kind=auth`, then `idle`, without asking. |
| Cursor CLI | Not yet. Cursor's team said it was "looking at it" on 2026-11-02 ([forum](https://forum.cursor.com/t/emit-osc-7501-program-status-in-cursor-agent-idle-working-blocked-done/177003)). | Not checked here. |

**Through Windows ConPTY (verified here, `osc7501-conpty-host.cjs`).**
- The reports a child writes reach the keeper intact.
- The keeper's answer to the "do you support this?" query did NOT reach a Node child's input. Real Claude needs its own
  test.
- Known emitter bugs: agy reports `done` while subagents still run
  ([#1560](https://github.com/google-antigravity/antigravity-cli/issues/1560)), and Codex reports a false completion on an MCP
  reload ([#62977](https://github.com/openai/codex/issues/62977)). Treat a report as strong evidence, not as the last word.

**Claude's session registry (verified here).** Claude Code 2.1.321 writes `<config home>\sessions\<pid>.json` for each
running session, holding `status` (`busy`, `waiting` or `idle`) and `statusUpdatedAt`, plus `waitingFor` while it waits
([agent view](https://code.claude.com/docs/en/agent-view)). `claude agents --json` prints the same list. These files are
undocumented, so read them defensively.

**agy's status-line fields Harbor ignores.** Harbor's tee already receives `task_count`, `pending_input_count`,
`subagents[]` (with each one's model) and `cycle_mode` ([statusline](https://antigravity.google/docs/cli/statusline)). An agy
`Stop` hook also receives `fullyIdle`.

**Permission and turn hooks.**
- Claude `PermissionRequest` can allow or deny, and an `http` hook type can post straight to Harbor
  ([hooks](https://code.claude.com/docs/en/hooks)).
- Codex has `PermissionRequest`, `Stop`, `UserPromptSubmit` and `Interrupt` ([hooks](https://learn.chatgpt.com/docs/hooks.md)).
  A non-managed hook must be trusted once.
- agy `PreToolUse` can return `allow`, `deny`, `ask` or `force_ask`.
- Parallel Code injects these per launch, without touching the person's own config, and fails open
  ([claude-settings.ts](https://raw.githubusercontent.com/johannesjo/parallel-code/main/electron/agent-hooks/claude-settings.ts),
  [codex-hooks.ts](https://raw.githubusercontent.com/johannesjo/parallel-code/main/electron/agent-hooks/codex-hooks.ts)).
- Its state reducer ([status.ts](https://raw.githubusercontent.com/johannesjo/parallel-code/main/electron/agent-hooks/status.ts))
  has guards worth copying:
  - only `working` goes stale;
  - a waiting state never expires on a timer;
  - a generic permission notice never replaces an open question;
  - a "turn ended with no hook" backstop takes two ready screens 2 seconds apart, which catches Codex errors and usage
    limits.

## 2. Review and git

- **Changes pane with line comments sent to the agent.** Orca ([docs](https://orca.dev/docs/review/annotate-ai-diff)),
  Paradev (formerly Superset), Emdash, Parallel Code and agent-manager have it, and comments survive diff updates. Harbor:
  no diff view (**verified here**: no diff component in `app/src`). The cheapest first step is a per-turn "files changed"
  card built from the Edit and Write records Harbor already parses.
- **Review button.** Send `/code-review` (Claude, with a level, `--fix` and `--comment`) or run
  `codex review --uncommitted`. Findings come back as transcript text. Small.
- **PR badge, and an agent that watches its PR.** Claude shows PR status in its footer, and Paseo 0.17.0 and T3 Code
  v0.1.12 wake the agent when checks or reviews change. Orca draws a CI pass or fail line in the chat. Small if the session
  already uses `gh`.
- **Git graph and blame** (Orca 1.4.254 and 1.4.262), and **multi-repo workspaces** (T3 Code, Conductor 0.101). Lower
  priority.

## 3. Recovery: rewind, fork, checkpoints

- **Rewind.** Claude `/rewind` restores code, conversation or both from `~/.claude/file-history/<session>/`. It does not
  track edits made by Bash or by subagents ([checkpointing](https://code.claude.com/docs/en/checkpointing.md)). Codex, Cursor
  (`/rewind`, on by default since v2026.06.22) and agy (`/rewind`, alias `/undo`) all have one.
  - Orca shows "Rewind to here, then edit the prompt" (1.4.235), and Paradev puts an undo on each turn's changes (2.0.3).
  - The restore is a terminal menu in each CLI, so a host drives it there. The research's cheaper first slice is Claude's
    summarize-from-here.
- **Fork and branch.** Claude `/branch` and `/fork`, Codex `codex fork` and `/fork`, Cursor `/fork`, agy `/fork`. A forked
  or rewound transcript changes under Harbor's reader, so it must re-read it.
- **Git as the real checkpoint for workers.** Auto-commit a lane snapshot per task, so rollback and resume work for every
  CLI.

## 4. Plan, task list, goal, background work

- **Plan card.** **Verified here**: `renderer/stage/dialog-state.cjs:11` says ExitPlanMode "draws only in the terminal".
  The plan itself is in `~/.claude/plans/` and in the tool record. A card with Approve and Edit would bring it into the
  window. Codex `/plan`, Cursor plan mode and agy plan mode are similar.
- **Task list panel.** **Verified here**: `main/providers/transcript.js:543-547` turns TodoWrite and TaskCreate into a row
  reading "Updated todos". The checklist itself is in the record and in `~/.claude/tasks/`. agy has an N/M step checklist
  (1.5.16).
- **Goal chip.** `/goal` exists in Claude (2.1.139), Codex, Cursor (v2026.08.11) and agy (1.0.14). A chip could show the
  goal with pause and clear; Claude writes a verdict entry per turn.
- **Background work strip.** Claude `/tasks` lists shells, agents, workflows, MCP calls and loops; agy reports `task_count`;
  Paseo 0.16.0 and Conductor 0.99 show them above the composer with Stop. Harbor's Team chart shows agents, not background
  shells or monitors.
- **Subagents as child rows.** Cursor writes them to `agent-transcripts/<parent>/subagents/` (v2026.10.17), but its
  `turn_ended` marker is often missing, so treat it as a hint. agy reports `subagents[]` in the status line, and Claude
  writes `<session>/subagents/`.

## 5. Finding things: search, export, history

- **Search inside conversations.** **Verified here**: `main/providers/history.js:191` matches project, title and first
  prompt only. Orca has opt-in "Search inside sessions"
  ([docs](https://orca.dev/docs/agents/session-history)); cass, Omnilogue and `claude-code-log serve` search all history.
  Harbor already parses every provider's transcripts; one SQLite FTS5 index fed by the existing watcher fits Harbor's rule
  against whole-file rereads.
- **Export a conversation** to HTML or Markdown, local file only ([claude-code-log](https://github.com/daaain/claude-code-log),
  [claude-code-transcripts](https://github.com/simonw/claude-code-transcripts)). Publishing to a gist is a public step and
  would need Pat's call.
- **Session analytics.** Tool counts, error and retry rates, time spent, spend per branch or PR, and model-versus-model on
  your own history ([codeburn](https://github.com/getagentseal/codeburn)).
- **Quote chat text into the next message** (Conductor 0.95, T3 Code v0.1.10). Small.

## 6. Cost and limits

- **Dollar cost per session and project, labelled "API-equivalent".** It is the most repeated feature in the ecosystem
  ([ccusage](https://github.com/ccusage/ccusage) has 19.6k stars; codeburn, tokscale, Conductor 0.96 and Paseo 0.17.2 also do
  it). It needs the usage block in Claude records plus Codex rollouts and a price table.
  - **Cursor transcripts carry no token counts** ([forum](https://forum.cursor.com/t/record-token-usage-in-local-agent-transcripts/175149)),
    so Cursor would show plan meters only.
- **Projected percent at reset on each meter** (`→NN%`, as in
  [claude-code-usage-bar](https://github.com/leeguooooo/claude-code-usage-bar)). Harbor already has used percent and reset
  time, and needs only a short sample history. Small.
- **Alerts before a plan runs out, and "which plan has the most room".** [ccswap](https://github.com/errhythm/ccswap)
  switches at 90%. Harbor already has move-session-to-plan. Small to medium.
- **Auto-resume after a usage limit.** Conductor 0.99, Orca 1.4.272 and Paradev do it. Claude has its own setting,
  `autoContinueAtUsageLimit` (2.1.234), which continues at most three times. **Verified here**: Harbor has no auto-resume code.
- **Waste findings.** codeburn's `optimize` finds unused MCP servers, a bloated CLAUDE.md and repeated file reads; Claude's
  status line now carries the cache-miss cause (`prompt_cache`).

## 7. Automation

- **Scheduled and recurring runs.** Orca has cron or RRULE schedules, a precheck that can skip a run and run history
  ([docs](https://orca.dev/docs/cli/automations)); Emdash, Paradev and T3 Code also have them. agy has `/schedule`, Claude
  `/loop`.
- **A lifecycle hooks file** (agent-manager's `hooks.toml`, Paseo and Emdash) lets a person script reactions to "session
  done" or "review requested" without code changes.
- **Codex `codex queue --thread <id> --message`** (0.149.0) delivers text to a session without typing into its pane. It
  needs Codex's own daemon.

## 8. Phone and attention

- **One "needs you" list across all sessions, with Ctrl+Tab to the next one.** Orca's phone Agent Home, Parallel Code's
  Needs you / Stopped / Working / In pull request groups, and Zed's thread switcher do this.
- **Approve or deny from a push notification**, through the Claude `PermissionRequest` hook and ntfy or web push
  ([claude-remote-approver](https://github.com/yuuichieguchi/claude-remote-approver)). Pushes carry only the session name,
  and pairing uses a PIN ([Parallel Code phone.md](https://raw.githubusercontent.com/johannesjo/parallel-code/main/docs/phone.md)).
- **Stuck-status escape hatches.** Orca checks a heartbeat from the desktop to catch stale statuses; Paradev has a manual
  "Clear status" ([docs](https://docs.paradev.com/agent-status)).
- **Phone reliability.** Orca queues sends while the desktop is unreachable and keeps drafts across restarts (1.4.254).

## 9. Orchestration practice

1. **A gate before work counts as done.** Claude's `TaskCompleted` and `TeammateIdle` hooks block completion on exit 2
   ([agent teams](https://code.claude.com/docs/en/agent-teams)). For Harbor: a lane does not land until the project's test
   gate passes.
2. **A wall-clock and stall cap per worker.** Claude headless runs can hang with no inactivity watchdog
   ([#87692](https://github.com/anthropics/claude-code/issues/87692)). Check `terminal_reason`, not just `subtype: success`.
3. **Sizing.** 3 to 5 workers, 5 to 6 tasks each, one owner per file, because same-file edits overwrite
   ([docs](https://code.claude.com/docs/en/agent-teams), [Osmani](https://addyosmani.com/blog/claude-code-agent-teams/)).
4. **Never parallelise sequential work.** Every multi-agent variant lost 39 to 70% on sequential tasks
   ([Google research](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/),
   read as a summary).
5. **Reviewers with separate lenses** (security, performance, tests), **plus a second model.** Execution-based and
   execution-free verifiers each plateau around 42 to 43%; combined they reached 51% ([R2E-Gym](https://arxiv.org/abs/2504.07164)).
6. **A serialised landing queue.** One lock, rebase, test, merge, one lane at a time.
7. **Best-of-N only for high-value tasks, with a judge that sees the whole run.** A judge that sees only the final patch
   did worse than no selection in one result. Parallel Code calls this "Arena" (2 to 4 agents).
8. **Spec-first, kept light.** Kiro-style waves of independent tasks ([docs](https://kiro.dev/docs/specs/)), with the spec
   optional per batch. Fowler found full spec-first heavy for small fixes
   ([article](https://www.martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html)).

## 10. Per-CLI notes

**Claude Code**
- Expose idle compaction: sessions of 200K tokens or more compact after about 54 idle minutes (2.1.299). It belongs beside
  the cache-warmth chip.
- Add output styles, `/skill-doctor` and `/reload-skills` to the menu.
- Queue controls: send now, and take back (2.1.275 and 2.1.312). Harbor already parses queue records.
- MCP tasks can ask questions mid-task (2.1.304). That is a new question source for the answer cards.
- Transcripts now record every API request (2.1.300). **Verified here**: 8.4 of this session's 23.6 MB are
  `api-request` and `api-request-blob` records. Harbor already accounts for them (`transcript.js:2250`, `pending-ask.js:143`).
- Set-aside `*.orphaned-<ts>-<suffix>.jsonl` files end in `.jsonl`, so a `*.jsonl` glob picks them up. **Verified here**:
  none exist on this machine now, but the history index should skip them.
- The sandbox does not run on native Windows, only WSL2.
- Native Windows has the self-updater crash ([#65478](https://github.com/anthropics/claude-code/issues/65478)): the updater
  renames `claude.exe` and every session dies. **Verified here**: Pat's settings set `DISABLE_AUTOUPDATER=1`. Harbor could
  record each session's CLI version at launch and show drift.

**Codex**
- Profiles moved to `~/.codex/<name>.config.toml` in 0.134.0. **Verified here**: Harbor's Codex "profiles" are separate
  homes, not `[profiles.x]` sections, so this does not affect it.
- Consider `/review`, `/plan`, `/goal` and `/side` in the menu.
- Paginated rollouts (0.144.0) are already handled. Compressed cold rollouts (0.142.0) are off by default.

**Cursor CLI**
- Its modes (plan, ask, debug) and an `&` cloud hand-off belong in the window header, since a handed-off chat stops changing
  locally.
- `agent persist` (v2026.08.26) keeps an agent running after detaching; its docs are thin.
- Windows traps:
  - imported Claude hooks run under bash when `MSYSTEM` is set, and every tool call is silently denied;
  - `agent.cmd` uses PowerShell 5.1, which can glue arguments together;
  - Smart App Control blocks its unsigned modules (v2026.11.17).
  A startup health check could name these.

**agy**
- Show subagents, background tasks and the step checklist from the status line.
- Read artifacts (`implementation_plan.md`, `task.md`, `walkthrough.md`) into the Files view. That layout comes from
  community write-ups.
- Re-read after `/rewind` and `/fork`.
- Quota drain reports are open: about four times the quota through `agy acp` in 1.5.17
  ([#1890](https://github.com/google-antigravity/antigravity-cli/issues/1890)), and safety pre-checks re-running on HTTP 429
  ([#1886](https://github.com/google-antigravity/antigravity-cli/issues/1886)).
- The updater console flash ([#1866](https://github.com/google-antigravity/antigravity-cli/issues/1866)): **verified here**,
  Harbor already sets `AGY_CLI_DISABLE_AUTO_UPDATE=true` for every agy it starts (`gemini-config.js:28`), and the console
  sentinel logged no agy window.
- A second `agy -p` resuming another live conversation ([#1884](https://github.com/google-antigravity/antigravity-cli/issues/1884)):
  **verified here**, Harbor's print-mode runs (gemini-worker, `agy-usage.mjs`) use their own profile folders, apart from the
  interactive sessions.

## 11. Speed and reliability lessons

- **Many windows.** Paradev keeps only the most recent terminals live, and cut its renderer heap from 581 to 286 MB and its
  scrollback from 80,016 to 20,004 lines ([changelog](https://paradev.com/changelog/2026-07-19-performance-memory-and-load)).
  Orca virtualises long tool runs and pauses hidden chats (1.4.259, 1.4.263). Harbor allows 16 windows.
- **Size.** Resend the size after attach and once the child is ready. Claude's agent view renders at a stale width
  ([#80123](https://github.com/anthropics/claude-code/issues/80123)), and ConPTY reflow desyncs are an open megathread
  ([terminal #15976](https://github.com/microsoft/terminal/issues/15976)). This may explain some of Harbor's screen misreads.
- **node-pty.** **Verified here**: the daemon bundles 1.1.0. The 1.2.0 betas fix Windows ConPTY event-loop blocking,
  a use-after-free and a worker deadlock ([releases](https://github.com/microsoft/node-pty/releases)). Worth testing before
  adopting.
- **Shutdown.** `ClosePseudoConsole` can block on an undrained output pipe: drain first, then close on a separate thread
  ([pitfalls](https://docs.rs/crate/conpty-oxide/0.1.2/source/docs/conpty-pitfalls.md)). Put interactive sessions in a Job
  Object at creation too, so killing the root kills the tree.
- **File watching.** When the Windows watcher overflows (an 8 KB default buffer), it reports nothing. Treat that as "rescan
  this folder" ([Microsoft](https://learn.microsoft.com/en-us/archive/blogs/winsdk/the-filesystemwatcher-buffer-size)).
- **Restarts.** Paradev splits output and control onto separate sockets after attach timeouts, and marks an unclean
  shutdown for "cold restore" ([post](https://paradev.com/blog/terminal-daemon-deep-dive)).
- **Workers.** Scrub secrets from worker environments; Claude teammates inherit the lead's permission mode and it cannot be
  set per teammate.

## 12. Smaller polish worth taking

- Fold runs of consecutive tool calls and thinking into one row (Conductor 0.96).
- Open a subagent in its own view, and add a "show full output" toggle (Orca).
- Keep the computer awake while agents work (T3 Code v0.1.10).
- On first run, suggest projects from folders where the CLIs already ran (Paseo 0.15.2).
- Add a "hidden projects" list and per-agent on/off toggles in the session browser (Orca 1.4.259).
- Archive finished workspaces on a rule, with a deletion preview (Orca 1.4.259).
- Copy chosen gitignored files (`.env`, local config) into a new lane (ccmanager's `.worktreeinclude`).
- A one-click install of a cross-CLI safety guard ([cc-safety-net](https://github.com/kenryu42/cc-safety-net), 15 CLIs,
  Windows).
- Show whether CLAUDE.md, AGENTS.md and GEMINI.md disagree; link out to [ruler](https://github.com/intellectronica/ruler) or
  [rulesync](https://github.com/dyoshikawa/rulesync) rather than rebuilding them.

## 13. Looked at and not worth borrowing

- **coder/agentapi.** Archived 2026-09-13. It decides "stable" from screen text that stays the same.
- **Claude Channels.** A research preview with an allowlist only.
- **Claude Remote Control.** It goes through Anthropic's servers.
- **Gemini CLI.** Replaced by agy.
- **Statusline projects and menu-bar monitors.** Harbor draws its own.
- **Containers (container-use).** Early, Docker-based, and no native Windows sandbox to pair it with; defer.
- **Shut down or off target.** Terragon, 1code, Vibe Kanban's company (its code continues as community open source),
  Omnara (now a hosted platform), Crystal (replaced by Nimbalyst) and opcode (no release since 2025-08).

## 14. Projects compared

- **Desktop and web managers:** Orca, T3 Code, Paseo, Paradev/Superset, Emdash, Nimbalyst, Conductor (closed source),
  Vibe Kanban, Parallel Code, Claude Code UI / CloudCLI, opcode, agent-manager, ccmanager, Vibeyard, Pane, Zed's agent panel.
- **Phone and remote:** Happy, Omnara, claude-push, claude-remote-approver.
- **Usage and history:** ccusage, codeburn, tokscale, Claude-Code-Usage-Monitor, claude-code-usage-bar, ccswap, caut,
  claude-code-log, claude-code-transcripts, Sniffly, Omnilogue, cass.
- **Rules and safety:** cc-safety-net, ruler, rulesync.
- **Orchestration and specs:** Claude agent teams, spec-kit, BMAD, Kiro.

None runs its own session daemon with chat windows built from transcripts the way Harbor does. Orca is the closest in
scope: all four CLIs, a Windows build and a phone app.

## 15. Not verified

- Whether real Claude Code receives a keeper's OSC 7501 answer through ConPTY, and whether Codex waits for one.
- A Claude registry record in the `waiting` state.
- Whether a slow Claude `PermissionRequest` hook blocks the dialog.
- Which Cursor hooks fire in `cursor-agent` on Windows (the docs and forum reports disagree).
- agy's subagent record format and artifact folder layout. Both come from community write-ups.
- Several star counts and dates. Orca's 138.9k stars was seen once and looks high.
- Competitor features were read from docs and release notes, not used.

The OSC 7501 test scripts are beside this report. To run them, see the header of each file.
