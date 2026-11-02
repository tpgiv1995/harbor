The change is not ready to ship. All three authorized test commands pass, but constructed screens demonstrate false `exact` results that trigger Enter on foreign or altered drafts, plus unsafe behavior in the new Claude gate.

I made no source edits and did not start, contact, type into, or signal any live session or daemon. The delivery probes used injected screen reads and captured writes in memory.

1. **Blocker: a matching paste shape does not establish ownership.**

   **File/function:** [C:\dev\harbor\app\src\main\session-send.js:388](C:/dev/harbor/app/src/main/session-send.js:388), `codexBoxCarries` and `codexBoxState`; consumed by `deliver`’s `ownEarlierTry` and `alreadyInPrompt` checks.

   Given:
   ```js
   box  = "F[Pasted Content 1182 chars]"
   text = "F" + "Z".repeat(1182)
   ```
   The result is `exact`, regardless of what the hidden paste actually contains. A foreign message beginning with `F` and having that length is indistinguishable.

   The staged typer’s `deliverCodex` consequently writes only `"\r"` and reports `sent`. I reproduced that sequence with injected screens. The old matcher returned `other` for this split shape. The equivalent weakness for a single whole-message placeholder already existed.

   **Recommended fix:** distinguish “compatible rendered shape” from “verified own draft.” An opaque placeholder must not authorize an existing-draft retry without a recorded attempt identifying the pane and exact payload. Serialize sends across Harbor and the typer; refuse an unowned opaque draft.

2. **Blocker: slack permits extra typed characters and missing message content.**

   **File/function:** [C:\dev\harbor\app\src\main\session-send.js:400](C:/dev/harbor/app/src/main/session-send.js:400), `codexBoxCarries`.

   These both return `exact`:
   ```js
   // Two extra visible characters:
   box  = "F[Pasted Content 1182 chars]xx"
   text = "F" + "x".repeat(1182)

   // Two missing non-whitespace characters:
   box  = "F[Pasted Content 1182 chars]"
   text = "F" + "x".repeat(1182) + "NO"
   ```
   The first works because the typed suffix can match characters already consumed by the paste. The second passes the final absolute-distance allowance.

   The allowance also compounds beyond the stated two characters per placeholder:
   ```js
   box = "A[Pasted Content 1000 chars]B"
       + "[Pasted Content 1000 chars]C"
       + "[Pasted Content 1000 chars]D"

   text = "A" + "x".repeat(1000) + "1234B"
        + "y".repeat(1000) + "1234C"
        + "z".repeat(1000) + "1234D" + "WXYZ"
   ```
   This returns `exact` despite omitting sixteen non-whitespace characters. Each typed boundary reuses the global six-character allowance, and the final check permits another discrepancy.

   **Recommended fix:** account for each placeholder’s discrepancy once. Never overlap already-consumed message characters or silently skip arbitrary non-whitespace content. Model the observed swallowed newline specifically instead of allowing symmetric character substitution.

3. **Blocker: unexpected image attachments disappear from the ownership check.**

   **File/function:** [C:\dev\harbor\app\src\main\session-send.js:444](C:/dev/harbor/app/src/main/session-send.js:444), `codexBoxState`.

   ```js
   box  = "[Image #9]F[Pasted Content 1182 chars]"
   text = "F" + "x".repeat(1182)
   ```
   With no requested image, this returns `exact`. The image chip is stripped before the new matcher runs. The typer then presses Enter, submitting the unexpected attachment too.

   The old matcher rejected this split shape, although stripping images around a whole-message placeholder was already a sibling weakness.

   **Recommended fix:** verify attachments separately against those belonging to the current attempt. For a text-only existing-draft retry, any image chip must prevent `exact`.

4. **Should-fix: literal placeholder syntax is interpreted as hidden content, even for short messages.**

   **File/function:** [C:\dev\harbor\app\src\main\session-send.js:388](C:/dev/harbor/app/src/main/session-send.js:388), `codexBoxCarries`.

   ```js
   box  = "F[Pasted Content 12 chars]"
   text = "Fxxxxxxxxxxxx"
   ```
   This returns `exact`, and the typer presses Enter without typing the requested text. The new matcher bypasses the large-paste threshold used by the older branch.

   Literal syntax also causes a false rejection in a mixed rendering:
   ```js
   box  = "Explain [Pasted Content 12 chars] [Pasted Content 1182 chars]"
   text = "Explain [Pasted Content 12 chars] " + "x".repeat(1182)
   ```
   This returns `other`, because the literal first marker is consumed as a paste count. A message consisting entirely of the literal marker still matches through the earlier literal-equality branch.

   **Recommended fix:** reject impossible small placeholder counts and account for literal marker text. Where a plain-text screen cannot distinguish literal text from a real placeholder, classify the representation as ambiguous rather than exact.

5. **Blocker: the Claude gate submits foreign drafts or skips typing the requested message.**

   **File/function:** [C:\dev\harbor\docs\orchestration\2026-11-01-session-comms\private\inputs\type.cjs:45](C:/dev/harbor/docs/orchestration/2026-11-01-session-comms/private/inputs/type.cjs:45), `deliverClaude`.

   `composerSendState(...)=holds` means the box ends with the compared tail. It does not mean the box contains exactly this message.

   Reproduced sequences:
   - Existing draft `do not say hello`, requested text `hello`: writes only Enter and reports sent.
   - Existing draft `delete all files; `, requested text `hello`: appends `hello`, then submits the combined draft.
   - Existing `[Pasted text #1]`, requested text `"x".repeat(900)`: treats the unrelated paste as its own and writes only Enter.
   - Welcome hint `Try "how does <filepath> work?"`, requested text `how does <filepath> work?"`: treats the hint as an existing draft and skips typing.

   **Recommended fix:** add an explicit empty/draft/suggestion check before typing. Refuse foreign drafts. Use verified full equality or recorded attempt ownership for Enter-only retries, never `holds`. Apply Harbor’s suggestion detection as well.

6. **Blocker: the Claude sessions view passes the new gate.**

   **File/function:** [C:\dev\harbor\docs\orchestration\2026-11-01-session-comms\private\inputs\type.cjs:45](C:/dev/harbor/docs/orchestration/2026-11-01-session-comms/private/inputs/type.cjs:45), `deliverClaude`.

   Using the existing real captures:
   - [C:\dev\harbor\app\test\fixtures\composer-enter\sessions-view-2.1.295.txt](C:/dev/harbor/app/test/fixtures/composer-enter/sessions-view-2.1.295.txt)
   - [C:\dev\harbor\app\test\fixtures\composer-enter\sessions-view-typed-2.1.295.txt](C:/dev/harbor/app/test/fixtures/composer-enter/sessions-view-typed-2.1.295.txt)

   The gate writes `hello typed in the sessions view`, then Enter. `isFleetView` correctly identifies the initial screen, but the typer never calls it. Enter here creates a background session instead of messaging the intended conversation.

   **Recommended fix:** check `isFleetView` before typing and throughout the hold/Enter loops. Reuse Harbor’s blocked-screen checks alongside it.

7. **Blocker: the Claude gate reports delivery from an inconclusive frame.**

   **File/function:** [C:\dev\harbor\docs\orchestration\2026-11-01-session-comms\private\inputs\type.cjs:73](C:/dev/harbor/docs/orchestration/2026-11-01-session-comms/private/inputs/type.cjs:73), `deliverClaude`.

   Sequence:
   ```text
   empty composer
   composer containing "hello"
   Enter written
   blank screen, empty composer without an echo, or permission dialog
   ```
   Every variant returns code 0 with “Enter taken.” A missing box does not prove the text left it. Harbor’s existing `watchEnterTaken` explicitly avoids this inference.

   Even `taken` is not independently sufficient: `composerSendState` searches old text above the box for a tail or any paste placeholder. An old matching echo can satisfy it without evidence of a new submission.

   **Recommended fix:** continue polling through inconclusive frames, stop spare Enters on dialogs, and return an explicit unconfirmed outcome on timeout. Confirm a new submission or queue event associated with this attempt. A verified queue event is sufficient; waiting for Claude’s answer is unnecessary.

8. **Should-fix: whitespace immediately before a paste still breaks legitimate splits.**

   **File/function:** [C:\dev\harbor\app\src\main\session-send.js:388](C:/dev/harbor/app/src/main/session-send.js:388), `codexBoxCarries`.

   ```js
   box  = "F   [Pasted Content 1182 chars]"
   text = "F   " + "x".repeat(1182)
   ```
   This returns `other`. The box normalization removes the three spaces, but the message cursor remains before them when the placeholder count is added. A typed prefix ending in `"\r\n\t"` fails similarly. Three leading spaces followed directly by a placeholder also fail.

   The typer’s newline replacement and trimming hide some of these cases; Harbor’s command bar can supply them unchanged.

   **Recommended fix:** account for normalized whitespace at segment boundaries without increasing the general slack. Add cases for whitespace-only typed prefixes and trailing whitespace in typed runs.

9. **Should-fix: the doctrine and test comments overstate the incident evidence and matcher guarantees.**

   **Files:** [C:\dev\harbor\docs\claude\conversation.md:42](C:/dev/harbor/docs/claude/conversation.md:42), the new bullet; [C:\dev\harbor\app\test\main\session-send.test.js:1259](C:/dev/harbor/app/test/main/session-send.test.js:1259), split-paste test commentary; the comment above `codexBoxCarries`.

   They present `F[Pasted Content 1182 chars]` as the observed original incident and say the walk must end at the message’s end. The original screen was not captured, and the counterexamples above disprove the latter guarantee.

   The `tail` branch also permits an arbitrarily long unmatched whitespace suffix: adding 99 trailing spaces to the requested message still returns `exact`.

   **Recommended fix:** identify the original split as an inference, separate it from the reproduced capture, and document the actual normalization and ownership limits. The split explanation is plausible; I found no stronger supported alternative. However, the 1,183/1,182 count difference alone cannot prove it, especially because the old single-placeholder matcher already tolerated a two-character difference.

**Checks that passed or showed no new defect:**

- The authorized tests passed: 192 session-send tests, 2 socket-guard tests, and all 13 typer self-test cases.
- Constructed multi-character prefixes, end splits, adjacent placeholders, typed middle segments, and astral-character prefixes matched successfully.
- A matching Codex transcript above a newly drawn empty composer returned `other`; I did not reproduce the proposed transcript-induced retry loop in that case.
- Ordinary Claude permission and rewind fixtures returned `nobox`; Codex trust and update fixtures returned `noprompt`.
- The `SessionClient` guard correctly rejects explicit empty values while preserving omitted-option behavior. I found no remaining evident caller regression in the requested directories. Both app-side factories constructed clients with concrete addresses resolved from an injected environment, without connecting.
- Whitespace-only differences in wholly literal text were already ignored before this change. That is an existing normalization limitation, not a new regression.