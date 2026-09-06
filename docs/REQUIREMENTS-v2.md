# Harbor v2 requirements (2026-07-17)

Product: "Harbor", a Linux desktop application that recreates the Claude Code
Windows desktop app experience the author lost in the migration, plus two enhancements the
official app never had: seamless dual-plan operation and first-class orchestration
kickoff. Evidence base: /home/you/dev/harbor/docs/RESEARCH-2026-07-17.md.
Architecture: /home/you/dev/harbor/docs/ARCHITECTURE-v2.md.

Every requirement below is testable. Workers cite these ids in reports.

## R: Functional requirements

- R1 Session browser sidebar. Projects as collapsible groups (carets), sessions nested
  under each, sorted by last-active descending. Shows live sessions (running herdr panes),
  recent, and full history in one panel. Per-project session count and last-active time.
  Per-session row: title (first-prompt derived), last-active, soft account badge, live
  indicator, win: tag for Windows-era. An in-place "older..." expander for deep history
  (never a popup). Hide empty sessions; dedupe migration twins by session id.
- R2 Per-session click targets. Clicking a live session focuses its terminal pane.
  Clicking a historical session resumes it (correct cwd, auto-detected account, live-guard
  honored) and opens its pane. One click, no confirmation for normal resume.
- R3 Time filtering and search. Filter chips (Today / 7d / 30d / All, plus custom since),
  free-text search across project label and session title/first prompt. The display day
  rolls at 06:00 local (the author works past midnight). Windows-era sessions remain listed and
  searchable with resume disabled and the reason shown.
- R4 Real terminals. Each session is a real terminal (xterm.js) attached to its herdr
  pane via the observe/control bridge. Tabs group panes by project workspace, mirroring
  herdr state. Typing, paste, resize, scrollback work like a native terminal. Copy/paste
  follows the author's convention: Ctrl+C copies when a selection exists (else interrupt),
  Ctrl+V pastes.
- R5 New session. A "+" affordance per project group and a global one. Account is chosen
  at the point of click via labeled split actions (New team / New personal), never via
  hidden state. A folder picker starts a session in any directory, including home-dir
  "general" sessions. New sessions land as herdr panes (bin/ai semantics) launched via
  claude-go with skip-permissions, in the chosen config home.
- R6 Plan/usage layer. Always-visible per-account meters for BOTH plans: 5-hour usage,
  weekly usage, cost, with account email and color coding consistent with the author's
  statusline. If a number is unobtainable, show an explicit "unavailable" state with the
  reason; never fake or hide it. Every launch/resume surface shows which account will be
  used at the point of action.
- R7 Orchestration panel. Per-project: the claude-delegate queue rendered live (sprint
  groups, batch cards with status, worker, last result excerpt, errors, timestamps),
  named workers for the workspace, and two kickoff actions: Research (goal text ->
  spawns a watchable pane running /orchestrate-research in the project root on the team
  seat) and Execute (spawns /orchestrate-execution the same way). Hard guard: refuse a
  second concurrent execution for the same workspace, with the reason shown.
- R8 Notifications. OS notification when a session that is NOT currently focused
  transitions from working to idle/done (herdr agent status events). No notification for
  the focused session. Coalesce bursts; never a modal.
- R9 Persistence and restore. The app attaches to the running daemon; if absent it starts
  one via bin/herdr-server-clean. After reboot, natively restored panes appear
  automatically; the sidebar's history works regardless of daemon state.
- R10 Copilot key. Bare = open/focus the Harbor app. Ctrl+Copilot = new TEAM
  session in the folder on screen. Alt+Copilot = new PERSONAL session in the folder on
  screen. This fixes the existing claude-key bug (today Ctrl launches personal and Alt
  opens the harbor, contradicting /etc/keyd/default.conf comments and the README).
  No keyd config changes; only the dispatcher script changes.
- R11 Look and feel. Claude Code desktop app design language: clean single window,
  left sidebar, header, dark theme default (light optional). Showable-to-a-stranger bar:
  visual grouping in nav, one primary action per row, no wall of equal-weight chrome,
  equal-height cards/tiles. No AI-slop styling.
- R12 Docs. README updated; the user guide PDF regenerated at the end with REAL
  screenshots of the shipped app (side-panel sessions, plan switching, orchestration,
  Copilot key), delivered to the author's personal output folder
  and copied into docs/.

## A: Anti-requirements (hard, from the author's recorded rejections)

- A1 No popups or overlays covering work. Ever. (Right-click context menus are fine.)
- A2 No keybinds the author must memorize to use the thing. Mouse-first; optional shortcuts may
  mirror the desktop app but nothing is keyboard-only.
- A3 No typed commands as the interface. `hist`/`ai` remain for agents/scripts only.
- A4 No additional windows. ONE app window is the harbor. (The existing Ptyxis TUI
  harbor remains available as a fallback but is no longer the primary.)
- A5 Never break the running session: no keyd restarts, no herdr daemon
  restarts/updates, no writes to the author's live panes, no pkill -f, no edits to
  /etc/keyd/default.conf. The live daemon may be read (snapshot/observe) but tests that
  mutate state run ONLY against an isolated named herdr session.
- A6 Never auto-update herdr. Pin 0.7.4; assert protocol 16 + schema_version 1 on
  connect; fail loudly on mismatch.
- A7 No "the platform can't do it" dead-ends without exhausting the public API and
  naming the upstream path. The author rejected this excuse explicitly.
- A8 No AI-slop UI (dense boxed text, gradient noise, gimmick taglines, em dashes in
  copy). No em dashes in any author-facing text, docs, or UI strings.
- A9 No "done" claims without driving the real flow. Every batch's DONE WHEN is
  verifiable by inspection or a command.
- A10 No new launcher named `cc`. No renaming herdr workspaces programmatically (exact-
  label routing depends on it).
- A11 Never resume a session that is live elsewhere (two writers, same transcript). The
  90-second live-guard from claude-sessions is the floor.
- A12 Never run two orchestration executions against one workspace concurrently.
- A13 Never hide crashed/mid-stream sessions from the browser (the Windows desktop app
  did; it cost the author real sessions).

## D: Data-derived UI rules

- D1 ~16 new sessions/day, ~500/month: grouping + search are baseline, flat lists fail.
- D2 Top 4 projects are 73% of sessions but the #2 "project" is the bare home dir:
  title/first-prompt search must be first-class, especially inside "~".
- D3 40% of sessions are multi-sitting: default sort is last-active, with the timestamp
  visible.
- D4 Parallel sessions are the norm (2+ in 58% of active moments, peak 7): concurrent
  same-project rows must be distinguishable at a glance (title + last prompt + time);
  never use "newest mtime" as "the current session".
- D5 28% of sessions have no confident account attribution: badges are soft/best-effort
  (team fallback), never a hard filter default.
- D6 Transcripts reach 154 MB: previews use the indexer's capped head/tail scans only.
- D7 The display day rolls at 06:00 local.
- D8 Both plans are load-bearing (personal 55% / team 45% of prompts): dual meters and
  per-account actions are first-class, not a settings page.

## S: Safety and integration invariants

- S1 The herdr daemon is started ONLY via
  /home/you/dev/harbor/bin/herdr-server-clean (panes inherit the
  server env; a dirty daemon leaks session ids/keys into every pane).
- S2 Resume goes through bin/claude-sessions --resume-id (live-guard, account detection,
  exact-label workspace routing) and new sessions through bin/ai semantics. The GUI does
  not duplicate this logic.
- S3 All claude-delegate operations run with cwd = the project root (queue identity is
  sha1(cwd); a wrong cwd operates a phantom queue).
- S4 Workers/tests touching herdr use an isolated named session (its own socket under
  /home/you/.config/herdr/sessions/<name>/); the default socket is read-only
  territory for tests. Tests never call `herdr update`, never restart the user daemon.
- S5 The observe stream is multi-observer and safe on live panes; control/takeover is
  exclusive and is acquired only on user focus of a pane in the GUI, released on blur,
  and NEVER exercised against the author's live panes in tests.
- S6 events.subscribe replays history to new subscribers (upstream #1270): bootstrap
  from session.snapshot and dedupe by ids/revisions.
- S7 Launches always go through claude-go (config-home selection + trust pre-accept +
  skip-permissions); the GUI never exports CLAUDE_CONFIG_DIR itself for interactive
  sessions.
- S8 The app is single-instance: a second launch focuses the existing window.
