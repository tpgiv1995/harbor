# Astra adversarial review, round 2: your round-1 findings, answered (2026-11-01)

Same job as round 1 (your review is `docs\orchestration\2026-11-01-session-comms\reviews\astra-review-r1.md`). Claude changed the code to answer every finding and found one more failure live. Do NOT edit any file, and do NOT start, contact, type into or signal any live session or daemon. Return the FULL review as your final message (it is saved from your final message; do not write it to a file).

## What changed since round 1

Read the working-tree diffs (`git -C C:\dev\harbor diff -- <path>`); other sessions have unrelated hunks in other files, ignore those.

1. `app/src/main/session-send.js`
   - `codexBoxCarries` rewritten (finding 2, 4, 8): no global slack; a placeholder with N <= 1000 is literal text; each larger placeholder consumes exactly N, only the last may consume N-1; whitespace before a placeholder may be typed or pasted (both readings tried); the walk must end at the message's end; trailing whitespace only after a typed run.
   - `codexBoxMatch(screen, sent)` returns `{ state, opaque }` (finding 1, 3): image chips are stripped only when `imageMarker` is set; `exact` resting on a placeholder is `opaque`. `codexBoxState` = `.state`.
   - Ownership (finding 1): `createSessionSend` keeps `codexTyped` (pane -> what Harbor typed, when). `ownsCodexBox` accepts an opaque exact box only with a record under 10 minutes; used for the busy check and `alreadyInPrompt`. Records are set after typing a non-slash Codex payload and cleared when the Enter is taken.
   - NEW, from a live failure (Pat's phone sends into Astra were refused three times): Codex 0.166.0 on Windows drops non-ASCII punctuation and symbols (measured: U+2010-2044 incl. ’ “ ” … – —, NBSP, ° « × ·, U+2060, € ™, arrows, minus, ✓, box drawing lost; accented letters, U+02BC, U+3000, emoji kept). `codexSafeText(text)` -> `{ text, dropped }` maps ASCII twins, keeps letters/marks/numbers/emoji, turns other spaces into a space, removes zero-width characters, drops the rest. `deliver` applies it to every non-slash Codex send before anything else and logs `codex-text-normalized`.
   - NEW: `getSuggestion` drops Claude's own dim box hints (`CLAUDE_BOX_HINT_RE`: `Try "..."` and `Press up to edit queued messages`), which the command bar offered on Tab. Measured live: while a message waits in Claude 2.1.316's queue, its box draws that sentence dim, and the keeper's dim reader reports it as a suggestion.
2. `app/test/main/session-send.test.js`: your counterexamples as specs ("no slack lets extra, missing or foreign content pass"), the retry tests rewritten around ownership, an unowned shaped paste refused with CODEX_BOX_BUSY, `codexSafeText` and a smart-punctuation deliver spec, the hint spec.
3. The typer, rebuilt (findings 1, 5, 6, 7): staged at `docs\orchestration\2026-11-01-session-comms\private\inputs\type.cjs`; what you reviewed in round 1 is `...\type.cjs.r1` beside it. Codex gate: `codexSafeText` first, ownership record in `C:\tools\harbor-peek\.typed\<pane>.json`, no spare Enter when the box vanishes after Enter (exit 6). Claude gate: refuses the sessions view, no box, shell mode and any foreign draft; dim prediction / welcome hint / queue hint count as empty; Enter-only retry only on exact equality, or a long message's tail with the record; after Enter, delivery comes from the TRANSCRIPT (`transcriptConfirm`: an `enqueue` queue-operation or a user line containing the text, stamped after the attempt began), otherwise exit 6. Its self-test has 31 cases (`node <staged type.cjs> --self-test`; set `HARBOR_SEND_MODULE` if you need it to load another checkout; the self-test reads two fixtures from `C:\dev\harbor\app\test\fixtures\composer-enter\`).
4. `docs/claude/conversation.md`: the bullet starting "ONE CODEX MESSAGE CAN BE DRAWN AS TYPED CHARACTERS" was rewritten (finding 9).

Live proof Claude ran in an isolated daemon (not for you to repeat): a smart-punctuation message reached a real Codex once as ASCII; a hand-made `R[Pasted Content 1182 chars]` box was refused with nothing typed; the typer's own `--no-enter` try was then sent with Enter only (one copy in Codex's history); on a real Claude pane an idle send was confirmed by its user line, two mid-turn sends by their `enqueue` records, and a foreign draft was refused.

## What to attack

- For each round-1 finding: is it actually closed, in both Harbor's `deliver` and the typer? Rebuild your constructed boxes against the new code.
- New false `exact` or false ownership: the record keyed by squashed text (whitespace-only differences), a record left behind by a send that failed or was answered "unconfirmed", Harbor's record and the typer's record not knowing about each other, a record surviving a pane that was restarted with the same id.
- `codexSafeText`: anything it maps or drops that changes meaning badly (code, paths, quotes inside commands, `<` `>` `|`, CJK punctuation, combining marks, a message that becomes empty or a slash command after normalization), and whether matching against the normalized text can now accept a box that holds the UNnormalized text or vice versa.
- `transcriptConfirm` in the typer: false confirmation (an older identical message, a message quoted inside Claude's reply or a tool result, another session in the same folder, clock skew between `Date.now()` and transcript timestamps, the 1 s back-off), and false "unconfirmed" (a transcript in another config home, `agent_session` stale after /clear or resume, a very long message whose stored text differs from what was typed).
- The empty-box rule: a real draft that reads like a hint, a suggestion read from a different frame than the screen it is paired with.
- The doctrine bullet: anything it states that the code or evidence does not support.

## How to check

You may run `npm test -- session-send` and `npm test -- session-client-guard` from `C:\dev\harbor\app`, and the staged typer's `--self-test`. Do NOT run the full suite. Do not use the browser MCP or god Chrome. Order findings by severity: Blocker, Should-fix, Nit, with the exact input that fails and the line it fails at.
