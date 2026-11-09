# Lighthouse glass: implementation report

The approved Lighthouse glass look is built on desktop and phone: a fixed night photograph behind glass panes, Inter, bar meters, the new message box layout, popups and dialogs on one raised surface, and a solid dark whiteboard. Sending, Stop, Resume, queued messages, attachments, slash suggestions, question replies, live voice and the format strip work as before. Screenshots of every size and state are in this run's `private\reports\` folder; this file names them by folder only.

## What changed

**Ground and glass.** `.ground` paints the sharp photograph once. Every glass surface paints its own opaque stack, every layer fixed to the window: its tint, the lamp and darkening gradients, and a copy of the photograph blurred ahead of time (`app/assets/ground/lighthouse-blur-960.webp`). No browser blur runs, so the glass costs nothing per frame. `backdrop-filter` and wide live blurs stay banned by `test/renderer/no-decorative-gpu-cost.test.js`, which was not changed. The method and its consequences are the first bullet of `docs/claude/views.md`.

**Desktop shell.**
- Title bar capsules and the rail panes are restyled.
- Plans shows each window as a percentage and reset above a thin bar, in place of the donuts.
- Windows have density tiers, so the project name and close button stay inside even with 16 windows at a laptop size.
- The assistant name line above each reply is gone.
- In the message box, the buttons stand in a column at the right, Send is 48px, and the model chip moved to the end of the status line.
- The rail gets a compact tier below 700px tall.

**Pages, cards and small surfaces.** Tasks, Notes, Files, Orch and the team chart sit on the glass. The question, permission, input-request, model-switch and reply cards are restyled, and so are the update ribbon, daemon banner, image viewers and drop cues. No card or row carries a coloured bar down its left edge any more.

**Popups and dialogs.** All of them, the Plan usage panel and Session configuration included, now match the approved design:
- one raised surface, with hairlines between sections and sentence-case headings;
- Inter throughout, with monospace only for commands and paths;
- no boxes nested inside;
- the selected segment of a control in the button blue over a dark well;
- a scrim dark enough that the app behind stops competing.

Effort in Session configuration is a segmented control. Plan usage lays out each plan's two windows side by side, like the rail's Plans. The task editor moved Duplicate and Assign to its footer, so the title has the full row.

**Whiteboard.** The canvas is solid `#141a26` on every board, and stored colours never change. Near-black ink that would vanish on the dark canvas is shown in a readable ink when drawn, and the stored value is written back on save. Excalidraw's dark theme was rejected because it inverts pasted screenshots and sticky colours; a forced test of it is in the board captures. New ink, lines, connectors and `bin/harbor-board` default to a light ink, and exports render the dark canvas. The tool rail wraps into a second column at short window heights. `docs/claude/board.md` is updated.

**Phone.** The phone has the same tokens, type and glass. The glass uses one fixed ground layer, and each pane is clipped over a fixed copy of the stack, because iOS Safari ignores fixed background attachment. Sheets and menus are solid. The name line is removed. The connect screen shows the app icon, and the static server now serves `.webp` with the right type.

**Also in this branch.**
- Alt+Enter makes the selected window fill the stage, and pressing it again puts the window back. F11 still takes the whole app full screen.
- Inter ships with its Latin Extended subset and its license.
- Plan letters too dark to read at badge size take a lighter mix of the plan colour.
- Drives that open Harbor on the real session history now wait up to ten minutes for the window.

## Fidelity

**Baked versus live blur.** Measured at 1906x908 and 1600x1000, the pre-blurred glass differs from a live 30px blur by a mean of 0.5 to 0.9 of 255 levels. The 99th percentile is 2 to 3 levels, and 0.0043% of pixels are more than 3 levels apart at a 40px inset. The baked version showed less banding than the live one (28 against 32 levels across a stretched crop).

**Against the mock.** The one-window and six-window views at 1906x908 match the approved screens closely. The places where they differ:
- The mock's popups were 95% opaque over a live blur. Here they are fully opaque, because without a blur the letters behind ghost through sharply.
- Scrims are darkened for the same reason.
- A held window no longer scales up while dragged. A scaled window breaks the fixed glass and turned the held window a flat navy.

## GPU

The same isolated Harbor was run off-screen, old build and new build back to back, with six windows open and one working. Figures are the GPU process's 3D engine use, averaged over 16 seconds.

| | Pre-reskin build | Lighthouse glass |
|---|---|---|
| Six windows, idle | 0.00% | 0.01% |
| Six windows, one conversation scrolling | 2.84% | 1.87% |

The live baseline of the old look, sampled only while Harbor was in front, read 2.9%, 0.1% and 0.2% across three valid rows. The same live sampling for the new look runs once the update is installed in the real app.

The two decoded ground images take about 19 MB: 2880x1479 sharp and 960x493 blurred.

## Contrast

All visible text was measured against the real pixels behind it, with text hidden, at 956x574 at 1.8x and at 1906x908, across 1, 2 and 6 windows. That is 918 text runs. The lowest real reading is 5.18:1, on a plan badge letter; everything else is higher. Two runs read lower, and neither is text that needs to be read: a decorative middle dot, and a note partly tucked under a window's working line, where the sampler caught the line itself. The fixture uses the darkest real plan colours, a deep blue and a deep green.

## Tests and drives

**Unit gate.** `npm test -- --exclude daemon --exclude bin`: 3102 and 7 pass, 0 fail. The `daemon` suite passes (4 and 147; 23 skipped by design), and so does the `bin` suite (112). No test was edited to pass. One drive changed its selector because the look it read was replaced: `drive-model-menus-win.js` reads the effort control's buttons. That drive also names a codex model that still exists, since the catalog no longer has its old one.

**Drives that pass.** `composer-focus`, `composer-paste`, `model-menus`, `toolbar` (78 checks), `whiteboard`, `board-look` (38 checks), `viewswitch`, `notes`, `team-chart`, `plan-surfaces`, `render-leak`, `boot-recovery`, `sidebar-lag` and `ask-sheet`. `drive-look-win.js` covers every size, layout, menu, card, state, the Alt+Enter shortcut, a held window, contrast and GPU, with geometry checks only.

**Failing before this work.** `drive-rail-controls-win.js` fails two checks on the real session history: an Oldest ordering tie, and a count under date grouping. It fails the same two checks at the pre-reskin commit, and no sort or filter code changed. `drive-phone-ux-win.js` fails one check, that formatted text stays selected in the phone's plain-text box, and it fails the same way at the pre-reskin commit.

**Not proven here.** Pressing Alt+Enter while focus is in a live raw terminal was not tested; the harness had no live pane. It uses the same capture-phase handler as Alt+arrows.

## For review

- **Popups and dialogs:** Plan usage, Session configuration, the plus menu, CLI updates, the quick guide, the model list, and the task editor.
- **Window states:** 16 windows at a laptop size, a question card, a permission card and the reply banner, plus a queued message with Stop.
- **Whiteboard:** an older white board shown on the dark canvas, a pasted screenshot, and stickies.
- **Phone:** chat, tasks, notes, settings, and the connect screen.
- **Shortcut:** Alt+Enter on any session window.
