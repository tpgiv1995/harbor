The revision fixes several round-2 failures, but it is not ready to ship. The remaining blockers include a public `sent` result after an unconfirmed Codex send, acceptance of incomplete messages, and confirmation that ignores meaningful whitespace.

All authorized tests passed: **204 session-send tests, 95 transcript tests, 7 turn-meta tests, 2 unbound-watch tests, and the typer’s 49-case self-test.** Additional probes used mocked screens and in-memory files. I edited no files and contacted no live sessions or daemons.

1. **Blocker: Harbor still reports `sent` after the Codex watcher returns `unconfirmed`.**

   **File/function:** [C:\dev\harbor\app\src\main\session-send.js:2780](C:/dev/harbor/app/src/main/session-send.js:2780), `runSend`; confirmation skip at line 992.

   Reproduced through the public send API:

   ```text
   Request: hello
   Box before typing: empty
   Box after Enter: STRANDED DRAFT, still nonempty
   Session ID: pane:test
   ```

   The watcher correctly returns `unconfirmed`, but `runSend` discards that result and emits:

   ```json
   {"ok":true,"paneId":"p","delivery":"confirming"}
   ```

   Statuses are `sending`, then `sent`. No correction follows because provisional `pane:` sessions skip transcript confirmation. A session without transcript metadata has the same gap.

   The new test at line 4070 explicitly asserts `res.ok === true` and checks only the internal `enter-state` log. It does not verify the user-visible outcome.

   **Fix:** propagate the watcher’s result. An unconfirmed send must remain unconfirmed unless transcript evidence subsequently establishes delivery. Do not emit `sent` when reconciliation is unavailable.

2. **Blocker: the suffix rule accepts an incomplete, fully visible short message.**

   **Files/functions:** [C:\dev\harbor\app\src\main\session-send.js:1763](C:/dev/harbor/app/src/main/session-send.js:1763), `deliver`; [C:\dev\harbor\docs\orchestration\2026-11-01-session-comms\private\inputs\type.cjs:285](C:/dev/harbor/docs/orchestration/2026-11-01-session-comms/private/inputs/type.cjs:285), `deliverCodex`.

   Concrete input:

   ```js
   text = "Do not deploy. " + "x".repeat(40)
   drawnBox = "x".repeat(40)
   ```

   The entire message fits on one line. Nevertheless, the truncated box is `holds`, and `text.endsWith(draft)` passes. The typer presses Enter and reports `sent` when the box clears.

   The rule excludes foreign prefixes but does not establish that the requested prefix arrived. The Claude typer uses the same unsupported assumption that a suffix represents clipping.

   **Fix:** permit suffix-only acceptance only with evidence that the composer is actually clipped. Otherwise require the full visible message or a compatible owned placeholder.

3. **Blocker: transcript confirmation still accepts a different message when whitespace changes meaning.**

   **File/function:** [C:\dev\harbor\docs\orchestration\2026-11-01-session-comms\private\inputs\type.cjs:141](C:/dev/harbor/docs/orchestration/2026-11-01-session-comms/private/inputs/type.cjs:141), `transcriptConfirm.wait`.

   After a valid byte boundary:

   ```text
   Requested:    print('a b')
   Appended user record: print('ab')
   ```

   Confirmation returns `sent`. Both sides are passed through `squash`, which removes every whitespace character.

   Session identity, append boundaries, and full-length comparison fix the previous sibling-session, old-message, and shared-tail cases. They do not fix this content mismatch.

   **Fix:** compare the actual transcript payload, with only explicitly justified transport normalization such as CRLF conversion. Transcript text does not need screen-wrap whitespace removal.

4. **Blocker, documented but unresolved: a stale record still authorizes a replacement paste in the same process.**

   **Files/functions:** [C:\dev\harbor\app\src\main\session-send.js:1500](C:/dev/harbor/app/src/main/session-send.js:1500), `ownsCodexBox`; [C:\dev\harbor\docs\orchestration\2026-11-01-session-comms\private\inputs\type.cjs:264](C:/dev/harbor/docs/orchestration/2026-11-01-session-comms/private/inputs/type.cjs:264), `deliverCodex`.

   Sequence:

   1. Sender records `F` plus 1,182 `x` characters.
   2. Another writer submits or clears it.
   3. That writer inserts `F` plus 1,182 different characters.
   4. The original sender retries within ten minutes.

   The screen remains `F[Pasted Content 1182 chars]`. The exact hash and process identity still match the old record, so the replacement is considered owned. My current-code Harbor probe returned `owned: true`.

   Exact-text records close the whitespace-key collision. The typer’s process/session identity closes its restart collision. Neither proves continuity of the draft.

   **Fix:** invalidate ownership on intervening input or draft replacement, using a shared keeper-level input generation or serialized send mechanism. Until that exists, an unverifiable opaque retry should require explicit handling rather than automatic Enter.

   I do **not** accept this as a safe residual for a feature specifically used by concurrent writers.

5. **Blocker, documented but unresolved: normalization still silently changes exact values.**

   **File/function:** [C:\dev\harbor\app\src\main\session-send.js:486](C:/dev/harbor/app/src/main/session-send.js:486), `codexSafeText`, applied in `runSend` at line 2724.

   Current results:

   ```text
   Open C:\dev\proof\a–b.txt  -> Open C:\dev\proof\a-b.txt
   const s = "don’t";        -> const s = "don't";
   ```

   Both return `dropped: []`, so the new “sent without …” status does not disclose these changes. They identify a different file or prescribe a different string.

   The command/empty guards now work: `✓/exit`, `÷exit`, and `✓` produced `CODEX_TEXT_UNSENDABLE` with no writes. Windows-only application and normalized transcript confirmation also work.

   **Fix:** preserve exact payloads through a verified transport, or make the transformed payload explicit before submission. “Codex would otherwise delete the character” explains the workaround but does not make a different filename correct. I do not accept silent value changes as the default for code and paths.

6. **Should-fix: a fresh or changed Claude conversation identity cannot be discovered during confirmation.**

   **File/function:** [C:\dev\harbor\docs\orchestration\2026-11-01-session-comms\private\inputs\type.cjs:106](C:/dev/harbor/docs/orchestration/2026-11-01-session-comms/private/inputs/type.cjs:106), `findTranscript`.

   Concrete cases:

   - Initial state has `agent_session: null`. After Enter, the new session writes its transcript and requested user line. `findTranscript` keeps returning null.
   - Initial state names the old conversation. After `/clear`, delivery is written under the new conversation ID. Confirmation remains pinned to the old file.

   Both probes returned unconfirmed despite the matching record being present. The state object is read once; polling never refreshes its identity.

   **Fix:** refresh the pane’s authoritative conversation identity while marking and confirming, and handle an observed identity transition explicitly. Preserve the restriction against accepting arbitrary sibling transcripts.

7. **Should-fix: the fresh-conversation welcome heuristic still modifies a genuine draft.**

   **File/function:** [C:\dev\harbor\docs\orchestration\2026-11-01-session-comms\private\inputs\type.cjs:196](C:/dev/harbor/docs/orchestration/2026-11-01-session-comms/private/inputs/type.cjs:196), `deliverClaude`.

   Initial screen has no previous turn and contains a genuine undimmed draft:

   ```text
   Try "delete all files"
   ```

   `readSuggestion()` returns null. Sending `hello` appends it to that draft. The new post-write guard then refuses Enter, leaving:

   ```text
   Try "delete all files"hello
   ```

   This is safer than round 2, which submitted the combined draft, but it still treats user content as empty and modifies it. Absence of visible turn markers also does not prove a conversation is fresh.

   **Fix:** expose the keeper’s actual dim/hint classification. Do not infer emptiness from the wording and visible conversation history alone.

8. **Should-fix: a quiet sub-agent permanently stops being followed, while a missing transcript can remain “Starting” forever.**

   **File/function:** [C:\dev\harbor\app\src\main\providers\transcript.js:1813](C:/dev/harbor/app/src/main/providers/transcript.js:1813), `readSubagentProgress`; running-state calculation at line 1865.

   Reproduced with one unfinished sub-agent:

   1. Read one tool.
   2. Advance beyond fifteen minutes without a transcript write.
   3. The row becomes `running: false`, labelled `Used 1 tool`.
   4. Append another tool and refresh its mtime.
   5. The next poll opens **zero files** because the early `live` check returns false. Progress never resumes.

   A long-running tool, model wait, or delegated grandchild can produce this silence without the parent dying.

   Conversely, if metadata exists but the transcript never appears, `mtimeMs` stays zero and the row remains running even an hour later.

   **Fix:** separate finished, quiet, and awaiting-transcript states. Continue checking unfinished agents for resumed activity. Silence is not proof of process death, and the doctrine should not state that it is.

9. **Should-fix: sub-agent caches survive parser resets and ignore child-file truncation.**

   **File/function:** [C:\dev\harbor\app\src\main\providers\transcript.js:1823](C:/dev/harbor/app/src/main/providers/transcript.js:1823), `readSubagentProgress`; main-parser replacement at line 2005.

   Two counterexamples:

   - Follow an agent to completion, then replace `entry.parser` as the truncation path does. The new Agent action has no `sub`, but the old cache says `settled`, so it is skipped forever. My probe returned no changed keys and no progress on the rebuilt action.
   - Read four child tool records, then truncate the child transcript to one record. The reader retains the old offset and reports four tools. It does not reset its count or line buffer.

   **Fix:** invalidate or rebind sub-agent state when the parent parser changes. Detect child truncation/replacement and rebuild that child’s offset, decoder, count, and settled state.

10. **Should-fix: sub-agent progress is not bounded consistently with the main transcript reader.**

    **Files/functions:** [C:\dev\harbor\app\src\main\providers\transcript.js:1037](C:/dev/harbor/app/src/main/providers/transcript.js:1037), `TranscriptParser.push`; `readSubagentProgress` at lines 1822–1860.

    Measured cases:

    - After 1,000 Agent actions, `blocks.length` is capped at 240 but `delegations.size` remains 1,000. Eviction removes only `pendingTools` entries.
    - With one followed agent and 500 unmatched descendant metadata files, three polls performed **1,503 metadata reads**. Unmatched metadata is never cached.
    - Parsing a constructed 7.25 MB child transcript containing 50,000 tool records took about **181 ms** in one call. Unlike the main reader, this loop does not yield.
    - An unread gap over 32 MiB is skipped outright while the existing count is retained and displayed without an “incomplete” qualification.

    **Fix:** prune evicted delegations, cache metadata associations, yield during parsing, and preserve honest count semantics when skipping bytes. Following direct children only is an acceptable scope choice; repeatedly rereading their descendants’ unrelated metadata is unnecessary.

11. **Should-fix: the evidence logger misses a repeatedly failing transcript-open path.**

    **File/function:** [C:\dev\harbor\app\src\renderer\stage\unbound-watch.cjs:31](C:/dev/harbor/app/src/renderer/stage/unbound-watch.cjs:31), `createUnboundWatch`; rejected-open handling in [C:\dev\harbor\app\src\renderer\index.jsx:713](C:/dev/harbor/app/src/renderer/index.jsx:713).

    A canonical session tile with no entry in `transcripts` produces no event, even after sixty seconds. That is exactly the state left when `transcript.open()` repeatedly rejects: the catch permits retry but creates no `missing` record.

    The logger therefore cannot distinguish this failed-open case despite its stated purpose.

    **Fix:** track an outstanding/failed open for canonical tiles, including the last failure category, and report it after the threshold.

12. **Nit: closing a stuck window is logged as successful binding.**

    **File/function:** [C:\dev\harbor\app\src\renderer\stage\unbound-watch.cjs:61](C:/dev/harbor/app/src/renderer/stage/unbound-watch.cjs:61), `createUnboundWatch`.

    Report a stuck `pane:p`, then close its tile. The event is:

    ```json
    {"kind":"window-bound","context":{"window":"pane:p","left":true}}
    ```

    `left: true` preserves a clue, but the event name asserts a recovery that did not occur.

    **Fix:** distinguish closure from an observed provisional-to-conversation upgrade, or use a neutral `window-left` event when the outcome is unknown.

Round-2 closure:

| Finding | Round-3 result |
|---|---|
| 1. Normalization changes meaning/creates commands | Command and empty-message injection closed; platform scoping fixed. Silent exact-value changes remain open. |
| 2. False transcript confirmation | Sibling files, previous records, and shared tails closed. Meaningful whitespace remains open. |
| 3. Ownership records | Exact-text hashing and typer process identity fixed. Same-process replacement remains open. |
| 4. Matcher shortcuts | Closed for the tested whole-placeholder slack and literal-marker bypasses. |
| 5. Two swallowed Enters reported sent | Watcher and owned retry matching fixed. Public Harbor status remains wrong when the watcher returns unconfirmed. |
| 6. Hint-shaped drafts | Established-conversation and undimmed queue-hint cases fixed. Fresh-conversation draft mutation remains. |
| 7. Normalized confirmation mismatch | Closed. The normalized payload reached the mocked transcript without the former false error. |
| 8. Transcript discovery/tail limits | Alternate homes, the 600,000-character record, complete-line handling, and clock independence passed. Missing/stale conversation identity remains. |
| 9. Large literal placeholder text | Closed; mixed literal/opaque rendering now matches as opaque. |
| 10. Documentation | Original incident inference is now stated correctly. The public “sent” guarantee and quiet-agent death claim still overstate the implementation. |

I accept the stated scope limits of omitting counts for agents first observed already finished and not following Codex sub-agent files without a known format. I also accept a conservative unconfirmed result when evidence is unavailable, provided the UI actually presents it that way.

I do **not** accept silent code/path changes, same-size replacement drafts receiving automatic Enter, or unexpected image attachments as established-safe behavior merely because they are documented. The text-only image regression is closed; attachment identity remains an acknowledged gap.

No additional logic defect stood out in `subagentLabel`, the collapsed-group branch that exposes running children, or the Tab hint filter. I did not visually validate the renderer in this review.