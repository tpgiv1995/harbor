All three round-two findings are fixed. **No findings remain open in the reviewed scope.**

Confirmed fixes:

- **Folder chronology:** [C:\dev\harbor\app\src\shared\team-model.cjs:581](C:/dev/harbor/app/src/shared/team-model.cjs:581) rejects a parent starting even one millisecond after the worker. Equal timestamps still permit attribution. My three-second replacement-agent reproduction now stays loose.
- **Pinned clock:** [C:\dev\harbor\app\src\renderer\orchestration\TeamChart.jsx:360](C:/dev/harbor/app/src/renderer/orchestration/TeamChart.jsx:360) supplies one timestamp throughout the chart. Expiry, attached and loose trays, counts, cards, warnings, chips, ended entries, and the drawer use it. The pinned worker retains its captured “Working” state and running count.
- **Idle folding:** [C:\dev\harbor\app\src\renderer\orchestration\team-text.cjs:69](C:/dev/harbor/app/src/renderer/orchestration/team-text.cjs:69) now folds the previously stuck parent after its child becomes inactive, without requiring another main-process event.

I also attacked the new fold:

- **480 combinations** of status, activity age, sub-worker age, live children, and warnings agreed with the model’s root/idle membership at the same instant.
- Live children and warnings prevent folding. Working and tool states remain full cards.
- Repeated application creates no duplicate idle entries and leaves the original model unchanged.
- Project, provider, and state filters retain the correct folded member.
- Evaluating the shipped layout-key expression showed that a fold changes the key, allowing Fit to rerun; subsequent unchanged ticks keep the key stable.
- The existing drawer selection survives because folding retains the member in the model.

**47 tests passed** across the model, renderer-text, and layout test files. The added logic tests are useful; the pinned-clock wiring was checked directly in the component. The updated doctrine bullet matches these three changes.

I made no file changes and did not run the full suite, drive, Harbor, or a browser. Visual verification remains the coordinator’s previously reported drive evidence.

**I am now satisfied this is safe to land within the reviewed scope.**