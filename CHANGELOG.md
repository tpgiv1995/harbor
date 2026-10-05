# Release notes

## Unreleased

The package version remains 0.1.0. These notes describe the current source tree,
not a claim that installers or a public release have been published.

- A message whose Enter Claude swallowed is submitted instead of left in the
  composer (2026-09-23). A busy Claude CLI can read the typed text and the Enter
  in one read and take the Enter as text, which stranded the message and showed
  "could not confirm the message reached the session". Harbor now watches the
  composer after Enter and presses it again, at most twice, only while the box
  still ends with the message it just sent.
- A pasted message shows as the words that were pasted (2026-09-20). Claude Code
  2.1.27x wraps a large paste in `<pasted_content id="...">` tags in the transcript,
  and the conversation window was showing the tags.
- Typing in a note or a task no longer flashes the "Unsaved changes" banner on every
  key (2026-09-20). The banner now appears only when a save was refused or an edit
  has stayed unsaved for four seconds after the last change.
- Provider model menus refresh when installed CLI versions change (2026-09-20),
  including updates installed outside Harbor. Codex works without a configured
  profile and offers reasoning levels per model; Cursor discovers its model
  list from the CLI. Open configuration menus refetch after discovery.
- The CLI update chip reconciles installed versions from disk before its first
  response and on throttled state reads or window focus. External installs get
  honest history, and installing an already-present version is a no-op.
- The phone new-session sheet keeps long folder paths within its width
  (2026-09-20). An isolated 390px browser drive verifies discovered models,
  per-model effort submission, the empty-home fallback and Cursor picker reachability.
- Harbor no longer spends the display GPU on decoration. The background glow
  and every frosted-glass blur are gone from the desktop and phone clients, and
  nothing in either client animates in a loop: status is shown by colour and
  shape, and the terminal cursor does not blink. One looping animation makes
  Chromium redraw the whole window at the display's refresh rate for as long as
  it runs. Two diagnostics that woke the app at that rate for a test harness
  are off outside that harness. Measured on a 240 Hz laptop panel driven by an
  integrated GPU, Harbor focused: about 70% of that GPU with the glow, about
  10% with the glow gone and the animations throttled, and under 2% with
  nothing looping (0.0 to 0.2% idle, 0.1 to 1.7% with a session working).
- Claude question forms receive structured `AskUserQuestion` input through a
  hook, with the terminal answer card retained for sessions without it.
- The rich composer supports nested lists, links and quotes, file chips and
  image attachments. Voice dictation and live voice use an optional OpenAI key.
- Notes has groups and topics, and its shared document model now ships with the
  desktop and phone callers. Phone Notes still does not display groups.
- Board offers shapes, stickies, connectors, frames, templates and a CLI.
  Tasks includes Assign to Claude.
- The title bar offers commit/memory information and provider CLI update notices.
  Codex model and reasoning choices use the launch home's cache.
- Session infrastructure includes daemon supervision and keeper-preserving
  handover, Windows Job Objects, dormancy and local crash capture.
- Screenshot tooling uses hidden windows on Windows and retains the Linux Xvfb
  path. The public visual set uses one synthetic corpus.
- Windows development, mobile test and setup-drive wrappers no longer depend
  on directly spawning a command shim or a missing Xvfb executable.
- Setup, configuration and packaging instructions now distinguish current
  behavior from the retired backend. The Node floor is 22.12.0.
- Both bundled font families include their upstream OFL notices. The Claude
  SVG's exact provenance remains unresolved.

Known limits and deferred fixes are in [the backlog](docs/BACKLOG.md).
Hosted CI status, installer behavior and release publication must be checked
separately; they are not implied by these notes.
