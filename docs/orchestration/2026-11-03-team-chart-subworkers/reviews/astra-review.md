I would not land this yet. The 40 focused tests pass, but the change has reproducible attribution and stale-state defects.

1. **P2: Folder inference can override a known parent or accept missing evidence.**  
   [C:\dev\harbor\app\src\shared\team-model.cjs:559](C:/dev/harbor/app/src/shared/team-model.cjs:559)

   A launch record names `ended-parent` as the parent of `run`. That parent has ended, while another agent remains in the same folder. Because `row.parentId` is empty, the launch lookup fails to find a live parent and folder inference assigns `run` to the unrelated agent. I reproduced this.

   The same predicate accepts unknown child or parent start times. It also filters candidates by age *before* checking uniqueness, so two live agents sharing a folder can yield one inferred parent when the second started later. That contradicts the documented shared-folder exclusion.

   **Fix:** Treat any recorded parent link, including launch evidence, as blocking folder inference when unresolved. Require exactly one live member in the folder before testing chronology, and require known start times.

2. **P2: Finished runs can move from the correct Codex parent to the wrong Claude parent.**  
   [C:\dev\harbor\app\src\shared\team-model.cjs:555](C:/dev/harbor/app/src/shared/team-model.cjs:555)

   Existing `launchParent()` handles a Codex shell inheriting an outer Claude session ID. The new tray lookup instead uses the raw `childOfLaunch` map.

   With `parents.claude = outer-claude`, `parents.codex = inner-codex`, and the Codex thread descended from Claude, I reproduced the live launch reporting to `inner-codex`, then its completed sub-session appearing under `outer-claude`.

   **Fix:** Build tray launch attribution through the same resolved `launchParent()` logic used for live cards.

3. **P2: Filtering history before resolving ancestry breaks valid nested workers.**  
   [C:\dev\harbor\app\src\main\providers\team.js:84](C:/dev/harbor/app/src/main/providers/team.js:84) and [C:\dev\harbor\app\src\shared\team-model.cjs:537](C:/dev/harbor/app/src/shared/team-model.cjs:537)

   Consider `live root → intermediate sub-agent → fresh leaf`. The intermediate last wrote seven hours ago; the leaf wrote one minute ago. `recentSubSessions()` discards the intermediate, so the model cannot walk its parent link. I reproduced the leaf appearing loose despite its history containing an exact chain to the live root.

   **Fix:** Keep a compact ancestry map independently of the six-hour display window. Filter displayed workers by age after resolving ancestry.

4. **P2: Rail promotions and delegation changes do not invalidate the sub-session cache.**  
   [C:\dev\harbor\app\src\main\providers\team.js:619](C:/dev/harbor/app/src/main/providers/team.js:619)

   `onBridgeUpdate()` recomputes from cached `subSessions`. However, rail promotion and delegation-link changes can mutate history rows and emit `update` without emitting `history-refreshed`.

   In an in-memory provider reproduction, promoting a helper and emitting `update` left it on the chart. It disappeared only after `history-refreshed`. Unpromotion can similarly leave a session absent, and changed parent links can leave old attribution displayed.

   **Fix:** Invalidate the relevant cached rows when classification or lineage changes. Use an explicit bridge event or revision; no provider polling clock is needed.

5. **P2: Time-window expiry depends on unrelated input events.**  
   [C:\dev\harbor\app\src\shared\team-model.cjs:694](C:/dev/harbor/app/src/shared/team-model.cjs:694) and [C:\dev\harbor\app\src\renderer\orchestration\TeamChart.jsx:400](C:/dev/harbor/app/src/renderer/orchestration/TeamChart.jsx:400)

   A loose-only project appears with a fresh worker. If inputs then remain unchanged, crossing 30 minutes does not remove the frame: the renderer clock updates labels, while project eligibility remains in the cached model. The six-hour worker cutoff has the same dependency.

   I reproduced a loose frame remaining after advancing time past its deadline, then disappearing when explicitly recomputed.

   **Fix:** Apply display expiry using the existing renderer clock, with pinned snapshots evaluated at their captured time. Preserve the event-driven provider.

6. **P2: A stale Task helper can remain “Working” throughout its retention window.**  
   [C:\dev\harbor\app\src\renderer\orchestration\team-text.cjs:40](C:/dev/harbor/app/src/renderer/orchestration/team-text.cjs:40) and [C:\dev\harbor\app\src\shared\team-model.cjs:156](C:/dev/harbor/app/src/shared/team-model.cjs:156)

   A helper interrupted before its completion record can retain `working: true`, with no open tool and no subsequent writes. Both functions treat that boolean as permanently active. An hour-old example still returned `Working`; it also sorts ahead of inactive workers and keeps its parent expanded.

   **Fix:** Require fresh activity for the working boolean, consistently in the model and renderer. Preserve an explicitly reported open tool as separate evidence. Add a test that advances time while leaving the helper facts unchanged.

7. **P3: Older pins silently lose their saved helpers.**  
   [C:\dev\harbor\app\src\renderer\orchestration\AgentDrawer.jsx:118](C:/dev/harbor/app/src/renderer/orchestration/AgentDrawer.jsx:118)

   Pre-change snapshots contain `member.helpers` but no `member.subWorkers`. They still load, but removing the old Helpers section means their recorded helpers appear neither in trays nor in the drawer.

   **Fix:** Normalize older snapshots in memory, or fall back to converting `helpers` when `subWorkers` is absent. Test a pre-change snapshot explicitly.

8. **P3: The drive can pass without opening the requested conversation.**  
   [C:\dev\harbor\app\scripts\drive-team-chart-win.js:514](C:/dev/harbor/app/scripts/drive-team-chart-win.js:514)

   `opened.hasSession || !opened.chart` passes whenever the chart disappears. Opening the wrong session, or merely navigating away from Orch, satisfies it. The test also skips this action when live data supplies no suitable worker.

   **Fix:** Require the requested session ID in an actual conversation tile, and make the interaction deterministic with a fixture. Assert the read-only state as well.

What I checked and found sound:

- All **40 tests** in the four authorized test files passed. The new assertions exercise changed model behavior, but omit the cases above; the provider tests cover extraction rather than cache invalidation.
- Unchanged provider recomputes produced **zero additional pushes** in my in-memory check. `builtMs` is excluded from comparison. A synthetic 10,000-row extraction plus serialization took approximately **2.6 ms median**, so I found no demonstrated cost blocker.
- A launch-keyed member subsequently bound to a session correctly suppresses its duplicate mini card and receives a nested worker through its session ID.
- Unit measurement, `portY`, tray-size layout keys, and the focused router tests are consistent with the intended geometry.
- Copy and open controls are sibling buttons, avoiding nested buttons. Native keyboard activation and the controlled `<details>` wiring look sound.
- No new animations or provider polling clock were introduced. The folded history list is conditionally unmounted.
- The production caller supplies `onOpenSession`. Without it, attached mini cards fall back to the parent drawer and loose cards do nothing; that is a caller-contract limitation, not a demonstrated production failure.

The 30-minute cutoff for loose-only frames, hiding loose workers under member filters, and folding older attached workers into the idle row are **product judgment calls**, not defects by themselves. They intentionally make the chart less complete than the six-hour history. The documentation largely describes those choices correctly, but overstates the attribution guarantees identified above.

Confidence is high in the reproduced logic defects. Visual confidence is limited to code and geometry-test inspection: I did not launch Harbor, rerun the drive, or use a browser. I made no file changes.