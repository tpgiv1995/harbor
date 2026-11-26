# Release notes

## Unreleased

- Gemini is Harbor's fourth provider, beside Claude Code, Codex and Cursor, through
  Google's Antigravity CLI (`agy`). New session has a Gemini tab with its own
  models and effort levels; a Gemini session opens in a conversation window with
  the Gemini mark on its model chip and its rail row, takes messages from the
  command bar, resumes, and sleeps and wakes like the others. Harbor reads
  Antigravity's own records for the conversation and a status line for whether it
  is idle, working or waiting for an approval. The first session in a profile
  that never ran Antigravity shows Google's own terms screens in the window's
  terminal; Harbor never answers them. The setup wizard and the phone know
  Gemini too. Antigravity is installed and updated by hand; Harbor's update chip
  leaves it alone.
- A Gemini window no longer refuses messages after Antigravity asks "How's the
  CLI experience so far?". That survey takes the place of the message box until
  it is answered, so every send failed with "Gemini is not showing its prompt
  box". Harbor now starts Gemini sessions with the survey switched off, and a
  send that finds one already open skips it first.
- A message sent to a Gemini window while Gemini is still working no longer
  ends in "could not confirm the message reached the session". Antigravity
  holds such a message and sends it when the current turn ends, together with
  anything else sent meanwhile, so Harbor now checks Antigravity's own record
  of what it took, and the status says the message is queued.
- A Gemini window no longer shows a made-up question while Gemini works. A
  numbered list in Gemini's reply was read as a question, so the window said
  "needs your answer" and offered the list items as answers, under the label
  "Claude is asking". Questions now come only from Gemini's own dialogs, and
  the card names the provider that is asking. This also holds while Gemini runs
  background agents or commands, which it lists under its message box; Harbor
  used to lose track of the box then, and messages sent to the window in that
  state could not find it either.
- A Gemini session started on an Orchestrator model keeps that name on its
  window. The orchestrator runs its own steps on other Gemini models, and the
  window showed whichever one ran last (an "Orchestrator (Neon)" session read
  "Gemini 4 Hydrogen"). Resuming such a session reopened it on that last model
  too; it now reopens on the Orchestrator.
- A Harbor built from this repository starts again: since the session-rename
  change it stopped at launch with "resolveConfigFile is not defined".
- Copy and paste keep their formatting. Pasting from Teams, Outlook, Word,
  Google Docs, a web page or another Harbor window brings real bullets,
  nesting, numbering, bold, italics, links, headings and quotes into the
  message box; plain text and spreadsheet tables paste exactly as before.
  Copying from a conversation window or the message box gives Teams, Outlook
  and Word clean formatting (bullets, bold, tables with borders, a blank line
  between paragraphs) instead of white-on-black text, and plain-text targets
  get real "- " bullets and tab-separated table rows.
- A message copied out of Teams no longer reports "could not confirm the
  message reached the session". Claude Code now removes invisible characters
  (zero-width spaces and similar) from what it receives, so Harbor removes
  them before sending, and a message holding a direction mark is no longer
  left unsent in Claude's box waiting for a second Enter.
- Conversation windows stay where you left them. A window at its latest
  message keeps following new replies through windows opening and closing,
  rearranging, full-stage toggles and minimizing; a window you scrolled up
  holds your place until you scroll back down or send it a message. A
  rearrange no longer sends untouched windows to the top of their chat.
- The mouse wheel scrolls the active conversation from anywhere on the stage,
  including the message box, and PageUp/PageDown scroll it a page while you
  type.
- Every prompt and reply shows the time it was written, in your own time
  zone; hover it for the full date.
- Harbor Mobile gets the same: each chat keeps your place (a fling, a new
  reply or the keyboard never moves it), each session remembers where you
  were, and every prompt and reply shows its time.

- Harbor has a new look on desktop and phone: a dark coastal night scene behind
  the windows (solid panes in the Schibsted Grotesk typeface on desktop, glass
  panels in Inter on the phone), plan usage shown as bars, and a roomier
  message box with its buttons on the right. Everything works the way it did,
  the glass is drawn without a live blur so it costs no more graphics power
  than before, and the whiteboard is now a dark canvas.
- Alt+Enter makes the selected session window fill the stage, and pressing it
  again puts the window back. F11 still takes the whole app full screen.
- A session that is waiting for its own background work (a long command, a
  Monitor, a background agent) is no longer put to sleep for being idle. Harbor
  used to end any session that sat at its prompt for an hour with little CPU,
  which killed the work it was waiting on. A launch with no completion notice
  now keeps the session up for as long as the work runs, up to 9 hours
  (`HARBOR_SESSIOND_DORMANT_BACKGROUND_MAX_MS`).
- The phone app lists Codex sessions from every Codex home, not only the default
  one. A session in a second or third Codex home used to appear on the phone as a
  nameless "Live session" while it ran and not at all once it stopped, with no
  conversation to open. The phone server needs a restart to pick this up.

## 0.1.0 (2026-10-12)

The first packaged release. Windows, macOS and Linux installers are attached to
the GitHub release, built by `.github/workflows/build.yml` from the `v0.1.0` tag.
They are not code-signed, so the OS warns before running them; the release page
says how to get past that. The Windows installer was unpacked and launched in an
isolated profile before release (it opened, started its own session daemon and
rendered every view, `app/scripts/drive-release-win.js`); the macOS and Linux
installers were built by CI and have not been launched on real hardware.

Changes since the notes below were written:

- Typing stays responsive with a large session history. The rail used to resend
  every session ever recorded about once a second; it now sends only what
  changed (about 5.9 MB a second down to about 1 KB in a measured case).
- Sessions that tools start on their own (codex reviews and exec runs, headless
  Claude workers, orchestration batches) live in the Orch view instead of the
  rail. A helper resumed into a live window still behaves like a normal session.
- The phone app reconnects at once when you come back to it, keeps the last
  session list on screen while it does, and its header shows the session's
  context use, whether it is working or waiting, and its model.
- On Windows each Harbor session's processes are held to 32 GB of committed
  memory apiece (a Job Object limit, configurable), so one runaway test cannot
  exhaust the machine.
- Orchestration shows what could start: a pending batch reads "ready, not
  started" or names what it waits on, batches are grouped Running, Error, Not
  started and Done with a colored dot, and the ETA schedules the dependency graph
  at the run's real width instead of assuming one batch at a time. The shipped
  `/orchestrate` commands plan runs for parallel execution.

From the earlier unreleased notes:

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
