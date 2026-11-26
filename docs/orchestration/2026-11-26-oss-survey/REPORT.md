# What Harbor could borrow from similar projects and from the four CLIs (2026-11-26, second pass)

Pat asked for a thorough look at open-source projects like Harbor, and at the four CLIs themselves, then for "one level
deeper", using Firecrawl and god Chrome to reach every site. This is the merged result of both passes.

**Sources.** The first pass was seven research summaries; its report is commit d47ce4c0. The second pass read primary sources:
- **W1:** every docs page and 2026 changelog entry of Orca, Paseo, T3 Code, Paradev, Conductor, Emdash, Nimbalyst and Vibeyard. That includes all 64 Orca pages the first pass could not open.
- **W2:** the source code of Orca, Parallel Code, T3 Code, Paseo, Paradev and Emdash for each mechanism below, plus the 60 most-commented and most-reacted issues of 11 repos (660 issues).
- **W3:** every page of the four CLIs' docs, the full changelogs of all four, and the Agent Client Protocol site (about 1,000 pages).
- **W4:** 38 Hacker News threads, 34 Reddit threads (through god Chrome), 12 Cursor forum topics and GitHub issue votes.
- **W5:** all 1,622 projects in six "awesome" lists and three 2026 roundups, with the READMEs of 273 projects that have 300 or more stars.
- **Local tests on the Legion:** whether each CLI's state reports reach Harbor through Windows ConPTY.

The detailed reports are in `deep\` beside this file: `W1-competitor-docs.md`, `W2-source-and-issues.md`, `W3-cli-docs.md`,
`W4-community.md`, `W5-long-tail.md` and `LOCAL-TESTS.md`. Every claim there carries its URL or file and line.

**Marks.** "Verified here" means checked on this machine or in Harbor's code on 2026-11-26. Everything else is what the cited
page, code or issue says; no competitor was installed or run. "Threads" counts are W4's hand tally of separate discussions;
"repos" counts are W2's count of the 11 trackers that raise a theme.

**Versions.** Installed here: Claude Code 2.1.321, Codex 0.167.0, agy 1.5.14, and node-pty 1.1.0 in Harbor's daemon. Newest:
Claude 2.1.332, Codex 0.172.0, agy 1.5.18, Cursor CLI v2026.11.19, node-pty 1.2.0-beta.18.

## What changed since the first pass

- **Claude's state reports can reach Harbor, but only on a newer ConPTY (verified here).** Windows' built-in ConPTY never
  delivers the terminal's answer to Claude, so Claude never reports. The ConPTY bundled with node-pty 1.2.0-beta.18 does:
  a real Claude reported `idle`, then `working` and `done` for a test turn. Codex reports under Harbor's current ConPTY with
  no answer needed. agy reports once `AGY_CLI_OSC7501=on` is set. Details in section 1 and `deep\LOCAL-TESTS.md`.
- **Harbor already has two things the first pass recommended.** Each session already runs in its own Windows Job Object
  (`app/src/daemon/win-job.js:3`). Harbor also already reads agy's subagent rows (`gemini-store.js:1-30`).
- **Paradev's "keep only the 12 newest terminals live" never parks a running coding agent** (its own changelog). For agent
  windows, the lessons are Orca's: hibernate finished agents, and pause updates for hidden chats (section 13).
- **Conductor is shutting down.** New sign-ups stopped 2026-11-04, its cloud went read-only 2026-11-13, and the local app
  winds down in early 2027 (HN 50369503). Vibe Kanban is sunsetting. Superset is now Paradev (MIT since 2026-11-04).
- **Two tools users name more than most were missing:** cmux (28,978 stars, macOS) and Herdr (52,948).
- **Corrected dates:** Paseo's PR watch is 0.17.1, not 0.17.0. T3 Code's PR watch dates to v0.1.0 (2026-10-15).
- **Orca's star count is real:** 139,007 on the GitHub API.
- **Parallel Code runs on macOS and Linux only.** T3 Code is a chat app over each CLI's programmatic interface
  (Claude Agent SDK, Codex app-server, `@cursor/sdk`, ACP for agy); it hosts no terminals.

## The short list (fifteen items, ranked)

Each item gives the user demand, how the best competitor built it, and what Harbor has today. Effort: small is days,
medium is a week or two, large is more.

1. **Session state from the CLIs, not the screen** (medium).
   - **Demand:** "Which agent needs me" is the top want (10 threads). "Wrong state" is raised in 8 of 11 trackers, and is
     worst in the screen-reading tools.
   - **Plan:**
     - Codex: read its OSC 7501 reports, which arrive today.
     - agy: set `AGY_CLI_OSC7501=on`.
     - Claude: two routes. One is the newer ConPTY (node-pty 1.2.0 with `useConptyDll`), with the keeper's headless xterm
       answering the terminal's questions; the keeper already feeds every byte into one (`daemon/keeper.js:268`,
       `daemon/screen.js:4`). The other is Claude's hooks (`Stop` with its `background_tasks` list, `StopFailure`,
       `Notification`) and `claude agents --json`.
   - **Copy:** Orca's scanner, grammar limits and the rule that hooks outrank OSC reports until 2 minutes of hook silence
     (W2 2.1.D).
   - **Harbor today:** none of these are read (verified here). Section 1.
2. **One "needs you" view with jump-to-next, and phone push with approve or deny** (medium).
   - **Demand:** 10 threads want the view and 9 want phone push. Completion alerts and approval pushes come up in 5 trackers.
   - **The gap:** no competitor documents answering an approval from the notification itself (W1). Harbor's phone app has a
     service worker but no push handler (`app/web/public/sw.js`, verified here), and desktop alerts fire only on
     working-to-idle (`main/notify.js`). Section 2.
3. **A changes and review pane** (large; a per-turn "files changed" card first, small to medium).
   - **Demand:** 6 threads and 6 trackers. Every strong competitor has one.
   - **Copy:**
     - T3 Code's "Turn changes" is built from git state, using a temporary `GIT_INDEX_FILE` plus `write-tree` per turn. It
       catches Bash and subagent edits, which tool records miss, and leaves out what a pull or merge brought in.
     - Orca sends all line comments to the agent as one batch.
     - Emdash clears a comment only after delivery is confirmed.
   - **Harbor today:** no diff view (verified here). Section 3.
4. **Usage limits: auto-resume, a plan-room projection, each session's share of the limit, and continue on another plan or
   CLI** (small to medium each).
   - **Demand:**
     - 10 threads ask for limits to be visible, and openai/codex #21073 has 94 reactions.
     - Failover across several accounts is raised in 4 trackers, and no competitor has solved it. Harbor already has 15
       Claude plans and move-session-to-plan.
   - **Copy:**
     - Orca's auto-resume lessons: no Continue button that hits the same limit again, cancel per chat, ignore resets older
       than 24 hours, continue on a switched account.
     - T3 Code's idempotent resume command.
   - **Harbor today:** an API-error turn counts as idle (`shared/claude-turn-state.cjs:9`, verified here), and nothing resumes.
     Section 7.
5. **Find in the open window, then search across all conversations** (small, then medium).
   - **Demand:** 5 threads and 4 trackers.
   - **Copy:**
     - Orca's index: SQLite FTS5, incremental append by byte offset, a 20 s reconcile, and splitting identifiers into words.
       FTS5 works in this machine's Node 24.19 `node:sqlite` (verified here).
     - Conductor's in-chat find also searches thinking and opens the collapsed group holding the hit.
   - **Harbor today:** search matches project, title and first prompt only (`main/providers/history.js:191`). Section 6.
6. **Workspace facts on every rail row: branch, changed files, PR, open ports; and a warning when two live sessions share
   one folder** (small for git, medium for ports).
   - **Demand:** 10 threads want automatic worktrees with their `.env` and ports, and 8 describe agents colliding on files,
     ports and databases.
   - **Seen in:** cmux, abtop and claude-bulkhead. Harbor's own 2026-11-06 commit that swept up another session's 18 staged
     files is this exact case.
   - **Harbor today:** nothing reads branch, dirty state or ports per session (W5, verified). Section 8.
7. **Plan, to-do, goal and background-work panels** (small to medium).
   - **Harbor today:**
     - Plan approval draws only in the terminal (`renderer/stage/dialog-state.cjs:11`).
     - The to-do list is a bare "Updated todos" row (`main/providers/transcript.js:543`).
   - **Data the CLIs already provide:**
     - Claude's Stop hook lists background shells, monitors, subagents and workflows (`background_tasks`).
     - Codex's app-server has `turn/plan/updated` and `thread/goal/*`.
     - agy's status line has `task_count`, `subagents[]` and an N/M step count. Harbor's tee drops these fields
       (`gemini-status-tee.cjs:45-54`, verified here).
   - **Watch:** Claude offers TodoWrite only to older models since 2.1.268, and Codex's plan tool has been off by default
     since 0.152.0. Section 5.
8. **Rewind and fork** (medium to large).
   - **Copy:**
     - T3 Code's "Edit from here" restores the conversation only, or files too, and restores files only when no other
       session shares the worktree.
     - Paseo's changelog lists the rewind cases that broke, which makes a ready test list.
     - Orca rewinds Claude through the Agent SDK's `forkSession` (`upToMessageId`).
   - Section 4.
9. **Cost and context weight per session** (small to medium).
   - **Copy:** Orca's price table, its dedupe key `message.id:requestId`, and its "inferred" and "partial" labels.
   - **Show:** each session's share of the plan window (W5). Also a "what is sent every turn" view: skills that arrive as
     bare names past the listing budget, the weight of MCP servers, and the size of instruction files.
   - **Watch:** Harbor's homes share transcripts through junctions, so the same file shows up under several paths. Count by
     record, never by file path (T3 Code #7858 double-counted exactly this way).
   - Section 7.
10. **Guard rails for parallel workers** (small each).
    - A test gate before a lane lands.
    - A check that a worker's claimed work matches its diff (dos-kernel).
    - A "looping x6" mark when the same command keeps failing (MartinLoop).
    - Wall-clock and stall caps.
    - One owner per file, and no parallel runs of sequential work.
    - Section 10.
11. **Runtime isolation per lane** (medium): copy chosen ignored files (`.env`) into a new worktree, give each lane its own
    port range and temp folder, and offer a setup hook per project. Per-worktree setup is raised in 8 trackers; Harbor's
    lanes give separate worktrees but nothing else (`docs/claude/lanes.md`). Section 8.
12. **Speed with many windows** (medium).
    - **Copy:**
      - Orca hibernates finished, idle background agents and pauses updates for hidden chats.
      - Orca caps the queue of answers the keeper writes back to the terminal.
      - Orca's and Paradev's resource views show CPU and memory per session.
    - Section 13.
13. **Codex through its app-server, and an Agent Client Protocol pilot for Cursor and agy** (medium, exploratory).
    - **Codex:** `codex --remote` attaches the real terminal to an app-server Harbor would start. That gives exact approval
      state, steering, plans, goals and rate limits without screen reading.
    - **Cursor and agy:** they speak ACP natively. Claude does not; its adapter runs the Agent SDK, not the CLI.
    - Section 11.
14. **Scheduled runs and an issue-to-session flow** (medium). Orca, T3 Code, Paradev, Paseo and Emdash all have schedules;
    the shared lessons are a precheck that can skip a run, a duplicate key, at-least-once delivery stated plainly, and a
    filter so an agent's own comments do not retrigger it. Section 9.
15. **Windows hardening from other projects' bug trackers** (small each).
    - Hook launchers must not be wrapped in `conhost`.
    - One stuck terminal must not take the daemon down.
    - Kill the whole process tree on a timeout: Git's launcher leaves the real `git.exe` running.
    - Check that a junction's target exists before creating it.
    - Section 12.

## 1. Session state from the CLIs themselves

**The report format (OSC 7501).** Spec rev 0.4 (2026-10-10): `ESC ] 7501 ; state=<idle|working|done|error|blocked|clear>`
plus `kind=<permission|question|auth>` on `blocked`, and `app`, `msg` (base64), `id` and `progress`. A program may first ask
`ESC ] 7501 ; ? ST`. The terminal must answer `ESC ] 7501 ; ? ST`, and may list the states and kinds it supports; a bare `?`
means all of them (W2 item 6).

**Local results on the Legion** (`deep\LOCAL-TESTS.md`; scripts `osc7501-*.cjs` beside this file; every run of the bundled
ConPTY checked by the console sentinel, `visible=0`):

| CLI | Built-in ConPTY (Harbor today) | ConPTY 1.25 bundled in node-pty 1.2.0-beta.18 |
|---|---|---|
| Claude 2.1.321 | Claude asks. The answer never arrives: its debug log says `programStatus=no (probe: no reply to OSC 7501 ; ?)`, with or without the host's answer. No reports. | The questions pass through to the host (`ESC[c`, `ESC[>0q`, `ESC[?u`, `ESC]7501;?`). With the host answering DA1 and 7501, Claude logged `programStatus=yes` and reported `idle` at its prompt, `working` 0.9 s after a prompt, and `done` 1.5 s later. With no answers, Claude's startup check did not finish within 16 s. |
| Codex 0.167.0 | Reports `state=idle:app=codex` with no question asked. Works today. | Not tested. |
| agy 1.5.14 | Asks only, by default. With `AGY_CLI_OSC7501=on` it reports `blocked:kind=auth`, then `idle`, without asking. | Not tested. |

**How Orca built it** (W2 2.1.D, with code links):
- A stateful scanner keeps partial frames across chunks and caps a report at 4,087 bytes. It also watches prompt-start
  (`ESC ] 133 ; A`) and full reset, because those end a report's lifetime.
- `done` and `error` outlive the program. `working` and `blocked` end at the next prompt or at exit. A permission or
  question block belongs to the turn; an auth block outlives it.
- The 7501 answer comes from a headless xterm in Orca's terminal daemon, and it must be sent before the DA1 answer. A
  program that sees DA1 first concludes the terminal has no support.
- Hooks outrank OSC reports until 2 minutes of hook silence. agy's `done` can arrive about 100 ms before its subagent's Stop
  hook, so Orca retries a refused `done` once after 2 s.

**Claude's other channels** (W3 section 2):
- **Hooks Harbor does not use:**
  - `Stop` carries `last_assistant_message` and `background_tasks[]`. Only `subagent`, `teammate` and `workflow` mean the
    turn will produce more; shells, monitors and MCP tasks do not (Vibeyard's `HOOKS.md`).
  - `StopFailure` fires on API errors. `Stop` does not fire on a user interrupt.
  - `Notification` matchers: `permission_prompt` after about 6 s, `idle_prompt` after about 60 s, and
    `quota_auto_resume_*`.
  - `SubagentStart` and `SubagentStop`.
- **Registry:** `claude agents --json` is the documented reader. Its fields are `status` (busy, waiting, idle) and
  `waitingFor` (permission prompt, input needed, sandbox request, worker request, dialog open). Harbor panes are
  interactive sessions, so `state` is absent for them. The `sessions\<pid>.json` files are undocumented.
- **Claude 2.1.326 (not installed here)** improves the reports. Background work counts as working, and the trust screen
  reads as waiting.

**Codex's other channels:**
- Hooks: `Stop`, `PermissionRequest`, `Interrupt`, `SubagentStart/Stop` and more.
- App-server events: `thread/status/changed` with `waitingOnApproval`, `turn/started`, `turn/completed`.
- Parallel Code trusts its Codex hooks per launch with `-c hooks.state={...trusted_hash...}`, taking the hash from the
  app-server's `hooks/list`, so the person's own config is never touched (W2 2.2).

**agy's other channels:**
- Hooks: `Stop` with `fullyIdle` and `continuation_active`, and `PreToolUse` decisions. Note: agy reads hooks from
  `~/.gemini/config/hooks.json`, not from `antigravity-cli/settings.json`.
- The status line documents seven `agent_state` values (adds `reviewing`, `initializing`, `error`).

**Hook lessons from other trackers:**
- Hook injection is a recurring complaint in 4 trackers (Vibeyard #56: "hooks break Claude Code terminal immediately after
  installation"). Any Harbor hook must only observe, fail open, and be removable.
- Orca writes its hook endpoint to a file that each hook re-reads, so sessions that outlive an app restart still reach it.
  This matters because Harbor's sessions outlive its main process by design.
- **One open question worth a probe:** Orca's code says Claude auto-blocks a `PermissionRequest` hook held longer than
  2:00, and holds its own for 122 s. Harbor's ask hook waits up to 12 hours and steps aside on timeout
  (`bin/harbor-ask-hook` header). A search of the Claude 2.1.321 binary found no such limit (verified here); it was not
  tested live.

## 2. Attention and the phone

**Demand:**
- 10 threads want one view of who needs them, with a jump.
- 9 threads want phone control with push and approve.
- Notifications that are missed or fire only once appear in 5 trackers (T3 Code #780, 64 reactions).
- Users also say a list that only shows what needs them still leaves them doing the scheduling. They want the question and
  a default answer in the alert, which Harbor's in-window answer cards already do on the desktop.

**What others built:**

| Product | What it does |
|---|---|
| Orca | Header bell, an Agents feed, and an experimental Needs You column. A subagent waiting on permission shows its parent as "waiting". |
| Conductor | A "Next workspace" jump to whatever needs attention (0.36.4). |
| T3 Code | Finished, failed or waiting threads return to the top. Snoozed threads wake on approvals, questions and errors. |
| Paradev | "Clear Status" for a stale state. |

Phone push:
- T3 Code: push, iOS Live Activities and Android live updates for finished, failed, needs approval or needs input. Background
  push requires its relay; direct or Tailscale connections get none.
- Orca: push on finish, and needs-input-only alerts (1.4.246). Questions and approvals are answered inside the app.

**Harbor today (verified here):**
- Desktop: OS notifications on working-to-idle for unfocused panes (`main/notify.js`). No jump-to-next key was found.
- Phone: the web app answers cards. Its service worker handles install, activate, message and fetch, but not push.

**Fit:**
- Web push works for an installed iPhone web app over HTTPS, and Harbor's phone app is already served through
  `tailscale serve`.
- A push carries only the session name and the question. Approve and Deny buttons in the notification post back to
  Harbor's own server.
- Pushover, which Pat's texting already uses, is a fallback.
- Not tested: action buttons on iOS web push.

## 3. Review and git

**Ways to define "what changed":**

| Product | Source of the diff |
|---|---|
| T3 Code | Four sources: Turn changes (git-based; leaves out what a pull or merge brought in), Uncommitted, Against base, Commits (W1 7.1, W2 2.3.B). |
| Orca | Diff against a start-from ref. |
| Conductor | Snapshots the branch into a private git ref before every response. |

**How comments reach the agent:**
- Orca collects line comments and sends them in one batch, because single comments make the agent "swing back and forth".
- T3 Code turns each comment into a chip in the composer.
- Emdash keeps a comment pending until delivery is confirmed.

**Details worth copying on day one:**
- Mark files as viewed, and show them again when a later commit changes them.
- Fold resolved threads into small markers on their line.
- Peek at a file's diff on hover.
- Per-hunk keep or revert (Nimbalyst).
- Apply ticked hunks from several tasks as one all-or-nothing `git apply` (wmux).

**Related:**
- A review button that sends `/code-review` (Claude) or runs `codex review --uncommitted`.
- A PR badge, and an agent that watches its own PR: T3 Code v0.1.0, Paseo 0.17.1.
- Link sessions to the commits they made, and restore an edit another session overwrote, from the recorded `old_string`
  (deja-vu).

## 4. Recovery: rewind, fork, handoff

- **Rewind:**
  - T3 Code has two modes, conversation only or files too.
  - Orca's "Rewind to here" works in its structured chat mode only, not in terminal panes.
  - Conductor keeps one checkpoint per user message in a private git ref.
  - Paseo's fix list is a ready set of test cases:
    - after a turn with subagent messages, and after a turn with no response;
    - Claude with `CLAUDE_CONFIG_DIR` set ("Session not found"), which matters for Harbor's 15 homes;
    - Codex 0.151 paginated threads, and Codex 0.156's renamed `thread/rollback`.
- **Fork:**
  - Paradev uses each CLI's own fork command, and refuses a fork when the source session is gone.
  - Codex `thread/fork`, agy `/fork` and Cursor `/fork` all copy the conversation, not the files.
- **Handoff to another CLI or plan:**
  - Paradev sends the last 36,000 characters, marked read-only, and tells the new agent to check `git status` first.
  - T3 Code sends a history budget (16,000 tokens by default), leaves out raw tool state, and lets the new agent fetch more.
  - Orca offers a handoff at a usage limit.
  - Harbor's handoff chain (`renderer/stage/handoff-chain.cjs`) stays inside one session, and move-session-to-plan stays
    inside Claude.
- **Automatic handoff at a context threshold:** an opt-in "hand off at 85%" trigger for Harbor's existing chain
  (aigent-os does this at 80%).

## 5. Plan, to-do, goal, background work, subagents

| Data | Claude | Codex | Cursor | agy |
|---|---|---|---|---|
| Plan | `~/.claude/plans/`, `ExitPlanMode` record | `turn/plan/updated` (app-server), item `plan` | `--mode plan`; ACP `cursor/create_plan` | plan mode, `cycle_mode`, artifacts `implementation_plan.md`, `task.md` |
| To-dos | TodoWrite and Task records, offered only on older models since 2.1.268 (`CLAUDE_CODE_ENABLE_TODO_TOOLS=1`) | plan tool off by default since 0.152.0 | ACP `cursor/update_todos` | `update_steps` N/M (1.5.16) |
| Goal | `/goal` (2.1.139); the transcript records a verdict per turn | `thread/goal/*` with token budget and time used | `/goal` (v2026.08.11) | `/goal` |
| Background work | Stop hook `background_tasks[]`; `/tasks` | `thread/backgroundTerminals/*` | jobs list | status line `task_count` |
| Subagents | `<session>/subagents/*.jsonl` | `collabToolCall`; TUI workspace shows them (0.171.0) | `agent-transcripts/<parent>/subagents/` (v2026.10.17); `turn_ended` often missing | `subagents[]` in the status line; `conversation_summaries.db` rows (Harbor reads these) |

How others show this:
- Orca draws Claude's to-do list and Codex's plan inline and in a collapsible panel above the composer, with a Codex goal
  chip (pause, resume, clear).
- Paseo 0.16.0 and Conductor 0.99 show background work above the composer with Stop.
- OpenChamber checks after every turn whether a goal is met and keeps the agent going until it is (a check in the host).

## 6. Finding things

- **In-window find, first and small.** Orca has Ctrl+F plus a rail with a marker per prompt. Conductor's Cmd+F also
  searches thinking and opens the collapsed group holding the hit. Paseo's find reaches beyond the loaded history.
- **Cross-session search.**
  - Orca's index (W2 2.1.A, with code links): SQLite FTS5; new lines appended by byte offset; a reconcile every 20 s;
    identifiers split into words; opt-in per computer.
  - Emdash #2882 shows the trap: a full FTS5 reindex locked its UI. Index in a worker.
  - T3 Code has Cmd+K across message contents, with `"exact phrase"`.
- **Export and replay:** a local HTML or Markdown file (claude-code-log). claude-replay adds playback and a live follow
  mode.

## 7. Cost and limits

- **Auto-resume, as the products that shipped it learned it** (W1 7.4, W2 2.3.A):
  - Orca took 12 releases to get it right (1.4.232 to 1.4.272):
    - it removed a Continue button that hit the same limit again;
    - it ignores resets older than 24 hours, and waits for sleeping workspaces;
    - the setting belongs to the host running the agent;
    - it continues on a switched account (1.4.259).
  - T3 Code stores the reset time on the failed run, makes the resume command idempotent, and starts new threads on
    providers that are not limited.
  - Claude has its own `autoContinueAtUsageLimit` (2.1.234), which continues at most three times.
- **Transient API errors:** Maestro resends a prompt that died on 529 Overloaded with back-off, and one status card replaces
  the wall of errors. Resend only the last prompt, only when no tool ran after it, and never into a window showing a
  dialog. A badge for provider incidents (CodexBar) explains a stalled window.
- **Cost:**
  - Orca's price table, its dedupe key, merging streaming rows by maximum, the 1-hour cache-write rate and long-context
    tiers (W2 2.1.B).
  - Everyone labels the figure an API-equivalent estimate, and Paradev adds "Cost to you: $0" for subscriptions.
  - Cursor transcripts carry no token counts, but its headless results do (`reasoningTokens`, v2026.10.28).
- **Plan room:**
  - A projected `→NN%` at reset on each meter.
  - An alert before a plan runs out.
  - Each session's share of the window (Agent Sessions).
  - Claude's status line also carries `prompt_cache.last_miss_cause` (2.1.260), and Harbor does not read it.

## 8. Workspaces and isolation

- **On each rail row:** branch, changed files and PR from one `git status --porcelain=v2 -b` per folder, refreshed when
  that session's transcript changes (never on a timer). Listening ports from the session's process tree joined to the TCP
  table. W5 points out the daemon already bundles `koffi`, so the TCP table can be read without a CIM query.
- **Two live sessions in one folder:** a badge on both rows. Then the overlap itself, from each session's Edit and Write
  records ("both touched `app/src/main/index.js`"). Show it; do not block.
- **Runtime collisions** (8 threads): ports, databases, temp folders and shared branches. claude-bulkhead's checks show what
  people want guarded.
- **Per-worktree setup** (8 trackers): copy chosen ignored files, link `node_modules`, run a setup hook, and name the branch.

## 9. Automation

| Product | What it does |
|---|---|
| Orca | Cron, a precheck that can skip and record a run, missed-run grace, per-run model and effort, created disabled. |
| T3 Code | Webhook signatures, a 7-day duplicate key, a coalesce window, untrusted values wrapped so they cannot invoke skills, up to 24 hours of buffering while offline. |
| Paradev | States its limits plainly: delivery is at least once, success means the workspace was created, an offline host means a missed run, and an agent's own activity can retrigger it. |

Issue or PR to session: jean, codeg, Cyrus and symphony start an agent in a fresh worktree from a GitHub, Linear or Jira
item. Harbor has the lanes for this, but no issue source.

## 10. Orchestration practice

- A gate before work counts as done: Claude's `TaskCompleted` and `TeammateIdle` hooks; for Harbor, a lane lands only on a
  green test gate. dos-kernel's `dos verify` also fails when the commits do not back a worker's "done".
- **Caps:** wall-clock and stall caps per worker; check `terminal_reason`, not only `subtype: success` (Claude #87692).
  Also flag fix-and-retry loops.
- **Sizing:** 3 to 5 workers and 5 to 6 tasks each, with one owner per file. Never parallelise sequential work: every
  multi-agent variant tested lost 39 to 70% there.
- **Review:** reviewers with separate lenses, plus a second model. Combining verifiers raised SWE-Bench Verified from
  about 43% to 51%.
- **Best-of-N:** only for high-value tasks. Parallel Code's Arena has no automatic judge: a person rates each result.
- **Spec-first, kept light:** Kiro-style waves, with the spec optional per batch.

## 11. Per-CLI integration surface and what is coming

Full tables: `deep\W3-cli-docs.md` sections 2 to 6. The points that change Harbor's plans:

- **Claude.**
  - New hook events keep arriving: `PreSkillShellCommand` in 2.1.332. A settings file that names it opens a dialog on
    2.1.331 and older.
  - 2.1.330 stops Grep and Glob from starting a console host per search, which was a popup source.
  - 2.1.317: a `claude -p` run inside a session now gets its own session ID. `CLAUDE_CODE_DISABLE_NESTED_SESSION_ID=1`
    brings back the old shared ID. W3 read this backwards; checked in the changelog here.
- **Codex.**
  - 0.171.0 turns the TUI workspace on by default (side panes for subagents and previews). Harbor reads Codex's screen, so
    test box detection before installing it.
  - `codex queue` does not reach a `--no-daemon` pane (Harbor measured this, `bin/harbor-msg:27-31`).
  - The app-server is the structured route: approvals, `turn/steer`, `account/rateLimits/read`, plans and goals. Attaching
    the TUI with `--remote` keeps the real terminal. The docs call `ws://` "experimental and unsupported", and do not say
    whether `unix://` works on Windows.
- **Cursor.**
  - Speaks ACP natively (`agent acp`), with extensions for questions, plans and to-dos.
  - Hooks run in the CLI. Since v2026.10.15 a missing hook command reports failure on Windows.
  - Known Windows traps:
    - imported Claude hooks run under bash when `MSYSTEM` is set;
    - `agent.cmd` uses PowerShell 5.1;
    - Smart App Control blocks its unsigned modules.
- **agy.**
  - 1.5.15 keeps every conversation in `~/.gemini/antigravity-cli/conversations`. Check that Harbor's history index still
    finds them.
  - `agy acp` was rough until 1.5.16.
  - Quota-drain reports are open (#1890, #1886).
- **Agent Client Protocol.**
  - v1 is stable, and v2 reached Preview on 2026-11-20. v2 adds `state_update` (running, requires_action, idle), a
    background-work list, plans and subagent sessions.
  - ACP carries no rate-limit windows and no transcript path, so plan meters and the history rail keep their current
    sources.
  - The structured window types in item 13 are a pilot, not a replacement.

## 12. Windows reliability lessons

From W2 section 4, with issue links there:
- **Hook launchers:**
  - Orca wrapped hooks in `conhost` with a `curl` that waited on stdin. Every hook event then blocked for the full 10 s and
    left processes behind (#14837).
  - Antivirus blocked `-WindowStyle Hidden -EncodedCommand` (#16003). Pat's rule rules that form out anyway.
  - Orca's end state is a direct launcher with absolute forward-slash paths, which survive cmd.exe and Git Bash.
  - Codex `commandWindows` hooks fail under PowerShell 5.1 (Paseo #3632).
  - An unquoted `>NUL` under Git Bash creates a file named `NUL`.
- **Popups:** a GUI app owns no console, so every console child gets its own window unless hidden. W2 lists the spawn sites
  others found (`git`, `netstat`, `where`, `gh`, `wsl`, a PowerShell process scan every 2.2 s). Use it as a checklist for a
  spawn audit.
- **The daemon must survive one bad terminal.** Orca's daemon died on "Timed out waiting for PTY process exit" and took
  every session with it (#10415). It also died silently 8 times a day with nothing in Event Viewer (#16797). Record why the
  daemon left, from outside it.
- **Process trees:** on a timeout, Paseo killed only Git's launcher, and the real `git.exe` kept running at 400 MB (#5645).
- **Ports:** Windows reserves port ranges. Harbor's 8787 is outside this machine's reserved ranges today (verified here,
  `netsh`), but the ranges move after reboots and WSL changes.
- **Junctions:** a junction whose target is missing broke agy's `session/new` (T3 #27057). Harbor shares transcripts across
  15 homes through junctions.
- **Hidden then shown:** a full-screen Claude pane draws overlapping text after a hide and show (Orca #7240). A resize nudge
  on show is the cheap test for Harbor's `>_` toggle.
- **Disk:** a PyInstaller agy probe once left one `_MEI*` temp folder per run, 785 GB for one user. There are 0 here
  (verified here).

## 13. Speed with many windows

- **Orca:**
  - hibernates finished, idle background agents, with a long list of vetoes;
  - pauses updates for hidden chats;
  - bounds the queue of answers written back to the terminal (1.4.180);
  - has a Resource Manager.
- **Paradev:**
  - keeps 12 non-agent terminals live;
  - runs git status on a worker pool, and one shared port scan per cycle;
  - has a Machine resources page (CPU and memory by app, workspace and pane).
- **Size:** resend the size after attach and once the child is ready. Claude #80123 and #91198 are stale-size bugs.
- **node-pty 1.2.0** fixes Windows event-loop blocking and a use-after-free, and is the route to Claude's state reports
  (section 1). It is still beta: test screen reading, resize and shutdown on it first.

## 14. Smaller polish

- Tool-call visibility modes: Show all, Hide successful, Hide all, Zen (T3 Code). Folding runs of tool calls (Conductor).
- A rail state between open and closed: settle and snooze, with snoozed sessions waking on a question (T3 Code).
- An agent-set one-line status per session, written at checkpoints (Orca's `worktree set --comment`).
- Quote chat text into the next message. Ask another session from the composer with `@name` (Maestro); Harbor already has
  the transport.
- Status shown by shape as well as colour (vibepanel). An attention badge that grows as an item ages (crystl).
- Keep the computer awake while agents work (T3 Code).
- On first run, suggest projects from folders where the CLIs already ran (Paseo).
- Show what was sent each turn and what was never received (context-tax, claude-devtools).
- Lint CLAUDE.md, AGENTS.md and skills by linking out to agnix, rather than building a checker.

## 15. Looked at and not worth borrowing

- Blocking guards and signed audit logs inside Harbor (claude-bulkhead's blocks, Tracekit, agentdiff): show the fact
  instead.
- Generic agent frameworks, observability platforms, routers, memory servers, and skill and prompt packs (W5 section 4).
- Relays and hosted servers for the phone: they dominate Happy's and T3 Code's failure lists, and Harbor's tailnet avoids
  them.
- Containers: early, Docker-based, and no native Windows sandbox to pair with.
- Driving Claude through ACP: the adapter runs the Agent SDK, not the CLI that Pat's hooks, homes and menus assume.
- Editing messages inside a closed session (Memory Forge): possible, but a bad rewrite loses a session.
- Shut down or stale: Terragon, 1code, Omnara (now hosted), Crystal (now Nimbalyst), claude-code-transcripts (no push
  since 2026-02).

## 16. Projects compared

- **Desktop and web managers:** Orca, T3 Code, Paseo, Paradev, Emdash, Nimbalyst, Conductor, Vibe Kanban, Parallel Code,
  CloudCLI, opcode, agent-manager, ccmanager, Vibeyard, Pane, Zed, cmux, Herdr, wmux, Maestro, OpenChamber, Calyx, abtop.
- **Phone and remote:** Happy, happier, ccpocket, claude-push, claude-remote-approver.
- **Usage and history:** ccusage, codeburn, tokscale, CodexBar, Agent Sessions, claude-code-log, claude-replay, cass,
  Omnilogue, deja-vu, Entire.
- **Safety and rules:** cc-safety-net, claude-bulkhead, agnix, ruler, rulesync.
- **Orchestration and specs:** Claude agent teams, MartinLoop, dos-kernel, agent-bridge, spec-kit, BMAD, Kiro.

None runs its own session daemon with chat windows built from transcripts the way Harbor does. The closest relatives:
- Orca: the broadest scope, all four CLIs, Windows and phone.
- wmux: Electron, ConPTY and its own daemon on Windows.
- Vibeyard: Windows, a grid, several Claude profiles.

Users repeatedly praise four things in a tool like this: local, no account, real CLIs, and sessions that survive updates.
Harbor has all four.

## 17. Still not verified

- Claude's `blocked` reports (a permission prompt) on the bundled ConPTY, and Codex's.
- Harbor's real keeper on ConPTY 1.25: screen reading, resize, shutdown, and whether the bundled `OpenConsole.exe` stays
  windowless under the keeper.
- Claude's reported 2:00 limit on a held `PermissionRequest` hook (section 1).
- Which Cursor hooks fire in `cursor-agent` on Windows.
- Action buttons in iOS web push notifications.
- Codex `--remote` over `unix://` on Windows.
- Competitor features beyond the source files W2 read: they are as documented, not run.
