# Harbor backlog

Open items with the evidence attached, newest first. An item leaves this list
when it ships (with the commit) or when the author drops it.

## Open

### assertComposerSafe is a single read, so a freshly launched claude pane can lose the front of its first message

Found 2026-08-08 while fixing the codex version of this. A brand-new codex
session recorded `026-08-05.pdf, 2 pages, curren…` for a message that began
`/home/…/Census Tool - overview and what I am asking for - 2026-08-05.pdf`: the
leading characters were typed into a TUI that was not listening yet, and codex
answered the fragment. The fix was to let a fresh non-claude pane settle before
the first keystroke, using `waitForProviderReady`, which already existed and had
been wired only to the resume path.

Claude has the same shape and is NOT covered. `assertComposerSafe` is a single
`readScreen`, deliberately so (its comment explains why one read is right for a
refusal: reading twice judges one frame and tests another). But a refusal check
is not a readiness wait, and nothing waits before the first send into a pane
Harbor just launched. Claude's TUI comes up faster, which is the only reason
this has not been caught in the wild.

Doing it properly means giving claude a first-delivery settle without breaking
the four specs whose staged screen queues the extra reads consume
(`image attachments set and verify the clipboard…`,
`image attach is confirmed even when a prior turn's markers scroll off…`,
`Claude /model answers a post-send full-history confirmation…`,
`Claude /effort handles the same…`). Those harnesses feed `readPane` from a
shift() queue, so any read added before the guard changes what the guard sees.
The settle needs its own read source, or those fixtures need to stop being
order-dependent.


### Part of the unit suite asserts against whichever Claude config homes exist on the machine running it

Found 2026-08-07 by an audit, and visible before that as a red CI badge on every
commit: `npm test` passes locally and fails on a clean machine. Measured, not
inferred, by running the same files twice with only `$HOME` changed:

```
node --test test/actions/launch.test.js                     -> 14 pass, 0 fail
HOME=<empty dir> node --test test/actions/launch.test.js    -> 10 pass, 4 fail
```

Across the whole non-herdr suite that is 1104 pass with a populated home against
1097 with an empty one. The failing specs assert
`--home ${os.homedir()}/.claude-team` and pass only because the author's machine
has that directory (`test/actions/launch.test.js:166`, and the same shape at
`:163`, `:179`). Under an isolated `$HOME` the failures are: resume argv
(`test/actions/launch.test.js`), newSession team argv, the PROVEN-dead owner
resume, the ownership single-flight probe, `resolveUnitPolicy`, and the
authenticated headless new-session spec in `test/server/`.

The fix already exists three lines away and is the one the suite documents as
correct. `test('newSession: launches the rail defaults for every Claude
account')` at `test/actions/launch.test.js:184` injects `FIXTURE_PROFILES` and
says why in its own comment: *"pinning that to whichever `.claude*` directories
happen to exist locally would pass or fail by whose machine ran it."* Its two
immediate neighbours do exactly the thing that comment warns against. Convert
them to injected profiles.

Two separate CI failures are NOT this bug and need their own decisions:
`test/providers` "Node adapters are byte-identical to Python on the real
transcript corpus" needs both the author's transcript corpus and `python3`,
which is supposed to be retired; and `test/bin` "the installed claude CLI really
does accept --effort/--session-id at launch" needs the Claude CLI on `PATH`.
Both should skip with a named reason when their prerequisite is absent, the way
`herdr-wedge-recovery.test.js` already skips the systemd path off Linux.

### The composer froze mid-keystroke when the update banner appeared, and repeated the character

Reported 2026-07-25 (the author, screenshot): typing "...i saw some notif" froze and
filled the composer with hundreds of `f`, with an app update notice on screen.
He is confident the physical key was not stuck, and the shape agrees: a stalled
renderer plus X11 key auto-repeat queues the repeats and flushes them all when
the main thread comes back, which looks exactly like a stuck key without being
one.

Trigger, confirmed: the notice is `app:update-available`, fired by the dist
watcher in `/home/you/dev/harbor/app/src/main/index.js:1199` every time a
rebuild settles, which is every time this project is built while the app runs.

Prime suspect, NOT yet measured: `UpdateBanner`
(`/home/you/dev/harbor/app/src/renderer/index.jsx:84`) renders INLINE at
the top of the app root, and `.update-banner` is an in-flow flex block
(`styles.css:3393`), so its appearance pushes the rail, the whole stage (up to
16 windows of parsed transcript DOM) and the command bar down in one
synchronous reflow. Second suspect, additive: every keystroke persists the draft
to `localStorage` through the draft store, so a keystroke already costs a
serialize plus a synchronous write.

**Measured 2026-07-25, and BOTH suspects are cleared.** Nine real corpus windows
on Xvfb :44, keystroke-to-paint latency, double-rAF, 40 keystrokes per run:

| condition | median | p95 | max | long tasks |
|---|---|---|---|---|
| baseline, nine windows | 100ms | 126ms | 127ms | none |
| banner inserted mid-typing, inline (today's markup) | 99ms | 130ms | 132ms | none |
| banner inserted mid-typing, fixed overlay | 102ms | 129ms | 129ms | none |
| eight sessions streaming small turns every 250ms | 91ms | 144ms | 156ms | none |
| eight sessions streaming ~80KB tool results every 400ms | 94ms | 117ms | 118ms | none |

The banner's own forced layout costs 7ms inline and 1ms as an overlay, so the
reflow theory is dead: do NOT "fix" it by moving the banner, that was a guess
and the numbers refute it. Live transcript streaming degrades p95 by tens of ms,
nowhere near a freeze. Absolute numbers are inflated by software rendering under
Xvfb and are only meaningful against each other.

Still unexplained, so the freeze stays open. Remaining candidates, none tested:
a burst from a source the profile did not simulate (a workflow fleet's agent
transcripts, the fs-watch to indexer to rail path, usage-endpoint fetches), or
something outside the renderer entirely (compositor stall: three
`GetVSyncParametersIfAvailable() failed` warnings appeared on the 19:10 launch
and on no earlier one).

**Capture now covers every layer that can produce the symptom** (2026-07-25,
extended after the first instrumentation could only see the renderer's own JS
thread). `~/.cache/harbor/perf/renderer-stalls.jsonl` receives, one line each:

- `blocked-main-thread`: the renderer watchdog (timer overshoot >= 250ms), with
  coarse context including `keys5s`/`repeats5s` (keystroke timestamps and the
  repeat flag only, never which key), so a capture shows the auto-repeat storm.
- `blocked-main-process`: the SAME watchdog math in the main process, which the
  renderer can never see, and which produces the identical symptom because X11
  input dispatch rides through it. hrtime-based, so suspend/resume cannot fake
  an entry.
- `compositor-stall`: renderer ticks on schedule while requestAnimationFrame
  goes silent >= 1s, gated on document.hasFocus() because X11 has no occlusion
  detection and a covered window legitimately stops painting.
- `child-process-gone` (the GPU process above all) and
  `renderer-unresponsive`/`renderer-responsive` (Chromium's outside verdict).

The pipeline itself is E2E-proven with induced blocks in both processes
(`HARBOR_PERF_LOG_DIR` relocates the log for harnesses). When the next freeze
hits, the log says WHICH layer stalled, for how long, and whether keys were
storming; that converts this from a hunt into a diagnosis. Do not re-run the
cleared theories above.

### The GPU process crashes, and each crash freezes the app for 16 to 37 seconds

Found 2026-07-30 by reading `~/.cache/harbor/perf/renderer-stalls.jsonl`, the log
the freeze item below was instrumented to produce. **The capture worked. Nobody
had read it.**

Two `child-process-gone` entries of `type: GPU`, `reason: abnormal-exit`,
`exitCode: 512`, and each one is followed immediately by a multi-second stall:

```
GPU CRASH 2026-07-28T09:05:42.411Z   exitCode=512 abnormal-exit
   +0.029s  blocked-main-process   16569ms
   +0.504s  blocked-main-thread    36709ms   typing=true  windows=13

GPU CRASH 2026-07-28T16:43:45.404Z   exitCode=512 abnormal-exit
   +0.057s  blocked-main-process   17579ms
```

Twenty-nine milliseconds from GPU death to a 16-second main-process stall. X11
input dispatch rides through the main process, so that is 16 seconds of queued
keystrokes, followed by a 37-second renderer freeze **while the author was typing**,
with 13 windows open. That is the reported freeze's exact shape.

**A claim made here on 2026-07-30 and RETRACTED the same night: "Harbor is
running software-rendered right now."** It was inferred from enumerating
`/home/you/dev/harbor/app`'s processes and finding no
`--type=gpu-process`, in an instance that had been through the 19:55 to 21:31
suspend. The telemetry shipped hours later (commit `4246a5b`) answered it
directly on its first boot and the inference was **wrong**:

```json
{ "kind": "gpu-status", "phase": "boot", "accelerated": true,
  "compositing": "enabled", "gpuCrashes": 0,
  "adapter": { "devices": [ { "vendorId": 4318,  "active": true  },
                            { "vendorId": 32902, "active": false } ] } }
```

Harbor is hardware accelerated, with a live GPU process. Worth keeping as a
worked example of why the telemetry was the no-brainer and the render-node pin
was not: the pin would have been a fix for a state Harbor was not in.

One real fact does survive the retraction, and it is new: **vendorId 4318 is
0x10DE, NVIDIA, and it is the ACTIVE adapter**; Intel (0x8086) is inactive. The
conversation UI is being drawn by the RTX 5090. That is a power and heat
argument for the iGPU pin, not a stability one.

None of this is configured anywhere: there is no `disableHardwareAcceleration()`
in `/home/you/dev/harbor/app/src/main/index.js`, no `--disable-gpu` in
`~/.local/bin/harbor` (a bare `exec "$ELECTRON" "$APP_DIR" "$@"`), and no GPU
switch in the `.desktop` entry.

Supporting evidence: **21 `ERROR:ui/gl/gl_surface_presentation_helper.cc`
(`GetVSyncParametersIfAvailable() failed`) on six separate days** (07-24, 25, 27,
28, 29, 30), plus 3 `ERROR:ui/gfx/x/atom_cache.cc`. The freeze item below listed
"three of these on the 19:10 launch and on no earlier one" as an untested
candidate. That instinct was correct and the count has grown sevenfold.

**Why `repeats5s` is 0 on every entry, and why that is not a refutation.** The
counter reports keystrokes the renderer *recorded* in the last 5 s. During a
37-second renderer freeze the renderer's JS is not running, so it records
nothing; the events queue in X11 and flush afterwards. Zero repeats is what a
real freeze looks like through this instrument. This blind spot should be fixed
by stamping key events in the main process, which is where they arrive.

**Environment, for whoever fixes this.** Hybrid GPU laptop: Intel Arrow Lake
iGPU (`i915`, `/dev/dri/renderD128`) plus NVIDIA RTX 5090 Max-Q (`nvidia`,
`renderD129`). GNOME on **Wayland**, so Electron runs under **XWayland** (no
`--ozone-platform` is passed). Electron **37.10.3**, roughly a year behind
current. Very new silicon against an old Chromium is a strong prior for GPU
process instability.

**The leading hypothesis, and what now watches for it.** The instance with no GPU
process was the one that slept 19:55 to 21:31. A GPU process torn down by a
suspend emits **no crash event**, so the boot-and-crash telemetry of `4246a5b`
was blind to exactly the thing most likely to be happening. Closed the same
night: `gpu-telemetry.js` now also polls (60 s, writing only on CHANGE plus a
30-minute heartbeat so the watcher's own liveness is visible) and brackets every
sleep through `powerMonitor`, reading `before-suspend`, `after-resume`, and
`after-resume-settled`, because "gone at once, back a moment later" is a
different answer from "gone for the rest of the session".

The poll reads `app.getAppMetrics()` for a `type: 'GPU'` entry, which is
Chromium's own process table and the first-party replacement for the `/proc`
enumeration this entry was originally written from. Both numbers are recorded,
never one: `GpuDataManager` caches, so a feature status can read `enabled` while
no process exists. The reverse was then observed for real under xvfb
(`accelerated: false` with `gpuProcess: true`), which is the same lesson from the
other side.

Costs measured under xvfb before choosing the interval: `getGPUFeatureStatus()`
3.9 us, `getAppMetrics()` 127 us, `getGPUInfo()` 1.5 ms. The first two are on the
tick; the third is deliberately not, and a heartbeat carries no adapter.

**Options, in ascending risk:**

1. **Pin the render node to the Intel iGPU**: `--render-node-override=/dev/dri/renderD128`.
   A conversation UI does not need a 5090, and the iGPU avoids the NVIDIA driver
   fight entirely. `teams-for-linux` already pins its own node this way.
2. **Log GPU feature status at boot** so "am I software rendering right now" is
   answerable from the app instead of by process forensics, and treat a GPU
   `abnormal-exit` as a first-class event rather than one line in a perf log.
3. **Upgrade Electron.** Real Chromium GPU fixes, but a large change surface.
4. **`--ozone-platform=wayland` is a TRAP, do not reach for it.**
   `/home/you/dev/harbor/app/src/main/focus-guard.js` depends on X11:
   `_NET_ACTIVE_WINDOW`, `wmctrl`, `xprop`, `XLowerWindow`. Native Wayland breaks
   the guard that keeps Harbor off a full-screen game. Rewrite the guard first
   or leave this alone.

**This does not explain everything.** The everyday stalls in the item below
(median 313 ms, ~150 to 200 per day) occur on days with no GPU crash, so they
have a separate cause. Prime unmeasured candidate: major GC on the main process,
whose RSS measures **787 MB**, since a 300 ms pause on a heap that size is
unremarkable. That is what the context capture below is for.

### The main process stalls 13x more often than the renderer, and nothing records why

Read out of `~/.cache/harbor/perf/renderer-stalls.jsonl` on 2026-07-30, five days
after the capture pipeline above went in. 950 entries.

| kind | n | median | p95 | max |
|---|---|---|---|---|
| `blocked-main-process` | 876 | 313ms | 2181ms | 77750ms |
| `blocked-main-thread` (renderer) | 68 | 750ms | 18315ms | 77618ms |
| `compositor-stall` | 2 | 1326ms | | 1326ms |
| `child-process-gone` | 4 | | | |

Per day, `blocked-main-process`: 179 / 198 / 257 / 165 / 38 / 39 across
2026-07-26 to 2026-07-31, median 292-394ms every single day. **Excluding
2026-07-28 entirely** (the swapfile-full and oomd day, which owns the 77s
outlier): 619 stalls, median 312ms, p95 1925ms, **111 over 1s, 29 over 2s**. The
baseline is stable and is not an artifact of the OOM day. The machine shows 206
OOM-related journal entries in the trailing 7 days, so memory pressure is an
ongoing condition rather than an incident.

The largest renderer stalls are co-timed with main-process stalls to within
milliseconds: 77618ms at `11:18:34.316Z` landed 62ms after 77750ms at
`11:18:34.254Z`, and three of the next four pair the same way. X11 input dispatch
rides through the main process, so a 2s main-process stall is 2s of queued input.

**These are NOT the composer freeze.** Zero of 950 entries carry
`repeats5s > 0`. The auto-repeat signature has never been captured. The freeze
item above stays open and unexplained.

**The gap that blocks the next step: `context` is `{}` on every single
`blocked-main-process` entry.** The renderer side records windows, domNodes,
transcript updates and key timing; the main side records only a duration. So the
876 stalls cannot be attributed. Candidates that a headless-server split would
move out of the UI process: transcript parsing, artifact scanning, the 275MB
model-catalog scan, per-frame JSON.parse and base64 decode, the herdr socket
client, fs.watch storms, and main's entire V8 heap with its GC. Candidates that
would stay: Chromium internals, window management, the dist watcher.

**Next action, and it is cheap:** give the main-process watchdog the same context
capture the renderer watchdog already has (what was in flight, heap size, recent
provider activity), run three days, then attribute. Do this BEFORE committing to
the server split in
`/home/you/dev/harbor/docs/RESEARCH-2026-07-30-mobile-and-always-on.md`,
because attributing the stalls is what turns that refactor's responsiveness
argument from inference into measurement. The reflow theory in the item above was
killed by exactly this discipline; do not skip it here.

### The Files view only indexes what Claude Code sessions produced

`main/providers/artifacts.js` scans `config.paths.projectsDir`, which is the
Claude Code transcript store, and `listTranscripts()` walks exactly one
directory level (`<root>/<projectDir>/*.jsonl`). Codex and Cursor sessions are
first-class everywhere else in Harbor, and their transcripts sit in their own
stores in their own shapes: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
(three levels deep, so the current walk would not find them even if the root
were added) and
`~/.cursor/projects/<munged-cwd>/agent-transcripts/<id>/<id>.jsonl`. So a file
written by a codex or cursor session is named in a transcript the scan never
reads and never appears in the Files view.

Found 2026-08-08 while building the published-screenshot corpus: the demo
sessions that produced artifacts had to all be claude ones, because a codex
session's output would have promised a card the product does not draw. The
README says so rather than leaving it to be discovered.

The extraction itself is provider-agnostic (a raw regex per line), so the work
is the traversal and the roots, not the parsing. **The reason this is not a
one-line change is cost, and it must be measured before it is shipped**: the
cold corpus scan is already ~77s on the author's machine over the claude store
alone, and cursor's store on that machine is ~50 project directories while
codex's is a date tree. Measure a cold scan across all three roots before
deciding whether this can stay a single scan, needs per-provider incremental
caching, or belongs off the UI process entirely (see the item above).

## Shipped

- **Orch chip on an all-live project, confirmed by eye** (2026-07-25). The
  state was created for real instead of waiting for it: a scratch project
  (`orch-chip-proof`) with exactly one session, launched through `bin/ai` into
  the real daemon, herdr-detected (`agent_session` joined its history row), so
  the project was genuinely all-live. The chip rendered on hover and opened a
  panel that resolved the correct root. Session /exit-ed, workspace closed,
  transcript and scratch dir removed afterward.

- **Three top-level views: Agents, Orch, Artifacts** (2026-07-25). A segmented
  control by the live pill switches the main pane between the conversation
  stage, orchestration (promoted to a peer; the title-bar entry lands on a
  project picker, the rail chip still opens a project directly), and the new
  Artifacts view: agent-produced HTML/images/PDFs/videos discovered from the
  transcripts (a file counts when a recent session names it, it exists, and its
  mtime is not older than that session's start), grouped by project like the
  rail, cached to `~/.cache/harbor/artifacts-index.json`. Everything renders
  INLINE through the allowlisted `harbor-artifact://` scheme (Range-capable):
  HTML in a sandboxed iframe, PDFs via Chromium's built-in viewer (plugins
  enabled; that frame is unsandboxed by necessity), video in `<video>`.
  http(s) and file subframe documents are refused in main, so no artifact
  frame can turn the viewer into a browser or navigate the shell.
- **Slash commands recognized anywhere in the draft** (2026-07-25). Recognition
  ran only on position 0, so the author's append-/quality-at-the-end pattern in long
  messages got no recolor, hint, or popup; and the recolor mirror never
  followed a wheel scroll (its sync listener could not install after mount, so
  the painted text drifted from the transparent textarea). Both shapes were
  reproduced in the real composer first. Non-leading tokens recolor only on an
  exact known-command match (a file path never lights up as a failed command),
  and only the token still being typed at the end of the draft pops
  prefix-matched suggestions.
- **Orch chip missing on all-live projects** (2026-07-25). The chip was gated on
  the P/T/S launch anchor, which requires a DEAD session because it carries the
  home a new session inherits; orchestration only needs a project root, which a
  live session answers just as well. Both the rail gate and OrchPanel's own
  finder now use `projectRootSessionId`, which also stops either of them taking
  a `live:` pane row that holds no session id at all.
- **Drag and drop files/images anywhere in Harbor** (2026-07-25). There was no
  drop handling anywhere, so Chromium navigated the window at the dropped file
  and took the whole app with it, which is the window the author lost. The window is
  now one landing zone: a dropped image saves and attaches to the selected
  session's draft exactly like a pasted screenshot, any other file appends its
  absolute path like the `+ add files` menu, and the composer rings as the
  target while a file drag is over the app. The guard is two-layer and
  independent of the feature: the renderer preventDefaults every file dragover
  and every drop in CAPTURE phase (so no child, xterm included, can swallow one
  and leave the default in place), and the main process refuses `will-navigate`
  and `setWindowOpenHandler` outright, because this app never navigates after
  its own load.
