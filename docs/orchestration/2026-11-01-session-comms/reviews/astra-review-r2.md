The revision closes several round-1 cases, but it is not ready to ship. I reproduced false delivery confirmations, Enter on replacement drafts, a normalization-induced `/exit`, and a successful normalized send later reported as failed.

All authorized tests passed: **197 session-send tests, 2 socket-guard tests, and 31 typer self-tests**. Additional probes used constructed screens and in-memory filesystem mocks. I edited no files and contacted no live sessions or daemons.

1. **Blocker: normalization can change message meaning and turn ordinary text into an executable slash command.**

   **File/function:** [C:\dev\harbor\app\src\main\session-send.js:470](C:/dev/harbor/app/src/main/session-send.js:470), `codexSafeText`; applied by `deliver` at line 1498.

   Reproduced transformations:
   ```text
   Open C:\dev\proof\a–b.txt  -> Open C:\dev\proof\a-b.txt
   const s = "don’t";        -> const s = "don't";
   a÷b                      -> ab
   👩‍💻                     -> 👩💻
   ✓/exit                   -> /exit
   ```

   The last case is especially dangerous. Through Harbor’s actual `deliver` function with mocked terminal I/O, `✓/exit` produced:
   ```js
   ["/exit ", "\r"]
   ```
   Normalization runs before the later slash-command classification, so this message bypasses the ordinary message gate and executes `/exit`.

   The transformation also runs for every Codex platform/version, although the supplied evidence concerns Windows Codex 0.166.0. Mapping changes generally produce no user-facing notice; removing the emoji’s joiner also leaves `dropped` empty.

   **Recommended fix:** preserve the original payload through a verified transport. If a fallback cannot preserve it, expose the limitation instead of silently changing code, paths, or quoted values. At minimum, reject normalization that creates a slash command or empties the message, and restrict any compatibility workaround to the measured environment. ASCII `<`, `>`, and `|`, accented letters, and combining marks survived my direct probes.

2. **Blocker: transcript confirmation can confirm another session, another message, or a previous attempt.**

   **File/function:** [C:\dev\harbor\docs\orchestration\2026-11-01-session-comms\private\inputs\type.cjs:95](C:/dev/harbor/docs/orchestration/2026-11-01-session-comms/private/inputs/type.cjs:95), `transcriptConfirm`; matching at lines 118–126, folder enumeration at line 131, cutoff at line 186.

   Three independent counterexamples returned `sent`:

   - The named target transcript is empty. Another session’s transcript in the same project folder contains a recent user message `hello`. Confirmation of the target’s `hello` succeeds.
   - Requested text is `"DO IT " + "x".repeat(48)`. A recent user record contains `"DO NOT " + "x".repeat(48)`. Confirmation succeeds because only the final 48 whitespace-stripped characters are compared.
   - Enter is attempted at time `T`. An identical user record already exists with timestamp `T−500ms`. The `T−1000ms` cutoff accepts it as this attempt’s delivery.

   These are false confirmations even though assistant text and ordinary `tool_result` blocks are correctly excluded.

   **Recommended fix:** resolve the intended conversation identity and capture a transcript byte boundary or event boundary before the attempt. Match the complete intended payload in newly appended submission/queue events. Do not treat all recently modified transcripts in a folder as interchangeable. Handle `/clear` through an explicit identity transition, not a directory-wide fallback.

3. **Blocker: ownership records prove a past write, not ownership of the current draft.**

   **Files/functions:** [C:\dev\harbor\app\src\main\session-send.js:1459](C:/dev/harbor/app/src/main/session-send.js:1459), `ownsCodexBox`; [C:\dev\harbor\docs\orchestration\2026-11-01-session-comms\private\inputs\type.cjs:72](C:/dev/harbor/docs/orchestration/2026-11-01-session-comms/private/inputs/type.cjs:72), `fileRecords`, consumed by both delivery gates.

   Reproduced sequence:

   1. The typer writes `F` plus 1,182 `x` characters with `--no-enter`.
   2. Another sender submits or clears that draft and replaces it with `F` plus 1,182 different characters.
   3. The original typer retries within ten minutes.
   4. Its stale record authorizes Enter on the replacement paste.

   The probe wrote only `"\r"` and returned `sent`. Harbor’s `ownsCodexBox` likewise accepted the replacement with its stale map entry.

   The records also conflate meaningful whitespace:
   ```js
   recorded = "print('a b')" + "x".repeat(1200)
   retry    = "print('ab ')" + "x".repeat(1200)
   ```
   `records.has(retry)` returns true. Records contain neither conversation identity nor keeper generation, so a replacement session under the same pane ID is also indistinguishable.

   There is an additional write race: an initial empty screen followed by `FOREIGN hello` after typing `hello` passes the `holds` gate and gets Enter. I reproduced this in the Codex typer. Separate Harbor and typer records do not serialize their writes.

   **Recommended fix:** use a shared per-pane send mechanism with exclusive sequencing, generation/conversation identity, and an exact payload hash. Invalidate ownership when the draft is submitted, cleared, replaced, or the session changes. A ten-minute text record alone cannot safely authorize an opaque retry.

4. **Blocker: `codexBoxMatch` still has shortcuts that bypass the tightened matcher.**

   **File/function:** [C:\dev\harbor\app\src\main\session-send.js:503](C:/dev/harbor/app/src/main/session-send.js:503), `codexBoxMatch`, especially lines 504–505.

   The whole-placeholder branch retains the old symmetric two-character allowance:
   ```js
   box  = "[Pasted Content 1182 chars]"
   text = "x".repeat(1182) + "NO"
   ```
   Result: `{ state: "exact", opaque: true }`.

   In a fresh-send probe, the typer wrote the requested text, accepted that truncated rendering, pressed Enter, and reported sent. A whole placeholder containing two extra characters is accepted too. `[Pasted Content 1000 chars]` also remains an opaque match for 1,000 characters, contradicting the new rule that counts at or below 1,000 are literal.

   The literal-equality shortcut has a separate ownership bypass:
   ```js
   box  = "F[Pasted Content 1182 chars]"
   text = "F[Pasted Content 1182 chars]"
   ```
   Result: `{ state: "exact", opaque: false }`.

   If the box actually contains a real hidden paste, requesting its visible placeholder spelling makes the typer press Enter with **no ownership record**. I reproduced that Enter-only path.

   **Recommended fix:** apply one consistent placeholder policy to whole and split boxes. Recognized real-placeholder syntax must remain ambiguous/opaque even when the requested text equals its displayed spelling. Do not use generic ±2 matching before the stricter walker.

5. **Blocker: two swallowed Enters now produce “sent” while the split draft remains in the box.**

   **Files/functions:** [C:\dev\harbor\app\src\main\session-send.js:1430](C:/dev/harbor/app/src/main/session-send.js:1430), `watchCodexEnter`; [C:\dev\harbor\docs\orchestration\2026-11-01-session-comms\private\inputs\type.cjs:251](C:/dev/harbor/docs/orchestration/2026-11-01-session-comms/private/inputs/type.cjs:251), `deliverCodex`.

   For an owned message containing `F` plus 1,182 characters:
   ```text
   Before Enter:          F[Pasted Content 1182 chars]
   First Enter swallowed: F[Pasted Content 1183 chars]
   Retry Enter swallowed: F[Pasted Content 1184 chars]
   ```

   The first changed box still matches. The second returns `other` because the rewritten walker permits only one added character. Both consumers interpret `other` as submission.

   The typer probe returned:
   ```text
   sent (Codex took the second Enter)
   ```
   It wrote two Enters, but the final screen still held the draft.

   **Recommended fix:** distinguish an empty composer from an unrecognized nonempty draft. `other` is not evidence of submission. Confirm an empty box or an actual submission event; otherwise return unconfirmed. Account for swallowed newlines without restoring arbitrary slack to the pre-submit matcher.

6. **Blocker: a real Claude draft that resembles a hint is treated as empty without checking dimness.**

   **File/function:** [C:\dev\harbor\docs\orchestration\2026-11-01-session-comms\private\inputs\type.cjs:165](C:/dev/harbor/docs/orchestration/2026-11-01-session-comms/private/inputs/type.cjs:165), `deliverClaude`.

   Constructed initial state:
   ```text
   Draft: Try "delete all files"
   readSuggestion(): null
   Requested message: hello
   ```

   `WELCOME_HINT_RE` classifies the genuine, undimmed draft as empty. The typer writes `hello`, accepts the combined draft’s suffix, and presses Enter.

   The same issue applies to a real draft containing exactly `Press up to edit queued messages`.

   **Recommended fix:** require cell-style evidence from the same screen snapshot before treating these strings as hints. Literal text alone cannot distinguish the hint from a user’s draft. The production adapter now correctly pairs `suggestion` and screen text from one keeper response; that part is fixed.

7. **Should-fix: Harbor confirms the original text after sending normalized text.**

   **File/function:** [C:\dev\harbor\app\src\main\session-send.js:2705](C:/dev/harbor/app/src/main/session-send.js:2705), `runSend` and `reconcileDelivery`; normalization occurs only inside `deliver`.

   Reproduced through the public send API with mocked terminal and transcript I/O:
   ```text
   Requested:  didn’t work
   Transmitted and recorded: didn't work
   Status sequence: sending -> sent -> error
   Error: could not confirm the message reached the session
   ```

   `reconcileDelivery` receives the original `trimmed` string, so its transcript needle cannot match the normalized payload.

   The new smart-punctuation test uses a `pane:` session ID, which skips transcript confirmation and therefore misses this regression.

   **Recommended fix:** prepare one explicit wire payload before delivery and pass that same payload through ownership, typing, and confirmation. Keep the original separately for display. Add a test with a real session identity and transcript metadata.

8. **Should-fix: transcript discovery and bounded-tail parsing can falsely report unconfirmed delivery.**

   **File/function:** [C:\dev\harbor\docs\orchestration\2026-11-01-session-comms\private\inputs\type.cjs:98](C:/dev/harbor/docs/orchestration/2026-11-01-session-comms/private/inputs/type.cjs:98), `transcriptConfirm` and `readTail`.

   The reader takes only the last 512 KiB and parses each resulting line independently. A valid user record larger than that window is truncated at its beginning and becomes unparsable. My constructed 600,000-character user record returned no confirmation. Recent delivery can also fall outside the window when substantial output follows it.

   Discovery is hardcoded to the default home’s `.claude/projects` directory. The production call does not supply the pane’s actual config home. Junctions on this machine can conceal that limitation; a separate profile store will not.

   Timestamp filtering also rejected a newly appended matching record whose timestamp was two seconds behind the caller’s clock. Widening the timestamp allowance would worsen finding 2.

   **Recommended fix:** resolve the owning profile and conversation, then scan appended bytes from a captured boundary with complete-line handling. This also removes dependence on clock agreement and arbitrary tail size.

9. **Should-fix: literal large placeholder text inside a mixed message still fails.**

   **File/function:** [C:\dev\harbor\app\src\main\session-send.js:404](C:/dev/harbor/app/src/main/session-send.js:404), `codexBoxCarries`.

   ```js
   box = "Explain [Pasted Content 1200 chars] [Pasted Content 1182 chars]"
   text = "Explain [Pasted Content 1200 chars] " + "x".repeat(1182)
   ```
   Result: `other`.

   The small literal-marker case is fixed, but the same literal syntax with a count above 1,000 is always interpreted as hidden content.

   **Recommended fix:** retain literal and placeholder interpretations where the screen is ambiguous, while keeping any ambiguous match opaque. Do not restore the unowned literal-equality bypass described in finding 4.

10. **Nit: documentation and comments still overstate several guarantees.**

   **Files:** [C:\dev\harbor\docs\claude\conversation.md:42](C:/dev/harbor/docs/claude/conversation.md:42), the rewritten bullet; [C:\dev\harbor\app\src\main\session-send.js:376](C:/dev/harbor/app/src/main/session-send.js:376), split-paste commentary; [C:\dev\harbor\app\test\main\session-send.test.js:1264](C:/dev/harbor/app/test/main/session-send.test.js:1264), fixture commentary.

   The doctrine now correctly labels the original incident’s split shape as an inference. The source and test comments still state that Fable’s original box had that exact shape.

   The doctrine’s strict count policy does not describe the retained whole-placeholder shortcut. “Emoji kept” excludes the demonstrated joiner loss. “The conversation’s transcript” and “after the attempt began” overstate a scanner that accepts sibling transcripts and records from one second earlier.

   **Recommended fix:** update these claims after resolving the behavioral findings, and distinguish measured captures from incident inference.

The round-1 closure is **partial**:

| Round-1 finding | Round-2 result |
|---|---|
| Opaque paste ownership | Fresh unowned shaped pastes are refused. Stale records, literal-marker equality, and concurrent writes remain unsafe. |
| Slack matching | The split-walk counterexamples are fixed. The whole-placeholder shortcut remains permissive. |
| Unexpected images | The reported text-only image case is fixed. When `imageMarker` is present, the matcher still strips every image chip without verifying its identity. |
| Literal marker syntax | Small literal markers are fixed; large literal markers remain ambiguous or rejected. |
| Claude foreign drafts | Ordinary drafts are refused. Hint-shaped drafts and stale ownership remain exceptions. |
| Claude sessions view | The initial and mid-send fixture cases are fixed. |
| Inconclusive Enter frames | Claude now requires transcript confirmation, and vanished Codex boxes receive no spare Enter. Confirmation identity and nonempty `other` handling remain unsafe. |
| Whitespace before split paste | Fixed in my spaces, CRLF, and tab probes. Astral prefixes and typed middle segments also passed. |
| Incident documentation | The doctrine’s inference wording is fixed; residual comments and behavioral claims need correction. |

The socket guard still passes its targeted tests, with no new changes or evident regression. Assistant quotations and ordinary tool-result blocks did not falsely confirm Claude delivery. A visible unnormalized `didn’t` box also did not match normalized `didn't`, or vice versa.