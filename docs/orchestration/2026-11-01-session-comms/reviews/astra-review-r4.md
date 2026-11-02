The revision closes most round-3 cases, but two false-success paths remain: the startup-echo detector can mistake draft text for submission, and Harbor’s transcript scanner can confirm an assistant quotation as the user’s send.

All authorized tests passed: **208 session-send tests, 96 transcript tests, 7 turn-meta tests, 3 unbound-watch tests, and the typer self-test**. Additional probes used mocked screens and in-memory files. I made no source edits and contacted no live session or daemon.

1. **Blocker: startup text inside a composer can falsely confirm delivery.**

   **File/function:** [C:\dev\harbor\app\src\main\session-send.js:338](C:/dev/harbor/app/src/main/session-send.js:338), `codexStartupEcho`; related exclusion in `codexPromptBox` at line 367.

   Constructed post-Enter screen:

   ```text
   › hello
     Waiting for startup · esc cancel

     GPT-6-Astra high · C:\dev\proof · proof
   ```

   This can represent a still-filled composer containing two lines. The normal composer footer is present. Nevertheless:

   ```js
   codexBoxMatch(screen, { text: "hello" }).state === "noprompt"
   codexStartupEcho(screen, { text: "hello" }) === true
   ```

   The typer consequently returns `sent (Codex took it and is still starting up)`. The helper searches anywhere below the last prompt for the status words, then ignores everything after the first blank or matching status line. It also accepts:

   ```text
   › hello

     EXTRA UNSENT TEXT
     Waiting for startup · esc cancel
   ```

   The reverse failure is reproducible too. A legitimate draft containing:

   ```text
   Please explain this line:
   Waiting for startup - esc cancel
   ```

   is classified `noprompt`, so its pre-Enter gate never recognizes it. A genuine multiline startup echo with a blank paragraph also fails because the echo reader stops at the first blank.

   **Fix:** recognize the complete measured startup layout, including the absence of a normal composer footer, rather than treating the phrase anywhere below a prompt as authoritative. Read the entire echo up to the actual status row, including paragraph breaks. Scope this exception to an observed startup transition for the current attempt; otherwise leave delivery unconfirmed.

2. **Blocker: transcript reconciliation accepts assistant output as delivery evidence.**

   **File/function:** [C:\dev\harbor\app\src\main\session-send.js:1110](C:/dev/harbor/app/src/main/session-send.js:1110), `transcriptScanner`, now used to resolve the new “checking that Codex took it” state.

   Reproduced sequence:

   - Request `hello`.
   - After Enter, the composer still contains another nonempty draft, so delivery is unconfirmed.
   - Append this record after the captured transcript boundary:

   ```json
   {
     "type": "response_item",
     "payload": {
       "type": "message",
       "role": "assistant",
       "content": [{"type":"output_text","text":"hello"}]
     }
   }
   ```

   Harbor emits:

   ```text
   sending
   checking that Codex took it
   sent
   ```

   No user-message record was written. The scanner accepts `chunk.includes(needle)` without checking record type or role. The needle is also only the first 60 serialized characters, so another message sharing that prefix can confirm the wrong payload.

   **Fix:** parse complete provider records and require a new user-input or accepted-input event containing the complete wire payload. Assistant text, tool output, and arbitrary matching bytes must not resolve an unconfirmed send.

3. **Should-fix: image-only Codex sends fail the text-clipping guard.**

   **File/function:** [C:\dev\harbor\app\src\main\session-send.js:1818](C:/dev/harbor/app/src/main/session-send.js:1818), `deliver`.

   Input:

   ```js
   text = ""
   images = ["C:/virtual/example.png"]
   ```

   The mocked Codex correctly attaches the image and draws `[Image #1]`. `codexBoxMatch` returns `holds` for the expected image marker. The next guard nevertheless requires a clipped box and a suffix of the empty text.

   Result: `CODEX_BOX_CHANGED`. The only write is the quoted image-path paste; no Enter is pressed.

   **Fix:** distinguish an image-marker match from a text-tail match. Verify the expected attachment state separately. Include image-only sends in unconfirmed-result handling too, which currently has `trimmed` conditions.

4. **Should-fix: an older confirmation overwrites a newer send’s error.**

   **File/function:** [C:\dev\harbor\app\src\main\session-send.js:2940](C:/dev/harbor/app/src/main/session-send.js:2940), `reconcileDelivery`’s new `onConfirmed` callback.

   Reproduced:

   1. Send A becomes unconfirmed and starts transcript polling.
   2. Send B, `✓/exit`, is correctly refused with `CODEX_TEXT_UNSENDABLE`.
   3. A’s genuine user-message record arrives.
   4. A’s callback emits `sent`, replacing B’s current error.

   The resulting status sequence ends:

   ```text
   checking that Codex took it
   error: ...your message would start with "/"...
   sent
   ```

   **Fix:** bind confirmation callbacks to a send ID/status sequence and update the displayed status only if that attempt still owns it. Apply the same protection to confirmation errors. The existing late-delivery watcher already demonstrates the required sequence check.

5. **Should-fix: normalization disclosure still omits some actual changes.**

   **File/function:** [C:\dev\harbor\app\src\main\session-send.js:527](C:/dev/harbor/app/src/main/session-send.js:527), `codexSafeText`; status construction at line 2792.

   Two concrete inputs:

   ```js
   "Open C:\\dev\\proof\\a\u00a0b.txt"
   "Open C:\\dev\\proof\\cafe\u0301.txt"
   ```

   They become a normal-space filename and an NFC-composed filename respectively. Both return:

   ```js
   dropped: []
   mapped: []
   ```

   The status is the incomplete sentence:

   ```text
   Codex cannot show some characters, so this went
   ```

   Thus the stated “every change” disclosure does not cover space conversion or NFC composition. These can change exact path characters or string values.

   **Fix:** record these transformations too, using readable names/code points for invisible characters. Handle NFC composition separately from the claim that Codex cannot display a character. I am treating the broader lossy-conversion policy as the product decision you explicitly retained; this finding concerns changes that its promised disclosure still misses.

6. **Should-fix: a wholly skipped sub-agent history is labelled “Starting,” without the partial-count qualification.**

   **File/function:** [C:\dev\harbor\app\src\renderer\stage\turn-meta.cjs:98](C:/dev/harbor/app/src/renderer/stage/turn-meta.cjs:98), `subagentLabel`.

   After the reader skips its first unread stretch exceeding 32 MiB, it produces:

   ```js
   {
     running: true,
     quiet: false,
     finished: false,
     tools: 0,
     now: null,
     partial: true
   }
   ```

   The label is `Starting`. The partial marker is bypassed when the observed count is zero, even though the skipped history may contain substantial completed work. A finished zero-observed-count partial history produces no label.

   **Fix:** render an explicit incomplete-history label when `partial` is true and the observed count is zero. Keep the existing `N+` treatment for positive observed counts.

7. **Nit: metadata first read without `toolUseId` is negatively cached forever.**

   **File/function:** [C:\dev\harbor\app\src\main\providers\transcript.js:1838](C:/dev/harbor/app/src/main/providers/transcript.js:1838), `readSubagentProgress`.

   Constructed sequence:

   ```json
   {"finished":false}
   ```

   is read first. The same metadata file later becomes:

   ```json
   {"toolUseId":"t","finished":false}
   ```

   where `t` names a visible delegation. Progress remains absent because the cached null association is never reread.

   **Fix:** cache validated associations; retry incomplete metadata on change or with a bounded interval. I reproduced this with mocked files, not with an observed CLI metadata-write sequence, so I consider it defensive rather than a demonstrated common failure.

The round-3 findings now stand as follows:

| Round-3 item | Round-4 assessment |
|---|---|
| 1. Public `sent` after unconfirmed Enter | The no-transcript case now correctly throws `CODEX_UNCONFIRMED`. The transcript-backed route still has finding 2 above. |
| 2. Short incomplete suffix accepted | The original short Codex and Claude counterexamples are closed. The real clipped Codex fixture passes. |
| 3. Transcript whitespace mismatch | Closed in the typer: `print('a b')` no longer matches `print('ab')`. |
| 4. Same-process replacement | Default opaque retries are now refused by the typer. Explicit `--enter-only` transfers the continuity judgment to the caller. Harbor retains the documented risk. |
| 5. Silent value changes | Twin substitutions are now disclosed. Space conversion and NFC changes remain undisclosed as described above. |
| 6. Missing/stale Claude session identity | Retained limitation, correctly resulting in unconfirmed delivery rather than a false success. |
| 7. Fresh `Try "..."` draft | Retained limitation: the draft can be appended to before the later guard refuses Enter. It is not fixed, but the refusal remains honest. |
| 8. Quiet agents stop following | Closed in my probes: quiet agents resumed progress after new writes; missing transcripts aged into quiet state. |
| 9. Parser reset/child truncation | Closed in my probes: parser state rebuilt and shrunk child files were recounted. |
| 10. Unbounded/repeated progress work | Evicted delegations are now bounded with the 240 visible blocks. Three polls over 500 unmatched metadata files performed only three active-agent metadata reads. Parsing now yields. The zero-count partial label remains open. |
| 11. Unanswered transcript opens unlogged | Closed: the canonical unresolved tile produced `window-unbound` with `neverOpened: true`. |
| 12. Closed window called bound | Closed: removing that tile produced `window-left`. |

For Harbor’s retained opaque retry, something short of an input counter is still worthwhile: require an explicit “submit the earlier draft” action tied to the failed attempt, record pane/process identity, and invalidate the record on any observed empty box, changed draft, session change, or newer successful send. That reduces accidental reuse and makes the user’s intent clearer. It still cannot prove that an unseen same-size replacement did not occur; an ordinary repeat send is not equivalent to that proof.

I would retain the startup exception only after tightening its layout and transition checks. The measured successful startup shape is useful evidence, but the current broad phrase search is not a reliable submission boundary.