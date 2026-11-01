# Harbor Mobile quality-of-life batch (2026-10-31)

Branch `mobile-qol-2026-10-31`, base `44fc1ed`. Three changes from Pat's screenshot of a working session on his iPhone:
Stop leaves its own row, a "new session here" button, a one-tap "copy session id" button. Then two rounds of feedback
on the composer (Pat: "this looks terrible ... you shouldnt be trying to invent this stuff yourself every time", then a
screenshot of Claude's phone composer) and an adversarial review of the first commit. Everything was built into a
scratch folder (`_astra\dist-web`) and driven there; `app\dist-web` and the live phone server were not touched.

Screenshots: `C:\dev\.orch\harbor\cli-1031-mobile\_astra\shots\` (scratch) and a copy in
`docs\orchestration\2026-10-31-mobile-qol\private\shots\` (gitignored: Harbor's repo is public). They are synthetic
fixtures, no real names. The "before" composer shots are in `shots\base\`.

## What changed (this round, on top of `ae878e9`)

| File | Change |
|---|---|
| `app/web/src/composer/Composer.jsx` | The composer is one card: chips, text box, toolbar. `[Send]` idle, `[Stop][Send]` working. The 500 ms guard, the slot swap and `stopButton('beside' / 'in-slot')` are gone. The auto-height effect budgets the card's own chrome, observes the box's width, and depends on `working`. |
| `app/web/src/composer/composer-actions.cjs` | Reduced to `composerActions` (`{ stop, sendReady }`) and `hasDraft`. The guard functions are deleted. |
| `app/web/src/composer/composer.css` | `.composer-card` (24px corners, thin border, a step lighter than the page), `.composer-bar`, `.composer-actions`; plus / Stop / Send are one 40px circle with a 44px inset tap area; text box transparent at the card's full width. |
| `app/web/src/slash/slash.css` | Slash validity colours the card's border; the inset 3px bar down the text box's left edge (a left-edge bar) is gone. |
| `app/web/src/shell/SessionActions.jsx`, `shell.css` | Visually hidden polite live region announcing "Session id copied" / "Could not copy the session id". |
| `app/web/src/shell/AppShell.jsx`, `shell.css` | New session here and copy id both step aside while disconnected; the project name keeps its room (the status gives up characters first). |
| `app/web/src/newsession/NewSessionSheet.jsx` | The folder state belongs to one open (cleared on close and on a preset change); "Loading folders" instead of "No candidate folders"; Start off until this open's list has resolved. |
| `docs/claude/views.md` | The two phone-frame bullets corrected, and two bullets added (composer card, header session buttons). |
| `app/test/web/composer-actions.test.js` | Rewritten for the card (7 tests; the guard tests are gone). |
| `app/test/web/session-header-actions.test.js` | +3 source-pattern tests for the review fixes (14 total). |
| `app/test/web/composer-cap.test.js` | Stubs follow the smaller helper module. |
| `app/scripts/drive-phone-qol-win.js` | Composer states rewritten for the card; new states `sendDoubleTap`, `draftClip`, `sheetFirstOpen`, `sheetSecondOpen`, `slashCard`; `stopGuard` removed; the fixture can start and end a turn and delay the folder list. 19 states. |

Unchanged from `ae878e9`: the header layout, `copy-text.js`, `session-actions.cjs`, `preset.cjs`, the sheet's preset, `newsession.css`.

## The composer: the established card, not an invention

### Reference pattern

| Source | What it gives |
|---|---|
| Vercel AI Elements `PromptInput` (scraped from its docs) | Header (attachments), body (text area), footer (tools left, submit right). One container. |
| Claude and ChatGPT phone composers (Pat's Claude screenshot) | One rounded card slightly lighter than the page, placeholder at the top with generous left padding, a toolbar along the card's bottom edge, the `+` as a subtle filled circle, round actions on the right all one size. |
| Stream Chat and Cursor / Codex composers | An action group whose positions do not change; a draft typed during a running turn queues while Stop stays. |

### The 390 working-draft shot, beside how it matches each point of Pat's note

| Shot (`private\shots\c3-working-draft-390.png`) | Match |
|---|---|
| ![working with a draft at 390](../private/shots/c3-working-draft-390.png) | **One card, about 24px, slightly lighter than the page, thin border.** 24px corners (asserted), 1px `--ln2` border, fill `rgba(255,255,255,.055)` over the page's `#0b0c0f`. The border takes the accent while the box has focus (the blue edge in this shot), the slash colour while a command is typed (`slashCard`).<br>**Placeholder / text at the top, full width, about 24px left padding.** The text box is 364 of the card's 366px at 390 (the card's full inner width, asserted), 24px of padding before the text, 16px type.<br>**Toolbar inside the bottom edge, about 12px in.** Measured 12px from the card's left, right and bottom edges (asserted at all three widths).<br>**Left: `+` as a subtle filled circle, light icon, no model chip.** 40px, `rgba(255,255,255,.09)` (a step lighter than the card), icon in the text colour.<br>**Right: round buttons the same diameter as `+`.** Stop and Send are 40px, the same as `+`; all three share one centre line (asserted). No mic in the toolbar: voice stays in the tools tray, so the right group is `[Send]` idle and `[Stop][Send]` working.<br>**Stop is the same subtle circle with a solid square; Send is the accent fill, muted when there is nothing to send.** Stop: the `+` circle with a 14px solid square in the text colour. Send: solid `--ac`, white arrow; with an empty box it is the accent at 30% (visible in `c2-working-empty-390.png`).<br>**Everything else stands.** Positions identical between working-empty and working-draft (bounding boxes, asserted); no tap guard; each button a 44px tap area; `onPointerDown={keepFocus}` on all three; 16px text; 150px / 40% caps. |

### Before and after

Text box width (px) and composer height, measured by the drive on the base bundle and the new one:

| | 375 | 390 | 430 | Composer height |
|---|---|---|---|---|
| Base, every state | 255 | 270 | 310 | idle 66, working empty 118, working draft 159 |
| First attempt (`ae878e9`), idle / working-empty | 263 | 278 | 318 | 66 / 66 |
| First attempt, working with a draft | 223 | 238 | 278 | 107 |
| **Card, every state** (idle, working empty, working draft, keyboard up) | **349** | **364** | **404** | idle 117, working empty 117, working draft 138 (2 lines) |

The box is about 94px wider than base and 126px wider than the first attempt's worst state, and it never changes width, so
nothing jumps when the first character is typed during a turn. **The cost is height: the idle composer is 117px against 66px**
(card padding plus a toolbar row), the same trade Claude's and ChatGPT's phone apps make. The Stop row is still 0px.

### Behaviour

- Idle: `[Send]`, muted until there is text or an attachment. Working: `[Stop][Send]`, always both, Stop just left of Send.
  Send keeps the same rule, so a draft typed during a turn can be sent (it queues) while Stop stays.
- Send never moves. In `composerWidths` the plus, Stop and Send boxes are identical (x, y, width, height) between working-empty and
  working-draft, and Send's x, width and height are identical idle and working.
- **No tap guard.** The 500 ms guard existed only because Stop took Send's place. `sendDoubleTap` double-taps Send: one send, no interrupt,
  Send and Stop in the same boxes afterwards, Send muted again.
- Stop and Send are 16px apart, which keeps **12px between their 44px tap areas** (Stop has no undo). Asserted, plus a dead-zone
  hit test at the midpoint of the gap.
- Slash palette opens over the card at the card's width; known and unknown commands colour the card's border (`slashCard`).
- Attachments are the card's header: chips inside the card, above the box, 12px in; the card grows upward and the toolbar does not move
  (Send, plus and Stop boxes identical with and without an attachment, idle and working, at all three widths).

## Review findings (adversarial review of `ae878e9`)

| # | Finding | Resolution |
|---|---|---|
| 1 | The 500 ms guard could eat a real Stop tap | No guard at all: Stop and Send never occupy the same place. Proof: `sendDoubleTap`. |
| 2 | Mis-tap between Stop and Send | 12px between the 44px tap areas, asserted, with a dead-zone hit test. |
| 3 | Box width must not jump when the first character is typed during a turn | The box is 349 / 364 / 404 in every state, asserted equal. |
| 4 | Textarea height must re-measure when its width changes | A `ResizeObserver` on the box (width only, so it cannot loop), and `working` is in the effect's deps. `draftClip`: a three-line draft, a turn starts, the keyboard comes up, the turn ends, at all three widths: the last line never clips and the box keeps its width and height. **Honest note:** in the card the box does not change width when a turn starts, so `draftClip` would also pass without the observer; the observer is the backstop for rotation and any later layout change. |
| 5 | Doctrine out of date | `docs/claude/views.md` edited in this commit (see below). |
| 6 | Sheet shows the last open's folder, Start live | Folder, list and picker clear on close and on a preset change; "Loading folders" (never "No candidate folders") until the list returns; Start and submit wait for it; the provider and plan follow the chat at once. **Two-sided:** against the pre-fix sheet `sheetFirstOpen` fails on the "No candidate folders" flash and `sheetSecondOpen` fails because the second open shows the first open's folder. |
| 7 | "Copied" not announced | A visually hidden `role="status" aria-live="polite"` span, always in the page; `copyId` and `copyIdFails` assert its text and that it clears. |
| 8 | Offline at 375 the project read "HAR..." | Both session buttons are hidden while disconnected, and the project name now keeps its room (`flex: 0 0.25 auto`: squeezed, the status loses four times as much). `headerOffline` asserts the project name is not clipped at 375 and 430, reconnecting and offline: it read "HARBOR" in full (`h4-header-reconnecting-375.png`). **Cost:** copy id is not available while disconnected. |

## Header and the sheet (unchanged design, `ae878e9`)

Controls on the project line (new / id / settings, 44px ghost buttons), the title on its own full-width row (227 / 242 / 282px ->
311 / 326 / 366px); the header is taller (one-line title 95 -> 105px, two lines 110 -> 124px). New session here opens the sheet preset to
the chat's folder, provider and plan (model and effort keep the sheet's defaults), the folder first as a folded card with Change; the server
already accepts the chat's own folder as a hint, so no server change. Copy id calls the clipboard first thing in the tap with a textarea
fallback and shows its check only for a copy that landed. Details and measurements are in `ae878e9`'s report text, now in
`docs/claude/views.md`.

## Verification

Drive: `app\scripts\drive-phone-qol-win.js <distDir> <evidenceDir>` (isolated `composeServer`, headless Chromium, iPhone insets, touch `tap`,
375x812 / 390x844 / 430x932, keyboard up at 59% of height). **All 19 states pass:** `composerWidths`, `stopTaps`, `sendDoubleTap`,
`attachments`, `headerWidths`, `headerVariants`, `headerOffline`, `newSessionHere`, `newSessionHereUnlisted`, `newSessionHereCodex`,
`newSessionBrowserUnchanged`, `draftClip`, `sheetFirstOpen`, `sheetSecondOpen`, `slashCard`, `copyId`, `copyIdFallback`, `copyIdFails`,
`copyIdProvisional`. `drive-phone-ux-win.js` on the same bundle: all 19 states pass. `detect.mjs` (impeccable) over the seven changed
UI files: `[]`.

What the composer states assert, at all three widths: one card with 24px corners and a 1px border; the text box at the card's full inner
width with 24px of padding and 16px type; the toolbar 12px in from the left, right and bottom; plus, Stop and Send all 40px on one centre
line, all inside the card; Stop just left of Send, 16px apart; identical boxes between states; 44px tap areas by hit test on plus, Send and
Stop; touch taps on Stop (empty box, draft, keyboard up with each) send Escape to the working pane, leave focus in the box and keep typing
mode on; the toolbar stays above the keyboard and the composer within 40% of what is visible (also with an attachment).

Text box widths at 375 / 390 / 430, by state:

| State | Box | Card | Composer height |
|---|---|---|---|
| Idle | 349 / 364 / 404 | 351 / 366 / 406 | 117 |
| Idle, keyboard up | 349 / 364 / 404 | 351 / 366 / 406 | 117 |
| Working, empty box | 349 / 364 / 404 | 351 / 366 / 406 | 117 |
| Working, draft | 349 / 364 / 404 | 351 / 366 / 406 | 138 |
| Working, draft, keyboard up | 349 / 364 / 404 | 351 / 366 / 406 | 138 |

Screenshots (`shots\`, all opened and read; names carry the width):

| Shot | State |
|---|---|
| `c1-idle-*` | Idle empty: Send muted, `+` left |
| `k3-idle-keyboard-*` | Typing: keyboard up, idle |
| `c2-working-empty-*` | Working, no draft: `[Stop]` and a muted Send |
| `c3-working-draft-*` | Working with a draft: `[Stop][Send]` ready |
| `k1-working-draft-keyboard-*`, `k2-working-empty-keyboard-*` | Keyboard up, working, draft and empty |
| `a1-idle-attachment-*`, `a1-working-attachment-*` | Attachment chip inside the card, idle and working |
| `a2-idle-attachment-keyboard-*`, `a2-working-attachment-keyboard-*` | The same with the keyboard up |
| `d1-draft-idle-*`, `d2-draft-turn-starts-*`, `d3-draft-turn-keyboard-*` | Multi-line draft: before the turn, when it starts, with the keyboard up |
| `s1-slash-palette-*`, `s2-slash-valid-*`, `s3-slash-invalid-*` | Palette over the card; valid and invalid command borders |
| `h1-header-*`, `h2-header-short-375`, `h3-header-provisional-375` | Header online |
| `h4-header-reconnecting-375/430`, `h5-header-offline-375/430`, `h6-offline-card-375/430` | Header reconnecting and offline, connection card |
| `n1`..`n7` | New session sheet: from a chat, change folder, unlisted folder, Codex, browser, first-open loading, second-open loading |
| `i1-copied-*`, `i2-copy-failed-390` | Copy id landed and failed |
| `base\c1-idle-*`, `base\c2-working-empty-*`, `base\c3-working-draft-*` | Before: the base composer |

Tests, from `app` with `TEMP`/`TMP` at `_astra\tmp` and `HARBOR_NO_DAEMON_START=1`:

| Filter | Result |
|---|---|
| `npm.cmd test -- web` | 109 tests, 107 pass, 0 fail, 2 skipped (the existing "no local capture" sidebar-fixture skips) |
| `npm.cmd test -- composer` | 18 pass, 0 fail |
| `npm.cmd test -- new-session` | 20 pass, 0 fail |
| `session-header-actions.test.js` (inside `web`) | 14 pass |

No full suite was run.

## Not verified

- **Real iPhone Safari.** Playwright's WebKit would not start here (version mismatch), so every check ran in Chromium. Open on a device: the clipboard
  write inside the tap on the Tailscale https page and the textarea fallback; the `::before` tap areas on the three circles; `display: contents` on the
  header's id span; the card's focus border colour on iOS; the keyboard-up composer at 40% with an attachment.
- The card against Claude's app pixel for pixel: it follows the pattern and Pat's listed points, not a measured copy of Claude's spacing.
- `drive-mobile-newsession-win.js` still fails at its wheel-scroll step on both base and new (sheet body does not overflow with five fixture folders); not touched.

## Found on the way

- `verify-composer-qol.js` and `test/e2e/mobile-ui.spec.js` are Linux-era harnesses that run on no machine; `verify-composer-qol.js` still queries
  `.composer-row` (gone). It was not updated, since it cannot run here.
- The slash palette shows the chat bubble behind it faintly in a headless Chromium screenshot (visible in `s1-slash-palette-*`). It is identical on the base
  bundle and the palette's computed style is opaque (`rgba(18,20,26,.98)`, opacity 1, above the conversation in the hit-test stack), so it looks like a compositing
  artifact of the headless renderer. Not investigated further; worth a look on a device.
- The server answers a second `new-session` within 3 s of the last with the first one's result and launches nothing; the drive waits it out.

## Doctrine: `docs/claude/views.md` (edited in this commit)

- "THE PHONE FRAME ..." item (3) now describes the header as two blocks (the session with its controls and a full-width title, then one strip), and item (4)
  says the pill sits on the project line, a drop adds no height, and new session here and copy id step aside while disconnected (the sentence "the title clamps
  to one line while disconnected" is gone).
- "Phone sticky headers are opaque ..." no longer says "attachments share one row with Stop".
- New: "The phone composer is ONE card, and Stop sits beside Send and never moves" (the pattern, the sources, the no-guard decision, the 12px tap-area gap,
  the measured widths and the height cost, the drive that proves it) and "The phone header's session buttons" (what each does, the sheet's one-open state).

## Impeccable follow-up

The project has no PRODUCT.md or DESIGN.md. This was a refinement on the incumbent phone tokens (`--ln2`, `--ac` / `--ac-rgb`, `--live`, `--err`, the spacing
scale; one new local custom property, `--cmp-btn`), no new colours beyond the card's white tints, no left-edge bar, no gradient on Send, no animation (a 120ms
colour ease on state change), no `vh`. `/impeccable init` can document the surface when someone wants it.
