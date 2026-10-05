# Verification record, 2026-07-16

What was actually run and what it proved. Anything not listed here was not
verified. Written before the adversarial review rounds; their findings and
fixes are appended at the bottom.

## Indexer

| Check | Result |
|---|---|
| First full build, 1,367 transcripts (11 GB store) | 0.74 s, exit 0 |
| Incremental rerun | 0.045 s |
| Rows emitted | 1,022 unique sessions; 12 empty hidden with an honest stderr note |
| Duplicate session ids after dedupe | 0 (was ~364 pre-fix from the Windows migration copies) |
| Noise titles (`<command-...>`) after fix | 0; slash-command sessions titled `/name` |
| This very conversation visible | yes, top of list, correct title and `~` project |
| `--since 7d` / `--today` / `-p example-app` | 94 / 14 / 204 rows as of 19:01 with the final code (counts drift as live sessions accrue; spot-checked consistent: 2w=228 covers 2026-07-01=256 minus older) |
| `meta <id>` | correct cwd, project, path JSON |
| `preview` on the largest transcript (154 MB) | 28 ms, correct fields |
| Windows-era sessions | labeled `win: dev/example-app` etc., listed, resume refused with clear error |

## Herdr + resume path

| Check | Result |
|---|---|
| Install script | all 110 lines read before running; binary-only install |
| `herdr pane run` + `claude --resume <id>` | resumed conversation visible in pane via `herdr pane read` |
| Agent detection without the claude integration | `herdr agent list` shows the pane as agent `claude`, status tracked |
| Cross-home resume (session created under personal, resumed with `--home team`) | pane shows "Claude Team" with the conversation loaded |
| No workspace for project yet | workspace created with right cwd + label, tab renamed to session title |
| Workspace already exists | new tab created in it (w2:t2), not a duplicate workspace |
| Run from INSIDE a Herdr pane (HERDR_PANE_ID set) | exit 0, session routed to a new workspace, focus switched |
| Cold start (daemon down) | picker auto-started it; daemon PPID 1 in its own session, survives the parent shell dying |
| Missing project directory | hard refusal with explanatory message (tested via the win-era path logic, code-level check `[ -d cwd ]`) |

## Picker UI

| Check | Result |
|---|---|
| Interactive fzf run under a pseudo-terminal | rendered, selection worked, ctrl-y branch fired, "copied session id: ..." echoed |
| Clipboard content read-back | inconclusive: a live gnome-screenshot overwrote the clipboard seconds later; clip-set itself exited 0. Not re-run to avoid stomping the live clipboard. |
| `--tsv`, `--help`, unknown-flag rejection | correct output / usage / clean error |
| `hist` and `claude-sessions` symlinks on PATH | both work from a fresh shell |

## Not verified (honest list)

- The fzf enter/ctrl-p keys in a REAL interactive run by a human (the pty
  test exercised selection + ctrl-y; enter/ctrl-p reuse the exact routing
  function proven above via `--resume-id`).
- Phone/SSH attach to the Herdr session (nothing set up for it yet; Herdr
  supports it, untested here).
- Behavior across a reboot (daemon does not autostart; first `hist` resume
  or `herdr` brings it back; this is by design, not tested).

## Post-review appendix

Adversarial round 1 ran two independent reviewers (correctness lens,
requirements lens). Real findings and their resolutions:

**Fixed in code (all re-verified after the fix):**
- HIGH: date filtering in the picker was dead. `--nth 2,3,4` indexes the
  with-nth-TRANSFORMED line, so the timestamp column was excluded from
  search. Now `--nth 1,2,3`; verified '2026-07' matches a row and the hidden
  uuid still cannot match.
- Head-scan caps ran before parsing, so a transcript whose first line
  exceeds 2 MB indexed as cwd/title/start = None. Caps now checked before
  reading the NEXT line; synthetic 2.1 MB-first-line transcript passes.
- Silent exit if `herdr workspace list` failed mid-resume (set -e killed the
  script with stderr suppressed). Pipeline now tolerates failure and the
  create path reports errors via die.
- Slash-command fallback titles only read string-form message content;
  list-form now handled (synthetic test passes).
- `<task-notification>` / `[SYSTEM NOTIFICATION` records could become
  titles; added to the noise filter (synthetic test passes; the one live
  occurrence now titles from the real prompt).
- Tail scan returned nothing when the final line exceeded 64 KB; retries
  once with a 1 MB window (synthetic test passes).
- Missing flag values crashed with raw bash/python errors; all value-taking
  flags now die cleanly with a message.
- ctrl-r reload no longer replays --rebuild (would have re-parsed all 1,370
  transcripts per press).
- Hidden-empty note now counts only sessions matching the active filters.

**Verified as non-issues or accepted:**
- The 0.4 s pane-run pause: tested a ZERO-delay run; PTY input buffers
  through bashrc init and the command still executes. The pause stays as
  belt-and-braces.
- Concurrent same-project resumes can duplicate a workspace label (TOCTOU).
  Accepted; documented in README gotchas.
- Head-scan byte cap counts characters not bytes (up to 4x undercount);
  accepted, the cap is a work bound, worst case reads ~8 MB of one file.
- Stale filter counts in this doc's first table were re-measured against
  final code (the original numbers predated the slash-command title fix).
- README overpromises removed: phone/SSH qualified (no sshd on this box),
  groupings scoped precisely, line-count corrected, jq documented,
  uninstall completed (~/.local/state/herdr, memory entries).
- Reviewer claim that panes cannot move between workspaces was wrong
  (`herdr pane move --new-workspace/--tab` exists); README states the
  verified subset only.

Adversarial round 2 (fresh reviewer, focused on regressions from the round-1
fixes and untested interactions) confirmed all round-1 fixes correct and
found four more real items, all fixed and re-verified:
- `--resume-id` against a session cached in the index whose transcript file
  was since deleted (Claude Code prunes old transcripts) created the Herdr
  workspace and reported success while the resume died inside the pane.
  Both resume paths now check the transcript file exists first; tested with
  a synthetic cached-then-deleted transcript (clean refusal, no Herdr
  mutation, no residue).
- Flag values could swallow flags (`hist -p --rebuild` made "--rebuild" the
  project filter AND forced a full re-parse; a ctrl-r reload then broke).
  Both parsers now reject flag-like values with a clean error.
- `--home`/`--here` were silently ignored in picker mode; now rejected with
  a pointer to ctrl-p / ctrl-o.
- README advice to rename workspaces would have silently detached them from
  the picker's exact-label routing; documented the interaction instead.
- Nits: singular/plural in the hidden-sessions note, stray __pycache__,
  SETUP-LOG tail-scan description updated for the 1 MB retry.

ESC-abort investigation (round 2 follow-up): the picker appeared to hang on
ESC under the `script`-based test harness. Bisection showed bare fzf exits
cleanly there, and a proper pty harness that answers terminal
cursor-position queries (which `script` piped to /dev/null cannot) got a
clean exit 0 in 0.3 s after ESC. Harness artifact, not a defect; ESC abort
works as designed in a real terminal.

Final sweep after both rounds: both scripts re-read top to bottom, full
functional battery re-run (emit counts, filters, meta/preview, help, flag
errors, syntax checks), one final live resume end to end, docs re-read
against the final code, em-dash and relative-path scans clean.

Same-evening hardening (details in SETUP-LOG step 14), each verified:
- Pane env after clean daemon restart: the author baseline + HERDR_* only, no
  CLAUDECODE/session-id/effort leakage; DISPLAY=:0 present; xclip read ok
  (checked by writing env to a file from inside a pane).
- Claude integration v7: settings.json normalized diff = exactly one
  SessionStart hook; a resumed pane reports agent_session.value equal to
  the resumed uuid.
- Same-file resume semantics: resumed a session, sent a message; file
  count in the project dir unchanged, original transcript mtime advanced.
- Live-guard: refuses an 8-second-old transcript with explanation; passes
  a cold one.
- Parked harbor: 7 panes each show the instruction banner and the
  correct pre-typed `claude-go [--team] --resume <id>` (verified by
  extracting the uuid from each pane's screen); `herdr agent list` = 0
  agents until the author presses Enter.
