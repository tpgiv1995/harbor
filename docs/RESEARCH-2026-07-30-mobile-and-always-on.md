# Harbor on a phone, and Harbor that is always up

> **Status: research note, not a description of shipped behavior.** This is a
> feasibility investigation, not a build log. Layer 0 and Layer 1 below describe
> what exists or was verified feasible; **Layer 2 (a second, always-on host, and
> multi-host support generally) was never built.** What actually shipped is a
> single-machine server: `app/src/server/compose.js` composes and binds exactly
> one `harbor-server` process, to loopback or a single Tailscale address, with no
> host-merging, no multi-server routing, and no `host` field anywhere in the
> shared session model. Read everything from "Layer 2" onward as a proposal.

Research note, 2026-07-30. Two wants, investigated together because they turn out
to be one architecture question plus one trap.

- **Want A**: a mobile Harbor for a phone. Different UI, same functionality.
- **Want B**: the "server" lives on a second, always-on machine, so the phone
  and every other device keep working without the primary workstation being
  awake and online.

Verdict up front: **A is very feasible and the codebase is unusually well shaped
for it. B is feasible but is not the thing it looks like**, and the honest cost
sits in the repos, not in the code.

---

## 1. The measurements this is built on

Everything below rests on numbers taken from the real machines on 2026-07-30,
not estimates.

| Fact | Measured value |
|---|---|
| Primary workstation | 62 GB RAM, 24 cores, Ubuntu 26.04 |
| Second, always-on machine | 16 GB RAM, Windows 11 Home, 784 GB free disk |
| Second machine uptime | continuously up since 2026-06-30 |
| Second machine virtualization | `HypervisorPresent: True`; WSL and VirtualMachinePlatform features currently **Disabled** |
| Second machine tooling already present | `node`, `claude`, `herdr.exe`, `tailscale` |
| Tailnet | Tailscale 1.98.9, HTTPS certs already provisioned |
| Phone on tailnet | offline, last seen 2 days ago |
| RAM per live Claude Code session | **434 to 560 MB RSS**, 7 sessions sampled |
| Herdr daemon | 31 MB |
| Harbor Electron | 1.5 GB across 9 processes |
| Transcript store | 4.5 GB, 3,820 JSONL files |
| Claude Code version | 2.1.220, Remote Control **eligible** |

**The primary workstation genuinely sleeps.** It suspended at 19:55 and resumed at 21:31
on 2026-07-30: 96 minutes during which a phone client would have been dead.
`sleep-inactive-ac-type` is `nothing` and the machine is on AC, so this was a lid
close or a manual suspend, which is exactly the case that no power setting fixes.
Want B is a measured problem, not a hypothetical one.

---

## 2. Why the mobile app is genuinely feasible

Not "possible with enough work". Feasible, because of one structural fact.

**Harbor's renderer already talks to its backend across a narrow, serializable,
typed boundary**: `/home/you/dev/harbor/app/src/preload/index.js` exposes
`window.harbor` as 76 request/response IPC handlers plus roughly 20 push
channels. Nothing crosses that bridge except JSON and base64. That is, exactly,
the shape of a WebSocket RPC API. It was not designed to be one, but it is one.

**And the backend is almost entirely not Electron.** Of the 53 modules under
`/home/you/dev/harbor/app/src/main/`, **49 have no `require('electron')`
at all.** The Herdr client, the pane stream supervisor, the transcript parser,
`session-send.js`, `menu-parse.js`, `ask-question.js`, every provider, the
sidebar bridge, the terminal bridge, workflow runs: all plain Node.

The four that do touch Electron:

| Module | Coupling |
|---|---|
| `/home/you/dev/harbor/app/src/main/index.js` | the composition root and IPC wiring (expected) |
| `/home/you/dev/harbor/app/src/main/config/store.js` | `app \|\| require('electron').app` for `getPath('userData')` |
| `/home/you/dev/harbor/app/src/main/providers/project-icons.js` | same pattern |
| `/home/you/dev/harbor/app/src/main/providers/tasks.js` | same pattern |

All three of the non-root couplings are **already written as injectable**
(`app || require('electron').app`), and `/home/you/dev/harbor/app/src/shared/tasks-file.cjs`
already derives a userData path with no Electron at all, because the
`harbor-tasks` CLI needs it. The seam exists and is already load bearing.

**Conclusion: a headless Harbor server is a re-composition, not a rewrite.** It
reuses the backend verbatim and swaps `ipcMain` for a socket.

### What is genuinely Electron-only, and what it becomes

| Today | Headless equivalent |
|---|---|
| `protocol.handle('harbor-artifact://')`, `harbor-icon://` | HTTP routes on the same server, same allowlist logic |
| `dialog.showOpenDialog` (folder/file pick) | server-side directory-listing RPC, client draws the picker |
| `clipboard` read/save image | client-side; phone supplies its own image bytes |
| `Notification` | Web Push, or lean on the Claude iOS app (see section 5) |
| `screen`, `BrowserWindow`, window bounds | dropped; the client owns its own layout |
| `shell.openExternal`, `showInFolder` | desktop-only, degrade honestly on mobile |

None of these are structural. The allowlist logic that makes
`harbor-artifact://` safe is in `/home/you/dev/harbor/app/src/main/providers/artifacts.js`,
not in the protocol handler, so it survives the move intact.

---

## 3. The trap in Want B

"Put the server on the second machine" sounds like a hosting change. It is not.

**Harbor does not do anything by itself.** It supervises Claude Code sessions
that run against real repositories on a real filesystem. Sessions run where the
Herdr daemon runs, and they edit files on that machine's disk.
`/home/you/dev/harbor/app/src/main/herdr/streams.js` spawns
`herdr terminal session observe|control <pane>` child processes against a unix
socket, so **the Harbor server must be co-located with its daemon**, and the
daemon must be co-located with the work.

So "move the server to the second machine" actually means **"make that machine a
second development host."** Moving Harbor without moving the work accomplishes
nothing: you would get a phone client that can beautifully observe an empty
machine.

That reframe produces the right architecture. The answer is not *move Harbor to
the second machine*. It is **make Harbor multi-host**, because:

1. Step 1 of that (headless server plus network client) is required by every
   possible version of the answer, so no work is wasted.
2. Once "host" is a first-class concept, the primary workstation, the second
   machine, and any future mini PC are all just hosts.
3. **Nothing has to move.** The primary workstation stays the heavy box. The
   second machine runs a second server for always-on work.
4. The phone connects to whichever is up, or both.
5. Zero desktop regression: the Electron client keeps its localhost fast path.

The rail already merges sessions from three config homes and three providers
using `/home/you/dev/harbor/app/src/shared/sidebar-model.cjs`. Adding a
`host` field to that merge is a natural extension of something the model already
does, not a new concept.

---

## 4. The recommended shape, in three layers

### Layer 0: tonight, zero code

**Turn on Claude Code Remote Control.** Verified eligible on this machine at
v2.1.220 (`claude remote-control --help` prints its flag list, which the CLI only
does for an eligible login).

What it actually gives, from the official docs at
`https://code.claude.com/docs/en/remote-control`:

- Server mode runs **up to 32 concurrent sessions** (`--capacity`, default 32),
  with `--spawn worktree` for isolation
- The **Claude iOS app** drives them: read the conversation, send messages,
  **approve permission prompts**, attach images from the phone
- **Push notifications** when a long turn finishes or a decision is needed
- Local MCP servers, filesystem and project config all stay available
- `/config` → **Enable Remote Control for all sessions** makes *every*
  interactive session register automatically, including ones Harbor launches
- Outbound HTTPS only, no inbound ports

What it does **not** give, which is why it does not end this project: no rail
across 3,820 historical transcripts, no three config homes, no Tasks view, no
Artifacts, no usage meters, no orchestration, no codex/cursor, no fleet view, and
**it still requires the machine to be awake**. Note also that while connected,
the transcript is stored on Anthropic's servers.

**Also tonight**: stop the primary workstation suspending. It cost 96 minutes today.

Realistically Layer 0 covers a meaningful slice of the mobile want in about
thirty minutes, and it is worth having regardless of what gets built.

### Layer 1: split Harbor into server plus clients

This is the actual build, and it is where the value is.

1. **Extract a transport-agnostic router** out of
   `/home/you/dev/harbor/app/src/main/index.js`. The 76 handlers become
   RPC methods; the ~20 push channels become server-to-client events. The
   Electron app keeps working by binding that router to `ipcMain`, unchanged.
2. **`harbor-server`**: plain Node, no Electron, no Chromium. Injects a fake
   `app` with `getPath('userData')` (the three couplings already accept it).
   Serves the RPC over WebSocket and the artifact/icon schemes over HTTP.
3. **`harbor-web`**: mobile-first React client. Reuses the `shared/` twins
   verbatim (`sidebar-model`, `tasks-model`, `date-roll`, `session-liveness`,
   `terminal-layout`) plus the conversation renderer and `md.jsx`.

**Transport: Tailscale.** The phone is already a tailnet node.
WireGuard-encrypted, device-authenticated, no port forwarding,
no public exposure. `tailscale serve` provides a real Let's Encrypt certificate
on `*.ts.net`, and certs are already provisioned for the primary workstation, which is what
a PWA needs for a secure context. **Do not use Tailscale Funnel**: `session.send`
puts arbitrary text into agents running `--dangerously-skip-permissions`, and
that must never be reachable from the public internet.

**The mobile UI is not the desktop UI shrunk.** The 16-window stage is
meaningless on a phone. What actually matters, in order:

1. Read what an agent is doing (transcript rendering, already exists)
2. **Answer a question or permission card** (the highest-value action: it
   unblocks a stuck agent from anywhere; `session:menu-state` /
   `session:menu-answer` already exist and already handle five dialog shapes)
3. Send a follow-up message
4. Tasks

So: one session at a time, swipe between open sessions, rail as a bottom sheet,
question cards as full-width native-feeling prompts. The `>_` xterm stays
available as a fallback but is explicitly not the surface, and terminal frame
streaming should be opt-in on mobile since it is by far the heaviest channel.

### Layer 2: the second machine as the always-on host

Run a second `harbor-server` on that second machine, **inside WSL2 Ubuntu, not
native Windows.**

Why WSL2 and not Windows directly:

- Real Linux, real ptys, and **Herdr 0.7.4 stable, protocol 16**. Native Windows
  Herdr ships only on the preview channel at protocol 17, uses ConPTY, is marked
  beta upstream, and per `/home/you/dev/harbor/docs/HANDBOOK.md` §7 Harbor
  has never been driven against it beyond "connects".
- Everything already validated on Linux applies unchanged: `bin/herdr-server-clean`,
  the systemd unit, `/proc`-based process identity. Process identity is called
  out in the handbook as the single highest-consequence porting risk, and WSL2
  sidesteps it entirely by having a real `/proc`.
- Hyper-V is already present on it; this is one `wsl --install` plus a reboot.

**Measured capacity, honestly stated.** At ~500 MB per Claude session:
16 GB, minus Windows (~4 GB), minus WSL2 overhead (~1 GB), leaves roughly 10 GB.
That is **comfortably 12 to 16 concurrent sessions**, since the headless server
is plain Node and costs a fraction of Electron's 1.5 GB. What it will **not**
take is a large workflow fleet: a 16-agent fan-out is another 8 GB on top. That
is a real ceiling and it is fine, because heavy fleets belong on the 62 GB box.

Division of labour that falls out of this: **the second machine** takes
long-running and overnight agent work, scheduled sessions, the Tasks list, and
monitoring. **The primary workstation** stays the heavy interactive dev box and
the workflow-fleet host.

---

## 5. Risks, in the order they are likely to bite

1. **The repositories are the real cost, not the code.** Two hosts means two
   working copies. The only sane mediator is **git**: the second machine holds
   its own clones and work moves by branch and PR. Do not reach for Syncthing or Dropbox
   on live repos: two writers on one working tree is the same failure class that
   Harbor's own 90-second resume live-guard exists to prevent, and it will
   corrupt work rather than merely annoy. This is a habit change more than a
   build, and it is the part most likely to be underestimated.

2. **Tailscale HTTPS from iOS is unverified here.** Tailscale issue #19147
   (still open) reports iPhones failing TLS to `*.ts.net` serve endpoints. It is
   a single report and smells like configuration, but it sits directly under the
   PWA plan. **Test it in ten minutes before committing**: `tailscale serve` a
   hello-world on the primary workstation and load it in Safari on the phone. Fallbacks if
   it bites: a native Expo client over plain `ws://` on the tailnet, which needs
   no secure context at all, or a real domain with DNS-01 certificates.

3. **iOS PWA push is fragile.** Web Push requires Add to Home Screen, there is no
   background sync, and iOS can evict the service worker. The clean answer is a
   hybrid: **let the Claude iOS app's own push handle "an agent needs you"**
   (free, native, already works via Layer 0) and let Harbor Web own the fleet
   view. That avoids building the least reliable part of the stack.

4. **Transcript volume.** 4.5 GB across 3,820 files. The desktop pushes fully
   parsed conversations; a phone on cellular cannot. `transcript.js` already
   tails, but it needs a windowed "last N blocks" mode with scroll-back paging
   before it faces a phone.

5. **Security posture.** Tailnet-only plus Tailscale device auth is the floor,
   not a nicety, for the reason in Layer 1. Additionally the server should
   refuse `session.send` from an unauthenticated socket even on the tailnet.

6. **Do not fork the logic.** The single biggest quality risk is a mobile client
   re-deriving what a session, a task, or liveness means. The `.js`/`.cjs` twin
   discipline in `/home/you/dev/harbor/app/src/shared/` exists precisely
   to stop that. Extend it; never let the web client grow its own copy.

---

## 5a. Does the split slow the Linux desktop down? Measured: no

The author's first reaction, and the right one to check before agreeing to any of this:
does making Harbor client/server make the workstation, the primary driver, laggy?

**Measured on 2026-07-30 under real load** (7 live Claude sessions, Harbor
running, load average 1.41), via
`/tmp/claude-1000/-home-you-dev-harbor/*/scratchpad/ipc-bench.js`:

| Case | Result |
|---|---|
| RPC round trip, unix domain socket, realistic JSON payload | **median 7.8 us, p95 10.1 us, p99 14.4 us** |
| `terminal:frame` streaming, 256 B frames | 679,000 frames/s, 166 MB/s |
| `terminal:frame` streaming, 2 KB frames | 222,000 frames/s, 435 MB/s |
| `terminal:frame` streaming, 8 KB frames | 75,000 frames/s, 590 MB/s |
| Harbor's measured keystroke-to-paint p95 (`docs/BACKLOG.md`) | 126 ms |
| Added RPC cost as a share of that budget | **0.008%** |

Two facts make this decisive rather than merely favourable:

1. **The frame path already crosses a process boundary.**
   `/home/you/dev/harbor/app/src/main/herdr/streams.js` spawns
   `herdr terminal session observe` as a child process and parses NDJSON off its
   stdout. A server split adds a second hop that is cheaper than the existing one.
2. **The desktop does not have to change at all.** The router extraction is a
   dispatch-table refactor: `ipcMain.handle('x', fn)` becomes
   `router.register('x', fn)` plus a one-line `ipcMain` binding. That is one
   extra function call, not a socket.

Three configurations, in ascending cost:

| Config | Desktop cost | Phone works when Harbor is closed |
|---|---|---|
| Electron keeps everything in-process, also hosts the WS server | zero | no |
| `harbor-server` as a systemd user service, Electron over a unix socket | 8 us per RPC | yes |
| Desktop routed through the network stack | real | yes, and nobody should do this |

Start at config 1. Move to config 2 only when "phone works with Harbor closed"
is worth 8 microseconds.

**The split plausibly makes the desktop faster.** Today the process that owns the
window also runs transcript parsing (a 51 KB parser over a 4.5 GB store), the
indexer, artifact discovery (77 s cold corpus scan), thumbnail generation via
offscreen Electron captures, and the 275 MB model-catalog binary scan. Harbor
Electron measures 1.5 GB across 9 processes. The open composer-freeze item in
`/home/you/dev/harbor/docs/BACKLOG.md` added `blocked-main-process`
instrumentation precisely because a main-process stall "produces the identical
symptom because X11 input dispatch rides through it". Moving the backend out
does not fix that bug, which is still undiagnosed, but it removes an entire class
of candidates from the process where a stall becomes a freeze.

**What would genuinely degrade quality**, none of which is the transport:

- Making the Electron client a thin client that re-fetches over the wire instead
  of keeping its local caches. It must keep its fast path.
- Letting a slow phone backpressure the desktop. Bounded per-client queues, drop
  frames for slow clients, never block a write on a cellular socket.
- The web client forking logic out of `/home/you/dev/harbor/app/src/shared/`.
  This is the real quality risk in the project and it is a discipline problem,
  not a performance one.

**The gate**: the existing two-run E2E gate green, plus a keystroke-to-paint run
at nine windows compared against the baseline table already recorded in
`/home/you/dev/harbor/docs/BACKLOG.md`. If the split costs anything
visible, that harness reports it before it is ever felt.

## 6. What this does not require

Worth stating, because each of these would have been a plausible and much worse
plan:

- **No fork of Herdr.** Unchanged: Harbor stays a third-party client of a stock
  pinned daemon.
- **No rewrite of the renderer.** The desktop app keeps its stage, its 16
  windows, and its localhost path.
- **No move of the transcript store**, and no change to the invariant that
  Harbor never writes `~/.claude/projects/`.
- **No native Windows port of Harbor.** WSL2 makes the Windows delta irrelevant.
- **No public internet exposure.** Nothing is ever Funnelled.

---

## 7. Order of work

| Step | Effort | Unblocks |
|---|---|---|
| 0a. Enable Remote Control, `/config` all-sessions on | 15 min | phone access to live sessions tonight |
| 0b. Stop the primary workstation suspending | 15 min | removes the 96-minute dead window |
| 0c. Test `tailscale serve` HTTPS from the phone | 10 min | de-risks the entire PWA plan |
| 1a. Extract the transport-agnostic RPC router | ~2-3 sessions | everything below |
| 1b. `harbor-server` headless, Electron client on it | ~1-2 sessions | proves zero desktop regression |
| 1c. `harbor-web` mobile client: read, answer, send, tasks | ~3-5 sessions | the actual mobile app |
| 2a. WSL2 Ubuntu on the second machine, Herdr 0.7.4, harbor-server | ~1-2 sessions | always-on host |
| 2b. `host` field through the sidebar model, multi-host rail | ~1-2 sessions | one rail, both machines |

Steps 0a to 0c are worth doing tonight regardless, and 0c in particular should
happen before anyone writes a line of client code.
