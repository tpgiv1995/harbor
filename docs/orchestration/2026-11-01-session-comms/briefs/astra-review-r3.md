# Astra adversarial review, round 3: your round-2 findings, answered (2026-11-01)

Same job (your reviews: `docs\orchestration\2026-11-01-session-comms\reviews\astra-review-r1.md` and `-r2.md`). Do NOT edit any file, and do NOT start, contact, type into or signal any live session or daemon. Return the FULL review as your final message (it is saved from your final message; do not write it to a file).

## What changed since round 2 (now committed: `git -C C:\dev\harbor show 2a69d92 d1080fe`; the working tree also holds other sessions' unrelated changes, ignore them)

`app/src/main/session-send.js`:
- r2-1: `codexSafeText` now composes (NFC), keeps letters, decimal digits, everything from U+3000 up and astral characters, maps twins (added ÷ ± ≈ ¼ ½ ¾ ¹ ² ³), and names everything else as dropped (marks, joiners, punctuation, symbols). A second measurement on the real Codex 0.166.0 (Windows) found: the zero-width joiner and combining marks are LOST (so the old "marks kept" was wrong), CJK punctuation 。、「 and full-width ！ are KEPT. Normalization moved out of `deliver` into `runSend`, runs on `platform === 'win32'` only (injectable dep), and the normalized text then flows into `deliver` AND `reconcileDelivery` (r2-7). A removal that leaves nothing or a slash command throws `CODEX_TEXT_UNSENDABLE` before anything is typed. A lossy send's status says what was left out.
- r2-4: the whole-placeholder ±2 shortcut is gone; literal equality with a box that shows a real-sized placeholder is `opaque`; a large placeholder is also tried as literal text (r2-9).
- r2-5: `watchCodexEnter` counts only an EMPTY box (`codexBoxDraft === ''`) as taken; a non-empty "other" after the first Enter returns 'unconfirmed' with no second Enter (logged `codex-box-changed-after-enter`); after the retry Enter it is CODEX_NOT_SUBMITTED.
- r2-3: `codexTyped` records the EXACT text and the number of Enters Harbor pressed into it (`noteCodexEnter`); `codexBoxCarries(box, text, extra)` lets only the last placeholder cover up to `max(1, extra)` fewer characters; `ownsCodexBox` passes the record's count only for a matching record. Write race: a box in state 'holds' whose draft is not a suffix of the message throws `CODEX_BOX_CHANGED` instead of pressing Enter.
- `test/main/session-send.test.js`: seven "round 2:" specs (each fails on the code you reviewed; claimed, verify if you doubt it).

The typer (staged `...\private\inputs\type.cjs`; what you reviewed in round 2 is `type.cjs.r2`): exact-text hash records tied to keeper pid + session with an Enter count; the slash/empty guard; the suffix rule while typing (both gates); only an empty Codex box is "sent"; the Claude welcome hint is empty only when no conversation turn is drawn above the box, the queue hint only with the keeper's dim evidence (r2-6); `transcriptConfirm` finds the session's own transcript by id in any `~/.claude*` home, takes a byte boundary right before Enter, reads complete appended lines only, and requires whole-text equality (r2-2, r2-8). Self-test: 49 cases including a transcript reader run against real temp files.

Also new and in scope for a quick look: sub-agent progress on Delegated rows (`readSubagentProgress` in `app/src/main/providers/transcript.js`, `subagentLabel` in `app/src/renderer/stage/turn-meta.cjs`, the collapsed-group rendering in `app/src/renderer/stage/Conversation.jsx`), the stuck-window evidence logger (`app/src/renderer/stage/unbound-watch.cjs` and its use in `app/src/renderer/index.jsx`), the Tab-suggestion hint filter (`getSuggestion`), and the two doctrine bullets in `docs/claude/conversation.md` starting "SENDING INTO CODEX" and "WHAT THE TERMINAL SHOWED".

## What to attack

Close or reopen each round-2 finding with a concrete input. Then hunt new defects in the changed code: anything that can now send a message the sender did not intend, report "sent" without evidence, or refuse a legitimate send in a common case (a fresh Claude session, a Codex mid-turn queue, a long message, a retry after CODEX_NOT_SUBMITTED). For `readSubagentProgress`: cost on a large session, a meta file written before its transcript, a parser rebuilt after truncation, a sub-agent's own sub-agents. Say plainly which residual risks you accept as stated in the doctrine and which you do not.

## How to check

You may run `npm test -- session-send`, `npm test -- providers/transcript`, `npm test -- turn-meta`, `npm test -- unbound-watch` from `C:\dev\harbor\app`, and the staged typer's `--self-test`. Do NOT run the full suite. Do not use the browser MCP or god Chrome. Order findings Blocker, Should-fix, Nit, each with the exact input and the line it fails at.
