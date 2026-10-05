> Superseded by [Session daemon cutover](SESSION-DAEMON-CUTOVER.md) for the current session architecture.

# Harbor v2 architecture (2026-07-17)

> **SUPERSEDED IN PART: "Slate" redesign, 2026-07-18.** The renderer described
> below (terminal grid as the main surface, context bar, sidebar meters,
> preview panel) was replaced wholesale by the Slate conversation workspace
> from the author's Claude-design handoff (`design_handoff_harbor_slate/`): a session
> rail, up to four designed conversation windows parsed live from session
> JSONL transcripts (`app/src/main/providers/transcript.js`), a universal
> command bar driving the selected session's pty (`app/src/main/session-send.js`,
> provisional session↔pane links, resume-then-send), per-window raw-terminal
> toggle, and title-bar usage rings + workers chip. Sections 1-3 (daemon
> choice, bridges, streams, lifecycle) remain accurate; treat renderer-layer
> sections as historical. Current conventions: /home/you/dev/harbor/CLAUDE.md.

Decision record + build plan for the "Harbor" desktop app. Requirements:
/home/you/dev/harbor/docs/REQUIREMENTS-v2.md. Evidence:
/home/you/dev/harbor/docs/RESEARCH-2026-07-17.md.

## 1. Decision: Electron GUI head on the stock herdr daemon

- The daemon stays stock herdr 0.7.4 (pinned). Upstream ships a purpose-built third-party
  client surface: `session.snapshot`, `events.subscribe`, `layout.updated`, and the
  terminal bridge `herdr terminal session observe|control` (NDJSON frames of base64 ANSI
  bytes; control adds input/resize/scroll/release with exclusive ownership). Forking a
  200k-line weekly-release Rust codebase or replacing it were costed and rejected
  (RESEARCH section 3).
- The GUI shell is Electron. Reasons: full keyboard ownership (a browser-tab app can
  never own Ctrl+W/Ctrl+N, fatal for terminals), xterm.js is the proven terminal widget
  (VS Code), Electron already runs fine on this box (Claude Desktop unofficial,
  teams-for-linux; note the GPU workaround precedent if NVIDIA/Wayland misbehaves:
  disable GPU compositing rather than fight it). Tauri rejected: webkitgtk on
  NVIDIA/Wayland is the exact fragility this machine punishes, for no user-visible gain.
- One window (A4). Left sidebar = session browser. Center = terminal tabs/grid mirroring
  herdr workspaces. Header = per-account usage meters. Right/into-sidebar section =
  orchestration panel per project.
- The existing TUI harbor (Ptyxis "Harbor" profile + harbor-hydrate) keeps working
  unchanged against the same daemon. Both heads see the same panes. Cutover is only the
  Copilot key default (R10), with the TUI path preserved as fallback.

## 2. Components

Repo layout (this repo becomes a git repository; app code in app/):

```
/home/you/dev/harbor/
  app/
    package.json            Electron + React + xterm.js, esbuild or vite build
    src/main/               Electron main process
      herdr/client.js       control-plane: NDJSON unix-socket client (85-method API),
                            session.snapshot bootstrap, events.subscribe + #1270 dedupe
      herdr/streams.js      pane stream supervisor: spawns `herdr terminal session
                            observe|control <pane>` child processes, decodes frames,
                            routes input/resize, enforces focus-acquire/blur-release
      providers/history.js  child_process around bin/harbor-index.py (emit/tree/meta/
                            preview/hydrate JSON adapters) + fs watch on
                            /home/you/.claude/projects + debounce
      providers/delegate.js reads/watches /home/you/.local/state/claude-delegate/
                            queues/<sha1(cwd)[:12]>.json + workers.json
      providers/usage.js    per-account 5h/weekly/cost, reusing the statusline's method
                            (locate via statusLine entry in the shared settings.json;
                            prior art from an earlier personal usage-dashboard script)
      actions/launch.js     resume via bin/claude-sessions --resume-id <id> --home <h>;
                            new via bin/ai [--team] semantics; kickoff panes via herdr
                            socket (workspace ensure by exact label, tab create, pane run
                            claude-go [--team] "<prompt>") with cwd = project root
      lifecycle.js          daemon presence check, start via bin/herdr-server-clean,
                            protocol/schema assert (16 / 1), single-instance lock
      notify.js             agent-status events -> notify-send for unfocused panes
    src/preload/            contextBridge: typed IPC only, no nodeIntegration
    src/renderer/           React UI: Sidebar, TerminalGrid (xterm.js), HeaderMeters,
                            OrchestrationPanel, theming (dark default)
    test/                   unit + integration (isolated herdr session harness)
    verify/                 screenshots + E2E artifacts (gitignored except .keep)
  bin/                      v1 glue, UNTOUCHED and reused as the organs
  docs/                     this file + REQUIREMENTS + RESEARCH + herdr-api.schema.json
```

## 3. Data flow

- Boot: lifecycle.js -> daemon up (or clean-start) -> client.js session.snapshot ->
  renderer store hydrated -> events.subscribe keeps it live (dedupe per S6).
- Sidebar model = merge of (a) live panes/workspaces from snapshot+events, (b) history
  from providers/history.js. Join key: workspace label == project label (exact-label
  rule) and agent_session ids from pane.report_agent_session (claude integration v7
  already reports them).
- Terminal: renderer mounts xterm per visible pane; streams.js runs one observer per
  visible pane (multi-observer safe), acquires control on focus (exclusive), releases on
  blur; offscreen panes have no stream attached (peak 7 concurrent sessions, D4).
- Resume click: renderer -> IPC -> actions/launch.js -> claude-sessions --resume-id
  (live-guard, account auto-detect, workspace routing) -> pane.created event -> sidebar
  updates + pane focused. The GUI never reimplements resume logic (S2).
- Orchestration: providers/delegate.js watches the queue file; kickoff spawns a
  WATCHABLE interactive claude in a herdr pane (claude-go --team "/orchestrate-research
  <goal>" with cwd = project root); execution likewise; a workspace-level mutex in
  actions/launch.js enforces A12 on top of a queue-state check.
- Usage: providers/usage.js polls per home on a gentle cadence; meters render both
  accounts; "unavailable" is an explicit rendered state (R6).

## 4. Verification strategy

- Isolated herdr session harness for anything mutating: a named session (own socket under
  /home/you/.config/herdr/sessions/<name>/) started with the herdr-server-clean
  env pattern, torn down after. The user daemon at
  /home/you/.config/herdr/herdr.sock is read-only territory for tests (A5/S4/S5).
- Bridge tests: spawn pane in isolated session -> run command -> assert streamed frames
  -> send input -> assert echo -> resize -> close. Contention test documents
  observe-vs-control and control-vs-control (--takeover) behavior.
- E2E: Playwright driving the Electron binary (xvfb-run fallback if the Wayland session
  is unavailable to the runner), against the real corpus read-only + isolated session for
  interactions. Orchestration kickoff E2E uses CLAUDE_DELEGATE_DRY_RUN=1 and a throwaway
  workspace directory, never real workers.
- Every batch ships its DONE WHEN evidence (command output, screenshots under
  app/verify/); the orchestrator re-verifies before marking a batch done, then the author gets
  a final adversarially-reviewed walkthrough (quality-plus rounds) before cutover.

## 5. Pinning and upgrade posture

- Archive the current binary to /home/you/.local/bin/herdr-0.7.4 (copy, not move).
- Never call `herdr update` from code or automation; updates remain a manual action.
- On connect, assert `herdr status` protocol == 16 and api schema_version == 1; on
  mismatch show a blocking-but-honest banner ("herdr changed underneath; harbor needs a
  compatibility pass") while the sidebar's history features (indexer-only) keep working.
- A verbatim docs mirror at `docs/upstream-herdr-docs/` was maintained against 0.7.4 at
  the time this was written; it was later removed (Herdr's docs are AGPL-licensed, and
  mirroring them inside an MIT repo was a licensing conflict, not a housekeeping choice;
  see `docs/UPSTREAM-HERDR.md`). The API ground truth remains `docs/herdr-api.schema.json`.

## 6. Known risks and their mitigations

- Control-channel contention with an attached TUI client: acquire control only on focus,
  release on blur, test the takeover matrix in the isolated harness (batch 2). If a TUI
  client holds control of a focused pane, surface a one-line "controlled by terminal
  client" state instead of fighting for input.
- events.subscribe replay (#1270): snapshot-then-dedupe (S6).
- xterm.js perf with many panes: stream only visible panes; cap scrollback; virtualize
  the sidebar list (1,000+ rows).
- Usage numbers availability: reuse the statusline's exact method; degrade honestly.
- Electron/Wayland quirks: ship with sane ozone defaults; document the disable-GPU
  fallback used by teams-for-linux; never require the author to debug rendering.
- Worker quota: Claude workers default to the personal pool (delegate env.sh); heavy
  mechanical batches go to Codex/Cursor lanes.
