# Astra: independent audit of two Harbor regressions (2026-11-04, Windows)

You are auditing Harbor, a Windows Electron app that runs many Claude Code sessions as chat windows
(read `CLAUDE.md`, `docs/claude/conversation.md`, `docs/claude/views.md` in this worktree first; they bind you).
The user (Pat) asked for YOUR independent audit because a Claude session's fixes tonight did not stop the
problems. Do not trust the Claude session's conclusions below: verify or refute each one from code and evidence.

Workspace: this git worktree, `C:\dev\.orch\harbor\astra-audit-1104` (branch `astra-audit-1104`, cut from
the live checkout's HEAD 0bc9af2). `app/node_modules` is a junction to the live install: never run npm
install. Never touch `C:\dev\harbor` (the live checkout other sessions work in), never restart or launch
Pat's Harbor, never run any GUI/Electron drive or anything that opens a window (that would steal Pat's
foreground, which is literally bug 1). Do not use the browser MCP or god Chrome. Run only targeted unit
tests (`cd app; npm test -- <filter>`, one filter per run), never the full suite. Committed fixtures must be
SYNTHETIC: this repo is published publicly; real logs stay in `private/` (gitignored).

## Bug 1: "taken out of the text box while typing"
Pat types in a session's message box (`app/src/renderer/stage/ComposeEditor.jsx`, a contenteditable) and
keys suddenly stop landing; he must click back in. Many times a day, worst tonight.

Claude session's claims to verify:
- Every loss logged since its diagnostics shipped is `cause: window-blur`, i.e. another program took the OS
  foreground, not Harbor code (`private/inputs/composer-focus-lost-rows.jsonl`).
- An event-driven foreground logger (`private/inputs/FocusLog.cs`, log `private/inputs/focus-log.txt`,
  started 22:50 local) names the thieves: WSLg's `msrdc.exe` "Remote Desktop" window (a new process each
  time a session runs `wsl` and the VM boots; 23:09:53, 23:13:15, 23:13:46, each within ~1 s of Pat's last
  keystroke), god Chrome agent windows (Pat's Chrome driven by other sessions over CDP; parked at
  -20000,-20000 by `C:\tools\chrome-god\quiet-cdp.cjs` + `quiet-ext\hub.js`), Teams' hidden window, and
  Harbor's own windows (a harness Harbor born at x=-4200 activated; a --no-focus-steal relaunch activated
  because maximize() is ShowWindow(SW_MAXIMIZE) on Windows).
- One event is unexplained: 22:54:20 a god Chrome window "Submit to r/Americanmahjongg" appeared
  MAXIMIZED on screen and took the foreground with no input; the hub log has no Show for it and the
  driving session made no successful browser call then.
Changes made (review each for correctness and regressions):
- b47deb6, 646824c, 0accb3a: ComposeEditor restores focus after a one-render contentEditable lock, after
  a steal/drop with no user input (next frame), and logs every loss with a stack and an "unmounted" case.
- 9bcc636: `app/src/main/index.js` window born hidden (`show:false`); E2E shows inactive; on win32 a
  flagged maximized relaunch fills the work area via setBounds + showInactive and maximizes on first
  focus; the app-menu Restart drops an inherited `--no-focus-steal`.
- Outside the repo (read only, copies in `private/inputs`): `%USERPROFILE%\.wslconfig` now sets
  `[wsl2] guiApplications=false` (WSLg off; applies at the VM's next start).
Your questions: Are these the real causes, and the only ones? What else in Harbor (renderer or main) can
move focus or deactivate the window while a user types (look hard: focus() calls, autoFocus,
contentEditable/disabled flips, remounts, portals, iframes/webviews, notifications, BrowserWindow
creation, the update ribbon, xterm panes, the ask/permission cards, the voice path)? Does
`guiApplications=false` actually stop msrdc.exe from starting on VM boot, and is anything else in
WSL/Windows likely to steal focus the same way? Is the 9bcc636 win32 maximize change safe (multi-monitor,
`isMaximized()` consumers, the title bar maximize button, saved window state on quit)? Explain 22:54:20 if
the evidence allows.

## Bug 2: "missing messages, mainly mine, when I scroll up"
Claude session's claims: a window opens on its last 1 MB (`MAX_INITIAL_BYTES`, `app/src/main/providers/transcript.js`)
and no desktop code ever pages back (`pageTranscript` has no caller); busy transcripts make 1 MB about 20
minutes; every restart/reload (five tonight, `private/inputs/harbor-boots.jsonl`) cut each window to that.
Fix 0bc9af2: `readPrefixBlocks` seeds the most recent 40 user prompts and queued mid-turn messages from
the skipped prefix (one parser in file order) plus prefix images, replacing the image-only scan.
Your questions: Is that the real cause, and the only one? Check every other way a user bubble can vanish:
the 240-block trim (`push`), queue-operation enqueue/remove/dequeue handling and the queued_command
attachment (its `prompt` is a STRING in CLI 2.1.316 records, the code expects an array), userTextFor
filtering, compaction, the renderer's block reducer (`app/src/shared/transcript-blocks.cjs`) and
`Conversation.jsx` rendering, phone/windowed opens. `private/inputs/send-log.jsonl` lists every send
tonight (`phase: resolve` rows carry sessionId and chars); compare against the real transcripts under
`%USERPROFILE%\.claude\projects\` (read only, search narrowly by session id; never sweep the tree).
A known pre-existing oddity: an idle-path message shows twice (an `enqueue` bubble marked queued, then the
normal user record 2 s later). Is that a bug to fix? Review 0bc9af2 for duplicates with the seeded opening
block, ordering, the image cap, and cost on a 150 MB transcript.

## Deliverable
Return the FULL audit as your final message (it is saved by -o; do not write it to that path yourself):
per bug, root causes ranked by evidence (CONFIRMED / LIKELY / RULED OUT, each with the file:line or log line
that shows it), every defect you find in the commits above, and anything the Claude session missed. Where a
fix is clear, small and testable, implement it on this worktree's branch with a synthetic unit test that
fails before and passes after, commit it (message ends with your attribution), and list the commits. Do not
fix things you are unsure of; say so instead.

done_when: both bugs have a ranked, evidenced cause list; every commit above has a verdict; any fixes you
made are committed with passing targeted tests, and the final message is the full report.
