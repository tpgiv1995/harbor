# W1: competitors' full docs and changelogs (2026-11-26)

Second-level pass under `C:\dev\harbor\docs\orchestration\2026-11-26-oss-survey\REPORT.md`. Brief: `C:\dev\harbor\docs\orchestration\2026-11-26-oss-survey\deep\briefs\_context.md` plus the W1 brief.
Every product claim carries the URL of the page it came from; each page was opened on 2026-11-26. Nothing here is a search snippet. Competitor behaviour is as documented, not run.

## Contents
1. Orca. 2. Paseo. 3. T3 Code. 4. Paradev. 5. Conductor. 6. Emdash, Nimbalyst, Vibeyard (each with a feature inventory by area and a short "how they built the ten items").
7. How they built each of the ten items, across products.
8. Corrections to and confirmations of REPORT.md.
9. New gaps for Harbor (features the earlier report does not mention).
10. What was not read.

## How the reading was done
- Pages were fetched with plain HTTP (curl and Node `fetch`), not through Firecrawl: every site's pages loaded, and three sites publish a full-text file (`llms-full.txt` on docs.paradev.com, www.conductor.build, nimbalyst.com/docs) while two serve a `.md` twin of every page (paseo.sh, emdash.com). One Firecrawl scrape (a GitHub release page) worked but returned a model-written summary that repeated the same lines under different releases, so it was not used as evidence. God Chrome was not needed.
- The earlier pass's "404/403" Orca pages were readable once the host `www.onorca.dev` (not `orca.dev/docs`) was used: all 64 docs pages loaded.
- The GitHub API ran at 60 requests per hour because `gh` on this machine is not logged in (`gh auth status` reports the stored login failed). The budget went to T3 Code's release list (600 entries). Other releases came from `github.com/<repo>/releases` HTML pages, which returned HTTP 429 beyond page 36 for Orca.
- Star counts, from each repo page's embedded count on 2026-11-26: Orca 139,048; T3 Code 80,010; Paseo 25,561; Emdash 6,310; Vibeyard 1,395.

## 1. Orca (stablyai/orca, MIT, desktop for macOS/Windows/Linux plus iOS/Android companion)

Sources read: every docs page in the sitemap (64 pages under https://www.onorca.dev/docs, fetched 2026-11-26; the sitemap lists `orca.dev` URLs but the site's own llms.txt links to `www.onorca.dev`, which is the host that serves them),
the changelog page https://www.onorca.dev/changelog (entries 2026-10-15 to 2026-11-24, v1.4.226 to v1.4.274), and the GitHub release pages (release notes v1.4.104 to v1.4.277, see the additions below this section's inventory). The earlier pass's "404/403" pages were readable by plain HTTP fetch once the host `www.onorca.dev` was used; no page needed god Chrome.
Release notes for June to October are summarised in the list that follows the ten items.

### Feature inventory

**Sessions and layout**
- Worktree-native model: every task gets its own git worktree, agent terminal and browser tab. https://www.onorca.dev/docs/model/worktrees
- Create dialog with Project, Run on (local, SSH, remote server, cloud VM), agent and task links; "Smart" sources: GitHub, Linear, GitLab, Branch, Name. https://www.onorca.dev/docs/model/worktrees
- Tabs, panes, nested splits; tab "+" menu is reorderable with per-action shortcuts (1.4.261). https://www.onorca.dev/docs/model/tabs-panes-splits
- Session restore: a background daemon owns the PTYs, so quitting or crashing Orca keeps agents alive and the app warm-reattaches; host reboot loses processes but keeps layout and last scrollback. https://www.onorca.dev/docs/model/session-restore
- Quick Open (file search ranked by recency plus match), a Jump palette (Cmd/Ctrl+J) over worktrees, and an omnibox that searches tabs, files, URLs, agents and browser history. https://www.onorca.dev/docs/model/quick-open
- Agent state dots, restart chip, and an experimental Agent Dashboard kanban (Needs You / Working / Done / Idle). https://www.onorca.dev/docs/model/agents-sessions
- Native "Chat UI" (structured transcript + composer, Claude, Codex, Grok, OpenCode, Pi, OMP, Antigravity, Copilot, Kimi, Cursor, Hermes, Kiro, Goose, Auggie, Gemini CLI, Droid, Kilo, MiMo, Qwen) with a one-click switch back to the raw terminal. https://www.onorca.dev/docs/agents/native-chat
- Hand Off a chat to another agent; Resume in New Native Chat / Resume in New CLI (moves a conversation between chat and terminal). https://www.onorca.dev/docs/agents/native-chat
- Sleep worktrees manually (Sleep with Descendants), hide sleeping ones with a toggle shortcut. https://www.onorca.dev/docs/agents/hibernation
- Floating workspace, folder workspaces (non-git), multi-repo project groups. https://www.onorca.dev/docs/model/worktrees
- Workspace cleanup with project rules and optional automatic deletion; preserved branches list when git refuses a branch delete (1.4.259, 1.4.262). https://www.onorca.dev/changelog
- Emoji workspace names, branch naming, shared directories and gitignored-file copy into new worktrees. https://www.onorca.dev/docs/model/worktrees

**Chat composer and transcript (structured chat)**
- Queue follow-ups as cards above the composer; steer into the running turn; edit, reorder or delete queued cards. https://www.onorca.dev/docs/agents/native-chat
- Send states: "Sending...", "Not sent" with reason and Retry, "unconfirmed" when the provider transcript cannot prove arrival. https://www.onorca.dev/docs/agents/native-chat
- Continue after a cut-off reply: first asks the agent to check whether its last step finished. https://www.onorca.dev/docs/agents/native-chat
- Slash picker merging commands and discovered skills; `@` file and folder picker; paste images; drag files; "Add to chat" quoting a selection from a file, terminal or Markdown preview. https://www.onorca.dev/docs/agents/native-chat
- Find in chat (Ctrl+F); message rail with one marker per prompt to jump back; up-arrow recalls prompts; folded long messages; a run of thoughts and tool calls collapses to one row. https://www.onorca.dev/docs/agents/native-chat
- Context ring beside the model control (token counts by messages, tools, memory files). Model and effort pills, Fast mode where the agent reports support, Claude model list from the installed CLI. https://www.onorca.dev/docs/agents/native-chat
- Answered approval and question cards stay as receipts; number key answers a numbered question. https://www.onorca.dev/docs/agents/native-chat
- Chat naming from the first message, with a configurable naming agent. https://www.onorca.dev/docs/agents/native-chat
- Inline visuals (charts, diagrams, mockups) and Mermaid with pan and zoom. https://www.onorca.dev/docs/agents/native-chat
- Per-turn "changed files" header with additions and deletions; expand to inline diff cards. https://www.onorca.dev/docs/agents/native-chat

**Review and git**
- Diff viewer: combined diff over staged, unstaged and untracked; image diffs (side by side, swipe, onion skin); merge-conflict three-way UI; stage by hunk or line; whitespace toggle; collapse unchanged; word wrap; file tree; keys j/k, n/p, F7, s, c. https://www.onorca.dev/docs/review/diff-viewer
- Annotate AI Diff: line and range comments, sent as one batch to a chosen agent. https://www.onorca.dev/docs/review/annotate-ai-diff
- Attribution: gutter marker on lines an agent wrote; local only, not committed. https://www.onorca.dev/docs/review/attribution
- Commit, push, PR creation, hosted reviews, issues and Actions; Linear and Jira drawers (Jira boards and sprint views, 1.4.226 and 1.4.229). https://www.onorca.dev/docs/review/commit-push, https://www.onorca.dev/docs/review/github
- Git Graph with checkout, cherry-pick, revert (1.4.255); inline git blame (1.4.262). https://www.onorca.dev/changelog

**Recovery**
- Rewind to here (undo on a sent message; message returns to the composer; needs an idle agent; Codex rewinds the whole turn). https://www.onorca.dev/docs/agents/native-chat
- Fork from this response, `/fork`, `/btw` and `/side` side chats; `/plan` mode for Claude and Codex. https://www.onorca.dev/docs/agents/native-chat
- Auto-resume of working chats after an Orca restart; offer to resume interrupted chats via a status-bar item. https://www.onorca.dev/docs/agents/native-chat
- Hibernation (experimental): pause idle finished agents and relaunch with the same resume flags on reopen. https://www.onorca.dev/docs/agents/hibernation
- Worktree checkpoints: a free-text comment and a card status the agent updates from the CLI. https://www.onorca.dev/docs/cli/worktree-checkpoints

**Plan, tasks, goals**
- TodoWrite and Codex `update_plan` render as inline checklists plus a collapsible progress panel above the composer. https://www.onorca.dev/docs/agents/native-chat
- Codex goal shown above the composer with pause, resume, clear; goal changes appear as transcript rows. https://www.onorca.dev/docs/agents/native-chat
- Background-task strip (agents, shells, monitors, workflows) with per-row Stop; subagents open in their own view and appear as indented sidebar rows. https://www.onorca.dev/docs/agents/native-chat
- Tasks drawers for GitHub, Linear, Jira. https://www.onorca.dev/docs/review/linear

**Search and history**
- Agent Session History panel over 20+ CLIs' own on-disk transcripts; scope Workspace / Project / All; group by project, folder or agent; sort by last updated or relevance. https://www.onorca.dev/docs/agents/session-history
- Opt-in "Search inside sessions" index, per computer; `orca search` CLI over the same index. https://www.onorca.dev/docs/agents/session-history
- Resume, Copy resume command, Copy session ID or log path, Open log. https://www.onorca.dev/docs/agents/session-history

**Cost and limits**
- Status-bar usage for Claude, Codex, Muse, Gemini, Antigravity, OpenCode, Kimi, MiniMax, Cursor, ZCode, GLM plans: 5-hour, daily, weekly windows, an 80% warning chip, credit balances, a roster popover sorted tightest first, Detailed or Compact, % used or % remaining. https://www.onorca.dev/docs/agents/usage-tracking
- Estimated cost in a Stats view from a local price table, labelled inferred or partial when a model is unpriced. https://www.onorca.dev/docs/agents/usage-tracking
- Account hot-swap for Claude and Codex without a restart. https://www.onorca.dev/docs/agents/codex-hot-swap
- Auto-continue a Claude or Codex chat after a usage-limit reset (on by default). https://www.onorca.dev/docs/agents/native-chat

**Automation and orchestration**
- Scheduled automations (hourly, daily, cron) with a precheck shell probe that skips a run, missed-run grace minutes, reuse of a live session, per-run model and effort, run history, Chat or Terminal output. https://www.onorca.dev/docs/cli/automations
- Orca CLI: worktrees, terminals, files, browser automation, artifacts, mobile emulator, skills registry and MCP. https://www.onorca.dev/docs/cli/overview, https://www.onorca.dev/docs/cli/reference
- Orchestration: Runs, Tasks, Dispatches, supervised workers, messages and decision gates (`gate-create` / `gate-resolve`). https://www.onorca.dev/docs/cli/orchestration
- Bots: agents with memory, automations and Slack, GitHub, Linear connectors, security model, import from OpenClaw or Hermes. https://www.onorca.dev/docs/bots
- Computer use (background desktop control on macOS). https://www.onorca.dev/docs/cli/computer-use
- Agent status hooks installed and removed from Settings or `orca agent hooks on|off`. https://www.onorca.dev/docs/agents/hooks-memory

**Phone and notifications**
- Notifications: per-category switches (system, sound, chip-only), per-workspace mute, per-machine opt-out, custom sounds, header bell with mark-unread, Dock badge on macOS. https://www.onorca.dev/docs/notifications
- Agents feed: chronological, threaded, running agents pinned, jump to worktree and pane, multi-select actions. https://www.onorca.dev/docs/activity
- Mobile companion: pairing by one-time code or QR (10-minute expiry) over Orca Relay, LAN or Tailscale; Agents tab across hosts; chat or terminal view per tab; reply, attach, dictate; Source Control (stage, commit, PR review comments, merge resolution); Quick Commands; account switcher; push on agent finish. https://www.onorca.dev/docs/mobile
- "Needs you" list for tool approvals and access requests (bot agents) on the phone. https://www.onorca.dev/docs/mobile
- Queued sends on the phone while the desktop is unreachable; drafts survive restart. https://www.onorca.dev/docs/mobile

**Browser, editor, remote**
- Per-worktree Chromium browser, Design Mode (click an element, send feedback to the agent), browser profiles, Chrome extensions, password manager. https://www.onorca.dev/docs/browser/overview
- Monaco editor with autosave, rich Markdown editor, HTML/Mermaid/PDF/image viewers, file explorer. https://www.onorca.dev/docs/editing/monaco
- SSH worktrees, remote Orca Servers, WSL managed hosts, on-demand cloud VMs. https://www.onorca.dev/docs/ways-to-run
- Plugins (themes, editors, languages, icons, machine recipes). https://www.onorca.dev/plugins

**Performance**
- Resource Manager in the status bar: CPU, memory, sessions, daemon controls, workspace disk scans. https://www.onorca.dev/docs/terminal
- Troubleshooting page advice: close unused worktrees (each keeps file watchers); browser tabs are the biggest RAM use. https://www.onorca.dev/docs/troubleshooting

### How Orca built the ten items

1. **Changes and line comments to the agent.** Source is the worktree's git diff against a start-from ref (changeable to any commit or branch); per-turn changed-file cards come from the agent's own edit records. UI: hover gutter "+", drag or Shift for a range, `c` key, Enter saves; comments pinned and tracked across edits; Resolve collapses a thread. One "Send to agent" button composes one prompt of all line-anchored comments and opens a "Send notes to" menu of the worktree's agents; unresolved comments ride the next batch. The send shortcut is unbound by default. Reason given for batching: single comments make the agent "swing back and forth". Failure handling is not documented. https://www.onorca.dev/docs/review/annotate-ai-diff
2. **Search inside sessions.** Reads each CLI's on-disk transcripts (Codex `~/.codex/sessions`, Claude history, Cursor session log, OpenCode db). List-level filter matches title, cwd, branch, model and preview text. Deep search is an opt-in index per computer (Settings, Session History) and "searchable data stays on each computer"; offline hosts show a notice; a scan limit with "Show more". CLI twin: `orca search`. https://www.onorca.dev/docs/agents/session-history
3. **Plan, task, goal panels.** Checklists are rendered from TodoWrite and `update_plan` records, inline and in a collapsible panel above the composer; a Codex goal chip with pause, resume, clear; `/plan` pill in chat; phone can "pin plans" and "manage goals" (1.4.255). https://www.onorca.dev/docs/agents/native-chat, https://www.onorca.dev/changelog
4. **Auto-resume after usage limit.** Claude or Codex chat that hits a limit with a known reset time gets an automatic continuation after the reset; on by default under Settings, Chat UI, Behavior; a "Don't continue" button on the limit notice cancels per chat; the setting belongs to the host running the agent; closed chats or sleeping workspaces wait until reopened; resets more than 24 hours old need manual continue. Bots resume after limits, account switches and crashes (1.4.274). https://www.onorca.dev/docs/agents/native-chat, https://www.onorca.dev/changelog
5. **Cost per session.** Status-bar plan meters per provider (see above) plus a Stats view with estimated cost from a local price table; flagged "inferred pricing" or "excludes unpriced models"; docs say to prefer the provider console for real spend. Muse usage is token counts only. Cursor usage comes from the existing Cursor sign-in, shown as plan monthly usage, not per session. https://www.onorca.dev/docs/agents/usage-tracking
6. **Rewind and fork.** In structured chat only: "Rewind to here" on a sent message (message returns to the composer; idle agent needed; Codex rewinds a whole turn; Claude can rewind to before the first message, 1.4.244); "Fork from this response" on any finished Claude or Codex reply, same workspace, agent, model and permission mode, original untouched; `/btw` side chat in a fork. Terminal-mode sessions get no Orca rewind. https://www.onorca.dev/docs/agents/native-chat
7. **Needs-you inbox and jump-to-next.** Three surfaces: header bell (unread across all worktrees, click jumps to worktree and pane, mark unread); Agents feed (chronological, running pinned, Ctrl+F filter, multi-select); experimental Agent Dashboard kanban with a "Needs You" column tinted amber and a shortcut to toggle it. Mobile has an Agents tab across hosts and a "Needs you" list for approvals. No documented "jump to next waiting agent" key. https://www.onorca.dev/docs/notifications, https://www.onorca.dev/docs/activity, https://www.onorca.dev/docs/model/agents-sessions
8. **Scheduled runs.** CLI-created automations with triggers hourly, daily or cron, a `--precheck` command whose non-zero exit records a skipped run, missed-run grace, `--reuse-session` to continue in the previous live terminal, per-run model and effort, created disabled for safety, run on demand. Phone edits automations (1.4.271). https://www.onorca.dev/docs/cli/automations
9. **Phone approvals and push.** Pairing by one-time code or QR (expires in 10 minutes), Orca Relay (sign-in needed for Relay only) or LAN/Tailscale; push when an agent finishes; since 1.4.246 a phone can receive only needs-input alerts; answers to agent questions and approval cards (1.4.268, 1.4.269); the phone is "a remote control for the desktop", the desktop owns the session. Server-side controls for phone pushes sit under the paired server's Notifications settings. https://www.onorca.dev/docs/mobile, https://www.onorca.dev/docs/notifications
10. **Memory and performance with many terminals.** Hibernation (experimental, off by default): done agents idle 30 minutes (1 minute to 24 hours), not in a foreground worktree, no keystrokes since done, no mobile session driving it, no unsettled orchestration dispatch, no live subagent roster; worktree agent panes hibernate together; resumes with the history resume flags and falls back to a fresh prompt if the transcript is gone. Plus Resource Manager, and per the earlier report virtualised long tool runs (1.4.259, 1.4.263). https://www.onorca.dev/docs/agents/hibernation

**Orca release-note additions (GitHub release pages v1.4.104, 2026-06-28, to v1.4.277, 2026-11-26; 150 stable releases scanned, keyword-filtered lines read; release notes before 2026-06-28 not read).** Each line names the release and date.
- Usage-limit handling grew in steps: v1.4.232 (2026-10-20) a Continue button on the limit notice; v1.4.242 (2026-10-27) "Remove the usage-limit Continue button that could hit the same limit again"; v1.4.246 (2026-11-02) continue "with another account or agent harness"; v1.4.247 (2026-11-03) optional auto-continue setting; v1.4.259 (2026-11-14) continue on the account you switch to; v1.4.258 shows when a Codex limit resets; v1.4.271 (2026-11-22) auto-continue on by default; v1.4.272 (2026-11-23) bots continue after limits, account switches, crashes. https://github.com/stablyai/orca/releases
- Session search: engine over an index landed v1.4.203 and v1.4.204 (2026-09-15, 2026-09-16); results sorted newest with recency tie-break v1.4.209; Cmd+J palette ranked by recency v1.4.188 (2026-08-22).
- Review: "send comments to AI" v1.4.169 (2026-08-05); multi-line range comments by drag or keyboard v1.4.206 (2026-09-20); large diffs deferred until you load them v1.4.195 (2026-09-02).
- Rewind: v1.4.235 (2026-10-20) "Rewind Claude chats: use Rewind to here on a message that started a turn, edit your prompt"; v1.4.232 notes "Rewind works in long conversations".
- Hibernation and memory: recursive "sleep" of a workspace's descendants and no sleep while an orchestration dispatch is active, v1.4.164 (2026-08-02); a bounded queue for PTY "cooked-query" replies "so backlog cannot grow without bound or starve keystrokes" and release of retained terminal output strings, v1.4.180 (2026-08-11); renderer OOM breadcrumbs measured by bytes not entries, v1.4.168; memory-profile census of PTY output processors, v1.4.176; hidden chat views pause updates while keeping draft, reading position and editor state, v1.4.262 (2026-11-17).
- State detection: Codex's "Implement this plan?" menu and open agent questions now count as waiting on you, v1.4.221 (2026-10-05); a question state with its own color and glyph on the Agent Dashboard, v1.4.185; "stop driving a hidden Codex TUI to read usage", v1.4.219 (2026-10-02); notify on every settled structured turn, v1.4.211.
- Plans and goals: task checklists with update diffs and a composer progress panel, v1.4.201 (2026-09-13); Codex goal above the composer, v1.4.211 (2026-09-25); mid-turn messages held in a host-owned queue, v1.4.219.
- Automations: per-run model and effort, v1.4.224 (2026-10-10); the scheduler tick isolated and oversized cron steps refused, v1.4.203; "tick latency no longer counts against the missed-run grace", v1.4.205; an unverifiable process loss reports as "lost", not "failed", v1.4.197.
- Stars: 139,048 on the GitHub page on 2026-11-26 (v1.4.237, 2026-10-21, celebrated 100,000).

## 2. Paseo (getpaseo/paseo, Apache-2.0 since 0.7.0 on 2026-08-31; desktop Mac/Windows/Linux, iOS, Android, web, CLI)

Sources read: `https://paseo.sh/llms.txt` and 72 docs pages as markdown (`https://paseo.sh/docs/<page>.md`: getting started, why, connectivity, security, workspaces,
worktrees, parallel tasks, providers, schedules, orchestration, agent profiles, skills, MCP, CLI, browser, voice, plugins, SDK, the whole Hub section), and the full
changelog page `https://paseo.sh/changelog` (149 release entries, 0.1.1 on 2026-02-11 through 0.17.5 on 2026-11-26; headline bullets read for every release, full lists for 0.17.x
and keyword-searched for the rest). GitHub's API was rate-limited, so the GitHub releases list itself was not read; the site changelog carries the same notes with PR numbers.
Plain HTTP fetch worked for every page; none needed god Chrome. The per-provider pages (about 40 agents) were not read one by one; the list is in llms.txt.

### Feature inventory

**Sessions and layout**
- Workspaces group a directory, agents, terminals and browsers; split panes; tabs; Command Center with Workspaces, Files and Actions tabs and relevance ranking (0.6.1, 0.16.0). https://paseo.sh/docs/workspaces.md
- Git worktrees per task: setup hooks, scripts, long-running services, `.worktreeinclude` for gitignored files, use an existing worktree or create one from a branch or PR (0.17.1), background workspaces hidden unless "Show background" (0.12.0). https://paseo.sh/docs/worktrees.md
- Providers: Claude Code, Codex, GitHub Copilot, OpenCode (v1 and v2), Pi, Oh My Pi, Antigravity (drives the installed `agy` over ACP), Muse Code, plus ACP agents (about 40 listed on the marketing site); custom providers and profiles in `~/.paseo/config.json`; update provider CLIs from inside the app (0.17.1). https://paseo.sh/docs/supported-providers.md
- Agent profiles: save provider, model, mode, thinking level as a named profile ("UI work", "Planning", "Review") with notes that guide an orchestrating agent; own settings page (0.17.5). https://paseo.sh/docs/agent-profiles.md
- Subagents track near the composer; background tasks above the composer with Stop for Claude Code, Codex, OpenCode v2 (0.16.0). https://paseo.sh/docs/orchestration.md
- Built-in browser with `browser_*` tools so agents click, type and verify pages. https://paseo.sh/docs/browser.md
- Voice (local-first speech models, opt-in). https://paseo.sh/docs/voice.md
- Metadata generation (branch names, commit messages, PR text) by a configured provider. https://paseo.sh/docs/metadata-generation.md
- Plugins: providers, sidebar views, composer controls, timeline transforms, hooks, plugin registry and in-app gallery (0.11.0, 0.16.0); launch wraps so plugins run agents inside a sandbox (0.17.5). https://paseo.sh/docs/plugins.md
- TypeScript SDK `@getpaseo/client`, CLI (`paseo run`, `schedule`, `host add`, `plugin add`), MCP tools for agents. https://paseo.sh/docs/sdk.md, https://paseo.sh/docs/cli.md
- First-run setup wizard; project suggestions from folders where Claude Code, Codex, OpenCode or Pi already ran (0.15.2). https://paseo.sh/changelog
- Chat display settings: group tool calls, collapse completed turns into summaries (0.14.0); copy a quote without `>` markers (0.17.5). https://paseo.sh/changelog

**Review and git**
- Changes pane with Push and Pull, PR tab that opens automatically once a PR is detected (0.9.0), "Jump to file" on mobile; review comments in the diff pane reach an agent through a "Send feedback" button without opening its chat (0.12.0 release note; no docs page describes it). https://paseo.sh/changelog
- Agents can watch a pull or merge request and wake on new checks, reviews or comments (0.17.1). https://paseo.sh/changelog
- Metadata for PRs; GitHub, GitLab, Gitea and Forgejo handling, fork PR checkouts on owner-prefixed branches. https://paseo.sh/changelog

**Recovery**
- Agent recovery (0.15.0): daemon restarts keep terminal programs running; with "Resume agents after restart" on (off by default, Host settings, Agents) interrupted agents are sent "Resume working." or your own prompt in their existing conversation. https://paseo.sh/changelog
- "Rewind chat or files from any user message" (0.1.82, 2026-05-26); Claude `/rewind`; Rewind in the Command Center for the latest turn (0.17.1); rewinds for Codex and Pi chats; Fork on replies. https://paseo.sh/changelog
- Import session from providers; mobile terminal reconnect restores up to 10,000 lines (0.15.0). https://paseo.sh/changelog

**Plan, tasks, goals**
- Pi task lists and goal extensions render in chat (0.10.0); question forms for Codex, OpenCode, OMP (0.8.0, 0.10.2). Not found: a Claude to-do panel, goal chip or plan card. https://paseo.sh/changelog

**Search and history**
- Cmd/Ctrl+F in file panes, in terminal scrollback and in chat, including messages outside the loaded history window (0.9.0). Command Center search includes archived workspaces and agent titles (0.16.0). https://paseo.sh/changelog

**Cost and limits**
- Usage dialog or sheet showing each subscription account's quota windows (0.11.0); sidebar usage summary on by default (0.17.2); provider quota forecasts when your pace will use up a quota before reset (0.17.1); OpenCode Go usage card. https://paseo.sh/changelog
- Turn and session stats: timing, tokens, cache and cost per turn and per session for Claude, OpenCode v2, Pi, Oh My Pi and plugin providers (0.17.2). https://paseo.sh/changelog
- No auto-resume after usage limits found (searched the docs and changelog for "usage limit" and "rate limit": no feature entry).

**Automation**
- Schedules (cron or presets like 5m, 1h) start a fresh agent per run, "Archive on finish" on by default; Heartbeats re-prompt one existing agent; created in the app, from chat, CLI, or MCP. https://paseo.sh/docs/schedules.md
- Hub: GitHub, Linear, Slack, Discord, schedule and webhook triggers that start an agent on a daemon you enrolled; triggers as YAML in `.paseo/triggers/*.yml`; scoped integration tools; hosted or self-hosted. https://paseo.sh/docs/hub.md

**Phone and notifications**
- Native iOS and Android apps; foldable layouts; fullscreen composer (0.12.0, 0.13.0); native mobile terminal with selection handles (0.15.0). https://paseo.sh/changelog
- Relay connection (end-to-end encrypted, Noise NK handshake bound to the daemon's public key, relay off by default and asks before enabling), SSH, Tailscale (first-class in 0.17.5), direct TCP. A confirmation appears before a pairing link connects to a new host or one whose key changed (0.10.3). https://paseo.sh/docs/security.md, https://paseo.sh/docs/connectivity.md
- Notifications: desktop through a native bridge, mobile push (a 0.4.0 fix mentions removed hosts still receiving push notifications; the feature entry itself was not found in the changelog), "Mark as unread" on finished workspaces (0.8.0), question notifications that summarise the requested input, parent agents notified when a child finishes, errors or needs permission. https://paseo.sh/changelog

**Orchestration**
- Agents launch and message other agents across providers and hosts, steer another agent's running turn (0.17.2), `paseo host add` for remote daemons (0.13.0), orchestration skills (handoff, second opinion, planning). https://paseo.sh/docs/orchestration.md, https://paseo.sh/docs/skills.md

**Performance and reliability (from fixes)**
- Daemon memory leaks fixed (unbounded workspace git caches; growth after client connections close, 0.9.2); plugin hosts, CLI and desktop growing to about 1 GB after 30 to 75 minutes fixed (0.12 era); archived chats kept in memory until reload fixed (0.17.5); Desktop freeze on a chat whose last turn had hundreds of tool calls fixed (0.17.5); large Git workspaces stalling the daemon during file-watcher scans, and a Git change in one repository rescanning every checkout, fixed (0.17.5); reduced background Git polling for repositories the watcher cannot observe (0.9.2); large and many-file diffs stalling fixed (0.7.2). https://paseo.sh/changelog

### How Paseo built the ten items

1. **Changes pane with line comments.** Only a release note: "Send feedback button to the diff pane, so review comments reach an agent without opening its chat" (0.12.0, 2026-10-19). Docs describe the Changes pane for review and merge but not the comment flow. https://paseo.sh/changelog
2. **Search inside sessions.** Cmd/Ctrl+F in the chat searches "including messages outside the loaded history window" (0.9.0), so it reads beyond what the UI has loaded; Command Center matches agent titles within their workspace; no cross-session full-text search documented. https://paseo.sh/changelog
3. **Plan, task, goal panels.** Present for Pi via extensions; Claude and Codex plan or to-do panels not found. Background tasks strip above the composer. https://paseo.sh/changelog
4. **Auto-resume after usage limit.** Not found. What exists is agent recovery after a daemon restart (opt-in, a "Resume working." prompt), which is a different trigger. https://paseo.sh/changelog
5. **Per-session cost.** Turn and session stats (0.17.2) with cost for Claude, OpenCode v2, Pi, Oh My Pi, plugin providers; Usage dialog for quota windows; quota forecast (0.17.1). https://paseo.sh/changelog
6. **Rewind and fork.** "Rewind chat or files from any user message" (0.1.82, 2026-05-26) plus Claude `/rewind`, Command Center "Rewind" for the latest turn, Fork on replies; fixes list the edge cases found in practice: Claude rewind after a turn with subagent messages, after a turn with no response, Codex rewind on paginated threads (Codex 0.151+), a Pi rewind undone by a daemon restart, Codex rewind dropping its custom provider and Paseo tools. https://paseo.sh/changelog
7. **Needs-you inbox and jump-to-next.** Sidebar status plus "Mark as unread"; no inbox list documented; Command Center switches workspaces by relevance. https://paseo.sh/changelog
8. **Scheduled runs.** Cron engine; schedules create a new agent and workspace per run, "Archive on finish" default on (also removes the worktree); heartbeats re-prompt an existing agent over MCP or CLI period updates. https://paseo.sh/docs/schedules.md
9. **Phone approvals and push.** Mobile app answers tool approvals and questions (question cards, Antigravity approvals in 0.17.1); connection through relay, Tailscale, SSH. Push to the phone exists (a 0.4.0 release note, 2026-08-13, fixes removed hosts still receiving it) but the docs pages read do not describe it or an approve-from-notification flow. https://paseo.sh/docs/security.md
10. **Memory and performance.** Documented only as fixes (above); no offload-hidden-terminals feature. https://paseo.sh/changelog

## 3. T3 Code (pingdotgg/t3code; desktop, web, iOS, Android, `t3` CLI and background service)

Sources read: every Markdown file under `docs/` in the repository (88 files fetched from `https://raw.githubusercontent.com/pingdotgg/t3code/main/docs/...` plus README, in particular the 70
user pages `docs/user/*.md`, `docs/internals/16_performance-regressions.md`), and the GitHub release list through the API (600 entries, 26 of them stable releases from v0.0.32,
2026-08-07, to v0.1.12, 2026-11-25; the other 574 are nightlies and Android betas). Stable releases before v0.0.32 were not read: the GitHub API rate limit ran out before page 7.
Most stable release notes are lists of pull-request titles; v0.1.0 to v0.1.12 also carry a short headline list. Plain fetch worked everywhere; no god Chrome use.

### Feature inventory

**Sessions and layout**
- Threads per task; "New worktree" per thread; projects optional ("No project" scratch thread, "Turn into project"); background start (Cmd+Enter); same prompt to several models at once (Shift-click models, one thread and worktree each). https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md
- Sidebar sections Pinned, Active, Working (beta), Settled, Snoozed; Settle, Snooze (wakes early on approvals, questions, errors), Archive; auto-settle after 7 days idle or when the linked PR merges or closes (0.1.8); drag-to-settle ranges; 5-second Undo toasts. Same page.
- Multi-repository projects: one project and thread across several repositories, per-repo diff picker (0.1.12). https://github.com/pingdotgg/t3code/blob/main/docs/user/multi-repo-projects.md
- Providers: Claude, Codex, Cursor (official Cursor SDK since 0.1.0), Antigravity, Grok, OpenCode 2, Pi, Muse Code, Kiro (beta), fx, ACP Registry agents (Devin, Cline, Kimi, Droid). https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-acp.md
- Switch provider or model mid-thread with a budgeted history handoff (default 16,000 tokens, imported history 64,000-byte ceiling; reasoning traces, raw tool state and attachments not copied; a fresh provider session is started automatically when the target lacks context room); fork any thread. https://github.com/pingdotgg/t3code/blob/main/docs/user/portable-handoffs.md
- Composer: queue or steer while working (follow-ups steer the running turn by default since 0.1.3), Send now, offline queue on mobile, quote an assistant response, recall a sent prompt, suggested next prompt (Labs, Tab to accept), prompt stash (Cmd+S, up to 100), voice input (Apple Speech on macOS 26+), `/goal`. https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md
- Permission modes: Supervised, Auto-accept edits, Auto (the provider's own review), Full access; a delegated subagent can never exceed its parent's mode. https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md
- Activity log with tool-call visibility modes Show all, Hide successful, Hide all, Zen; screen reader announcements and a status-prefixed window title. https://github.com/pingdotgg/t3code/blob/main/docs/user/activity-log.md
- In-app browser with tunnels and port forwarding for dev servers on another machine (0.1.11); HTML renders; file viewer (PDF, ZIP up to 50 MB, Office files, SQLite, notebooks; large previews virtualised, 0.1.3). https://github.com/pingdotgg/t3code/blob/main/docs/user/browser.md
- Command palette (Cmd/Ctrl+K), keybindings, custom themes with CSS and background images (0.1.10), 10 languages (0.1.11), keep the computer awake while agents work (0.1.10). https://github.com/pingdotgg/t3code/blob/main/docs/user/keybindings.md
- Triage an issue: an agent investigates a T3 Code problem from local logs and drafts the GitHub issue; also `npx t3 triage`. https://github.com/pingdotgg/t3code/blob/main/docs/user/triage.md
- Managed policy for administrators, including Windows Group Policy (0.1.7); secrets (1Password). https://github.com/pingdotgg/t3code/blob/main/docs/user/managed-policy.md

**Review and git**
- Diff pane sources: Turn changes (only that turn's own edits, commits and conflict fixes), Uncommitted, Changes (against base), Commits (newest 100); find in diff; inline review comments on any diff or file line attach to the composer as context chips so feedback across files goes in one message; unified or split; colorblind palettes. https://github.com/pingdotgg/t3code/blob/main/docs/user/diffs.md
- Pull requests page across GitHub, GitLab, Forgejo, Gitea, Bitbucket, Azure DevOps, GitCafe, Cursor Origin: review, comments, checks, request reviewers, mark files viewed, saved views, auto-merge, revert PRs, strip agent co-author trailers on merge, "Work on PR" from mobile. https://github.com/pingdotgg/t3code/blob/main/docs/user/source-control.md
- Review guides (beta): an agent writes an ordered tour of a PR with "Look closely" spots. Same page.
- Agents can watch a PR and are woken when checks, reviews or conflicts need them (0.1.0). https://github.com/pingdotgg/t3code/releases/tag/v0.1.0
- Issues page for Linear, GitHub, GitLab, Azure DevOps, Forgejo, handed to an agent through to a merged PR (0.1.11). https://github.com/pingdotgg/t3code/releases/tag/v0.1.11
- Add pull request comments to the chat (0.1.8). https://github.com/pingdotgg/t3code/releases/tag/v0.1.8

**Recovery**
- "Edit from here" under a sent message rewinds the conversation to before it and returns the text to the composer; "Revert and keep changes" or "Revert files too" (worktree threads only, and only when no other thread or session shares the directory); rewinding needs provider rewind support and cannot undo external actions. Cursor and Antigravity also get it (0.1.11); ACP agents cannot rewind themselves so the next turn starts a fresh session with the kept history. https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md, https://github.com/pingdotgg/t3code/blob/main/docs/user/cursor.md
- Native resume of stopped Claude, Codex, OpenCode and Cursor threads without adding a new user message (0.1.10). https://github.com/pingdotgg/t3code/releases/tag/v0.1.10
- Queued messages pause in order when you stop or the server restarts; "Resume" continues. https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md

**Plan, tasks, goals**
- `/goal` for Codex, Claude and OpenCode 2.2.5+ with status in the UI; Codex and OpenCode support pause and resume; Claude keeps the goal when you stop. https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md
- Claude task list progress shown when `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` is set in the instance environment. https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-claude.md
- Subagents: T3-delegated (`delegate_task`: another provider or model, an isolated worktree, or a linked machine; has its own composer) and provider-native (read-only; approvals bubble to the parent); opens in a right-panel tab; Stop on the parent stops delegated children; child approvals answerable from the parent (0.1.7). https://github.com/pingdotgg/t3code/blob/main/docs/user/subagents.md

**Search and history**
- Cmd+K searches threads across connected environments by title, branch, PR, project and message contents ("indexed message search", 0.1.3; quotes for exact phrases); find messages and plans inside the current thread (0.1.0). https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md
- Shareable thread links (0.1.7); guest links share one thread with a teammate in a browser with no account, and a guest message waits for the owner's approval before it runs. https://github.com/pingdotgg/t3code/blob/main/docs/user/guest-links.md

**Cost and limits**
- Usage page: tokens, cache hit rate, estimated API-equivalent cost, "Premium" for Fast or Ultrafast surcharge; pools subscription quotas per provider across environments, de-duplicating the same account on several machines; history kept 92 days by default; custom model prices and "Map to" for preview model ids; `usageModelFilter`; cost and token views over 24h, 7d, 30d, 90d; mobile home-screen widget. https://github.com/pingdotgg/t3code/blob/main/docs/user/usage.md
- In chat: `/usage-limits`; limit rows show your pace (0.1.11); a mid-turn limit shows the window and reset time and Claude "holds the turn until reset, or you can stop and resume later"; new threads avoid providers that just hit a usage limit (0.1.5); ChatGPT Business limit shows a copyable admin request (0.1.2). https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-claude.md, https://github.com/pingdotgg/t3code/releases/tag/v0.1.5
- Redeem banked Codex or Claude reset credits ("Use reset"). https://github.com/pingdotgg/t3code/blob/main/docs/user/usage.md

**Automation**
- Scheduled tasks: recurring (target environment's time zone), once (0.1.7), webhook; destination New thread each run, One thread continuing, or One thread fresh session each run; pause, resume, run now. Webhooks: signature check, filters, duplicate-request key (7 days), coalesce key (10 to 3600 s), placeholders wrapped in tags so untrusted payloads cannot invoke skills, held while offline up to 24 hours, Deliveries view. https://github.com/pingdotgg/t3code/blob/main/docs/user/project-settings.md
- Workflows (Labs, 0.1.12): durable TypeScript scripts chaining agents, code steps, schedules, webhooks, issue and PR triggers and human approvals, each step checkpointed so runs survive restarts. https://github.com/pingdotgg/t3code/blob/main/docs/user/workflows.md
- Project actions that run when a worktree thread settles (for disk cleanup). https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md
- T3 Code as an MCP server for outside agents (read, launch, message, stop threads; OAuth; 30-day sign-ins; Read only or Supervised to Full access). https://github.com/pingdotgg/t3code/blob/main/docs/user/outside-agents.md

**Phone and notifications**
- Push alerts, iOS Live Activities, Android live updates, home-screen widgets (Agent Activity, Subscription usage) when agents finish, fail, or need approval or input; requires T3 Connect sign-in on phone and host, "Publish agent activity" on the host; ordinary alerts muted while the app is in the foreground. https://github.com/pingdotgg/t3code/blob/main/docs/user/mobile-notifications.md
- Remote access: T3 Connect relay, direct, Tailscale; device approval with a short code valid 10 minutes; linked environments with cross-machine thread reading. https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md
- Mobile app: threads, PR review, offline-readable PR lists, queue messages offline (from the source-control and composer pages). https://github.com/pingdotgg/t3code/blob/main/docs/user/source-control.md
- Devices: stream and drive iOS Simulators, Android Emulators and physical Android devices beside a thread; agents inspect and drive them with `device_*` tools. https://github.com/pingdotgg/t3code/blob/main/docs/user/devices.md

**Settings and onboarding**
- `t3` CLI: `t3 up`, `status`, `service install|status|restart|uninstall`, `update` (channels stable and nightly, pinned versions), `pair`. https://github.com/pingdotgg/t3code/blob/main/docs/user/background-service.md
- `t3 service protect` (Linux): shields the server from the OOM killer so agents filling memory cannot take it down. https://github.com/pingdotgg/t3code/blob/main/docs/user/background-service.md

**Performance**
- Internals doc "Performance regression checks": wire and payload budgets (cold opens, history pages and resume catch-ups bounded by bytes and rows; no raw tool bodies on thread snapshots; live command output bypasses orchestration events; initial shell sync sends only active navigation rows), server process metrics, client and mobile switch metrics, background work invariants, no looping mobile animations. A release added a "server metrics run" that catches CPU, memory and first-request regressions (0.1.12). https://github.com/pingdotgg/t3code/blob/main/docs/internals/16_performance-regressions.md
- Faster turns on long threads (0.1.11); virtualised large file previews (0.1.3).

### How T3 Code built the ten items

1. **Changes pane with line comments.** Select lines in any diff or workspace file, write a comment; each becomes a context chip in the composer, so comments across several files go to the agent in one message that you send yourself. Draft PR line comments stay local until submitted. Diff sources include "Turn changes", which isolates a turn's own edits from pulled-in files. https://github.com/pingdotgg/t3code/blob/main/docs/user/diffs.md, https://github.com/pingdotgg/t3code/blob/main/docs/user/source-control.md
2. **Search inside sessions.** Two scopes. Cmd+K searches message contents across connected environments with an index (0.1.3), `"exact phrase"` syntax, mobile thread-list search; and "find messages and plans in the current thread" (0.1.0). Archived threads leave search; settled ones stay searchable. https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md
3. **Plan, task, goal panels.** Native `/goal` with status in the UI for Codex, Claude, OpenCode (and Antigravity native goals, 0.1.10); Claude task list is opt-in by an environment variable; a Plan interaction mode exists but is not supported on every provider (Antigravity). https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md
4. **Auto-resume after usage limit.** Not automatic. Documented behaviour: the limit message shows window and reset time; Claude "holds the turn until reset, or you can stop and resume later"; new threads avoid providers that just hit a limit; native resume continues a stopped thread without a new message. https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-claude.md
5. **Per-session cost.** Usage page with API-equivalent estimates by provider and model from each CLI's own history (Codex, Claude Code, Grok, OpenCode, Antigravity, Pi, Muse, Cursor), custom per-model prices, 92-day retention; excludes text-generation runs (titles, commits). Per-thread cost is not documented. https://github.com/pingdotgg/t3code/blob/main/docs/user/usage.md
6. **Rewind and fork.** "Edit from here" with two restore modes (conversation only, or files too) and these stated limits: worktree threads only, no other session sharing the directory, needs provider support; cannot undo external actions. Fork any thread (0.1.0); fork with a portable handoff when the provider cannot resume natively, with a documented token budget. https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md, https://github.com/pingdotgg/t3code/blob/main/docs/user/portable-handoffs.md
7. **Needs-you inbox and jump-to-next.** The sidebar's Working section collapses running threads and returns them to the top of Active "when they finish, fail, or need input", sorted by most recent return; pending approvals show on their timeline row; Snooze wakes a thread early on approvals, questions or errors; the window title can carry "Needs approval" or "Needs your input". No separate inbox page and no jump-to-next key documented. https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md
8. **Scheduled runs.** As in the Automation list, plus the rule "settle, do not archive, a thread that a scheduled task targets, because archived threads refuse new messages and runs fail". https://github.com/pingdotgg/t3code/blob/main/docs/user/project-settings.md
9. **Phone approvals and push.** Push, Live Activities and widgets say agents "need your approval or input"; approvals themselves are answered in the app thread (pending approval cards, 0.1.4; child approvals in the parent, 0.1.7). Push needs the T3 Connect relay; direct or Tailscale connections do not deliver background push. Whether the push action itself is Approve or Deny was not documented. https://github.com/pingdotgg/t3code/blob/main/docs/user/mobile-notifications.md
10. **Memory and performance.** Payload and row budgets on the wire, virtualised previews, switch-time metrics checked in CI, `t3 service protect` for OOM on Linux, a Working section that stops sorting churn. No hidden-terminal offload described. https://github.com/pingdotgg/t3code/blob/main/docs/internals/16_performance-regressions.md

## 4. Paradev (formerly Superset; MIT since 2026-11-04; desktop Mac/Windows/Linux, iOS and Android)

Sources read: the whole docs corpus from https://docs.paradev.com/llms-full.txt (120 pages including CLI reference, SDK, 30 plugin pages and 12 recipes), all 37 changelog
entries dated 2026 at https://paradev.com/changelog/ (2026-01-06 to 2026-11-22), and all 19 posts at https://paradev.com/blog. Fetched by plain HTTP; no page needed Firecrawl or god Chrome.
The docs are the "v2" product; some older 2026 changelog entries describe v1 behaviour.

### Feature inventory

**Sessions and layout**
- Workspace = git worktree plus terminals, one per branch; "session workspaces" with no project; cloud workspaces (out of beta 2026-11-08) and bring-your-own-cloud hosts. https://docs.paradev.com/workspaces, https://docs.paradev.com/cloud-workspaces
- Terminal host daemon owns the terminals, so closing or updating the app keeps agents running and the app re-attaches with scrollback. https://docs.paradev.com/keep-agents-running
- Standalone CLI host (`paradev start --daemon`) keeps a machine reachable from phone and automations while the desktop app is closed. https://docs.paradev.com/keep-agents-running
- Tabs, splits, merge tabs, pane rename, drag tabs between main area and sidebar, per-pane error recovery with Retry. https://docs.paradev.com/terminal-integration, https://docs.paradev.com/editor
- Multiple windows (per organization), same workspace in two windows kept in sync. https://docs.paradev.com/multiple-windows
- Chat interface over Agent Client Protocol for Claude Code, Codex, OpenCode, Pi; CLI/Chat toggle on a running session; "Fork into Chat / Fork into CLI" (2026-11-15). https://docs.paradev.com/chat, https://paradev.com/changelog/2026-11-15-stacked-pull-requests-merge-queue
- Rich input overlay (Cmd+I) to write a prompt in an editor over a terminal agent. https://paradev.com/changelog/2026-07-12-terminal-rich-input-mistral-vibe
- Custom agents (any CLI), per-agent resume args, fork args, launch flags, task prompt template. https://docs.paradev.com/supported-agents
- Workspace pinning, bulk actions, groups and tag folders, a triage-oriented Workspaces page grouped by device. https://paradev.com/changelog/2026-08-16-workspaces-triage-editable-markdown
- Ports panel per workspace with labels. https://docs.paradev.com/ports
- Run button, setup and teardown scripts, project presets, terminal scripts. https://docs.paradev.com/setup-teardown-scripts, https://docs.paradev.com/terminal-scripts
- In-app browser, Design Mode (pick an element, send its context to the agent), Chrome extensions, mobile simulator pane. https://docs.paradev.com/browser, https://paradev.com/changelog/2026-10-18-mobile-pane-page-sharing
- Computer control: accessibility-first driver so agents operate native apps. https://docs.paradev.com/computer
- Pages: agent-made designs and reports shared with a team, comments pinned to elements and sent back to the agent; public sharing. https://docs.paradev.com/pages
- Skills (orchestration, automations, feedback, diagnostics) delivered to agents automatically; plugins (Gmail, Slack, Linear, Sentry, Supabase and others) and organization plugins. https://docs.paradev.com/skills, https://docs.paradev.com/plugins/overview
- MCP server so other agents drive Paradev; TypeScript SDK; large CLI (`paradev workspaces|agents|terminals|automations|...`). https://docs.paradev.com/mcp-server, https://docs.paradev.com/sdk/getting-started, https://docs.paradev.com/cli/cli-reference
- 17 interface languages; custom theme files and a theme marketplace. https://paradev.com/changelog/2026-08-30-seventeen-languages-session-handoff

**Review and git**
- Changes pane: staged, unstaged, untracked and against-base sections; split or unified layout; focus mode that shows one file at a time with Prev/Next and per-section counts; image, video and PDF diffs; commit, push, create PR from the pane. https://docs.paradev.com/diff-viewer, https://paradev.com/changelog/2026-09-06-changes-pane-ship-flow-image-diffs
- Review tab for PR review comments (resolved separated from open, synced with GitHub), PR check status in the sidebar. https://docs.paradev.com/diff-viewer
- Pull Requests view: filters (repo, author, review status), Summary and Code tabs, activity stream, merge methods, merge stack, merge queue, restack. https://docs.paradev.com/pull-requests
- Comment straight to an agent from selected PR lines (file, line range and diff side are sent; optional GitHub post; creates a PR-checkout workspace if none). https://docs.paradev.com/pull-requests
- Double-click a diff line to jump to that line in the raw editor. https://docs.paradev.com/diff-viewer
- Editor with external-change banner (Keep editing / Reload from disk / Overwrite; no merge), auto save modes, cross-workspace search. https://docs.paradev.com/editor

**Recovery**
- Automatic resume of a session whose terminal died unexpectedly, with a "Resuming..." pill and a "Failed to resume" Retry; only unexpected deaths qualify; only one session comes back even if many windows notice. https://docs.paradev.com/agent-sessions, https://paradev.com/changelog/2026-08-23-pull-requests-multi-window-design-mode
- Fork session (native fork command per agent: Claude, Codex, OpenCode, Pi, Grok, Droid). A fork copies the conversation, not the files. https://docs.paradev.com/agent-sessions
- Continue with another agent: seeds a new agent with the last 36,000 characters of context marked read-only, with a size preview; warns it sends terminal output to the target provider without redaction. https://docs.paradev.com/agent-sessions
- Chat "Undo per turn" (experimental, 2026-11-01 entry). https://paradev.com/changelog/2026-11-01-right-pane-workspaces-list
- `paradev agents read` returns the saved transcript for Claude and Codex. https://docs.paradev.com/agent-sessions
- Clear Status to unstick a workspace that shows running. https://docs.paradev.com/agent-status

**Plan, tasks, goals**
- Tasks view: Linear issues (live) or GitHub issues, list or board, filters, label hierarchy tree, semantic search, multi-select "Run in workspace" (one workspace per task) with an auto-run toggle and a per-agent task prompt template. https://docs.paradev.com/tasks
- Agents pause for questions, tool approval and plan review inside chat, and the workspace is flagged. https://docs.paradev.com/agent-status
- Subagents listed under their parent in the terminal header (Claude and Codex); sidebar shows them under their agent (2026-09-13). https://docs.paradev.com/supported-agents
- Orchestration skill: one agent coordinates workers in separate workspaces through the CLI; workers report structured done or blocked messages. https://docs.paradev.com/orchestration

**Search and history**
- Cross-workspace file search; semantic task search. Docs describe no search inside agent conversations. https://docs.paradev.com/editor, https://docs.paradev.com/tasks
- `paradev agents read` for transcripts; sessions listed with IDs to copy. https://docs.paradev.com/agent-sessions

**Cost and limits**
- Usage page: official quota meters (Session 5h and Weekly) per Claude, Codex, Grok, Antigravity and OpenCode login, refreshed every 5 minutes; multiple accounts with a default; token-cost chart priced at API list rates ("Cost to you: $0" for subscriptions) with 7/30/90 day ranges, per-agent, per-model, per-workspace drilldowns, top sessions by cost. https://docs.paradev.com/usage
- Machine resources view (CPU and memory per app, workspace, pane) refreshed every 2 seconds. https://docs.paradev.com/usage
- Public usage leaderboard (opt-in, publishes up to 90 days of local usage). https://docs.paradev.com/usage
- Chat shows a usage or spend limit as a notice, not a red failure, with "Resume at reset" (experimental chat, 2026-11-01). https://paradev.com/changelog/2026-11-01-right-pane-workspaces-list

**Automation**
- Automations (Pro): triggers are schedules, webhooks and events from GitHub, Slack, Linear, Sentry, Notion, Microsoft Teams; target a device or Cloud; new, same or picked workspace; Start fresh or Continue session mode; run states created, creating, missed, failed; Run now, Pause, Archive; groups; retry failed runs. https://docs.paradev.com/automations
- Recipes: fan-out refactor, race agents, nightly audit, PR feedback, Sentry triage, Slack bug reports, webhook runs. https://docs.paradev.com/recipes/nightly-audit
- Slack bot (@Paradev files tasks or starts agents). https://docs.paradev.com/use-with-slack

**Phone and notifications**
- Mobile app (iPhone iOS 26+, iPad, Android; needs Paradev Pro): Home lists workspaces by machine with a status dot (yellow needs permission, red failed, green finished), start an agent from a prompt, follow sessions, reply by typing, dictation or photo, review diffs and comment on a line, "Finish review" sends all comments to a session, PR merge and "Fix Checks with Agent" / "Address Comments with Agent". https://docs.paradev.com/mobile
- Notifications on finish or waiting, per-agent support varies; macOS dock badge. https://docs.paradev.com/agent-status
- Push notifications on the phone were listed as "coming next" in the mobile blog post (2026-09-28); the mobile docs page lists no push. https://paradev.com/blog/superset-mobile (the post's "What's next" section, opened 2026-11-26; the same sentence says Android has since shipped)

**Orchestration**
- Coordinator skill, CLI-driven fan-out, MCP server and SDK, "100 agents" roadmap (adversarial "bouncer" agents, stacked review agents, prepared briefings instead of raw output, event triggers). https://docs.paradev.com/orchestration, https://paradev.com/blog/roadmap-to-100-agents

**Settings and onboarding**
- Per-agent Settings (command, resume args, fork args, hooks toggle), migrate from Conductor (local and cloud), first-session guide, providers page (OpenRouter, Bedrock, Vertex, Vercel, Foundry). https://docs.paradev.com/migrate-from-conductor, https://docs.paradev.com/providers

**Performance**
- 2026-07-19 entry: only the most recent terminals stay in memory (default 12, setting "Background terminal memory"); the rest are saved to disk and rebuilt on switch-back; active terminals and running TUIs are never offloaded; hidden browser tabs likewise. Measured with 16 terminals of 5,000 lines: held terminals 16 to 4, scrollback lines 80,016 to 20,004, JS heap 581 to 286 MB, renderer RSS 1,127 to 838 MB. https://paradev.com/changelog/2026-07-19-performance-memory-and-load
- Git status moved off the main thread to a worker pool; large file-change bursts capped (worst stall 82.3 to 28.0 ms on a 20,000-file repo). Same entry.
- Port detection runs one shared process scan per cycle instead of one per terminal; idle terminals scan every 30 s instead of 2.5 s. Same entry.
- 2026-02-02 entry: memory-leak fixes and terminal upgrades. https://paradev.com/changelog/2026-02-02-file-explorer-workspace-improvements
- Terminal daemon: process-isolated host, backpressure handling, cold restore from disk (blog). https://paradev.com/blog/terminal-daemon-deep-dive

### How Paradev built the ten items

1. **Changes pane with line comments to the agent.** Two places. (a) Mobile: long-press a line, "Finish review", pick an open session or "New agent session", "Send review" delivers all comments plus an optional summary at once. (b) PR "Code" tab: select lines, send to a running agent terminal or a new session; the agent receives file, line range and diff side; posting to GitHub is optional; with no linked workspace Paradev creates a PR-checkout workspace. The desktop changes pane itself documents no per-line agent comments, only the PR flow. https://docs.paradev.com/mobile, https://docs.paradev.com/pull-requests
2. **Search inside sessions.** Not documented. Search covers files across open workspaces and tasks (semantic). Transcripts are only readable by `paradev agents read` for Claude and Codex. https://docs.paradev.com/editor, https://docs.paradev.com/agent-sessions
3. **Plan, task, goal panels.** Tasks view is an issue tracker (Linear, GitHub issues), not the agent's own to-do list. The agent's plan review and approvals appear inline in chat; no goal panel is documented. https://docs.paradev.com/tasks, https://docs.paradev.com/agent-status
4. **Auto-resume after usage limit.** Only in experimental chat: the chat "pauses at a usage limit with a Resume at reset button" (a button, not automatic), and a limit shows as a notice rather than a failure. Terminal sessions: none documented. Automatic resume exists only for terminals that died unexpectedly. https://paradev.com/changelog/2026-11-01-right-pane-workspaces-list, https://docs.paradev.com/agent-sessions
5. **Per-session cost.** Estimated from the agents' local session logs, priced at API list rates, split by agent, model and workspace, with "top sessions by cost" in a workspace drilldown whose rows copy the session ID. Covers 13 agents' logs; quota meters only for Claude, Codex, Grok, Antigravity, OpenCode. Remote hosts are not aggregated. https://docs.paradev.com/usage
6. **Rewind and fork.** Fork uses each agent's own command (table in the docs); a fork copies the conversation, not files; Paradev refuses a fork if the source session was deleted (Claude, Codex, OpenCode, Pi) and disables Fork until it knows the session id. Handoff to another agent is a 36,000-character read-only context prompt. Undo per turn exists only in experimental chat. No rewind of terminal sessions. https://docs.paradev.com/agent-sessions
7. **Needs-you inbox and jump-to-next.** Activity strip on each workspace row, agent chips when several run in one workspace, unread and attention dot, dock badge; status comes from hooks Paradev installs in each agent's config and wrappers in `~/.paradev/bin`, no-ops outside Paradev terminals, with a per-agent "Paradev hooks" toggle; "Clear Status" for stale state. The Workspaces page is a triage view. No dedicated needs-you list or jump key is documented. https://docs.paradev.com/agent-status
8. **Scheduled runs.** Automations (Pro plan), created in the app, CLI or SDK, with the limits documented: at-least-once delivery (a run may dispatch twice), no tracking of whether the agent's work succeeded (success means the workspace was created), offline target device means "missed" and no retry, loops possible when an agent's own activity matches its trigger. https://docs.paradev.com/automations
9. **Phone approvals and push.** Phone opens the same workspaces through a relay when Remote Access is on; needs the desktop (or CLI host) awake; permission waits show as a yellow dot and you answer by replying. No approve-from-notification flow and, per the blog, push notifications were still "coming next". https://docs.paradev.com/mobile, https://docs.paradev.com/remote-access
10. **Memory and performance with many terminals.** See the Performance list above: offload all but the 12 most recent terminals to disk (setting), 20,004-line scrollback cap in the measured test, shared port scan, git work off the main thread. https://paradev.com/changelog/2026-07-19-performance-memory-and-load

## 5. Conductor (conductor.build; closed source, Mac app plus iOS app and a cloud product)

Sources read: `https://www.conductor.build/llms-full.txt` (68 pages: every docs page under /docs plus the brand kit, privacy, terms and Slack pages), the changelog index
`https://www.conductor.build/changelog.md` (219 entries) and the markdown of all 119 entries dated 2026 (0.28.7, 2026-01-05, to 0.101.0, 2026-11-25), each at
`https://www.conductor.build/changelog/<slug>.md`. The earlier pass read five entries; this pass read all 119 (model-release-only and bug-fix-only entries were skimmed by title). Version numbers below 0.28.7 (0.7.3, 0.12.0, 0.15.2, 0.17.0, 0.21.0, 0.22.7, 0.25.x, 0.26.0) are 2025 entries known from the index title only.
Fetched by plain HTTP; no page failed.
Context worth knowing: 0.93.0 (2026-11-04) said Conductor was joining Meta and winding down; 0.94.2 (2026-11-13) said "It's back, and we're building again".
0.95.0 (2026-11-16) says the app moved from Tauri to Electron.

### Feature inventory

**Sessions and layout**
- Isolated workspaces on git worktrees, grouped by repo; workspace status columns (backlog, in progress, in review, done) since 0.35.0; sidebar sections (0.85.0); pin workspaces (0.25.3). https://www.conductor.build/docs/concepts/workspaces-and-branches
- Multiple chats per workspace (0.17.0, 2025, index title only); fork a chat to a new tab or workspace, with an experimental setting to fork mid-turn (Cmd+Option+Enter) (0.62.0 and 0.78.0 entries). https://www.conductor.build/changelog/0.62.0-repo-settings-browser-preview.md
- Dispatcher: a prompt box that starts a workspace, with "create more" to keep dispatching (0.63.0). https://www.conductor.build/changelog/0.63.0-cursor-support-dispatcher.md
- Create a workspace from a Linear or GitHub issue (0.66.0), from a PR (0.15.2), from the "Create from..." menu. https://www.conductor.build/docs/guides/issue-to-pr
- Multi-repo workspaces: several repositories in one workspace (0.101.0); linking multiple directories. https://www.conductor.build/changelog/0.101.0-multi-repo-workspaces.md
- Agents manage Conductor: Claude, Codex, Cursor or OpenCode in a local workspace can create workspaces, start chats with other agents, wait for replies, cancel and archive (0.95.0); Conductor MCP and a cloud API (0.82.0, 0.77.0). https://www.conductor.build/docs/api/mcp
- Harnesses: Claude Code, Codex, Cursor (Composer), OpenCode; Sign in with ChatGPT (0.89.0); model picker with "loadouts" you can share and keyboard shortcuts for model, effort and speed (0.85.0, 0.86.0). https://www.conductor.build/docs/reference/harnesses
- Big Terminal Mode: a full terminal in the center panel (Cmd+Shift+T, experimental); `@terminal` brings terminal output to the chat. https://www.conductor.build/docs/reference/big-terminal-mode
- Chat features: queue (redesigned 0.54.0), steering (0.50.0), find in chat (Cmd+F, also searches thinking, 0.90.0), table of contents with chat summaries (0.32.0, 0.34.2), "reply to any part of a chat" quote pills (0.97.0), up-arrow recall (0.101.0), folded tool-call groups (0.96.0), links to workspaces and chats (0.71.0). https://www.conductor.build/changelog/0.96.0-know-what-you-re-spending.md
- Plan mode (0.7.3, 0.21.0), send plans to new chats (0.22.7), approve plans with feedback (0.25.5), AskUserQuestion keyboard-navigable (0.31.3). https://www.conductor.build/changelog/0.31.3-askuserquestion-improvements.md
- Artifacts: agents make HTML pages shown inline, publishable by link and commentable; comments go back to the agent (0.97.0, 0.100.0). https://www.conductor.build/changelog/0.100.0-artifact-publishing-and-commenting.md
- Spotlight testing (run one instance, hot-swap branches), run scripts (multiple, 0.70.0), setup and archive scripts, files to copy / `.worktreeinclude` for gitignored files, direnv, auto port forwarding in cloud (0.83.0). https://www.conductor.build/docs/reference/scripts
- Sync agent configs between Claude Code and Codex (skills, slash commands, MCP; 0.57.0); settings as files at user and repo scope (0.62.0); managed (org) settings. https://www.conductor.build/docs/reference/settings
- Deep links `conductor://`; command palette (Cmd+K); keyboard shortcuts settings (0.95.0). https://www.conductor.build/docs/reference/deep-links
- Conductor Cloud: microVM workspaces that keep running when the app is closed, multiplayer (share, follow, prompt together), forwarded ports, remote desktop, Conductor CLI preinstalled (0.78.0, 0.80.0, 0.84.0). https://www.conductor.build/docs/cloud
- Cloud-only routines: run an agent on a schedule or GitHub event, filters by label, author, base branch (0.85.0, 0.87.0). https://www.conductor.build/changelog/0.85.0-sections-routines-and-a-new-model-picker.md

**Review and git**
- Diff viewer with unified view, commit filtering, mark-as-viewed (files return to "Ready for review" when changed, 0.29.1), multiline comments (0.38.3), edit files directly in diffs (0.84.0). https://www.conductor.build/docs/reference/diff-viewer
- Comments on changed lines go to the agent; GitHub review comments are fetched and synced, outdated or resolved ones disappear; "Claude can now comment on your code" (0.29.0). https://www.conductor.build/docs/reference/diff-viewer
- Checks tab: git status, PR metadata, CI, deployments (Vercel), GitHub comments, todos; re-run failed Actions; forward failing checks to the agent (0.12.0); optional checks can block merge. https://www.conductor.build/docs/reference/checks
- PR page: edit title and description, merge, one-click approval, stacks (Graphite 0.32.0, GitHub stacks 0.80.0). https://www.conductor.build/changelog/0.73.0-pr-page.md
- Todos: merge-blocking list the agent and you both edit; `@todos` sends it to the agent. https://www.conductor.build/docs/reference/todos
- Customisable prompts for code review, create PR and branch rename (0.29.1). https://www.conductor.build/changelog/0.29.1-customize-prompts-mark-files-as-viewed.md

**Recovery**
- Checkpoints: before each agent response Conductor saves the working branch in a private git ref; "revert" on a message deletes that turn and later turns, messages and code included; the agent has no memory of them. https://www.conductor.build/docs/reference/checkpoints
- Archive saves git state including uncommitted files (0.33.5); instant archive (0.46.0). https://www.conductor.build/changelog/0.33.5-better-archiving.md
- Continue chats (0.32.0); hand off plans (0.30.0); instant chat summaries (0.39.0). https://www.conductor.build/changelog/0.39.0-insta-summarize-command-palette-opus-4-6.md

**Plan, tasks, goals**
- Codex goal support (0.65.0); tasks list for Claude (0.33.0); Codex plan mode and skills (0.43.0); background tasks above the composer with elapsed time and Stop (0.77.0, 0.98.0, 0.99.0); open a background subagent or shell in its own tab with live output (0.99.0). https://www.conductor.build/changelog/0.99.0-auto-resume-for-claude-code-and-codex.md

**Search and history**
- Cmd+F in chat; Cmd+Shift+F file-content search with case, whole-word and regex (0.87.0); command palette searches sessions by message content (0.39.0); search workspaces (0.26.0); model search (0.87.5). https://www.conductor.build/changelog/0.87.0-search-across-files-opencode-2.0.md

**Cost and limits**
- Context circle in the composer opens a panel with context fullness, usage limits, and the chat's estimated cost (0.96.0); Usage page with chats, estimated cost and tokens for 7, 30, 90 days by model and workspace (0.98.0); Codex chats on a custom provider show estimated cost for known models. https://www.conductor.build/changelog/0.98.0-see-where-your-usage-goes.md
- Experimental menu-bar icon showing Claude and Codex usage limits and opening recent workspaces (0.101.0). https://www.conductor.build/changelog/0.101.0-multi-repo-workspaces.md
- Auto-resume after a usage limit (0.99.0). https://www.conductor.build/changelog/0.99.0-auto-resume-for-claude-code-and-codex.md
- Copy a request to a ChatGPT Business admin when Codex hits an admin-set limit (0.92.0). https://www.conductor.build/changelog/0.92.0-remote-control.md

**Phone and notifications**
- iOS app (0.90.0) for cloud workspaces: chat with agents, merge PRs. Remote Control (0.92.0, experimental): drive your Mac's local workspaces from the iPhone, end-to-end encrypted through a relay, one-use pairing code that expires in 10 minutes, Mac must be awake and the app open; keeps the Mac awake while the phone is connected and the Mac is plugged in. https://www.conductor.build/docs/reference/remote-control
- Notifications when Claude has a question or awaits plan review; clicking one opens the session (0.28.7, 2026-01-05, https://www.conductor.build/changelog/0.28.7-change-target-branch.md); completion sounds (0.52.0); "Next Workspace" jumps to chats needing attention or unread (0.36.4); command palette "jump to the next session needing attention" (0.39.0); workspaces with unsent drafts show a pencil (0.73.0); mark workspaces unread (0.25.11). https://www.conductor.build/changelog/0.36.4-next-workspace.md, https://www.conductor.build/changelog/0.39.0-insta-summarize-command-palette-opus-4-6.md

**Orchestration**
- Parallel workspaces, agents spawning agents, Conductor CLI and MCP in cloud and local, Slack integration (https://www.conductor.build/slack). https://www.conductor.build/docs/concepts/parallel-agents

**Settings and onboarding**
- Settings layers (user, repo, managed), themes (Dracula, Nord, etc., 0.98.0), quick start, deep migration from Cursor, keyboard shortcut editor. https://www.conductor.build/docs/guides/migrate-from-cursor

**Performance**
- 0.38.1: terminal rewritten; runaway error loop writing huge logs capped and cleaned (0.38.1-0.38.2 entry). https://www.conductor.build/changelog/0.38.1-0.38.2-new-terminal-perf-issues.md
- 0.49.0: app rebuilt "twice as fast" (tabs, workspace switches, file rendering 50% faster, 150 MB smaller). https://www.conductor.build/changelog/0.49.0-conductor-allegro-gpt-5.5.md
- 0.63.0: terminal scrollback limit setting, default 10 MB, measured by output size not lines. https://www.conductor.build/changelog/0.63.0-cursor-support-dispatcher.md
- 0.96.0: reduced background git activity when Conductor is not focused; archived workspaces take less disk. https://www.conductor.build/changelog/0.96.0-know-what-you-re-spending.md
- 0.35.3: animations removed because of high idle CPU. https://www.conductor.build/changelog/0.35.3-reliability-and-performance.md

### How Conductor built the ten items

1. **Changes pane with line comments to the agent.** Diff viewer comments point at changed lines "so the agent gets more precise context than from a general chat message"; multiline comments by drag (0.38.3); GitHub review comments appear in the same list and are tagged with repo and PR when sent (0.99.0); resolve a thread so the Checks tab reflects review state. The docs do not describe how batching works. https://www.conductor.build/docs/reference/diff-viewer
2. **Search inside sessions.** Cmd+F in the current chat, including the agent's thinking (matches expand collapsed groups); command palette searches sessions by message content; Cmd+G steps through matches; workspace search. https://www.conductor.build/changelog/0.31.0-search-chats-add-scripts-in-the-ui-and-view-setup-script-logs.md, https://www.conductor.build/changelog/0.90.0-conductor-for-ios.md
3. **Plan, task, goal panels.** Todos are a Conductor-owned merge-blocking list in the Checks tab (agents and people add items; `@todos` shows them to the agent); Claude's own task list is shown (0.33.0); Codex goal support (0.65.0); plan mode with approve-with-feedback and "send plan to a new chat". https://www.conductor.build/docs/reference/todos
4. **Auto-resume after usage limit.** 0.99.0 (2026-11-23): when Claude Code or Codex stops on a usage limit, Conductor resumes the chat after the reset; switch on from the limit message in the chat or Settings, General; the agent "picks up where it left off". No stated cap or edge cases in the entry. https://www.conductor.build/changelog/0.99.0-auto-resume-for-claude-code-and-codex.md
5. **Per-session cost.** Context circle panel shows the chat's estimated cost (0.96.0); Usage page by model and workspace over 7/30/90 days (0.98.0). Local workspaces only. The usage panel's 5h and 7d limits show how much you've used, to match Claude's own page (0.99.0). https://www.conductor.build/changelog/0.96.0-know-what-you-re-spending.md
6. **Rewind and fork.** Checkpoints use a private git ref per user message, kept apart from the branch history; revert is destructive for the conversation too; the docs warn it is risky when several chats run in one workspace. Fork a chat to a new tab or a new workspace; experimental mid-turn fork. https://www.conductor.build/docs/reference/checkpoints
7. **Needs-you inbox and jump-to-next.** No inbox list. A "next workspace" action jumps to chats needing attention or unread, there is a palette command for it, notifications for questions and plan review open the right session, and the workspace list shows status and unsent-draft marks. https://www.conductor.build/changelog/0.36.4-next-workspace.md
8. **Scheduled runs.** Routines (0.85.0), cloud only, Pro or Team plans; schedule or GitHub event trigger with label, author and base-branch filters and several triggers per routine; Home can hide workspaces created by routines. Local scheduling: not documented. https://www.conductor.build/changelog/0.85.0-sections-routines-and-a-new-model-picker.md
9. **Phone approvals and push.** iOS app drives cloud workspaces and, through Remote Control, local ones; no push notification feature appears in the 2026 changelog (searched all 119 entries for "push notif": no match). Tool approval exists as an enterprise setting for Claude Code (0.41.0, 0.45.0). https://www.conductor.build/docs/reference/remote-control
10. **Memory and performance with many terminals.** Scrollback limited by MB (default 10 MB), terminal rewritten, less background git work when unfocused, rebuilt on Electron (0.95.0). No documented offloading of hidden terminals. https://www.conductor.build/changelog/0.63.0-cursor-support-dispatcher.md

## 6. Emdash, Nimbalyst, Vibeyard

### 6a. Emdash (generalaction/emdash, YC W26; "Emdash Classic" v1.x desktop app for macOS/Windows/Linux; "Emdash 2.0" announced)

Sources read: the 24 docs pages listed in `https://emdash.com/llms.txt` (each as `https://emdash.com/docs/<page>.md`), the changelog page `https://emdash.com/changelog` (30 releases, v1.1.5 on 2026-04-30 to v1.2.10 on 2026-10-30; highlights of every release), `README.md` and `CONTEXT.md` in the repository. GitHub's release API was rate-limited; the changelog page carries the same notes. The newest GitHub release in the atom feed is dated 2026-11-19; the changelog page stops at v1.2.10 (2026-10-30), so releases from 2026-11-01 to 2026-11-19 were not read (headline of the feed entries not opened). Plain fetch worked everywhere.
- Stars on 2026-11-26 (from the repo page HTML): 6,310.

Feature inventory:
- **Sessions:** a task = branch + worktree (or existing workspace or repo root), started from a branch, issue or PR, agent in Chat UI (ACP) or TUI with a switch in the agent selector remembered per agent, project and machine; split panes, tabs, drag a tab to an edge to split (1.2.3), command palette, zen mode; about 35 agent providers (35 table rows on the providers page, header excluded) defined by a shared plugin system (1.1.34). https://emdash.com/docs/tasks.md, https://emdash.com/docs/providers.md
- **Remote:** "Workspace Server" for remote projects with git, files, terminals, agents, automations and preview forwarding (1.2.0, 2026-08-28); SSH with ProxyJump and agent forwarding; machines settings. https://emdash.com/docs/remote-development.md
- **tmux sessions:** terminal and TUI agents survive closing the app or losing SSH; resolved project override, then machine default, then app default; does not survive reboot; not used on local Windows. https://emdash.com/docs/tmux-sessions.md
- **Review and git:** Changes sidebar with Changed, Staged and Pull Requests sections that refresh on file and git events; stage, discard, commit, "Commit & Create PR"; edit working-tree diffs in the viewer (1.1.10); PR files, commits, checks (CI/CD checks tab), comments; GitLab MRs (1.2.9); multiple GitHub accounts per project. https://emdash.com/docs/diff-view.md, https://emdash.com/docs/ci-checks.md
- **Diff comments to the agent:** "Attach draft diff comments to chat through the 'Diff comments' item in the @ menu. Comments are cleared only after confirmed delivery, while failed sends and comments edited during submission remain pending" (1.2.8, 2026-10-10). https://emdash.com/changelog
- **Issues:** Linear, Jira, GitHub, GitLab, YouTrack, Notion, Monday, Trello, Plane, Asana as task sources with editable issue context templates (1.1.36). https://emdash.com/docs/issues.md
- **Automations:** cron schedule per project, prompt, agent, run in a new worktree, existing workspace or repo root; run history, rerun, "Convert run into a task", optional auto-approval; remote schedules run on the Workspace Server without the desktop connected. https://emdash.com/docs/automations.md
- **Library:** reusable prompts, skills, MCP servers (with a catalog), skills.sh search. https://emdash.com/docs/library.md
- **Usage:** Settings page showing remaining Codex and Claude Code subscription allowances, reset countdowns, shared accounts shown once across machines (1.2.8). https://emdash.com/changelog
- **Chat features:** prompt queueing (1.1.38), chat export, Mermaid, model and effort remembered per agent and machine (1.2.7), Codex Plan/Default mode switch (1.2.2), grouped thinking and "Ran N commands" collapse (1.2.4), notifications that focus the right conversation tab (1.2.7). https://emdash.com/changelog
- **Performance and Windows:** background processes no longer open console windows on Windows (1.2.10); diff loads continue while background git runs; disk usage scan reused for 5 minutes and stopped when you leave the view; long operations no longer fail after 30 seconds; crash-loop recovery screen shows why the last launch failed. https://emdash.com/changelog

How Emdash did the ten items: (1) comment chips via the @ menu with confirmed-delivery clearing (above); (2) file-content search only (Cmd/Ctrl+Shift+F, added in 1.2.0, 2026-08-28), no chat search found; (3) Codex Plan/Default mode only, no task or goal panel found; (4) no auto-resume after usage limits found (searched docs and changelog); (5) Usage page of subscription allowances, no per-session cost found; (6) no rewind or fork found in docs (the string appears only in contributing.md); (7) notifications and a conversation-focus click, no inbox found; (8) automations as above; (9) no phone app found; (10) tmux persistence and the 1.2.10 fixes; no terminal offloading documented.

### 6b. Nimbalyst (nimbalyst.com; open-source visual workspace for Claude Code, Codex and other agents; desktop, iOS, browser)

Sources read: `https://nimbalyst.com/docs/llms-full.txt` (110 pages) with the index `https://nimbalyst.com/docs/llms.txt`; session management, workstreams, automations, mobile, usage report, file history, file edits sidebar, interactive prompts, agent teams, red/green diff, pull-request review pages read in full or in large part; visual-editor, extension and wiki pages read by title and first paragraph only. Not read: release announcements archive.

Feature inventory:
- **Agent window:** session list with title and optional transcript-content search ("Search contents"), transcript, right panel switchable between Edited Files, Review queue, and "Chat with Session" (a side conversation about the session). Turn summary line "Finished in 6m 57s, 3 files +45 -12". https://nimbalyst.com/docs/session-management/agent-window-and-session-management.md
- **Workstreams:** sessions that touch the same files or topic group as tabs sharing one combined edited-files view; forms automatically when a session gains a sibling; an agent can add a sibling with `/launch-new-session`; a workstream is not a worktree. https://nimbalyst.com/docs/session-management/workstreams.md
- **File History:** automatic snapshots on autosave, manual save and "around AI edits" (labels Auto Save, AI Edit, Pre Edit), Cmd+Y to compare and restore; restore keeps the current text as a new snapshot. https://nimbalyst.com/docs/file-management/file-history-and-restore.md
- **Red/green diff approval** for AI edits in documents; keep or revert all or one by one; Plan mode limits the agent to markdown files. https://nimbalyst.com/docs/visual-editors-powered-by-ai/markdown-wysiwyg/ai-editing-red-green-diff-approval.md
- **File Edits sidebar** (Edited, Referenced, Read) with a hover "Diff Peek" popover; All Uncommitted Files mode. https://nimbalyst.com/docs/file-management/file-edits-sidebar.md
- **Trackers:** built-in issue tracker with 7 item types, kanban, list and tag board, custom types in YAML, `nim` CLI, link sessions and commits to items (commit message ids). https://nimbalyst.com/docs/task-management/overview.md
- **Automations:** markdown files in `nimbalyst-local/automations/` whose frontmatter holds schedule and output, created from `/automation`, created disabled for review, output to a new file per run. https://nimbalyst.com/docs/session-management/automations.md
- **Interactive prompts:** `PromptForUserInput` tool shows one multi-field widget (drag to prioritise, approve a list, edit a draft, confirm) instead of several chat questions. https://nimbalyst.com/docs/session-management/interactive-prompts.md
- **Agent Teams and Super Loops:** one session spawns parallel teammates; a Super Loop reruns an agent with fresh context each iteration while progress persists in files. https://nimbalyst.com/docs/developer-features/agent-teams-and-super-loops.md
- **Mobile (iOS):** pair with QR code, answer approvals, start, resume or redirect sessions, edit synced markdown (alpha), voice; syncs session transcripts and drafts, not code files. https://nimbalyst.com/docs/mobile/mobile-app.md
- **AI Usage Report:** token and session totals, activity heatmap, per-project cards, tool-call counts with success and failure, by provider. https://nimbalyst.com/docs/session-management/ai-usage-report.md
- **Pull-request mode** over the `gh` CLI (no stored tokens), AI review, open a branch in a worktree. https://nimbalyst.com/docs/developer-features/pull-request-reviews.md
- **Import Claude Code sessions**, share a session by public link, wiki plugin, extensions, Mermaid, mockups, canvas, CSV and more. https://nimbalyst.com/docs/session-management/import-claude-code-sessions.md

How Nimbalyst did the ten items: (1) a review queue plus red/green approval, not per-line comments sent to the agent; (2) title search plus "Search contents" over transcripts; (3) trackers and plan files rather than the agent's to-do list; (4) not found; (5) usage report of tokens, not cost per session (cost not found in the page read); (6) file snapshots including "Pre Edit" so a bad AI edit can be restored, no conversation rewind found; (7) system notification on completion that opens the session; sessions list and mobile; (8) markdown automations; (9) phone approvals in the iOS app (push not documented in the pages read); (10) not documented.

### 6c. Vibeyard (elirantutia/vibeyard; Electron app for Claude Code, Codex CLI, Gemini CLI; 1,395 stars on 2026-11-26)

Sources read: `README.md`, `HOOKS.md` (a 18 KB map of Claude Code hook events to session states, verified against Claude Code 2.1.327), `CHANGELOG.md` (releases 0.2.39 on 2026-05-30 to 0.3.11 on 2026-11-21). No docs site.
Feature inventory:
- Kanban task board per project, a card spawns or resumes a CLI session and moves to Done when the session completes. https://github.com/elirantutia/vibeyard/blob/main/README.md
- Swarm mode: a grid of all sessions; global active-sessions sidebar across projects (0.3.4); global session search with a current-project scope (0.3.11). https://github.com/elirantutia/vibeyard/blob/main/CHANGELOG.md
- Cost and context tracking per session, Session Inspector timeline with cost breakdown and tool stats (Cmd+Shift+I), plan usage limits shown (0.3.11). README.
- Session status dots (working, waiting, input needed, completed) from 25 hook events (9 core, 16 inspector-only), installation gated by CLI version so an unknown event never lands in `settings.json`. https://github.com/elirantutia/vibeyard/blob/main/HOOKS.md
- Stop resolution: the main agent fires a `Stop` every time it pauses to wait on parallel subagents, so "Stop = done" gives false completion alerts; the Stop payload carries `background_tasks` entries (`shell`, `subagent`, `monitor`, `workflow`, `teammate`, `cloud session`, `MCP task`) and only `subagent`, `teammate` and `workflow` hold the session in `working`; unknown types fail toward completed; running shells, monitors and MCP tasks are shown as a ring on a completed tab and block close. HOOKS.md
- Multiple Claude profiles with isolated config dirs (0.3.1), P2P session sharing over WebRTC with a PIN, embedded browser with element inspection, `vibeyard-ctl` for agents to control tabs (0.3.9), AI Readiness Score, i18n (English, Chinese), Hebrew and Arabic terminal text.

How Vibeyard did the ten items: (2) global session search (0.3.11); (4) not found; (5) real-time spend per session and a Session Inspector; (7) status dots plus a global active-sessions panel; (3) a kanban board separate from the agent's own plan; (1), (6), (8), (9) not found; (10) not documented.

## 7. How they built each of the ten items, across products

Product names: Orca, Paseo, T3 (T3 Code), Paradev, Conductor, Emdash, Nimbalyst, Vibeyard. URLs are in the product sections above.

### (1) Changes pane with line comments sent to the agent
- **Orca.** Source: git diff against a start-from ref, switchable to any commit or branch. Comment by a gutter "+", drag or Shift for a range (range support v1.4.206), key `c`. Comments pin to a line and follow it when the diff shifts. One "Send to agent" opens a "Send notes to" menu of that worktree's agents and sends one prompt with all line-anchored comments; unresolved comments ride the next batch; Resolve collapses a thread. Stated reason for batching: single comments make the agent "swing back and forth". The send shortcut is unbound by default.
- **T3.** Select lines in any diff or file; each comment becomes a chip in the composer, so comments from several files go in the one message you send yourself. The diff pane has four sources: Turn changes (excludes files a pull or merge brought in), Uncommitted, Changes against base, Commits.
- **Emdash.** Draft diff comments attach to chat from the `@` menu ("Diff comments"). They are cleared only after confirmed delivery; failed sends and comments edited during submission stay pending (1.2.8).
- **Conductor.** Comments on changed lines "give the agent more precise context than a general chat message"; multiline by drag (0.38.3); GitHub review comments sync in and are tagged with repo and PR when sent.
- **Paradev.** Mobile: long-press a line, "Finish review", pick a session or a new one, "Send review" (all comments plus an optional summary). Desktop: select lines in a PR's Code tab and send to a running terminal or a new session (file, line range and diff side go with it); optional GitHub post.
- **Paseo.** A "Send feedback" button on the diff pane (0.12.0 release note only).
- Not found: Nimbalyst (red/green approval and a review queue instead), Vibeyard.
- Shared pattern: comments are collected, then sent as one message to a chosen session; line, range and side travel with the comment.

### (2) Search inside sessions
- **Orca.** Session History lists sessions from 20+ CLIs' own transcripts; deep search is an opt-in per-computer index ("searchable data stays on each computer"), a scan limit with "Show more", sort by relevance or newest, `orca search` on the command line; Ctrl+F inside a chat; message rail of prompt markers.
- **T3.** Cmd+K searches message contents across environments with an index (0.1.3) and `"exact phrase"`; "find messages and plans in the current thread" (0.1.0).
- **Conductor.** Cmd+F in a chat that also searches thinking and expands collapsed groups to show a hit (0.90.0); palette search by message content (0.39.0); Cmd+G between matches; file-content search Cmd+Shift+F with regex (0.87.0).
- **Paseo.** Cmd/Ctrl+F in chat "including messages outside the loaded history window" (0.9.0), in files and in terminal scrollback.
- **Nimbalyst.** Session list search by title plus "Search contents". **Vibeyard.** Global session search with a current-project scope (0.3.11).
- **Paradev, Emdash.** None found (file and task search only).

### (3) Plan, task and goal panels
- **Orca.** Claude TodoWrite and Codex `update_plan` render inline and in a collapsible panel above the composer (v1.4.201); Codex goal chip with pause, resume, clear (v1.4.211); `/plan` pill; phone can pin plans and manage goals; background-task strip.
- **T3.** `/goal` for Codex, Claude, OpenCode (Antigravity native goals 0.1.10) with status in the UI; Claude's task list needs `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`; a Plan mode that some providers lack.
- **Conductor.** Tasks for Claude (0.33.0), Codex goal (0.65.0), plan mode with approve-with-feedback and send-to-new-chat, merge-blocking Todos in the Checks tab.
- **Paseo.** Pi todo and goal extensions only. **Paradev.** Inline plan review; Tasks view is an issue tracker. **Emdash.** Codex Plan/Default switch. **Nimbalyst.** Trackers and Plan mode (markdown files only). **Vibeyard.** Kanban board, separate from the agent's plan.

### (4) Auto-resume after a usage limit
- **Orca.** Most developed (see the Orca release-note list). Final design: for Claude or Codex chats whose limit has a known reset time, on by default (v1.4.271); a "Don't continue" button on the notice cancels per chat; the setting belongs to the host running the agent; closed chats and sleeping workspaces wait until reopened or awakened; resets more than 24 hours old need manual continue; earlier Continue button removed because it could hit the same limit again; continue on a switched account (v1.4.259).
- **Conductor.** 0.99.0 (2026-11-23): resumes the chat once the limit resets, switched on from the limit message or Settings; no caps stated.
- **Paradev.** Experimental chat only: "Resume at reset" button, and the limit shows as a notice rather than a failure (2026-11-01 entry).
- **T3.** Not automatic: Claude "holds the turn until reset" or you stop and resume; new threads avoid providers that just hit a limit (0.1.5); native resume continues a stopped thread without a new message (0.1.10).
- **Paseo.** None (opt-in agent recovery after a daemon restart is a different trigger). **Emdash, Nimbalyst, Vibeyard.** None found; Vibeyard shows plan usage limits (0.3.11).

### (5) Per-session cost
- **Conductor.** Context circle in the composer opens a panel with context fullness, usage limits, and the chat's estimated cost (0.96.0); Usage page by model and workspace, 7/30/90 days (0.98.0).
- **Paradev.** Local session logs priced at API list rates; "Cost to you: $0" for subscriptions; per agent, model, workspace; top sessions by cost with copyable ids.
- **Paseo.** Turn and session stats with cost for Claude, OpenCode v2, Pi, Oh My Pi and plugin providers (0.17.2); quota forecast (0.17.1).
- **T3.** Usage page of API-equivalent estimates from each CLI's own history, custom per-model prices, `Premium` for Fast surcharge; per-thread cost not documented.
- **Orca.** Stats view with a local price table and "inferred" or "partial" labels. **Vibeyard.** Per-session real-time spend and an inspector. **Emdash.** Subscription allowance page only. **Nimbalyst.** Token usage report.
- Common caveat stated by Orca, Paradev, T3: the number is an API-equivalent estimate and the provider console is the authority.

### (6) Rewind and fork
- **T3.** "Edit from here" under a sent message with two modes, conversation only or files too (files only for worktree threads that no other session shares); needs provider rewind support; cannot undo external actions. Fork any thread; provider switch mid-thread with a budgeted history handoff.
- **Orca.** "Rewind to here" (v1.4.235, 2026-10-20; idle agent needed; Codex rewinds a whole turn); "Fork from this response" with the same workspace, agent, model and permission mode, original unchanged; `/btw` side chat. Chat mode only.
- **Conductor.** Checkpoint per user message in a private git ref, "revert" deletes that turn and later turns permanently; fork a chat to a tab or workspace (0.62.0).
- **Paradev.** Fork uses each CLI's own fork command (6 agents); a fork copies the conversation, not files; fork is refused if the source session is gone; handoff to another agent sends the last 36,000 characters read-only.
- **Paseo.** "Rewind chat or files from any user message" (0.1.82) and a long fixes list that doubles as a test list: after a turn with subagent messages, after a turn with no response, Claude with `CLAUDE_CONFIG_DIR` set ("Session not found"), Codex 0.151+ paginated threads, Codex 0.156+ renamed `thread/rollback`, Pi rewind undone by a daemon restart, Codex rewind dropping its custom provider and tools.
- **Nimbalyst.** File snapshots including a "Pre Edit" one, no conversation rewind. **Emdash, Vibeyard.** None found.

### (7) Needs-you inbox and jump-to-next
- **Orca.** Header bell with mark-unread, Agents feed (chronological, running pinned, multi-select), experimental Agent Dashboard with a Needs You column (amber tint, idle after about 30 minutes); a Claude subagent waiting on permission shows its parent as "waiting" not "blocked". No documented next-waiting key.
- **Conductor.** "Next Workspace" jump to chats needing attention or unread (0.36.4), palette command, notifications for questions and plan review that open the session.
- **T3.** Working section returns a thread to the top of Active when it finishes, fails or needs input; snoozed threads wake on approvals, questions, errors; window title can show "Needs approval".
- **Paradev.** Activity strip, dock badge, Workspaces triage page, Clear Status for stale state. **Paseo.** Sidebar status, mark as unread. **Vibeyard.** Status dots plus a global active-sessions panel. **Emdash, Nimbalyst.** Notifications that open the right tab.

### (8) Scheduled runs
- **Orca.** Hourly, daily or cron; `--precheck` shell probe whose non-zero exit skips and records the run; missed-run grace; reuse the previous live terminal; per-run model and effort; created disabled; the scheduler tick isolated from latency.
- **Paradev.** Triggers: schedule, webhook, GitHub, Slack, Linear, Sentry, Notion, Teams. Honest limits listed: at-least-once delivery, no tracking of whether the agent's work succeeded, an offline device means "missed" and no retry, an agent's own activity can retrigger it (filter by person).
- **T3.** Recurring, once, webhook; three destination modes; webhook signature, filters, duplicate key (7 days), coalesce window (10 to 3600 s), placeholders wrapped so untrusted input cannot invoke skills, buffering up to 24 hours while offline; Workflows (Labs) with checkpointed steps and human approvals.
- **Paseo.** Cron schedules start a fresh agent and workspace, "Archive on finish" on by default; heartbeats re-prompt an existing agent; Hub triggers from GitHub, Linear, Slack, Discord, webhooks.
- **Conductor.** Routines (cloud only). **Emdash.** Automations with run history, Run now, convert a run to a task, remote schedules on the Workspace Server. **Nimbalyst.** Markdown automation files. **Vibeyard.** None.

### (9) Phone approvals and push
- **T3.** Push, iOS Live Activities, Android live updates and widgets for "finished, failed, needs approval or input"; needs the T3 Connect relay on both ends (direct or Tailscale connections give no background push); approvals answered inside the app thread; device approval with a 10-minute code.
- **Orca.** Pairing by one-time code or QR (10-minute expiry) over Orca Relay, LAN or Tailscale; push on agent finish; needs-input-only alerts (1.4.246); answer questions and approvals in the app (1.4.268, 1.4.269); queued sends while the desktop is unreachable.
- **Paradev.** Phone shows a yellow dot when an agent needs permission and you reply there; push listed as "coming next" in the mobile post; Remote Access needs the desktop or a CLI host awake.
- **Conductor.** iOS app and Remote Control (E2E encrypted relay, one-use 10-minute pairing code, Mac must be awake); no push entry in 119 changelog entries. **Paseo.** Native apps, relay with Noise handshake, question cards; push exists (0.4.0 fix) but is not documented. **Nimbalyst.** iOS app answers approvals.
- No product documents approving or denying straight from the notification itself.

### (10) Memory and performance with many terminals
- **Paradev.** Keep only the 12 most recent terminals live (setting), save the rest to disk, rebuild on switch-back; never offload active terminals or running TUIs; hidden browser tabs the same; measured 16 terminals: GPU contexts 16 to 4, JS heap 581 to 286 MB, process memory 1,127 to 838 MB, scrollback 80,016 to 20,004 lines; git status on a worker pool; one shared port scan per cycle, idle terminals scan every 30 s.
- **Orca.** Hibernation of finished, idle, background agents with a long veto list (see Orca section); pause updates of hidden chats; bounded PTY query reply queue; Resource Manager.
- **Conductor.** Scrollback capped in MB (default 10 MB); terminal rewritten; app rebuilt; less background git while unfocused.
- **Paseo.** Fixes for daemon memory growth, plugin hosts reaching about 1 GB, and large Git workspaces stalling file watchers. **T3.** Payload and row budgets on the wire, virtualised previews, CI metrics for CPU, memory and first request. **Emdash.** tmux persistence and Windows no-console fixes. **Nimbalyst, Vibeyard.** Not documented.

## 8. Corrections to and confirmations of REPORT.md

Confirmed (opened in the primary source):
- Orca 138.9k stars: GitHub's own page shows 139,048 on 2026-11-26.
- Orca rewind in 1.4.235: the release says "Rewind Claude chats: use Rewind to here on a message that started a turn, edit your prompt".
- Orca git graph (1.4.254, with checkout, cherry-pick, revert in 1.4.255) and blame (1.4.262).
- Orca hidden chats pause updates (1.4.262); the report's "virtualises long tool runs (1.4.259, 1.4.263)" was not found in those release notes.
- Orca auto-resume (the report says 1.4.272): the feature chain runs 1.4.232 to 1.4.272; default-on is 1.4.271 (2026-11-22).
- Conductor 0.95 quote chat text, 0.96 cost, 0.99 auto-resume, 0.101 multi-repo workspaces.
- Paradev numbers in report section 11 (581 to 286 MB, 80,016 to 20,004 lines); the entry adds the default of 12 live terminals.
- Paseo 0.16.0 background tasks above the composer; Paseo 0.17.2 cost metrics.

Corrected:
- "Paseo 0.17.0 wakes the agent when checks change": the "Watch PRs and MRs" entry is 0.17.1 (2026-11-21).
- "T3 Code v0.1.12 wakes the agent when checks or reviews change": the line "agents can watch a PR and get woken when checks, reviews, or conflicts need them" is in v0.1.0 (2026-10-15).
- "Paradev ... an undo on each turn's changes (2.0.3)": the changelog pages carry no version numbers; the only undo-per-turn found is in the experimental chat (2026-11-01 entry). Not verified.
- "Orca, Paradev and others have line comments sent to the agent": Paradev's docs describe the flow for mobile review and the PR Code tab, not the desktop Changes pane; Paseo's only trace is a one-line release note.
- Report section 5 lists Orca, cass and others for search; T3 (Cmd+K index, 0.1.3), Conductor (palette, Cmd+F including thinking), Paseo (Cmd+F beyond loaded history) and Vibeyard also have it.
- Orca Rewind and Fork exist only in Orca's structured Chat UI, not in terminal-mode sessions.

## 9. New gaps for Harbor (not in REPORT.md)

Harbor checks are `grep` over `C:\dev\harbor\app\src` on 2026-11-26 and say only that no match was found; they do not prove absence of an equivalent.

1. **The Stop payload names background work (Claude Code).** Vibeyard's `HOOKS.md` (verified against Claude Code 2.1.327): the main agent fires `Stop` whenever it pauses for parallel subagents, and the payload's `background_tasks` entries carry a `type`. Only `subagent`, `teammate` and `workflow` mean the model will produce more in this turn; `shell`, `monitor`, `MCP task`, `cloud session` do not; unknown types fail toward "completed"; running shells and monitors are shown on a finished tab (and block close, since they die with the pty). Why it matters: it is the Claude-side cure for false "done" that REPORT section 1 only describes for agy and Codex, and it gives the background-work strip of section 4 a data source. Harbor: no match for `background_tasks`. Source: https://github.com/elirantutia/vibeyard/blob/main/HOOKS.md
2. **Hook endpoint that survives a restart of the host app.** Orca writes the hook endpoint to a file (`endpoint.env` on POSIX, `endpoint.cmd` on Windows) that every hook invocation re-reads, "so long-lived agent sessions keep reaching the live Orca server even after an app restart"; Vibeyard installs a hook only for events the installed CLI version supports so an unknown key never lands in `settings.json`. Why it matters: if Harbor adopts hooks (REPORT section 1), Harbor's sessions outlive its main process by design, and a hook that posts to a fixed port would go dead after each restart. Source: https://www.onorca.dev/docs/agents/hooks-memory
3. **Bound what the keeper writes back to the terminal.** Orca v1.4.180 capped the queue of PTY "cooked-query" replies "so backlog cannot grow without bound or starve keystrokes". Why it matters: REPORT section 1 tests the keeper answering OSC 7501 `?` queries (the answer did not reach a Node child through ConPTY), and section 11 notes ConPTY already misbehaves; an unbounded reply path is the failure Orca fixed. Source: https://github.com/stablyai/orca/releases (v1.4.180, 2026-08-11)
4. **Find inside the open conversation, without an index.** Orca Ctrl+F in chat plus a message rail with one marker per prompt; Conductor Cmd+F that also searches thinking and opens the collapsed group holding the hit, plus a chat table of contents with hover summaries; Paseo Cmd+F that reaches messages beyond the loaded window. Why it matters: REPORT section 5 proposes only a cross-session SQLite index; an in-window find is a smaller first step that works on the transcript Harbor already holds. Harbor: no match for a find or message-rail component in `renderer`. Sources: https://www.onorca.dev/docs/agents/native-chat, https://www.conductor.build/changelog/0.90.0-conductor-for-ios.md, https://paseo.sh/changelog (0.9.0)
5. **Scope a turn's changes by git state, not by tool records.** T3's "Turn changes" shows the files a turn edited, committed or conflict-resolved and excludes files a `git pull`, merge or rebase brought in; Conductor snapshots the branch into a private git ref before every response. Why it matters: REPORT section 2 builds the per-turn card from Edit and Write records and section 3 notes Claude's own rewind misses Bash and subagent edits; the git-based scope covers those. Sources: https://github.com/pingdotgg/t3code/blob/main/docs/user/diffs.md, https://www.conductor.build/docs/reference/checkpoints
6. **Sidebar lifecycle: settle, snooze, wake on attention.** T3's Working, Settled and Snoozed sections: settle when a task is done for now (stays searchable, any new message reactivates it), snooze until a time (wakes early on approvals, questions, errors), auto-settle after 7 days idle or when the PR merges, an Undo toast, and a rule that a thread a scheduled task targets must be settled, not archived. Why it matters: REPORT section 12 lists only "archive finished workspaces on a rule"; with 16 windows and 15 plans the rail needs a state between "open" and "closed". Harbor: no match for `snooze`. Source: https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md
7. **Continue in another CLI with a bounded handoff.** Paradev sends the last 36,000 characters, marked read-only, with the instruction to check `git status` first because the workspace, not the transcript, is the source of truth. T3 sends a budgeted history (default 16,000 tokens), starts a fresh session when the target lacks room, leaves reasoning traces, raw tool state and attachments out, and lets the new agent fetch omitted history with a thread-reading tool. Orca (v1.4.246) offers it at a usage limit. Why it matters: Harbor hosts four CLIs and 15 Claude plans, and REPORT sections 3 and 6 cover fork and plan switching but not "this CLI is capped, continue the work in another one". Sources: https://docs.paradev.com/agent-sessions, https://github.com/pingdotgg/t3code/blob/main/docs/user/portable-handoffs.md
8. **Design details for usage-limit auto-resume that earlier attempts learned.** Orca removed its Continue button because it "could hit the same limit again" (v1.4.242), cancels per chat, ignores resets older than 24 hours, ties the setting to the host running the agent, waits for sleeping workspaces to wake, and later continued on a switched account (v1.4.259); T3 starts new threads on providers that are not currently limited (0.1.5). Why it matters: REPORT section 6 calls auto-resume "small"; these are the cases that made it not small. Source: https://www.onorca.dev/docs/agents/native-chat
9. **Permission cards for asks that come from rules or hooks, even in bypass or full access.** Paseo 0.16.1 fixed "Claude Bypass approving actions without a permission card when a `permissions.ask` rule or a hook that returns `ask` required one"; T3 0.1.2 shows "why Claude asked" on approvals in full access. Why it matters: Harbor draws permission prompts from the pty and its own hook lane, and Pat runs bypass modes. Source: https://paseo.sh/changelog (0.16.1), https://github.com/pingdotgg/t3code/releases/tag/v0.1.2
10. **A resource view per session and process.** Paradev's Machine resources page (every 2 seconds: CPU and memory by app, workspace and terminal pane, click to jump) and Orca's Resource Manager (CPU, memory, sessions, daemon controls, workspace disk scans). Why it matters: REPORT section 11 covers renderer memory and node-pty, not a per-session process table showing which session's process tree is heavy; Harbor's win32 process-question helpers could feed one. Sources: https://docs.paradev.com/usage, https://www.onorca.dev/docs/terminal
11. **Agent-set one-line status per workspace.** Orca's `orca worktree set --comment ... --workspace-status in-progress`, written by the agent at checkpoints, with the rule "read before writing" so it never overwrites the person's own goal text. Why it matters: a rail row that says what the agent just did and what is next, from the agent itself, with Harbor's existing board and notes CLIs as the transport. Source: https://www.onorca.dev/docs/cli/worktree-checkpoints
12. **Tool-call visibility modes.** T3: Show all, Hide successful, Hide all, Zen (only your prompt and the final reply). Why it matters: REPORT section 12 only proposes folding runs of tool calls (Conductor, Orca). Source: https://github.com/pingdotgg/t3code/blob/main/docs/user/activity-log.md
13. **Automation guard rails beyond a precheck.** T3: a duplicate-request key (7 days), a coalesce window, signatures, placeholder values wrapped so untrusted input cannot invoke skills; Paradev: say plainly that delivery is at-least-once, success means "workspace created", and an offline host means a missed run; filter a trigger by person so the agent's own comments do not retrigger it. Why it matters: REPORT section 7 mentions Orca's precheck only. Sources: https://github.com/pingdotgg/t3code/blob/main/docs/user/project-settings.md, https://docs.paradev.com/automations
14. **Review-pane details worth copying on day one.** Mark files viewed and show them again as changed after new commits (Conductor 0.29.1, T3); a Review queue plus per-hunk keep or revert for edits to documents (Nimbalyst); comments cleared only after confirmed delivery (Emdash 1.2.8); resolved threads fold into avatars on their line (T3 0.1.10); a hover diff peek from the edited-files list (Nimbalyst). Sources: https://www.conductor.build/changelog/0.29.1-customize-prompts-mark-files-as-viewed.md, https://emdash.com/changelog, https://nimbalyst.com/docs/file-management/file-edits-sidebar.md
15. **Check Harbor's own usage reading against Orca's lesson.** Orca v1.4.219 "stop driving a hidden Codex TUI to read usage" (2026-10-02). Not checked here whether any Harbor path reads Codex or agy usage by driving a TUI; Harbor's memory notes say idle Claude plans are refreshed with headless `claude -p /usage`. Source: https://github.com/stablyai/orca/releases (v1.4.219)

## 10. What was not read

- **Orca.** GitHub release notes before v1.4.104 (before 2026-06-28; HTTP 429 on release pages past page 36); the plugin directory; per-plugin pages.
- **Paseo.** The roughly 40 per-provider pages; the blog (3 posts); the GitHub release list itself (the site changelog was read instead); Hub sub-pages read by title only.
- **T3 Code.** Stable releases before v0.0.32 (before 2026-08-07); `docs/internals/*` except the performance page and the file list; `docs/operations/*`; user pages not opened: appearance, browser-import, cli, default-browser, faq, html-renders, install, keybindings, keyboard-focus, open-source-licenses, project-settings (only the scheduled-tasks section), prompt-links, providers-* (only Claude, Cursor, ACP skimmed), question-attachments, secrets-*, snap-shot, t3-json, telemetry, text-generation, updating.
- **Paradev.** Plugin pages (30), SDK pages, the CLI reference (130 KB), recipes (by title), blog posts (first paragraph only), changelog entries from 2025.
- **Conductor.** Cloud, API and harness docs pages and most guides (by title); changelog entries for model releases and bug-fix releases (titles only); entries before 2026-01-05 (index titles only); the blog.
- **Emdash.** GitHub releases dated 2026-11-01 to 2026-11-19 (the changelog page stops at v1.2.10, 2026-10-30); `CONTEXT.md` and the ADRs; the blog.
- **Nimbalyst.** Wiki, extension, team and feature pages (title and first paragraph only); release announcement archive; no changelog page was found.
- **Vibeyard.** `HOOKS.md` was read to the end of the Stop-resolution section only (about 40% of the file).
- **All products.** Competitor behaviour is as documented; nothing was installed or run.
