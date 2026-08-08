# Installing Harbor

Harbor is a Linux desktop app for running and monitoring several Claude Code
sessions at once. It is an Electron GUI on top of a pluggable session daemon
(Harbor's own `sessiond` by default, or the third-party Herdr terminal daemon
as a fallback): it drives your agent sessions through that daemon and renders
their conversations by reading the transcript files Claude Code writes to disk.

Everything below was performed on a clean checkout against an empty home
directory on 2026-07-29. Where something is untested, this document says so.

## What you need

| Requirement | Version validated | Notes |
| --- | --- | --- |
| Linux | Ubuntu-family, GNOME/X11 | The only platform validated end to end. See `../windows/README.md` and `../macos/README.md`. |
| Node.js | v22.22.1 | v22 is what the app is built and tested with. |
| npm | 9.2.0 | Ships with Node. |
| Herdr | **Optional.** 0.7.4 exactly, only if you use it. | See "Which session daemon" below. |

Electron (^37.2.6) is installed by `npm install`; you do not install it
separately.

### Which session daemon: you probably do not need Herdr at all

Harbor drives sessions through a pluggable backend, chosen by the
`HARBOR_SESSION_BACKEND` environment variable (`app/src/main/session-daemon/factory.js`,
detail in `../../docs/SESSION-DAEMON-CUTOVER.md`):

| Value | Backend | Install needed |
| --- | --- | --- |
| unset, or `sessiond` (**the default**) | Harbor's own pty daemon, `app/src/daemon/`, driven by `bin/harbor-sessiond` | None. It ships with Harbor and Harbor starts it itself. |
| `herdr` | [Herdr](https://herdr.dev), a third-party terminal multiplexer daemon that Harbor drives but never forks or replaces | **Herdr 0.7.4 exactly**, installed separately. See the pin below. |

So: install Herdr only if you intend to run with `HARBOR_SESSION_BACKEND=herdr`.
Everything else in this document that talks about `herdr-server-clean`,
`herdr-health.sh`, or the protocol pin applies only to that fallback path.

### The Herdr version pin is real, if you use the Herdr backend

When `HARBOR_SESSION_BACKEND=herdr`, Harbor asserts on connect that the daemon
speaks a protocol on its **allowlist, currently 16 or 17, with schema_version 1**
(`SUPPORTED_PROTOCOLS` in `app/src/main/lifecycle.js`). 16 is Herdr 0.7.4, the
pinned stable build; 17 is the preview channel, which is the only channel Herdr
publishes Windows binaries on, and it was added only after diffing the two
schemas and confirming every method Harbor calls exists in both.

It is an allowlist rather than a "16 or newer" comparison on purpose, so a
future protocol fails closed and gets read by a human instead of being accepted
for having a bigger number. A protocol outside it does not degrade gracefully
into partial functionality: Harbor shows a degraded-daemon banner and declines
to drive anything, because a mismatch means the API it depends on may not mean
what it thinks.

Do not run `herdr update` from a script or let anything auto-update it.

## Install

```sh
# 1. Harbor itself. Herdr is NOT required for this step; the default
#    session backend (sessiond) ships with Harbor.
git clone <your-harbor-remote> harbor
cd harbor/app
npm install              # observed: 92 packages, about 4 seconds on a warm npm cache
npm run build            # builds the renderer into app/dist/

# 2. Run it.
npm start
```

```sh
# Optional: only if you want the Herdr fallback backend instead of the default.
curl -fsSL https://herdr.dev/install.sh | sh
herdr --version          # must report 0.7.4
export HARBOR_SESSION_BACKEND=herdr
```

### Or: a packaged installer (AppImage / deb)

Running from source above is the path that has actually been validated (the
full unit suite, the two-run Playwright E2E gate, and a cold-start drive
against an empty home directory, all described below). As of this writing,
Harbor can also be packaged into a Linux AppImage or `.deb` via
`electron-builder`, either locally (`cd app && npm install && npm run
dist:linux`, output in `app/release/`) or from `.github/workflows/build.yml`
on a tagged release. **Producing that installer is proven; running Harbor
from it has not been separately re-verified** beyond "it is the same built
`app/dist/` and the same source tree the from-source path already runs" --
see `docs/PACKAGING.md` for exactly what does and does not go into it,
including a real, unresolved risk around the `sessiond` backend (Harbor's own
default terminal daemon) and how it locates its own files once packaged. If
you hit something that only breaks from the packaged build and not from
source, that document is where to start.

`npm run build` is required before `npm start`. Electron loads `dist/index.html`
over `file://`, and without a build there is no renderer to load. During
development `npm run dev` runs a Vite dev server instead and needs no prior build.

## First run

The first launch opens a seven-step setup wizard, because there is no config yet:

1. **Welcome** shows what Harbor found on this machine: your OS, home folder,
   the Herdr binary and its version, and which agent CLIs (`claude`, `codex`,
   `cursor-agent`) are on your PATH. Everything on this screen is editable.
2. **Claude plans** is the important one. A "plan" is one Claude config home, the
   folder holding that account's `.claude.json`. Harbor detects `~/.claude` and
   shows the signed-in email next to it. Add one plan per account you run. Adding
   none is fine if you only use Codex or Cursor.
3. **Codex and Cursor** enables the other agent CLIs it found.
4. **Commands** picks up your skills and slash commands.
5. **Shared config** is optional and symlinks settings across config homes.
6. **Orchestration** is optional and controls whether the Orch view appears.
7. **Defaults** sets what new sessions launch with, then review and finish.

No step can be skipped into a dead end: if a screen will not advance it shows a
field-level reason. Finishing writes `~/.config/harbor/config.json` and reloads
the app onto it.

You can reopen the wizard at any time from the app menu.

## The daemon

By default Harbor drives sessions through its own daemon, **sessiond**
(`app/src/daemon/`, controlled through `bin/harbor-sessiond`). Harbor starts it
automatically; there is nothing to run by hand for ordinary use. Its store
lives at `~/.local/state/harbor/sessiond`.

```sh
./bin/harbor-sessiond status   # confirm it is up: {"ok": true, ...}
```

### If you are on the Herdr backend (`HARBOR_SESSION_BACKEND=herdr`)

Harbor starts the Herdr daemon itself when it needs one. **Start it only through
`bin/herdr-server-clean`**, never with a bare `herdr server`:

```sh
./bin/herdr-server-clean
```

That script exists for reasons that are not cosmetic. It starts the daemon with a
scrubbed environment allowlist, so a daemon started from inside an agent session
cannot leak that session's ids and API keys into every pane it spawns. It also
puts the daemon in its own systemd unit (`herdr-daemon`) rather than the cgroup
of whichever window launched it, so a memory-pressure kill on your desktop
session does not take the daemon and every live agent session with it. And it is
the only sanctioned recovery for a half-dead daemon: one whose main thread has
died while its worker threads keep the listening socket open, which accepts
connections and answers nothing.

To check whether a Herdr daemon is usable:

```sh
./bin/herdr-health.sh ; echo "exit: $?"
```

Exit 0 means it answered a real request. Do not use `herdr status` for this: a
zombie daemon still answers `status: running` in milliseconds because that reply
needs no main thread.

Daemon stderr appends to `~/.cache/harbor/herdr-daemon.log`.

## The `bin/` scripts

`bin/` holds the reusable organs: the session indexer, the resume picker, the
launcher, the daemon starter, the health probe. Five of them look like shell
scripts and are not. They open with a polyglot:

```sh
#!/bin/sh
':' //; exec node "$0" "$@"
```

so the only shell that runs is that `exec` line and the rest is JavaScript. Two
consequences worth knowing: **`node` must be on your PATH** for any of them to
work, and `sh -n bin/ai` will fail because it is parsing JavaScript as shell. To
syntax-check them, use `node --check`.

### `bin/harbor-tasks`

The Tasks view's command line. Same document, same rules, same locked atomic
write as the app, so an agent session can read and edit the list while Harbor is
open and the app repaints. Put it on your PATH if you want your coding agents to
be able to work with it:

```sh
ln -s "$PWD/bin/harbor-tasks" ~/.local/bin/harbor-tasks
harbor-tasks file      # the exact file it edits
harbor-tasks --help
```

Every command takes `--json`, and tasks are addressed by id or by a unique piece
of the title. If you drive it from an agent, tell that agent to act only when
you ask: a to-do list that edits itself is a to-do list you stop trusting.

## Verifying your install

```sh
cd harbor/app
npm test                 # runs the full unit suite, exits 0
npm run test:e2e         # Playwright Electron suite, run TWICE, both must pass
```

`npm run test:e2e` wraps itself in `xvfb-run` and `dbus-run-session` so test
windows never open on your desktop and no portal dialog can reach it. Do not
"fix" a hanging E2E run by giving it your real display.

**Run the suite on a quiet machine.** Two specs (`test/herdr/bridge.test.js` and
`test/herdr/control-latency.test.js`) exercise the Herdr backend specifically:
they talk to a real Herdr daemon in an isolated named session, and one of them
asserts that it leaked no processes by comparing a before-and-after snapshot of
the process table. Any *other* herdr process starting or stopping while they run
is indistinguishable from a leak, so they fail. **The most likely cause is
Harbor itself being open**, since it spawns a herdr child per visible pane when
it is running on the Herdr backend.

If you get exactly one failure and it is in one of those two files, close Harbor
and any other agent sessions and run it again before assuming anything is wrong.
Verified behaviour: red when run concurrently, green three times out of three
when run alone. This is a property of the harness, not of the code under test.

## Where Harbor keeps things

| Path | What |
| --- | --- |
| `~/.config/harbor/config.json` | Your profiles, workflows, paths, defaults. Written by the wizard. |
| `~/.cache/harbor/` | Session titles, context tees, the artifacts index, the daemon log. |
| `~/.claude/projects/**/*.jsonl` | Claude Code's transcripts. Harbor reads these; it does not own them. |
| `~/.local/state/harbor/sessiond/` | sessiond's socket and session state (the default backend). |
| `~/.config/herdr/` | Herdr's sockets and session state (only if you are on the Herdr backend). |
| `localStorage` | Rail width and grouping, open windows, per-session drafts. |

Harbor reads transcripts, it does not write them, so pointing it at an existing
Claude Code install is safe and non-destructive.

## Troubleshooting

**"Reconnecting..." banner that never clears.** On the default `sessiond`
backend, check `./bin/harbor-sessiond status`. On the Herdr backend, the daemon
is more likely wedged than dead: run `./bin/herdr-health.sh`; if it hangs into
its timeout, run `./bin/herdr-server-clean`, which moves the non-answering
sockets aside as `*.dead-<timestamp>` (it never deletes them) and starts a
fresh daemon.

**Degraded-daemon banner.** On the Herdr backend, your Herdr is probably not
0.7.4; check `herdr --version`. On the default `sessiond` backend this banner
means the session backend it selected could not be reached at all; see
`../../docs/SESSION-DAEMON-CUTOVER.md`.

**A session window says "No transcript yet" and stays there.** That is a real
transcript that has not been located. It should self-heal within a few seconds;
if it does not, the session id and its project directory are the thing to check.

**The app opened but the window is blank.** You skipped `npm run build`.
