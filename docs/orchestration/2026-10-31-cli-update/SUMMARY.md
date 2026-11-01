# CLI update cycle, 2026-10-31: Claude Code 2.1.312 to 2.1.316, Codex 0.165.0 to 0.166.0 (Cursor unchanged)

Split as the doctrine fixes it: the Claude half by Claude with one fresh-context Claude reviewer, the Codex half by Astra (gpt-6-astra, high, personal seat) and re-verified by Claude. Cursor 2026.10.22-27dcf5f was already current. Pat's brief added two lenses to every note: disk footprint and plan usage. Notes: `notes-claude.md` (C1 to C174), `notes-codex.md` (X1 to X16); coverage table `reviews/NOTES-TABLE-claude.md` (37 touching + 137 no-contact = 174). Probes, briefs and evidence stay in the gitignored `private/` folder and the worktree scratch.

## Verdict

Neither CLI broke a Harbor contract in its notes; the review found five live problems around them, all fixed:

- **Codex safety-rewrite chooser and transcript selection** (Astra, `session-send.js`, `dormancy.js`): every Codex send, slash commands included, waits for a drawn composer; selection/Find overlays veto composer detection; dormancy recognises Codex's new selection footers.
- **A Codex box already holding text** (`session-send.js`): Harbor typed after another session's unsent paste and every retry added a copy. Now refused with `CODEX_BOX_BUSY`, and a busy Codex is read over its key-hint footer. `C:\tools\harbor-peek\type.cjs` (the other session's typer) now goes through the same reader.
- **PreToolUse hooks now fire on Monitor, and ignore `updatedInput` there**: guard.ps1's matcher is `Bash|PowerShell|Monitor`; rewrites are Bash-only; codex-stdin and pytest-width deny a Monitor command. guard's sealed-folder tail now ends quotes by the running shell's rules (a PowerShell `"C:\dir\"` swallowed the next command), under the rule timeout.
- **npm parks a replaced package under a derived name**, so a copy still in use blocked the next install (Codex 0.166.0 failed EBUSY twice): the chip sweeps before and after every npm install, deleting free copies and renaming in-use ones whole.
- **The update chip** flags plan-usage and disk-footprint lines on every provider (`USAGE_FLAG`, `FOOTPRINT_FLAG`, verbatim specs).

## Decisions

- **Idle compaction** (C4, C93): 2.1.316 drops the server gate, so it now runs on all six homes. An idle compaction is written as `trigger: "auto"`; the corrected 7-day replay found 59 fired, 37 returned, and a return after one cost 94K cache-write tokens against 256K without. Net saving, so Pat's 2026-10-15 choice to keep it stands; `"idleCompaction": false` is the off switch (not set).
- **Subagent effort** (C123): `CLAUDE_CODE_SUBAGENT_EFFORT=high` in master settings; claude-worker keeps low/medium lanes' helpers at the lane's effort.

## What was proven

- Scratch 2.1.316: 19 model ids and 102 commands unchanged, `--help` wording only, 0 of 990 Harbor screen literals removed; all six proof drives OK before install.
- Installed (2026-11-01 03:14Z Codex, 03:16Z Claude, both through the running Harbor's chip; history ok, disk and `--version` agree): all six Claude proof drives OK (`prompt-gate`, `perm-bash`, ask hook bypass and default, `resume-hooks`, `ask-sheet`); real guard on installed 2.1.316 doubles backslashes (2 and 4 arrive), passes a plain Monitor command and denies a Monitor `codex exec`; `codex-pane-proof.cjs` PASS on 0.166.0.
- Tests on the integrated code: session-send 191/191, cli-updates 80/80, test-hooks ALL GREEN (deny 298, ask 25, pass 398), claude-worker 27/27; every new spec fails on the code before its fix.
- astra-run `windowsHide` over a full job with shell commands: ConsoleSentinel `visible=0`.
- Codex `/model <id>` then `/model --reasoning=<level>`: source (identical in 0.165.0 and 0.166.0) applies a model argument directly with no picker, so the menu pair is safe under the new composer wait.

## Pending

- Harbor restart (Pat's choice) to load the main-process fixes; a sessiond restart for the dormancy markers.
- Phone server restart for the Codex-rows fix (shipped in the same integration, `docs/orchestration/2026-10-31-phone-live-rows/report.md`).
