# Stages 3 and 4: launcher adapters and Harbor's slot guard (Claude, 2026-11-01)

Doctrine: `docs/claude/lanes.md` (Launcher adapters; Harbor and pool slots). The brief and Astra's full review are kept in this run's `private/` because they name local profile paths.

## What was built

- Core: `reopen` (a sealed lane back to running in its slot for a revision, renewed token and generation, environment scan, optional new runtimes); `lookup.cjs`, the read-only registry and session-key module launch paths use; pool roots must be folders named `pool`; default state under the real profile.
- Harbor: `resume-guard.cjs` refuses every session start or resume inside a slot (in `claude-sessions --resume-id` and `bin/ai`); `findQueueForWorkspace` matches a lane batch to its slot only while the slot holds that lane.
- Outside the repo: a shared launcher adapter and `--lane` support in the four worker launchers (opt-in; the default path is unchanged apart from refusing an unleased start inside a slot), lane fields in the delegate queue, an opt-in lane flow in the orchestration recipe (integration through slot 00), a command-guard rule against hand-made slot changes, and the pool root on the disk janitor's keep list.

## Evidence

- Synthetic: Harbor lane suite 70/70, delegate suite 27/27, resume and launch suites green; adapter and launcher suites 30/30 against the installed launchers (a compiled fake worker binary stands in for claude.exe and codex.exe); the launchers' own suites unchanged; command-guard suite green.
- Real providers, throwaway pool: a Sonnet worker committed in a leased slot and the lane sealed for review; a revision reopened the lane and `claude --resume` continued the same session id in the same slot; after release a Cursor worker reused the slot from a clean base. astra-run's lane path ran only against the fake codex.
- `claude-sessions --resume-id` refused a real session whose slot had moved on to another lane, and passed the guard with no pool.

## Astra's review (REQUEST CHANGES, 12 findings) and the round that answered it

1. Prompt words such as `constructor` read as lane flags: own-key lookup, option-aware parsing that stops at `--`.
2. Default path depended on the pool CLI and the pool implementation: session lookups read the snapshot directly; `lookup.cjs` loads no other lane module (a test pins the guard's load set).
3. An unreadable snapshot disabled the guards: absent pool vs unreadable snapshot; unreadable fails closed for slot-shaped folders.
4. Cursor sessions unbound; binding failures tolerated: pooled Cursor resume refused, cursor-run's guard covers interactive runs, a failed binding stops claude-worker's launch or quarantines the lane.
5. Cursor's shadow home could redirect pool state: state follows the real profile in core and adapter; Cursor children get the state folder pinned.
6. Sealing not exactly once on failure paths: idempotent finish, receipt failures separated, crash handler and child-error paths seal. Catchable signals are deliberately not trapped: sealing while a worker may still write is worse than OWNER_GONE quarantine.
7. Reopen skipped the environment scan and ignored new runtimes: both fixed in the core.
8. The recipe integrated in the coordinator's checkout: pooled integration now runs in slot 00 through an integrator worker.
9. Receipt and output paths: receipt inside the slot refused, relative `-o` resolved where codex resolves it, junctions followed on the existing part of a path.
10. The queue fix dropped the current worker's summary: current-lane matching.
11. The documented quarantine recovery could not succeed: recipe now says checkpoint, then `recover`.
12. The guard rule matched quoted prose and missed `git -C <slot> worktree remove`: quote-aware command position and a `-C` rule, with fixtures for both.
