Most fixes are confirmed, but three issues remain. All **48 focused tests passed**; I would fix the two P2 findings before landing.

1. **P2: Folder inference still accepts a parent that started after the worker.**  
   [C:\dev\harbor\app\src\shared\team-model.cjs:581](C:/dev/harbor/app/src/shared/team-model.cjs:581)

   The comparison still allows `createdMs <= startedMs + 5000`. I reproduced a worker starting at 12:00:00 and the sole replacement agent starting at 12:00:03: the older worker is assigned to the replacement agent.

   The shared-folder and missing-timestamp guards now work, but chronology remains weaker than the stated rule.

   **Recommended fix:** Remove the five-second allowance and add this boundary case. If the tolerance is intentional, document it as an inference policy; it does not establish that the agent started first.

2. **P2: Pinned sub-worker statuses use today’s clock, despite expiry using the pinned moment.**  
   [C:\dev\harbor\app\src\renderer\orchestration\TeamChart.jsx:400](C:/dev/harbor/app/src/renderer/orchestration/TeamChart.jsx:400) and [C:\dev\harbor\app\src\renderer\orchestration\TeamChart.jsx:456](C:/dev/harbor/app/src/renderer/orchestration/TeamChart.jsx:456)

   `expireSubWorkers()` receives `pinnedMs`, but `ctx.now`, loose trays, and the drawer still receive live `now`.

   A worker active one minute before capture remains in the pinned tray, correctly, but opening that snapshot an hour later changes its captured “Working” state to “Last active 1h 1m ago.” Running counts change too. The snapshot combines two different moments.

   **Recommended fix:** Define one display timestamp, `pinView ? pinView.pinnedMs : now`, and pass it consistently to expiry, cards, trays, counts, and the drawer. Test the rendered status and count of an older pin, not only retained entries.

3. **P3: A parent kept expanded by recent sub-workers never folds back on the renderer clock.**  
   [C:\dev\harbor\app\src\renderer\orchestration\team-text.cjs:73](C:/dev/harbor/app/src/renderer/orchestration/team-text.cjs:73)

   `expireSubWorkers()` updates entries and loose-only frames but preserves `roots` and `idle` unchanged.

   I reproduced a parent idle for an hour, kept as a full card by a child active one minute ago. After advancing 31 minutes without another main-process event, the renderer still puts the parent in `roots`; deriving the same inputs at that time correctly puts it in `idle`.

   **Recommended fix:** Reevaluate the sub-worker-dependent idle-fold decision on the existing renderer clock. Preserve full cards when children, warnings, or other qualifying evidence require them.

What I confirmed fixed, using the original reproductions:

- **Finding 1, except chronology:** Ended recorded parents remain loose; shared folders remain ambiguous even when one agent started later; unknown child or parent start times prevent inference.
- **Finding 2:** Completed launch entries resolve to the nearer Codex parent through the same rule as live cards.
- **Finding 3:** A fresh leaf resolves through an intermediate older than six hours.
- **Finding 4:** Rail promotion and unpromotion take effect without `history-refreshed`. The new provider test also proves delegation-link changes follow `update`.
- **Finding 5, for entry/frame expiry:** Six-hour tray expiry and 30-minute loose-only frame expiry work without a main-process event.
- **Finding 6:** Stale `working` flags and old open-tool evidence no longer count as running; model and renderer agree.
- **Finding 7:** Pre-tray pins retain their helpers through normalization.
- **Finding 8:** The drive now requires the requested conversation tile and its read-only flag. “NOT CHECKED” accurately identifies missing live test data. I accept that limitation; I did not execute the drive.

The performance changes do not present a demonstrated blocker. In an in-memory provider benchmark with 2,000 recent workers:

| History rows | Full recompute median | 95th percentile |
|---:|---:|---:|
| 10,000 | 4.0 ms | 6.3 ms |
| 50,000 | 6.4 ms | 9.8 ms |

Repeated unchanged recomputes produced only the initial push. These are synthetic measurements, not live-machine profiling.

The new `team` identity every 30 seconds causes filtering, derived collections, and measurement-observer setup to rerun. It does **not** itself trigger Fit: Fit depends on the layout key and size, while unchanged geometry skips routing. Preserving object identity when nothing expires would be an optimization, not a required fix.

The doctrine bullet mostly matches the implementation. Its “agent’s first” claim conflicts with the five-second allowance, and “a pin uses its own moment” currently describes expiry but not status rendering.

**I am not yet satisfied this is safe to land unchanged.** The remaining fixes are narrow. No repository files were edited, and I did not launch Harbor, run the drive, or use a browser.