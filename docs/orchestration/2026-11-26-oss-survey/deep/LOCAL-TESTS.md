# Local tests on the Legion, 2026-11-26: do the CLIs' state reports (OSC 7501) reach Harbor?

The scripts are beside REPORT.md: `osc7501-claude-startup.cjs`, `osc7501-codex-startup.cjs`, `osc7501-agy-startup.cjs`,
`osc7501-conpty-host.cjs`. Each run used a scratch folder (`C:\dev\.orch\harbor\osc-claude\ws`). Every run of the bundled
ConPTY went through the console sentinel, and each one ended `RESULT consoles=0 visible=0`.

## Results

| CLI and version | ConPTY | What happened |
|---|---|---|
| Claude Code 2.1.321 | Windows built-in (Harbor today: node-pty 1.1.0) | Claude asks `ESC ] 7501 ; ? ST` at startup. The host answered within about 1 s, but Claude's own debug log reads `programStatus=no (probe: no reply to OSC 7501 ; ?)`, the same as when the host stays silent. The answer never reaches Claude, so it never sends a state report. |
| Claude Code 2.1.321 | Bundled in node-pty 1.2.0-beta.18 (`useConptyDll: true`, ConPTY 1.25.260303002) | This ConPTY passes the terminal's questions through to the host: `ESC[c` (DA1), `ESC[>0q` (XTVERSION), `ESC[?u` (kitty keyboard) and `ESC]7501;?`. With no host answers, Claude's startup check never finished (no capabilities line in 16 s, against 50 ms on the built-in ConPTY). When the host answered DA1 and 7501, Claude logged `programStatus=yes (probe: OSC 7501 reply)` and then reported `state=idle:app=claude-code` at its prompt, `state=working:app=claude-code` 0.9 s after a prompt was sent, and `state=done:app=claude-code` 1.5 s later. |
| Codex 0.167.0 | Windows built-in | Codex sent `ESC ] 7501 ; state=idle:app=codex` at its prompt with no question and no answer. It works under Harbor's ConPTY today. |
| agy 1.5.14 | Windows built-in | By default agy only asks the question. With `AGY_CLI_OSC7501=on` it reported `blocked:kind=auth`, then `idle`, without asking (earlier test, REPORT section 1). |

Claude's code (2.1.321 binary) decides support only from the answer (`u.answer("programStatus", ...)` after the
`ESC]7501;?` probe); no environment variable turns the reports on. On exit Claude writes `state=clear` as part of
restoring the terminal.

## What this means for Harbor

- **Codex and agy reports can be read today.** Codex needs nothing; agy needs `AGY_CLI_OSC7501=on` in its environment.
- **Claude's reports need the newer ConPTY.** That means node-pty 1.2.0 (still beta) with `useConptyDll: true`, and a keeper
  that answers the terminal's questions, because this ConPTY no longer answers them itself.
- **The keeper is already most of the way there.** `app/src/daemon/keeper.js` feeds every pty byte into an
  `@xterm/headless` screen (`app/src/daemon/screen.js`). A headless xterm answers DA1 and cursor-position questions through
  its own `onData`, so wiring that `onData` back into the pty would answer them. One OSC handler on the same screen
  (`parser.registerOscHandler(7501, ...)`) would answer the 7501 question and record every state report.
- **Untested, and the risks to check first:** whether Harbor's screen reading, resize and shutdown behave the same on
  ConPTY 1.25; whether the bundled `OpenConsole.exe` stays windowless under the keeper; node-pty 1.2.0 is a beta.
- Claude 2.1.326 (not yet installed here) improves the reports: background work counts as working, and the trust screen
  reads as waiting on you.

## Not tested

- A `blocked` report from Claude (a permission prompt), and from Codex.
- The built-in ConPTY on a newer Windows build than 10.0.26200.
- Harbor's real keeper on the bundled ConPTY (these tests used a stand-alone host script).
