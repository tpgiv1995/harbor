# CLI update cycle, 2026-11-09: Claude Code 2.1.316 to 2.1.321 (Fable 5.2), Codex 0.166.0 to 0.167.0, Cursor 2026.10.22 to 2026.11.05

Split as the doctrine fixes it: the Claude half and Cursor by Claude, the Codex half by Astra (gpt-6-astra, high, work seat) with Claude re-checking its source and binary claims. Pat asked for a fresh-context Opus review before anything was committed; two ran on the Claude half and one on Astra's later rounds.

## Verdict

Neither CLI broke a Harbor contract outright. The review found these problems around them, all fixed in this commit:

- **Fable 5.2** (`claude-fable-5-2`) is the new `fable` alias. Discovery found it unaided; the shipped seed now carries it so a failed scan or an older CLI still offers it.
- **A blank non-Claude pane was typed into.** A fresh Cursor pane draws nothing for 35 to 45 s (saved runs of the new build; over 60 s on the old build under load), and the first send gave up waiting after 45 s and typed anyway. The boot budget is now 90 s, it is the default of `waitForProviderReady` (the Resume buttons call it with no options), and a pane still blank at 90 s is refused with `PROVIDER_NEVER_DREW`.
- **Two quick launches became one.** `newSession`'s double-click guard answered any launch within 3 s of another with the first one's result. It is now keyed by the whole request.
- **Codex 0.167.0 keeps a provider-mismatch resume open on a read-only notice** instead of exiting (Astra). Sends refuse it, the answer panel takes it, dormancy keeps it awake, the writer notice accepts a remapped transcript key, and resume-only says it needs an answer.
- **The update chip** missed several lines that touch Harbor. New and widened flags, each pinned by verbatim lines and near-miss negatives; the notes table reconciles the 139 no-contact notes that still raise a flag.

## Codex thread-following (second commit)

Following a Codex pane to a new thread after `c`, `n`, `/new`, `/fork` or `/resume` (the argv keeps the old id) landed in its own commit after four more Astra rounds, each read by a fresh Opus reviewer. Astra's first design had the session keeper query Codex's SQLite store on PTY output; review found that retry unbounded and synchronous in the process that owns the terminal, and found it would regress new panes until Harbor restarts. The landed design pins Codex's terminal title to the thread id; the keeper only records the displayed prefix, and the main-process linker resolves it and moves the window. A new chat with no rollout yet takes its first Harbor message through a provisional pane key; subagent and `/side` views keep the parent and refuse parent-directed sends with the way back. Driven on scratch 0.167.0 through the real launcher, daemon, keeper, linker and send engine: `/new`, `n` and `c` each recorded the first Harbor message exactly once in the new thread. Child and `/side` refusals were driven at 80 and 50 columns with zero writes. The same commit stops tests writing the real send log and config-load log. Doctrine: `docs/claude/providers.md`; record: `reviews/ROUND5-codex.md` to `ROUND7-codex.md`.

## Decisions

- **Install before integration.** Pat wanted Fable 5.2, and the CLI install does not depend on this code, so Claude 2.1.321 was installed first, by exact version through the running Harbor's installer (2026-11-09 21:31Z). The chip's cached `latest` said 2.1.319; clicking it would have installed that.
- **The account email check stays on.** 2.1.321 refuses only a shell call holding the plan email and a User-Agent, with no prompt.
- **90 s is a judgment**, about twice the saved new-build draw times; no saved run measured the new build under heavy load.

## What was proven

- Scratch 2.1.321: 20 model ids (adds `claude-fable-5-2`), commands 100 to 102 (neither new one offered by Harbor), `--help` identical, 0 of 1,171 Harbor screen literals removed, status-line schema unchanged. Both builds draw the suggested prompt through the same dim placeholder renderer (C217).
- One paid call by id and one by alias both answered as `claude-fable-5-2`, first party.
- All six Claude proof drives passed on scratch 2.1.321 with the merged code (prompt gate, permission card, ask hook bypass and default, resume hooks, ask sheet). The Codex pane proof passed on 0.167.0. The Cursor pane proof passed three times on 2026.11.05 (35, 38, 45 s).
- The real desktop menu on the hidden host and the phone sheet in headless Chromium both offer Fable 5.2 and launch `fable`, before and after the Lighthouse glass reskin.
- Astra's Codex claims re-checked in the 0.167.0 source: `daemon_auto_start` still on, `--no-daemon` on launch and resume, `fullscreen_transcript` pinned off, `check_for_update_on_startup` honored, `cli_daybreak` present, `deferred_tool_world_state` flips on (stable), migrations unchanged, the notice footer text, and the rollout schema (two audio fields and one unpersisted event). Codex config hashes in all three homes unchanged.
- Tests on the commit: full gate 3,111 passed, 0 failed, 11 skipped (serial pass 7/7, 4/4); daemon suite 147 passed, 0 failed, 23 skipped (POSIX-only). Every new spec fails on the code before its fix.
- Installed Claude 2.1.321: `claude --version` 2.1.321, chip history ok, Harbor's live model cache lists `claude-fable-5-2`.

## Installed and proven

- Codex 0.167.0 installed through Harbor's installer (23:45Z). Its pane proof drew the version banner, kept the inline transcript, accepted the strict config and left no daemon state; the three Codex config files were unchanged.
- Cursor 2026.11.05-86047df landed by hand from the reviewed package (archive and extracted tree hashes matched the review). Its pane proof drew the banner in 27 s, and a cursor-worker job passed.
- Claude 2.1.321: the prompt gate, answer sheet and resume-send drives passed on the installed build, the live model list includes Fable 5.2, the Bash backslash behavior was re-measured (unchanged) and the hook tests are green.

## Pending

- A Harbor restart (Pat's choice) loads the main-process changes, including thread-following; the dormancy markers need the daemon restarted. New Codex panes get the new keeper and launcher at once.
- Pat: Fable 5.2 inherits the saved xhigh effort and spends its weekly allowance faster than Opus; 2.1.321 shows a free Fable limit reset to redeem by March 8, 2027.
