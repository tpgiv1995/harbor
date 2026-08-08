# Harbor on Windows

**Status: the core session lifecycle is now proven on real Windows hardware,
driven directly. The Harbor Electron GUI itself has never been launched
there.** As of 2026-08-07 (see the third update below and `AGENTS.md` §11):
working and verified are install, `node-pty` with a real ConPTY binding,
daemon start, spawning a session, sending input, reading the screen, and
closing a session. Not working or not yet attempted: many unit tests still
fail on POSIX assumptions, one test suite hangs, and nobody has launched the
Electron app on Windows at all. Treat "the session backend works on Windows"
and "Harbor runs on Windows" as two separate claims; only the first is
proven. The rest of this document, including the checklist below, predates
that progress and is kept for its real, verbatim output.

> **Update, same batch that added Harbor's installers:** the protocol blocker
> this document originally described as unconditional ("there is no
> combination of currently published builds in which Harbor and Herdr can
> talk to each other on Windows") was resolved on 2026-07-29, the same day
> this document was written: Harbor's allowlist now accepts **both** protocol
> 16 (Herdr 0.7.4, stable, Linux) and protocol 17 (the Windows preview build
> quoted throughout this document), checked in `assertDaemonCompat` /
> `SUPPORTED_PROTOCOLS` in `app/src/main/herdr/client.js`. So the specific
> `protocol_mismatch: expected 16, got 17` failure quoted below no longer
> happens. That does **not** mean Windows is proven: nothing past the
> connection itself (a pane opening, a session launching, a transcript
> rendering, a send landing, the wizard completing, restore-on-restart) has
> been driven end to end on a real Windows machine, which is exactly what the
> rest of this document already says below, and none of that changed. Treat
> everything from "What was actually observed" onward as still accurate: it
> was never contingent on the protocol number by itself, only on getting past
> the connection to reach it.

> **Second update, 2026-08-06: a blocker upstream of everything below, found by
> audit rather than by running it.** Harbor invoked its own `bin/` scripts by
> handing the raw path to `execFile`/`spawn`. Those files are extensionless and
> carry a shebang (`#!/bin/sh` or `#!/usr/bin/env node`); Windows
> `CreateProcess` cannot execute such a file, since it is not a PE binary, not a
> `.bat`/`.cmd`, and Windows does not read shebangs. That path is how EVERY
> session launch, every resume, and both daemon starts happen, including the
> `harbor-sessiond` auto-start that runs at boot on the default backend. The
> window would have opened and then nothing else in the app would have worked,
> and the failure would have looked like a daemon problem rather than a process
> spawn problem.
>
> Fixed in `app/src/main/script-exec.js`: on Windows the interpreter is named
> explicitly and the script becomes its first argument, with
> `ELECTRON_RUN_AS_NODE=1` so the Electron binary behaves as Node. Linux and
> macOS keep the exact command they use today. Every `bin/` script is valid
> JavaScript (the sh+node polyglot is what makes one file runnable by both),
> and `app/test/main/script-exec.test.js` checks that assumption rather than
> assuming it, plus guards against anyone exec'ing a `bin/` script by bare path
> again.
>
> This makes Windows POSSIBLE. It does not make it proven, and the checklist
> below is unchanged: still nothing past the connection has been driven on real
> Windows hardware. Expect the next blocker to be the pty layer, where
> `app/src/daemon/daemon.js` and `keeper.js` hand `net.Server.listen()` a
> filesystem-style socket path rather than a `\\.\pipe\...` name. Whether Node
> accepts that on Windows has not been tested and should be the first thing you
> check after the app launches.

> **Third update, 2026-08-07: the pty-layer question above was answered, and
> the core session lifecycle now works end to end on real Windows hardware,
> on Harbor's OWN daemon, not Herdr.** `node-pty` (with the real ConPTY
> binding this update verified) belongs to `app/src/daemon/`, sessiond,
> Harbor's default session backend since the cutover documented in
> `docs/SESSION-DAEMON-CUTOVER.md`; Herdr is a separate Rust binary and is
> not involved in what this update proved. So the protocol-mismatch saga
> this whole document is otherwise about is specific to the OPTIONAL Herdr
> fallback backend (`HARBOR_SESSION_BACKEND=herdr`): a Windows install that
> stays on the default backend never touches Herdr, never hits protocol 17,
> and never needs any of the Herdr-specific troubleshooting below. Verified
> directly against the daemon and pty layer (not through the Electron
> GUI, which still has not been launched on Windows at all): daemon start,
> spawning a session, sending input, reading the screen, and closing a
> session. Fixes made along the
> way, recorded here so they are not rediscovered: `process.getuid` does not
> exist on Windows; Node's `net` module supports only named pipes there, so a
> filesystem-style `.sock` path fails with `EACCES`; a named pipe creates no
> file on disk, so a readiness check built on `fs.existsSync` against a socket
> path can never pass; and `node-pty` refuses a signal argument to `kill`.
> Still open: many unit tests fail on POSIX assumptions (`/proc`, file modes,
> the PATH executable bit), one test suite hangs, and the Electron GUI itself
> has never been launched on Windows. Full statement: `AGENTS.md` §11
> ("Platform status, stated plainly").

This is not a guess and it is not a configuration problem on any particular
machine. It is a version bind between two things neither of which is wrong on its
own. Everything below was performed on a real Windows 11 box on 2026-07-29 and
the outputs are quoted verbatim.

## The blocker, in one paragraph (historical; see the update above)

Herdr publishes Windows binaries **only on the preview channel**; there is no
Windows build of the stable 0.7.4 release that Harbor pins. The current Windows
preview is `0.7.5-preview.2026-07-21-0f10e1453a7f`, and it speaks **protocol 17**.
At the time this was written, Harbor asserted **protocol 16** on connect and
showed a degraded-daemon banner on anything else. Harbor's protocol allowlist
was widened to accept 17 as well later the same day (see the update above), so
this specific mismatch is no longer the blocker; the section is kept as-is
below because everything that was tested against it (the daemon starting, the
socket paths, the "Harbor refuses that daemon" result) is still real, verified
output from a real machine.

## What was actually observed

Test machine: Windows 11, `10.0.26200.0`, `AMD64`, PowerShell `5.1.26100.8655`.

### Herdr installs cleanly

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://herdr.dev/install.ps1 | iex"
```

```
==> Fetching Herdr preview manifest
==> Installing Herdr 0.7.5-preview.2026-07-21-0f10e1453a7f for x86_64-pc-windows-msvc
==> Downloading Herdr
==> PATH updated for future PowerShell sessions.
Herdr 0.7.5-preview.2026-07-21-0f10e1453a7f installed successfully.
```

It lands in `%LOCALAPPDATA%\Programs\Herdr\bin\herdr.exe`, with releases kept
under `%USERPROFILE%\.herdr\packages\standalone\releases`. **PASS.**

### The daemon starts and answers a real request

```
{"id":"cli:api:snapshot","result":{"snapshot":{"agents":[],"layouts":[],"panes":[],
"protocol":17,"tabs":[],"version":"0.7.5-preview.2026-07-21-0f10e1453a7f",
"workspaces":[]},"type":"session_snapshot"}}
```

**PASS**, and note `"protocol":17`.

Its sockets appear as named pipes:

```
%USERPROFILE%\AppData\Roaming\herdr\herdr.sock
%USERPROFILE%\AppData\Roaming\herdr\herdr-client.sock
```

### Harbor refuses that daemon

Running Harbor's own `assertDaemonCompat` against exactly the value above:

```
windows beta -> {"ok":false,"error":"protocol_mismatch: expected 16, got 17","protocol":17}
linux 0.7.4  -> {"ok":true,"protocol":16,"schemaVersion":1}
```

**FAIL.** This is the blocker. Every validation step below it (Harbor connects, a
pane opens, a session launches, a transcript renders, a send lands, the wizard
completes, the app restarts and restores) is **NOT VALIDATED**, because they all
sit behind a connection that cannot be established. They are not reported as
passing and they are not reported as failing. They were not reached.

## The other things you will hit, once the blocker is lifted

These are real and known now, so they are written down rather than rediscovered.

### The socket path must be set by hand

Harbor's Windows adapter **throws unless `HERDR_SOCKET_PATH` is set**:

> `HERDR_SOCKET_PATH must name the real Herdr Windows named pipe`

That is deliberate. Upstream does not publish a stable pipe name, so Harbor
refuses to guess one rather than silently connecting to nothing. The value to use
is the socket path Herdr reports in `herdr status`, which on the test machine was
`%USERPROFILE%\AppData\Roaming\herdr\herdr.sock`.

### SSH lands you in session 0, where no GUI can render

`(Get-Process -Id $PID).SessionId` returned `0` over SSH. Windows session 0 is
non-interactive: Electron will not show you a window there, and a run that
"succeeded" in session 0 rendered nothing to anybody. Do not report a launch from
an SSH shell as a launch.

The working pattern for anything needing the interactive desktop is a scheduled
task registered interactive-only, driven by a file-based request/response queue
because `schtasks` cannot pass arguments at run time:

```powershell
schtasks /create /tn HarborRun /it /sc once /st 00:00 /tr "..."
```

Related: a daemon started with `Start-Process` from an SSH session **did not
survive that session ending**. It has to be launched from the interactive session
or registered as a task.

### PowerShell over SSH mangles quoting

Ordinary quoting through `ssh host 'powershell -Command "..."'` corrupts on the
way. Use base64 UTF-16LE:

```sh
powershell -NoProfile -EncodedCommand <utf16le-base64>
```

Use `sftp` rather than `scp` for file transfer.

### Node version

The test machine had Node **v20.18.1**. Harbor is built and tested on **v22**.
Install Node 22 before trying to build Harbor there.

### Upstream's own Windows caveats that matter to Harbor

From Herdr's Windows beta documentation, filtered to things Harbor depends on:

| Capability | Upstream status | Why Harbor cares |
| --- | --- | --- |
| Clipboard image paste | **unverified** | Harbor's drag-drop and paste-image flows attach images to the composer. |
| Live cwd after a shell `cd` | **partial** | Harbor keys project grouping and transcript lookup off the session cwd. |
| Agent process detection | beta, different model | Windows scans descendants of the pane shell instead of Unix foreground process groups; Harbor's live/idle rail state reads this. |
| Panes | beta, via ConPTY | Not the Unix PTY model Harbor's byte bridge was built against. |
| Plugins | preview, best effort | Commands must be Windows-compatible argv; `sh`-based ones need alternatives. |

## What it would take to unblock this

Two options were listed here originally, and the choice was a judgement call
about risk, not a technical toss-up.

1. **Wait for a stable Windows release.** Zero risk to the Linux install, and no
   timeline, since upstream says Windows may graduate to stable, stay preview, or
   be reduced depending on beta feedback. Still the safer long-term option and
   still not scheduled.

2. **Move Harbor to accept protocol 17 / Herdr 0.7.5-preview, as an explicit
   allowlist rather than a `>=` comparison.** This is the option that was
   taken, the same day this document was first written: Harbor's protocol
   check is now `SUPPORTED_PROTOCOLS = [16, 17]`
   (`app/src/main/herdr/client.js`), an explicit two-value allowlist, exactly
   so that a future protocol 18 still fails closed instead of being silently
   accepted. This removed the specific blocker described above. It did **not**
   re-run the Linux gate against 0.7.5-preview and did not move Linux off the
   pinned stable 0.7.4; Linux keeps running 16, Windows would run 17, and both
   are now individually allowlisted rather than either being treated as "close
   enough."

Getting past the protocol check is not the same as Windows being supported.
As of 2026-07-29 (when this section was written), nothing past "Harbor
connects" in the numbered list under "Harbor refuses that daemon" above had
been re-attempted on a real Windows machine. **That has since changed for the
default `sessiond` backend specifically**: see the third update near the top
of this document. Session launching, sending input, reading the screen, and
closing a session are now proven there, directly against the daemon, not
through the Electron GUI. Still genuinely open: the wizard completing, restore
on restart, and the Electron GUI itself, which has never been launched on
Windows at all.

## Installer (NSIS)

As of this same batch, `.github/workflows/build.yml` (or `cd app && npm
install && npm run dist:win` run directly on a Windows box) produces an NSIS
installer via `electron-builder`. That installer is **unsigned**; Windows
SmartScreen will warn on first run, and there is no code-signing certificate
configured to change that (see `docs/PACKAGING.md`).

Producing that `.exe` has not been tested on a real Windows machine as part of
this batch, and running it has not been tested at all: everything in this
document above about the daemon connection being unproven past the protocol
check applies identically to a session launched from the installer, since the
installer runs the exact same `app/dist/` and `app/src/` the from-source path
runs, packaged rather than run from a checkout. Do not read "an installer
exists" as "Harbor runs on Windows." It means exactly what section 8
"Gatekeeper and the unsigned app" in `setup/macos/README.md` means for macOS:
there is now something to double-click, and whether it works is still the
open question this whole document is about.
