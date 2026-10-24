# CLI settings in Harbor: build report (2026-10-24)

Worktree `C:\dev\.orch\harbor\cli-settings-ui`, branch `cli-settings-ui`, cut from `board-agent-write` at 800e4bb. Not merged, pushed or published.

## Summary

- **`>_` on a dialog works now.** Two causes, both proven by bisection against Pat's own input log: the window's header buttons kept the keyboard (keys never reached the terminal), and the terminal view never learned that the CLI had switched mouse reporting on, so clicks only selected text. Fixed and pinned two-sided.
- **`/mcp` opens Harbor's own Connections panel.** Every MCP server and claude.ai connector for the session's plan and folder, grouped like the CLI, with Sign in, Sign out, Reconnect, Enable and Disable. Sign in was proven end to end on the real CLI with a throwaway OAuth server: the running session gets the new tools after one reconnect, which the panel does by itself.
- **Every other built-in list dialog gets a list card**: all rows, the highlighted one marked and kept in view, a click walks the CLI's pointer there (re-reading after every key) and presses Enter only once it is verified on that row. Proven on the real `/mcp` (20 rows, pointer 14 rows deep), `/plugin` (including its search) and `/theme`.
- **The review found eight dialogs that showed nothing at all** in the window (`/plugin`, `/hooks`, `/powerup`, `/config`, `/feedback`, `/mobile`, `/skills`, `/workflows`): dead ends. All eight are closed (list card or the raw-keys panel).
- **One step needs Pat**: a real claude.ai connector (Zoom) sign-in stops at his consent click on claude.ai. Everything up to that click is built and proven; the throwaway-server proof covers the rest of the path.

## Commits (all in this worktree)

| Commit | What |
|---|---|
| 190ab58 | `>_` view takes keys after a window button and forwards clicks to the CLI |
| 23274de | `/mcp` opens the Connections panel; Sign in, Sign out, Reconnect, Enable, Disable |
| 51999ec | Generic list card for built-in list dialogs; menu-parse edge fix |
| f8b7d39 | Eight dialogs no longer leave the window blank; list card handles `/plugin`, `/theme` and kin |
| (this commit) | The slash-dialog probe and this report |

## What changed, by file

### Part 1: `>_`

- `app/src/daemon/screen.js`: `read()` now also reports the pane's input modes (`inputModes()`: mouse tracking and encoding, bracketed paste, application cursor keys, focus reporting, cursor visibility) from the keeper's headless terminal.
- `app/src/main/terminal-bridge.js`: `modeSequence()` turns those modes into the escape sequences that set them, and `backfillPane` sends them with the screen, so a freshly opened `>_` view starts in the same modes as the CLI (the CLI only re-asserts mouse mode at startup or on a real size change, and that re-assert arrived before the view was listening).
- `app/src/renderer/stage/terminal-view.cjs`: `windowClickArms` and `headerKeepsKeys`, the two decisions: a click in a window showing `>_` focuses the terminal, and a header button never takes the keyboard away from it.
- `app/src/renderer/stage/SessionTile.jsx`: uses both.
- Specs: `app/test/main/terminal-view-modes.test.js`, `app/test/daemon/screen-modes.test.js`, `app/test/renderer/terminal-view.test.js` (7 checks fail at 800e4bb, pass now).
- Drives: `app/scripts/drive-mcp-tty-win.js` (the proof), `app/scripts/probe-mouse-mode-win.js` (which stimuli make the CLI re-assert mouse mode).
- Doctrine: `docs/claude/views.md`, bullet "A `>_` VIEW STARTS WITH THE PANE'S INPUT MODES AND KEEPS THE KEYBOARD".

### Part 2: Connections

- `app/src/main/providers/mcp-connections.js` (new): runs `claude mcp list` / `get` / `logout` for the session's config home and folder (`CLAUDE_CONFIG_DIR` set, `ENABLE_CLAUDEAI_MCP_SERVERS` removed so claude.ai connectors are listed), groups like the CLI, decides each row's actions, runs sign-in jobs (starting, waiting in the browser, verifying, reconnecting, done or failed), and runs the CLI's inline `/mcp reconnect|enable|disable <name>` in the live session, reading the result from the transcript.
- `bin/harbor-mcp-login` (new): holds `claude mcp login --no-browser <name>` in a real pty (the CLI refuses OAuth without a terminal) and reports the sign-in address and the outcome as JSON lines; `cancel` on stdin ends it. A script CLI (an npm `cli.js`, a stand-in) runs under a real `node.exe`, because Electron-as-Node inside a ConPTY prints nothing and exits 0 (measured).
- `app/src/main/index.js`, `app/src/main/rpc/channels.js`, `app/src/preload/index.js`: the `connections:*` channels (local only) and the update push.
- `app/src/renderer/stage/ConnectionsPanel.jsx`, `connections-model.cjs`, `connections.css` (new): the panel.
- `app/src/renderer/stage/CommandBar.jsx`: bare `/mcp` (typed, or picked from the slash menu) opens the panel and types nothing into the session; the capability menu gets "Connections: sign in, reconnect, enable or disable..." and the `+` menu's Connectors section gets "Manage connections...". `/mcp reconnect <name>` and the other inline forms still go to the session as typed.
- Specs: `app/test/providers/mcp-connections.test.js` (18), `app/test/renderer/connections-model.test.js` (6), `app/test/bin/harbor-mcp-login.test.js` (5, including the Electron case, which fails without the fix), `app/test/main/rpc-router.test.js` (channel census). Fixtures `app/test/fixtures/mcp/` (generic names).
- Test support: `app/test/support/fake-claude-mcp.cjs` (stand-in CLI), `app/test/support/mcp-session-standin.js` (stand-in session), `app/scripts/lib/oauth-mcp-standin.cjs` (loopback OAuth server plus a protected MCP server with two tools).
- Drives: `app/scripts/drive-mcp-signin-win.js` (real CLI proof), `app/scripts/drive-connections-win.js` (panel UI), `app/scripts/probe-mcp-inline-win.js` (inline action wording).
- Doctrine: `docs/claude/conversation.md`, bullet "`/mcp` IS HARBOR'S OWN CONNECTIONS PANEL, AND A SIGN-IN IS NOT LIVE UNTIL THE SESSION RECONNECTS".

### Part 3: generic list

- `app/src/main/generic-list.js` (new): reads a built-in list dialog whole (rows lined up on their label column, section headers, notes, wrapped sentences, row descriptions, the detail column, a scrolling list's hidden-row count and scrollbar, a search field's text). Refuses anything `menu-parse` recognizes, numbered rows, MCP input forms, toggle lists ("Enter to toggle") and stale frames under a live prompt.
- `app/src/main/session-send.js`: the fallback panel carries the parsed list; `list-pick` is the verified walk (one arrow, re-read the grid, repeat; Enter only on the verified row; steps from a search field into the list); `raw` with `perKey` types one key at a time (the CLI's text fields drop a chunk); a Backspace key; and the blocked-screen check now counts any generic list and any capital "Esc to cancel/close/clear/go back" once the tail shows no prompt and no working turn.
- `app/src/main/menu-parse.js`: the dialog's top edge can carry the status line drawn into it (`▔▔▔…▔ ○ low · /effort ▔`); before this, the per-server `/mcp` menu's question began with the session banner.
- `app/src/renderer/stage/AskCard.jsx`, `app/src/renderer/styles.css`: `ListCard`, with only the keys the dialog's footer names (arrows for tabbed dialogs, Space, Backspace when searching, Enter, Cancel) and a search field when the dialog takes typing.
- Specs: `app/test/main/generic-list.test.js` (25), `app/test/main/menu-parse.test.js` (+1, fails before the edge fix), `app/test/renderer/session-tile-ask.test.js` (raw-key census now 4 places, reason recorded). Fixtures `app/test/fixtures/generic-list/` (Pat's real screens with every name and path made generic; `/theme`, `/powerup` and plugin details as drawn, banner removed).
- Drive: `app/scripts/drive-generic-list-win.js` (`HARBOR_DRIVE_COMMAND=plugin|theme`, `HARBOR_DRIVE_SEARCH=<text>`).
- Doctrine: `docs/claude/conversation.md`, bullet "A BUILT-IN LIST DIALOG IS A LIST, NOT AN UNRECOGNIZED PROMPT".

### Part 4: review

- `app/scripts/probe-slash-dialogs-win.js` (new): opens each command in its own fresh real session and daemon, classifies what it draws, presses Esc once. Presses Enter only when the command menu's highlighted entry is exactly the command (see Incidents).

## What was proven, and how

All drives run the real renderer hidden and offscreen on the capture host, against an isolated sessiond the script starts; none touches the live Harbor, `~/.harbor/config.json` or a real session.

1. **`>_`**: `node app/scripts/drive-mcp-tty-win.js` with the real CLI showing `/mcp`. PASS: the view shows the dialog with mouse events on; after the window's focus button, three Down presses move the CLI's pointer three rows; one click on a row opens that server's menu. At 800e4bb (`HARBOR_DRIVE_APP=C:\dev\.orch\harbor\cli-settings-ui-prefix\app`) all three fail, the way Pat saw.
2. **Sign in, real CLI**: `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/drive-mcp-signin-win.js` (run with `HARBOR_DRIVE_CLAUDE_HOME` set to this worker's plan home). Adds a throwaway local-scope HTTP server backed by the loopback OAuth stand-in, then: the CLI and the live session both read it as needing a sign-in; a control sign-in without a reconnect leaves the running session still needing authentication 20 s later; one `/mcp reconnect` brings its 2 tools in; the real sign-in job goes starting, waiting, verifying, reconnecting, done, and the session answers "Successfully reconnected"; the session's own `/mcp` shows "2 tools"; Sign out reverses both. Server, tokens and transcript removed afterwards. Result: `private\proofs\signin-proof.json` (0 problems).
3. **Panel UI**: `node app/scripts/drive-connections-win.js` (stand-in CLI and session, 20 servers shaped like Pat's list). PASS: `/mcp` + Enter opens the panel and types nothing into the session; all 20 listed in the CLI's groups; Sign in on a claude.ai connector opens its address once and waits; when claude.ai confirms, the session is reconnected and the row reads Connected; a refused sign-in shows the CLI's own reason; Reconnect on a row reports the session's answer; Esc closes. Shots `private\shots\connections\` (list, list bottom, waiting, signed in, failed, reconnect), each read.
4. **Generic list, real CLI**: `node app/scripts/drive-generic-list-win.js`. PASS: with the pointer moved 14 rows deep from the terminal side, the card lists all 20 rows and highlights the same row the CLI does, in view; a click three rows further opens that server's own menu; the card's Esc returns the dialog to the list. At 800e4bb the window shows the raw tail with the highlighted row cut off and nothing to click (Pat's screenshot, reproduced: `private\shots\generic-list-prefix\`). Also `/plugin` (search typed from the card filters the real list; a click from the search field opens that plugin's details, nothing installed) and `/theme` (8 rows, current-theme mark kept). Shots `private\shots\generic-list*\`, each read; defects seen in them were fixed and re-shot (squashed section headers, the search box frame in the subtitle, descriptions missing, a wrapped warning shown as rows, hover erasing the highlight).
5. **Dead ends**: the real `getMenu` run over every captured dialog screen at 800e4bb and now (`private\slash-dialogs\window-prefix.json`, `window-now.json`).
6. **Unit gate** (`npm test -- --exclude daemon --exclude bin` from `app\`): 2669 tests, 2658 pass, 0 fail, 11 skipped by their own platform conditions, on the final code (the first full run caught two real issues, both fixed: the highlighted row's tint erased on hover, and the raw-key census). The touched daemon and bin specs pass locally as well (`daemon/screen-modes`, `bin/harbor-mcp-login`).

## Review: Claude Code 2.1.303 commands that open a screen

Measured, not guessed: each command was opened in its own fresh real session (this worker's plan home, folder `C:\dev\.orch\harbor\cli-settings-ui`), and the window's answer comes from Harbor's real `getMenu` on that screen. "Typed" is how often Pat typed the bare command across all five plans' prompt history since 2026-04-03 (last 30 days in brackets), my probe sessions excluded. Screens: `private\slash-dialogs\`.

| Command | What it opens | Window before | Window now | Typed | Recommendation |
|---|---|---|---|---|---|
| `/mcp` | server list | raw tail | Connections panel (typed in Harbor); list card (from the terminal) | 46 (30) | Done: native panel |
| `/login` | sign-in method picker | question card | question card | 18 (6) | Works; no native needed |
| `/plugin`, `/plugins` | tabbed plugin manager with search | **nothing** | list card (search, tabs, Space) | 17 (0) | Fixed; native only if use returns |
| `/model` | model picker | question card | question card | 15 (1) bare, 299 with a model name | Works; Harbor's capability menu is the native surface already |
| `/rate-limit-options` | usage-limit choices | question card | question card | 7 (7) | Works |
| `/effort` | slider (←/→) | raw panel | raw panel | 1 bare, 195 with a level | Raw keys fit a slider; the capability menu already sets effort |
| `/skills` | skill list, hint at the top | **nothing** | raw panel | 5 (0) | Fixed (no dead end); list card would need a footerless variant |
| `/status`, `/usage`, `/cost` | Settings tabs (Status, Usage) | raw panel | raw panel | 2, 1, 0 | Read-only; Harbor's plan meters cover usage |
| `/config` | tabbed settings, search | **nothing** | raw panel | 0 | Fixed (no dead end). Native settings only if Pat asks; rows are toggles |
| `/theme` | theme list with preview | raw panel | list card | 0 | Done (generic) |
| `/permissions` | rules tabs | question card | question card | 0 | Works |
| `/hooks` | read-only hook list | **nothing** | list card | 0 | Fixed (generic) |
| `/memory` | memory files and the auto-memory toggle | raw panel | raw panel | 0 | Raw keys (it draws two pointers, a toggle and a list) |
| `/resume` | session picker with search | raw panel | raw panel | 0 bare | Harbor's rail is the native resume |
| `/privacy-settings` | one toggle | raw panel | raw panel | 0 | Raw keys on purpose: a click must never flip a setting |
| `/export` | copy or save picker | question card | question card | 0 | Works |
| `/usage-credits`, `/extra-usage` | sign-in prompt | question card | question card | 1, 0 | Works |
| `/release-notes` | version list | raw panel | list card | 0 | Done (generic) |
| `/chrome`, `/remote-env`, `/powerup` | small lists | raw panel / nothing | list card | 0 | Done (generic) |
| `/feedback`, `/workflows`, `/mobile` | drafts list, workflow list, QR code | **nothing** | raw panel | 0 | Fixed (no dead end) |
| `/add-dir`, `/ide`, `/install-github-app`, `/fast`, `/help`, `/rewind`, `/import`, `/passes` | text field, pickers, info | raw panel | raw panel | 0 | Raw panel is enough at this use |
| `/agents` | (removed in 2.1.303; prints a note) | no dialog | no dialog | 0 | Nothing to do |
| `/output-style`, `/context`, `/color`, `/plan`, `/cd`, `/rename`, `/diff`, `/sandbox` | print a line (or change only this session) | no dialog | no dialog | 0 | Nothing to do |
| `/scroll-speed`, `/loops`, `/daemon`, `/todos`, `/vim`, `/output-styles`, `/approved-tools`, `/statusline-help` | "unknown command" on this plan | no dialog | no dialog | 0 | Not available here |
| `/doctor`, `/tasks` | in Pat's plans these names are his own skills (model turns) | n/a | n/a | 5, 0 | Not dialogs |
| `/skill-doctor` | was still loading when captured | n/a | n/a | 0 | Not judged |

Not opened, because they act the moment they run: `/logout`, `/clear`, `/exit`, `/compact`, `/init`, `/statusline`, `/review`, `/security-review`, `/pr-comments`, `/insights`, `/background`, `/teleport`, `/terminal-setup`, `/stickers`, `/upgrade`, `/web-setup`, `/install`, `/branch`, `/fork`, `/keybindings`, `/tui`, `/brief`, `/focus`, `/stop`, `/recap`, `/btw`, `/goal`, `/copy`, `/setup-bedrock`, `/setup-vertex` (reasons in the probe's `SKIPPED` table).

**Recommendation.** After `/mcp`, nothing Pat opens often lacks a working window. The data does not justify another native surface now: `/login`, `/model` and `/rate-limit-options` already get recognized cards, and the next most typed dialog, `/plugin` (17, none in the last month), is now a working list card. If one more is wanted, `/config` is the candidate (a real settings screen behind tabs and toggles, today only raw keys), but Pat has not typed it once.

## Not proven, and what needs Pat

- **A real claude.ai connector sign-in end to end (Zoom).** For claude.ai connectors the CLI's login only prints a claude.ai address; the sign-in happens on claude.ai and needs Pat's consent click there. The panel opens that address, waits, polls the CLI until claude.ai reports the connector connected, then reconnects the session (proven with the stand-in CLI). To finish the proof: in a Harbor built from this branch, open a session on the personal plan, type `/mcp`, press Sign in on "claude.ai Zoom for Claude", approve on the claude.ai page that opens, and the row should turn Connected with "Signed in, and this session reconnected with the new tools". I did not sign anything out or in on Pat's plans.
- **Tool counts** are not in the panel: `claude mcp list` and `get` do not report them (only the CLI's own `/mcp` screen does). The panel shows status only.
- **The phone app** receives the same list from `getMenu`, but I did not drive the phone.
- **Live Harbor needs a restart of main and the daemon** to get this (the main-process code, and the `>_` mode report, which lives in each session's keeper): sessions started before the daemon update keep the old `>_` behavior until they restart.
- **Older `/mcp` layouts** (CLI 2.1.2xx, no leading status glyph) read every line as a row, headers included; a click on a header there fails its walk with a message instead of misfiring. Current 2.1.303 is read correctly.
- The list card's rows are clicked through the verified walk; the key row (arrows, Space, Enter, Backspace, Cancel) sends raw keys by design, as the old panel did.

## Incidents during the work (all ended without changes)

- The first review runs typed `/session`, and Enter took the command menu's top suggestion, Pat's `/log-session-backfill` skill (which posts Teams log entries). Twice: the first run read the billing state and the last-run marker and had started its candidate-listing script when the throwaway session was killed about 10 seconds in; the second was killed while its session hooks were still starting. No process from it was left running, nothing under `C:\tools\log-backfill` changed after 1:53 AM (the runs were after 4 AM), and no posting step was reached. The probe now presses Enter only when the highlighted menu entry is exactly the command, and `/session`, `/doctor` and `/tasks` are off its list.
- `/doctor` and `/tasks` are Pat's own skills in his plans: each started a short model turn that only read things (a CLAUDE.md size survey; the task lists) before the session was ended. `/terminal` autocompleted to `/terminal-setup`, which refused to run ("cannot be run from xterm-256color").
- `/privacy-settings` was opened and closed with Esc; its "Help improve our AI models" setting read `true` before and after (the CLI prints the value it kept).
- The sign-in proof added and removed a throwaway local-scope server (`harbor-signin-proof-<pid>`) in this worker's plan home; the folder-trust entry for its temporary folder remains in that home's `.claude.json` (harmless). The probe sessions added about 120 slash-command lines to that plan's `history.jsonl`.

## Open items

- The throwaway pre-fix worktree `C:\dev\.orch\harbor\cli-settings-ui-prefix` (detached at 800e4bb, used for every two-sided comparison) has been removed.
- Optional: a footerless list variant for `/skills` (its key hint sits above the rows).
- Optional: let the raw panel's text field type key by key too; Ink text fields drop a multi-character chunk (measured on `/plugin`), and the raw panel still sends one.
- The run's brief (`briefs\build.md`) is the orchestrator's and is left uncommitted for it.
