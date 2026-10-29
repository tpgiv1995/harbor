# CLI update cycle, 2026-10-28: Claude Code 2.1.310 to 2.1.312, Codex 0.164.0 to 0.165.0 (Cursor unchanged)

Split as the doctrine fixes it: the Claude half by Claude with one fresh-context Claude reviewer, the Codex half by Astra on a GPT seat (gpt-6-astra, high effort) and re-verified by Claude. Cursor 2026.10.22-27dcf5f was already current. The numbered release notes are beside this file (`notes-claude.md` C1 to C131, `notes-codex.md` X1 to X12 plus P1 to P68); the notes tables, briefs, reviews and probe evidence stay in the gitignored `private/` folder.

## Verdict

Claude 2.1.312 broke two Harbor contracts; Codex 0.165.0 broke none, but the review found one live Codex hazard. Harbor changes (commits d1c486f, c2b984d, 6250f70, 159f89e):

- **/model cache warning** (`app/src/main/session-send.js`, `app/src/main/menu-parse.js`). The dialog's title is "Switch model?" (the match guessed "Change model?") and 2.1.312's sentence ends "gets re-read." without "on your next message", so a model change from Harbor in a cached conversation stopped on the open dialog. Both readers accept the real title and both endings. Fixtures are real 120-column captures, inline and fullscreen, with usage lines scrubbed.
- **Phone images** (`session-send.js`). From 2.1.311 a pasted line becomes an image only when every segment on it is a path, so the phone's `Image: <path>` line stayed text and Claude got a path to Read instead of an attachment. A Claude pane now gets each path quoted on a line of its own; codex and cursor keep the labelled line.
- **Codex update screen** (`bin/harbor-bin.cjs`). Once a seat's `version.json` knows a newer release, Codex opens on "Update available", which drops a pasted message and whose highlighted row is "Update now (runs `npm install -g @openai/codex`)". Every Codex pane from 0.164.0 now passes `-c check_for_update_on_startup=false`. Harbor's chip reads the npm registry itself.
- **Update chip flags** (`app/src/main/providers/cli-updates.js`). Claude: `ask-dialog` gains the cache warning, `composer` gains pasted images. Codex (Astra): `models` gains reasoning-effort and model-not-found notes, `visibility` gains the session picker, and a new `memory` flag covers memory v2. Both pinned by verbatim-note specs.

## What was proven

- Claude 2.1.312 (scratch install): same 19 model ids and 102 slash commands; `--help` changed only the purge wording; the new type strings are not transcript records.
- Live on the real 2.1.312, two-sided (`app/scripts/drive-prompt-gate-win.js`, the fixed code against a copy of the old one): with the fix the phone image arrives attached and Harbor answers the /model dialog ("Set model to" shown); the old code delivers a path to Read and leaves the dialog open. Every other step (a 20-second-late first message, a 1,600-character line, a pasted body, a prompt that never takes the text) passed on both.
- Also on 2.1.312: AskUserQuestion hook lane (bypass and default permission modes), the Bash permission card, resume then send, the answer sheet, the slash-command dialogs.
- Codex 0.165.0 (Astra, re-checked): GPT-6.1 Terra (`gpt-6.1-terra`, low through ultra, default low) is listed in the bundled catalog and all three seats' catalogs and shows by name in the desktop and phone model menus; one paid Terra turn ran; no Guardian review under full access with never-approval; memory v2 stays off; the pane proof passes.
- The update-screen pin, two-sided on the real 0.165.0 in a throwaway home whose `version.json` named 0.999.0: the composer with the pin, the update screen with "Update now" highlighted without it. Two launch-argv specs fail without the pin.
- The Bash tool still halves backslash runs on 2.1.312 (2 reached the shell as 1, 4 as 2); the guard's calibration moved to 2.1.312 and the hook suite is green.
- Unit filters (one per run, isolated daemon): every matching filter passed, 0 failed, 6 skipped (the known unported real-pty family).

## Lessons

- A scratch Claude CLI run against the real `~/.claude` rewrites `~/.claude/chrome/chrome-native-host.bat` to point at the scratch exe, every run. Restore it after each scratch probe. `/effort` in such a probe writes `modelSettings` into the real `settings.json`; capture the switch dialog with `/model` only.
- A reworded dialog is found only by a capture from the new build at a realistic width. The guessed "Change model?" title was never on any screen.
- A bare POSIX path at the start of a message is a slash command to Claude's prompt; quote it.

## Follow-ups (Codex UX, from the same night's diagnosis)

- Codex sends are not verified: Harbor presses Enter 160 ms after a paste and never checks, and long pastes on Windows can lose that Enter to Codex's paste-burst rule.
- The window shows nothing of a message that was typed but not submitted, and one row per Codex exec cell hides about 39 percent of the commands run.
- Codex image sends use Claude's clipboard route; a quoted path pasted on its own attaches natively.
- Pre-existing: 1,951 compressed `.jsonl.zst` rollouts in the personal Codex home are unreadable by Harbor; the phone offers `/effort` to codex panes, which have no such command.
