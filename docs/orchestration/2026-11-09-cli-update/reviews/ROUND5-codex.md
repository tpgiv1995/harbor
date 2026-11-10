# Codex thread-following, round 5

Implemented the round-five review on branch `cli-1109-codex`. The final feature patch targets `2cba4c4`, keeps that revision's readiness changes, and excludes the superseded round-two, round-three and round-four reports. Nothing was installed, pushed or written to the live checkout. Evidence paths below are relative to the repository and refer to ignored scratch material.

## 1. Test log isolation

Every spec in this change that builds createSessionSend receives its own temporary send log through `app/test/support/send-log-fixture.cjs`. Under NODE_TEST_CONTEXT, session-send writes no send log when sendLogFile was omitted, and its implicit screen captures are suppressed or placed beside the injected log. An explicitly supplied diagnostic destination still works. HARBOR_NO_SEND_LOG is not used by the test runner, because `session-send.test.js` reads its logs back.

The floor test substitutes a fake home inside its fixture and exercises both cases: omission must leave the default-home log absent, and injection must create a nonempty log. It fails on the previous implementation and passes on the fix. The runner also places HOME, USERPROFILE, app-data directories, config, context, daemon store, npm cache and TEMP/TMP inside scratch, and the native probes inject their own send logs. The integration owner re-ran all 13 changed suites with HOME and USERPROFILE pointed at an empty scratch folder, and it stayed empty.

## 2. Ordinary binding fallbacks

The linker uses a matching keeper identity or launch-argv UUID without requiring indexed lineage. This covers an unloaded index, unmigrated/null lineage, unusual/custom source metadata and ordinary resume. A temporarily unavailable screen does not invalidate that matching identity; positive writer-lock or child/side evidence still vetoes it. apply() retains a keeper identity that agrees with the prefix before the first history listing. An absent/unrecognized prefix follows the existing argv/history path on the full timer pass; it no longer strands the pane in a title-only branch. Known duplicate or writer-locked panes remain excluded.

Regression cases cover both keeper and argv evidence, missing/unknown/custom lineage, preservation on the first apply, and null-prefix fallback through process discovery. They failed against the previous implementation. No UUID is invented from a truncated title, and a recognized different prefix never falls back to the original resume argv.

## 3. New-chat sends and remaining refusals

For an unindexed changed prefix, main reads the actual screen. If it proves an ordinary writable composer, the linker re-keys the window to its pane id. That provisional id is not persisted as a provider identity. The first Harbor message can then create the new rollout, after which the linker annotates the real UUID, records home/path and replaces the provisional key. The old route is removed at the transition and the window draft is preserved.

A null/unrecognized prefix no longer refuses a normal send. A recognized different view can still refuse a message addressed to the old root until the window follows it. Child and side views do not become sendable provisional roots. Their refusal text names the actual way back and retains "Your text is kept": Ctrl+C closes the side chat; /subagents followed by Main returns from a child.

The provider-continuation draft contains native punctuation. When the requested message exactly matches text already displayed in Codex's composer, the sender preserves that text and submits with Enter. Normalizing it first would break the existing exact-match safeguard even though no keyboard text needed to be sent. A different or opaque draft is still protected by the existing busy-composer guard; this change does not silently replace user text.

The following were driven through scratch Codex 0.167.0, the real bin/ai launcher, real isolated daemon/keeper/linker/bridge and real createSessionSend, using system Node v24.19.0 and a loopback Responses fixture:

| Transition | Actual first Harbor send | Rollout result |
| --- | --- | --- |
| /new | One bracketed paste and Enter to the provisional pane | The requested first user message occurs exactly once in the new root. |
| n | One bracketed paste and Enter to the provisional pane | The requested first user message occurs exactly once in the new root. |
| c | One Enter, with no retyping, for the exact native continuation draft | That complete continuation message occurs exactly once in the new root. |

The evidence includes the key writes, old/new identities, and a count made by parsing the actual rollout through TranscriptParser. Follow-up messages also reached the bound new roots. No raw-terminal typing was used to create the /new or n first messages, and no raw-terminal Enter submitted c's continuation draft.

First-message evidence: `_astra/round5/navigation/new-first-send-proof.json`, `_astra/round5/recovery/n-first-send-proof.json`, and `_astra/round5/recovery/c-first-send-proof.json`. Their adjacent before/after phase JSON and terminal captures show provisional re-keying and subsequent real binding. Fresh launch, ordinary resume, /fork and picker resume also passed in `_astra/round5/navigation`.

Subagent and /side drives retained the parent window, refused parent-directed sends with zero writes, and accepted parent follow-ups after return. Evidence: `_astra/round5/child` and `_astra/round5/side`.

View markers must belong to the current prompt or the final status footer. Quoted markers in historical conversation text do not classify an ordinary composer as a child or side view. Positive/negative specs and replay of all four captured view/return screens cover that distinction; results are in `_astra/round5/view-markers.json`.

## 4. Paths and port contents

ROUND4-codex.md was rewritten with repository-relative references and an explicit correction of its incomplete outside-write claim. The doctrine now describes the final behavior using repository-relative paths and replaces the obsolete title-resolver notes. The port excludes ROUND2-codex.md, ROUND3-codex.md and ROUND4-codex.md entirely, along with earlier commit messages. The new commit message and doctrine insertion contain no machine-specific checkout or profile paths. A scan of added patch lines checks the forbidden path/profile patterns.

Port files:

- `_astra/round5/thread-following-feature.patch`
- `_astra/round5/port-manifest.json`
- `_astra/round5/doctrine-to-insert.md`, for insertion by hand

The feature patch was checked and applied to an isolated copy of exact base `2cba4c4`. Its readiness function, resume readiness call, 90-second blank-screen budget and PROVIDER_NEVER_DREW guard were compared with that base and preserved. The live checkout and its private overlay were not modified. Use a fresh integration commit message; do not replay the earlier branch commits or their messages.

## 5. Linker frequency and cold duplicates

Pane events and history refreshes now call resolveTitlesNow, which first checks whether any title pane has new unresolved evidence. That pass uses resident metadata and bounded screen reads; it never enters legacy process discovery or reads history.jsonl. The full linker pass stays on its existing timer. A test drives 40 pane events and history refreshes and verifies zero full passes; a separate check confirms the explicit full/timer path still performs legacy discovery.

With no existing links and multiple panes showing the same prefix, main binds neither until exactly one screen positively proves a writable composer. Merely failing to find a writer notice is insufficient. Transcript-mode or unreadable screens cannot win by iteration order. Bounded, spaced rereads allow initially ambiguous screens to settle without requiring a title change. After a winner exists, the second pane cannot take its route. apply() does not turn a known writer-locked pane into a live root through the fallback.

The real two-pane drive also restarted the bridge while both panes remained alive. Both the warm and cold cases selected the original writer, and a send offered with the second pane wrote only through the writer route. Evidence: `_astra/round5/duplicate/duplicate-cold.json` and `_astra/round5/duplicate/duplicate-send.json`. Synthetic cases cover two apparently writable screens, two transcript screens, one proven writer, and later settling from ambiguity.

The keeper claim is now stated accurately: it performs one bounded persist() per normalized prefix change. It performs no identity lookup, SQLite access or retry polling, and adds no terminal.onData work. It is not a zero-IO component.

## Validation

Targeted commands ran sequentially with one filter per command. Worktree result: **467 tests, 463 passed, zero failed, four skipped, zero cancelled**. The skips are the existing Windows live-Claude first-run exclusion, the unported Windows bin integration and two installed-Claude PATH checks. The real Windows bin/ai launch was separately exercised above. No full suite was run.

After applying the patch to `2cba4c4`, four targeted suites passed again: ordinary-pane 12, thread-following 10, sidebar-bridge 8 and that base revision's session-send suite 238. **268 passed, zero failed or skipped.** These are a separate port validation, not extra unique coverage added to the worktree count. Summaries and full logs: `_astra/round5/final-test-summary.json` and `_astra/round5/ported-test-summary.json`.

The application build passed in 16.60 seconds. Existing dependency-directive and large-chunk warnings remain. Build log: `_astra/round5/build.log`.

The shipped renderer and actual preload replayed the real bridge models, link-registry updates and launch events in headless Chromium. All 24 states retained the expected single window and exact draft through the re-key operations, with no page errors. The provisional states show a live fresh session with an ordinary Send button. Clicking that button in the renderer produced a pane-addressed send payload with no resumeOnly request. The actual backend send/rollout proof is the native drive above. Screenshots were visually inspected; the three provisional states were inspected at full size. `_astra/round5/window-proof.json` records both state assertions and Send dispatch payloads.

An earlier renderer replay omitted link-registry updates and therefore showed a past-session fallback. That harness omission was corrected and the replay rerun before accepting the visual result. The final replay uses mocked IPC and final probe rollouts, so it is not a simultaneous installed-desktop run, and an earlier phase screenshot can contain messages written later in the probe.

All three real config hashes match their briefing values. The after-test evidence is in `_astra/round5/safety-after.json`. Probe and test homes, logs, browser profiles, daemon stores, npm cache, TEMP/TMP and generated files were placed inside the worktree. No credential was copied and no paid model turn was used. Only owned probe processes were stopped; no real daemon or installed CLI was changed.

## Remaining limits

For c, the proved first send is the exact prepared continuation draft. Sending different text while Codex already holds that draft remains subject to the ordinary busy-composer guard. Guardian and unavailable-lineage edge cases are covered synthetically; no live guardian was spawned. Fork inheritance keeps its byte/depth bounds and compressed-parent limitation. No physical-phone or installed-desktop run was performed. Independent review, final integration and post-load verification remain with the integration owner.
