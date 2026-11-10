# Codex thread-following, round 6

Committed on cli-1109-codex as f369ed35 and d7e2779f32eaf014f91507076b5e0b868eaff577. The worktree is clean. The round-six delta passes the requested read-only apply check against the designated port worktree. No changes were applied there, and nothing was installed or pushed.

The code and targeted tests pass. No Codex config file was edited by this job (see the configuration note below).

## Window recovery

Inconclusive frames and failed reads no longer become permanently handled titles. The existing full timer permits a new screen read every five seconds through the first minute (13 attempts including the initial read), then every 30 seconds while evidence remains inconclusive. History events and pane chatter do not turn those waits into tight polling. A conclusive child/side view stays cached until its title changes.

An ordinary CODEX_THREAD_VIEW_CHANGED refusal now asks the bridge to clear that pane's title/screen evidence and run a fresh title pass. Both desktop and phone composition roots wire that callback. It waits for an in-flight linker pass to finish before invalidating the evidence. The refused request writes nothing and keeps its text; when the screen proves a writable composer, the window re-keys in that fresh pass and the next send can use the pane.

The first ten regression cases failed against c4a9b082. They include a first noprompt frame followed by a writer, three failed reads followed by success, a minute of bounded retry, and refusal-driven recovery. Red evidence: _astra/round6/red-codex-thread-recovery.test.js.log. Final suite evidence: _astra/round6/final-codex-thread-recovery.test.js.log.

The native refusal drive used scratch Codex 0.167.0 through the real launcher, isolated keeper, bridge and send engine. A bridge screen read was deliberately held at an inconclusive redraw while the real CLI had reached its new composer. The first send refused with zero writes, refreshed the title, and produced the provisional route. The next Harbor send reached the new rollout exactly once. This is fault injection through the real path, not a claim that a spontaneous redraw race was captured. Evidence: _astra/round6/refusal-final/refusal.json and _astra/round6/refusal-final/refusal-next-first-send-proof.json.

Native /new, n and c first-message drives passed again. /new and n each used one paste plus Enter; c submitted the exact prepared continuation with one Enter and no retyping. Each parsed rollout contains the requested first user message once. Follow-ups, /fork and picker resume also passed. Evidence: _astra/round6/navigation-final/new-first-send-proof.json, _astra/round6/recovery-final/n-first-send-proof.json and _astra/round6/recovery-final/c-first-send-proof.json.

## Correct window ownership

A previous id is not emitted as replacesKey when another live pane holds it through raw agent_session or a link. Ownership is checked again immediately before publication, because annotation and metadata persistence can yield. Route cleanup still removes obsolete aliases for the transitioning pane without deleting another pane's route.

The p/q restart regression passes. The shipped renderer retained both windows, preserved q's root-A draft and p's new-chat draft, and dispatched q's Send to q. A second test adds q while p is awaiting metadata persistence; it failed before the final publication check and passes after it. Evidence: _astra/round6/restart/before.json, _astra/round6/restart/after.json, _astra/round6/window-proof.json, _astra/round6/restart-after-q.png, _astra/round6/restart-after-p.png and _astra/round6/red-late-owner-codex-thread-recovery.test.js.log.

## Writer retry and title-less panes

A cached writer notice is re-read by the full pass no faster than once per 30 seconds. A clock-controlled test clears the notice without changing the title and verifies that the pane binds on the next eligible read. The prior permanent-read-count assertion was replaced with bounded-clock coverage. A native r-retry cycle was not separately driven; this behavior is proved by the real linker with controlled screen/clock inputs.

apply() preserves native identities for Cursor and old-keeper Codex panes without codex_title, including duplicates. Title-aware duplicate/writer guards remain active for the new Codex panes. Both title-less providers have regression coverage.

## Exact native draft safety

When normalization is bypassed because an exact native draft is already present, deliver carries an Enter-only requirement. It checks the exact draft at the composer gate, again before the typing branch and immediately before Enter. If the draft disappeared or changed, it refuses with Your text is kept. It never falls back to typing the un-normalized text.

The disappearing-draft spec failed on c4a9b082, where raw keyboard text reached the boundary, and now records zero writes. The real c continuation remains a one-Enter success. These checks cannot make the terminal and another external input source atomic, but the implementation no longer has a raw-text fallback after relying on an exact draft.

## Startup, widths, flapping and lineage

Matching durable facts suppress startup metadata rewrites and launch/link events for already-named real-id panes. A separate route-restore event hydrates desktop and phone send routing without renaming windows or scheduling a history refresh. Five native ordinary-resume checkpoints had zero new link events, one route restoration and unchanged metadata-file hashes. The cold duplicate restart also added no launch event or metadata rewrite. Resident cache setup, route notifications and normal sidebar publication remain; missing or changed facts still use the normal metadata write path. General cross-process metadata merging was not redesigned.

Actual subagent and /side captures at 80 columns retained their distinguishing prompt/footer markers. Both were recognized. Parent-directed and provisional-pane sends refused with zero writes; parent sends resumed after returning. A provisional send now also requires a complete recognizable writable composer, so an incomplete or otherwise unclassifiable frame refuses instead of treating absence of a marker as proof. Evidence: _astra/round6/child-final80/subagent-view.txt, _astra/round6/child-final80/child-provisional-send.json, _astra/round6/side-final80/side-reply.txt and _astra/round6/side-final80/side-provisional-send.json. Narrower widths and custom footer layouts were not driven.

After a valid prefix, null overlays are ignored. Genuine title changes update the keeper's in-memory annotation guard immediately, while title-triggered state writes are coalesced to one pending flush per event-loop turn. The flapping test feeds 10,000 null/id cycles and 1,000 valid-id alternations: null/id chatter produces one notification, and valid changes produce one persist for the queued turn. There is no polling timer or added terminal.onData work; the onData block is unchanged from c4a9b082.

A fresh pane with a unique indexed row can now bind despite null or unlisted lineage when the screen positively proves a writable root composer. Child/guardian lineage and child/side screens still veto that inference. Null and custom lineage cases pass.

Under an old main process, a mismatching inferred id can still produce an annotation error on each five-second linker tick until main is reloaded; the keeper continues to refuse that unsafe annotation.

Consolidated native assertions are in _astra/round6/evidence-summary.json. The native keeper runs used system Node v24.19.0 and local deterministic Responses fixtures, with zero paid turns and no copied credentials.

## Validation and delivery

Targeted suites ran sequentially, one filter per command: **332 passed, zero failed, zero skipped, zero cancelled**. The 13 filters cover thread recovery, thread following, ordinary panes, title identity, provider keeper/link/history/events, sidebar bridge/boot, both server provider integrations and session-send. No full suite was run. The coordinator-owned id-upgrade test and other listed files were left unchanged. Summary and complete logs: _astra/round6/test-summary.json and the sibling final logs.

The application build passed in 10.44 seconds with the existing dependency-directive and large-chunk warnings. Build log: _astra/round6/build.log.

The renderer replay passed 28 single-window states and the two-window p/q restart sequence, with zero page errors. Thirty-one screenshots were inspected, including the restart and refusal-recovery states at full size. It used the shipped renderer/preload and recorded bridge/link events, with mocked IPC and final probe rollouts. It is not an installed-desktop run, and earlier phase screenshots can contain later messages from those final files. Results: _astra/round6/window-proof.json.

The final delta is _astra/round6/delta.patch, generated from git diff c4a9b082 HEAD -- app bin with coordinator-owned files excluded. The read-only apply check against the designated port worktree returned exit 0. No patch was applied there and no file was written there. Evidence: _astra/round6/apply-check.json. Protected-file, readiness-function and onData comparisons are in _astra/round6/protected-checks.json.

The real send log was not read or measured. Every new sender spec injects a scratch sendLogFile. Generated data, test homes, daemon stores, npm cache, browser profiles and TEMP/TMP stayed inside the worktree. Only owned probe processes were stopped.

## Configuration note

The three Codex config hashes matched the briefing at every checkpoint of this job's own work. During final verification a separate, deliberate configuration change added `model_auto_compact_token_limit = 500000` to all three; this job did not write them. Round 7 checked against that new baseline and matched.

Independent review, integration and verification after loading the reviewed main/daemon remain pending. The final installed desktop and physical phone were not driven, and the coordinator's full gate was not rerun here.
