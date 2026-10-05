# The answer sheet: rebuilding Harbor's in-window question card (2026-09-03)

Pat's report: "Q&A interface busted and not working. its never truly worked right and honestly it has been clunky from the start." The screenshot showed a two-question batch rendered with no question text, options 1 to 3 missing, a free-text row numbered 4, "Chat about this" numbered 5, and a footer of seven navigation buttons.

## What was actually wrong (measured, not theorised)

1. **The daemon's screen model counted emoji as one cell while ConPTY counts two.** `src/daemon/screen.js` built xterm-headless with its default Unicode 6 width table. ConPTY writes a full-width row and trusts the terminal to wrap; when that row holds a `❌` or `✅`, xterm-headless ends the row one cell short, does not wrap, and the next row's first character lands on the previous row's last column. Every such row shifts everything below it one more column left until ConPTY next positions the cursor absolutely. Reproduced against the real CLI in an isolated daemon (a pasted prompt holding three `❌` rows shifted the three rows under it by one, two, then three columns) and read live off Pat's Data-Mapper pane, where a table of `❌` rows above the dialog shifted the option rows so that `1. Reassemble…` became `1` at the end of one row and `. Reassemble…` at the start of the next. `OPTION_RE` cannot match either half, so the parser saw a run starting at 4, called the menu clipped, blanked the question, and the transcript merge found no option label to match. That is the screenshot.
2. **The parser did not know `☒`.** The current CLI marks an answered question's tab `☒`; `TAB_GLYPHS` listed `☐☑✔✓⬜⬚`. A batch with one answered question lost its tab strip and the strip text fell into the question line.
3. **The card was a remote control, not a form.** Every arrow was a pty round trip through a 700 ms poll, question 2 was reachable only through Previous/Next buttons, and the card never showed the whole batch even though the transcript carries it in full.

## Measured dialog behaviour (Claude Code v2.1.258, real pty at 120x60)

- `→` next question, `←` previous, `←` on the first question stays put.
- Single-select in a batch: `Enter` on an option answers that question AND auto-advances to the next; the answered tab flips to `☒`.
- Typing on the `Type something.` row rewrites the row's label; `Enter` answers with it and advances.
- Multi-select: `Space` ticks (`[✔]`); the tab flips to `☒` on the first tick; the unnumbered `Submit` row under the text row (labelled `Next` when questions follow) confirms and advances.
- After the last question: the review screen (`Review your answers`, `Ready to submit your answers?`, `1. Submit answers / 2. Cancel`, no footer). `Enter` there writes the tool result.
- A message queued while blocked is echoed UNDER the dialog as `❯ text` lines; the review screen with such an echo parsed as unrecognized before this change.

## The finding that changed the design mid-build

Measured in an isolated pty against Claude Code v2.1.258: while an AskUserQuestion dialog is up, the transcript holds NOTHING from the assistant turn. Thirty seconds of polling with the dialog on screen saw zero assistant records; the thinking, text, tool_use and tool_result records all landed together 2.5 seconds after the answer. So the transcript cannot be the source of the batch, and the 2026-07-27 mechanism has been silently inert since the CLI changed its persistence. The pty is the only live source. A batch is therefore DISCOVERED by walking the dialog once (`session-send.js` `discoverBatch`): ← until the screen stops changing, → through every question reading each screen whole at 120x60, ← back to the question the user was on, every hop verified by the screen's own labels, cached per pane by the strip's labels, with a failed walk retried at most every 10 seconds. The transcript read stays in front of discovery as an additive enhancement.

## Design

### Authority split, revised
The pty says everything live: whether the dialog is up, what is highlighted, what the footer offers, and (through discovery) what the batch's other questions are. The transcript, when a CLI persists early, may supply the same question set first. Nothing here builds a card from the transcript alone.

### One shape for every recognized dialog: the sheet
`main/ask-question.js` `buildSheet(menu, ask)` returns
```
sheet: {
  kind: 'ask' | 'permission' | 'resume' | 'review',
  mode: 'immediate' | 'staged',
  questions: [{ index, header, question, multiSelect, options: [{ index, label, description, recommended, checked? }],
                acceptsText, textIndex, answered, current }],
  currentIndex, chatIndex, source: 'transcript' | 'pty'
}
```
- A batch (`questions.length > 1`) or a multi-select question is `staged`: clicks only mark local state; one Submit delivers everything.
- A lone single-select question (AskUserQuestion, permission prompt, resume dialog) is `immediate`: a click answers now, exactly as before.
- `answered` comes from the strip's `☒` when present, else from the local state.
- Current question derivation, in order of strength: visible option labels (existing), then the pty's question line matched against the transcript questions (normalised, at least 12 characters), then a lone transcript question when the strip has no batch. Ambiguity still yields no claim.

### Delivery: `answerMenu({ type: 'sheet', answers })`
For each question in order: make it current (derive; step `→`/`←` bounded by the batch size; verify), answer it (verified walk + Enter; toggles verified by re-reading checkboxes then the confirm row; text typed and verified in the row then Enter), then re-read. After the last question, reach the review screen (step `→` if needed, bounded) and select `Submit answers` with the same verified walk. Any step that cannot be verified stops, leaves the dialog exactly where it is, and returns `{ ok: false, reason, question }` naming the question it stopped on. A lone question needs no review screen.

### Renderer: `stage/AskCard.jsx` + pure `stage/ask-sheet.cjs`
- Header: calm eyebrow, question count pill, quiet Dismiss.
- Batch stepper: one chip per question, state dot, clickable.
- Question text prominent; options as rows with a number keycap, label, description, Recommended pill; local highlight; staged selection shown in the keycap.
- Free text row per question (immediate: Enter sends; staged: typing stages).
- Footer: one primary button (`Answer` / `Submit N answers`), quiet `Chat about this`, key hints.
- Keyboard (pure, tested): `↑`/`↓` move the local highlight, `←`/`→` (and Tab) change question in a staged sheet, digits pick an option, Space toggles/selects in staged mode, Enter answers (immediate) or selects-and-advances / submits when complete (staged), Esc dismisses. No arrow key reaches the pty from the card any more.
- Fallback panel (unrecognized dialog) stays as the floor, restyled to match.

### Proof
- `test/daemon/screen-width.test.js`: a full-width row holding `❌` wraps the next character to column 0 (fails at HEAD).
- Real-bytes fixtures from the probe runs (`test/fixtures/askuserquestion/real-batch-*-2.1.258-*.txt`) drive parser and merge tests, including `☒` and the queued-echo review screen.
- `test/main/session-send.test.js`: the sheet driver against scripted screens for single, batch, multi, text, and a mid-batch failure.
- The driver run live against a real dialog in an isolated daemon (`scripts/drive-ask-sheet-win.js`): discovery in about 430 ms, delivery in about 920 ms, the CLI's own tool result carrying exactly the two answers.
- The real card rendered and driven in a browser (`scripts/ask-card-harness/`): seven states at three widths, then keyboard bursts against the stubbed `window.harbor`, which caught the focused-row Enter and the non-advancing digit.
