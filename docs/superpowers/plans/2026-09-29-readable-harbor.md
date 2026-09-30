# Harbor Reading Style Implementation Plan

**Goal:** Make Harbor comfortable to read with white text and a Codex-inspired dark interface.
**Architecture:** Add a desktop-only stylesheet after the existing structural stylesheet. Keep React behavior and provider data untouched.
**Tech Stack:** Electron, React, Vite, CSS.
**Spec:** ../specs/2026-09-29-readable-harbor-design.md

## Constraints and review focus
Preserve sidebar virtualization heights, window header density handling, semantic
status colors, composer serialization, and horizontal scrolling for code/tables.
Do not dim text in inactive tiles. Test both wide and narrow reading surfaces.

## Task 1: Presentation and validation
- [x] Add src/renderer/reading-theme.css and import from index.jsx.
- [x] Render real Markdown and conversation markup with synthetic data; inspect screenshot and overflow at wide and narrow sizes.
- [x] Run npm run build and the bounded CI-selected test families.
- [x] Review the diff and prepare a Mac bundle preserving existing native dependencies.
- [x] Install with rollback protection and verify installed content and rendering.

No new unit tests are required for this reversible styling change. Use rendered
checks and existing tests. Execute directly in the clean existing Mac checkout.

## Verification record

- Vite production build passed.
- Renderer suite: 573 passed, 0 failed.
- Isolated Electron preview: 15px / 25.5px line height, rgb(245,245,245),
  760px reading width; zero column overflow. At 320px tile width, code and
  tables scroll internally, Copy remains visible, and resting tiles have no filter.
- Independent read-only review: no actionable regressions.
- Broad CI-selected gate: parallel phase reported 1,903 passed, 11 failed,
  7 skipped; the serial PTY phase reached the 180-second deadline. Failures
  include filesystem-write simulation, transcript corpus, tailnet identity,
  and Windows-path tests. This is not a fully green broad gate.
- Installed /Applications/Harbor.app; all delivered renderer asset hashes
  matched staging. Runtime and provider files are unchanged.
- Rollback: /Applications/.Harbor-before-reading-20260929.app.
- Relaunched installed app and inspected its live UI: neutral dark surfaces,
  brighter sidebar text, white conversation prose, and preserved two-pane layout.

Ruling: The requested native system font takes precedence over the generic
frontend skill's preference for unusual fonts. No behavior tests were added for
this reversible stylesheet change; existing renderer tests and rendered checks
cover the intended validation. No push or publication was performed.
