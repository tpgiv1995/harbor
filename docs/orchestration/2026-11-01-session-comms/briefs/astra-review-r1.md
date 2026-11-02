# Astra adversarial review, round 1: cross-session send fix (2026-11-01)

You are reviewing work Claude implemented in Harbor (C:\dev\harbor, a Windows Electron app that hosts Claude Code and Codex CLI sessions in ptys through its own session daemon). Pat asked for an adversarial review: find what is wrong, missing or unproven. Do NOT edit any file. Return the FULL review as your final message (it is saved from your final message; do not write it to a file).

## The incident

Sessions message each other by typing into each other's terminal panes. Fable (a Claude session) types into Astra's Codex 0.166.0 pane with `C:\tools\harbor-peek\type.cjs` (staged copy: `docs\orchestration\2026-11-01-session-comms\private\inputs\type.cjs`; the version before this change: `...\private\inputs\type.cjs.before`). On 2026-11-02 03:06Z the typer pasted a 1,183-character message, waited 15 s for Codex's box to show it, refused ("the box never showed the text, so no Enter was pressed"), and its retry at 03:08Z refused again with "the box already holds text that is not this message (1 pasted block(s): 1182 characters)". Fable pressed Enter by hand at 03:08:43 and Astra received the full message. Pat's own sends into Astra from Harbor's command bar failed with the same reader on 2026-11-01 ("Codex's box never showed your text").

Claude's diagnosis: Codex on Windows reads a paste as keystrokes; when the first one arrives a moment before the rest, it is inserted as typed and only the rest becomes the paste, so the box shows `F[Pasted Content 1182 chars]`. The reader (`codexBoxState` in `app\src\main\session-send.js`) accepted only a box that is exactly one placeholder. Reproduced on the real Codex 0.166.0 in an isolated daemon by writing the first character 40 ms (and 150 ms) ahead; the capture is `app\test\fixtures\codex-box\codex-0.166.0-split-paste-154.txt`. Note: the diagnosis that the 03:06Z failure was this split is inferred from the 1,183 vs 1,182 counts and the draft reading; no screen capture from 03:06Z exists. Challenge it if you see a better explanation.

## What changed (uncommitted in the working tree; other sessions have unrelated changes in other files, ignore those)

Read the diffs with `git -C C:\dev\harbor diff -- <path>` (and `git status` for the new files):

1. `app/src/main/session-send.js`: new `codexBoxCarries(box, text)` and its use in `codexBoxState` (walks typed runs and `[PastedContent N chars]` placeholders in order against the message).
2. `app/test/main/session-send.test.js`: new spec "codexBoxState: a message drawn as a typed first character plus a pasted block is in the box"; new fixture `app/test/fixtures/codex-box/codex-0.166.0-split-paste-154.txt`.
3. `app/src/daemon/client.js`: `SessionClient` throws on an explicitly empty `socketPath`; new `app/test/main/session-client-guard.test.js`. `bin/harbor-bin.cjs` has ONE hunk of ours near line 346 (`spawnSessiond` stops passing `socketPath: undefined`); the other hunks in that file belong to another session, ignore them.
4. `docs/claude/conversation.md`: the new bullet starting "ONE CODEX MESSAGE CAN BE DRAWN AS TYPED CHARACTERS".
5. The typer (staged copy above): a Claude-pane gate (`deliverClaude`, built on Harbor's exported `composerSendState`) replacing a blind "type, wait 1.5 s, Enter"; refusals print the pane's last rows; new self-test cases.

## What to attack

- **False 'exact'** is the dangerous direction: it makes Harbor or the typer press Enter on a box that holds someone else's text, or only part of ours, or ours plus a stranger's. Construct box contents that the new matcher accepts but should not (a foreign paste of similar length, our text plus extra typed characters, a placeholder that swallowed text from a different message, image chips, a typed run in the middle, the 2-per-placeholder slack compounding, whitespace-only differences, astral characters, a message that itself contains the literal text "[Pasted Content 12 chars]"). Also the `tail` acceptance at the end of `codexBoxCarries`.
- **False 'other'**: real split shapes it still rejects (more than one typed character before the paste, a split at the end, two placeholders, CRLF or tab in the message, a message with leading or trailing whitespace, the typer's own `replace(/\r?\n/g, ' ').trim()` normalisation vs what Harbor's command bar sends).
- How `codexBoxState`'s result is consumed: in `session-send.js` (`waitForCodexBox`, the 'already-in-prompt' path, the Enter-taken confirmation that treats 'other' as "taken") and in the typer (`own` check, the after-Enter loop). Could the new 'exact' change any of those flows badly (for example the after-Enter loop never seeing 'other' because the transcript above the box now matches)?
- The typer's Claude gate: `composerSendState` semantics ('holds', 'taken', 'pending', 'nobox'); is 'taken' (text drawn above the box) or 'pending' after Enter a sound "sent"? Claude's welcome hint (`❯ Try "how does <filepath> work?"`), permission and trust dialogs, the sessions/fleet view (`isFleetView` in session-send.js, which the typer does not check), a box that already holds someone else's draft (the typer types after it), long messages Claude collapses to `[Pasted text #N]`.
- The `SessionClient` guard: any caller in `app/src`, `app/scripts`, `app/test`, `bin` that can now throw (a variable that is legitimately undefined), including the app-side wrappers in `app/src/main/session-daemon/`.
- The doctrine bullet: anything it states that the code or the evidence does not support.

## How to check

- Run only the tests that touch the change: `node --test-reporter=tap test/main/session-send.test.js` and `node --test-reporter=tap test/main/session-client-guard.test.js` from `C:\dev\harbor\app`, and `node docs\orchestration\2026-11-01-session-comms\private\inputs\type.cjs --self-test` from `C:\dev\harbor` (it requires Harbor's `session-send.js` by absolute path). Do NOT run the full suite.
- You may write throwaway scripts under your own temp folder that call `codexBoxState` / `composerSendState` with constructed screens.
- Do NOT start, type into, or signal any session or daemon, and do not launch codex or claude. Do not use the browser MCP or god Chrome.

## Done when

Your final message lists each finding as: severity (blocker / should-fix / nit), the exact file and function, a concrete input or sequence that shows it (a constructed box string is ideal), and the fix you recommend. Say explicitly which areas you checked and found sound. If you find nothing material, say so plainly.
