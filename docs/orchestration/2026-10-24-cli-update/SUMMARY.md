# CLI update cycle, 2026-10-24: Claude Code 2.1.303 to 2.1.310, Codex 0.163.0 to 0.164.0, Cursor 2026.10.16-e3cb207 to 2026.10.22-27dcf5f

Split as the doctrine fixes it: the Claude half and Cursor by Claude (Cursor through one helper), the Codex half by Astra on a GPT seat and re-verified by Claude, then one fresh-context adversarial reviewer over all three. The full reports, briefs and evidence name real machine paths and accounts, so they stay in this folder's untracked `private\` (`private\reviews\CLAUDE-REPORT.md`, `ASTRA-CODEX-REPORT.md`, `NOTES-TABLE-codex.md`, `CURSOR-REVIEW.md`). The numbered release notes are `notes-claude.md` (C1 to C265) and `notes-codex.md` (X1 to X14).

## Verdict

None of the three releases breaks a Harbor contract. Harbor changes:

- **Update chip flags** (`app/src/main/providers/cli-updates.js`). Claude: every "permission check" line, the rm "safety prompt", the Consumer Terms notice and numbered "confirmation" dialogs now carry `ask-dialog`; startup-warning lines carry `screen`; `cleanupPeriodDays` and "session file size" carry `transcript`. Codex (Astra): presets and keyboard menus, Kitty/Sixel previews, setup wizards, compressed histories, restored thread settings, `-c` override levels, queued prompts and compaction. Specs pin the real note lines verbatim (red on the old table, green after).
- **Cold-resume usage warning** (`app/test/main/session-send.test.js`). Claude Code's "Resume this conversation?" dialog (on for Pro and Max since 2.1.304, gated by server switches) can put default focus on "Start a new conversation". Two specs pin that Harbor never types into it: a send refuses when it is up, and when it appears after the Enter no spare key follows.
- **Slash-dialog probe** (`app/scripts/probe-slash-dialogs-win.js`). 2.1.310 draws a command's alias in the `/` menu (`/plugin (plugins)`); the probe's highlighted-row reader accepts it. No product code reads that row.

## What was proven

- Claude 2.1.310 (scratch install): same 19 model ids and 102 slash commands; no screen literal Harbor reads left the binary; the AskUserQuestion hook lane (bypass and default), the Bash permission card, the prompt gate, resume then send, the answer sheet and eight slash dialogs pass on the real CLI; a headless worker with the orchestration fleet's exact flags succeeds; the Bash tool still halves backslash runs.
- Codex 0.164.0 (Astra, re-checked): unchanged catalogs and rollout record kinds; the pane proof draws the v0.164.0 banner under every pin with `--strict-config`; Harbor renders only message and tool-call records, so the new on-by-default `incremental_tools` records never show; every Harbor launch keeps its `-c` pins at one level. Behavior change: a Harbor resume carries no model pins, so 0.164.0 restores the thread's own model and effort.
- Cursor 2026.10.22: no flag, sign-in, trust or launch change; pane proof passes; package launchers byte-identical to the installed ones.
- Unit filters: 878 passed, 0 failed, 6 skipped (known unported real-pty family and a missing large fixture).

## Lessons

- Cursor's native updater (2026.10.16 forward) starts detached cmd.exe waiters whose children open visible consoles; a review helper's rehearsals flashed 58 of them. Never run it outside an invisible desktop; land a reviewed build by extracting the hashed package into a staged sibling folder, hashing it, and renaming it into place.
- A chip-flag spec must use verbatim note lines: a paraphrase proves nothing about the real wording.

## Follow-ups

- PowerShell permission prompts still skip the hook-lane card, and 2.1.309 makes more of them; extending `permissionPrompt` needs a live measurement of the CLI's own option 2 for PowerShell.
- Whether resume-then-send should auto-answer "Resume" on the cold-resume warning as it does for the older resume dialog (it removes a usage warning, so it is the owner's call).
