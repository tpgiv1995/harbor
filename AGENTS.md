# AGENTS.md

**You are an AI coding agent helping someone install, configure and run Harbor
on their machine.** This file is the reference for that job: what Harbor
expects, every knob it has, how to discover what this particular user already
has, how to verify each piece separately, and what to do when something is off.

This is a different job from `CLAUDE.md`, which is the working instruction file
for *developing* Harbor. If you are changing Harbor's own source, read that one.
If you are getting it running for a user, stay here.

**The premise:** Harbor was developed on one Linux machine, and your user's
setup is not that machine. Different config homes, different accounts,
different CLIs installed, different shells, maybe a different OS. That is the
normal case. Almost every section below exists because an assumption about
"the machine" turned out to be wrong somewhere. Prefer discovering over
assuming, and read the *why* before you change anything: several behaviours
that look like bugs are deliberate guards.

---

## 1. Discover the machine before you touch anything

Run these and read the answers back to your user. Everything after this depends
on what they say.

```sh
node -v                                  # must be >= 22
uname -s                                 # Linux is validated; see section 11
ls -d ~/.claude ~/.claude-* 2>/dev/null  # Claude config homes = "plans" in Harbor
ls ~/.claude/projects 2>/dev/null | wc -l  # existing sessions Harbor will index
command -v claude codex cursor-agent herdr 2>/dev/null
```

What each answer changes:

| Answer | Consequence |
|---|---|
| Node < 22 | The build fails inside `vite.config.js` with an ESM/`require` error that names a module, not the version. Upgrade Node first; nothing else will make sense. |
| Several `~/.claude*` homes | Each is a separate **profile** (Harbor calls them plans). Harbor discovers them; it does not assume names. |
| No `~/.claude/projects` | Harbor has nothing to show yet. This is fine. It never writes there. |
| `codex` / `cursor-agent` missing | Those providers are simply disabled. Not an error. |
| `herdr` missing | Fine. It is only needed for the non-default session backend. |

---

## 2. Install

```sh
cd app
npm install      # postinstall also installs the daemon's own dependencies
npm run build    # renderer -> app/dist/; npm start loads it over file://
npm start
```

`npm install` matters more than it looks. The session daemon runs under the
**system Node**, not under Electron, so its runtime dependencies (`node-pty`,
`@xterm/headless`) live in `app/src/daemon/package.json`, not the app's. The
`postinstall` hook installs them. If you ever see sessions that will not start,
check this first:

```sh
node -e "require.resolve('node-pty',{paths:['app/src/daemon']})"
```

`MODULE_NOT_FOUND` there means the daemon can never open a pty. Fix with
`npm install` from `app/`, or `npm run pack:daemon-deps` for just those.

First launch opens a seven-step setup wizard, because there is no config yet.
Everything it shows is detected, not guessed; every field is editable; and it
can be reopened later from the app menu.

---

## 3. The config file

**Do not hardcode the location; find it.** It is `<userData>/config.json`,
where `userData` is Electron's per-application directory, and the directory name
is derived from the app name, which is **not** the same for a development run
and a packaged install. On this machine a dev run lands at
`~/.config/harbor/config.json` (lowercase); a packaged build can use the
capitalised product name instead. Locating it beats guessing:

```sh
# Linux
ls -d ~/.config/harbor ~/.config/Harbor 2>/dev/null
# macOS
ls -d ~/Library/Application\ Support/harbor ~/Library/Application\ Support/Harbor 2>/dev/null
# Windows (PowerShell)
Get-ChildItem $env:APPDATA -Filter "*arbor*"
```

Override with `HARBOR_CONFIG_FILE`. Anything left `null` is derived at use
against the real home directory, which is why the defaults are correct on all
three platforms rather than hardcoding one OS's layout.

```jsonc
{
  "setup":    { "completed": false, "completedAt": null, "appVersion": null },
  "platform": { "os": null, "herdrBin": null, "herdrSocket": null, "shell": null },

  // One entry per Claude config home. This is the multi-account model.
  "profiles": [
    { "id": "personal", "label": "Personal", "letter": "P", "color": "#437FFE",
      "provider": "claude", "configHome": null, "email": null, "isDefault": false }
  ],

  "providers": {
    "claude": { "enabled": true, "bin": "claude" },
    "codex":  { "enabled": true, "bin": "codex" },
    "cursor": { "enabled": true, "bin": "cursor-agent" }
  },

  "paths": {
    "projectsDir":      null,  // default ~/.claude/projects
    "cacheDir":         null,  // default ~/.cache/harbor
    "delegateStateDir": null,  // default ~/.local/state/claude-delegate
    "binDir":           null,  // default ~/.local/bin
    "projectIconsDir":  null,  // default <userData>/project-icons
    "tasksFile":        null   // default <userData>/tasks.json
  },

  "orchestration": { "launcher": null, "stateDir": null }
}
```

### Profiles, which are the thing most worth getting right

A profile is one Claude config home: a directory holding that account's
`.claude.json`. Users commonly have a personal account and a work account.
Harbor indexes transcripts across **all** profiles into one rail, while keeping
each session attached to the account that owns it.

- `configHome` is the directory. `id` is the internal key. `label`, `letter`
  and `color` are display only.
- `isDefault` decides which account a new session launches under.
- `email` is read back from the account so the user can tell them apart. If it
  shows blank, that home is probably not signed in.
- **Do not invent profile ids to match a convention.** Harbor discovers homes
  from the filesystem (`app/src/main/config/homes.js`); ids that are not
  one of the conventional words work fine for launching and resuming. An
  account travels as its config home, never as a per-account flag.

### Providers

Set `enabled: false` for any CLI the user does not have, or point `bin` at a
non-`PATH` location. Cursor's binary is `cursor-agent`, not `cursor`.

### Orchestration

Optional, and it can be turned off entirely in the wizard, in which case the
Orch view does not appear at all. `launcher` defaults to Harbor own `bin/ai`,
which ships with the repository; `stateDir` is where the delegation queue CLI
keeps its queues. That CLI is NOT shipped here, and the wizard says so on the
Orchestration step when it cannot find one on PATH.

---

## 4. Environment variables

Everything here is optional. Reach for these when the user's layout differs
from the defaults, or when you are isolating something for a test.

**Choosing the session backend**

| Variable | Meaning |
|---|---|
| `HARBOR_SESSION_BACKEND` | `sessiond` (default, Harbor's own daemon) or `herdr`. Any other value refuses to start. |

**Paths and stores**

| Variable | Meaning |
|---|---|
| `HARBOR_CONFIG_FILE` | The config file itself |
| `HARBOR_USER_DATA_DIR` | Electron `userData` root |
| `HARBOR_SESSIOND_DIR` | Session store (state files, keeper sockets, daemon log) |
| `HARBOR_SESSIOND_SOCKET`, `HARBOR_SESSIOND_SOCKET_DIR` | Daemon socket, and where per-session sockets live |
| `HARBOR_SESSIOND_LOG`, `HARBOR_SESSIOND_LOG_MAX_BYTES` | Daemon log and its rotation size |
| `HARBOR_TASKS_FILE` | The Tasks view's document |
| `HARBOR_PROJECT_ICONS_DIR` | Per-project icons (see section 6) |
| `HARBOR_CONTEXT_DIR` | Statusline context tees |
| `HARBOR_ARTIFACTS_ROOTS`, `HARBOR_ARTIFACTS_CACHE`, `HARBOR_ARTIFACT_THUMBS_DIR` | Files view roots, index cache, thumbnails |
| `HARBOR_TITLES_FILE`, `HARBOR_MODEL_CACHE_FILE` | Session-title and model-discovery caches |
| `HARBOR_DELEGATE_STATE_DIR` | Orchestration queues |
| `HARBOR_UNRECOGNIZED_DIR`, `HARBOR_PERF_LOG_DIR` | Captured unknown dialogs, performance logs |

**Binaries**

| Variable | Meaning |
|---|---|
| `HARBOR_CLAUDE_BIN` | Pin the Claude CLI (also what model discovery scans) |
| `HARBOR_SESSIOND_BIN` | The `bin/harbor-sessiond` entry point |
| `HARBOR_HERDR_BIN`, `HARBOR_HERDR_DIR`, `HARBOR_HERDR_UNIT` | Herdr backend only |

**Turning features off** (all useful when a machine lacks a dependency, or for
a quiet first run)

| Variable | Effect |
|---|---|
| `HARBOR_NO_TITLER=1` | No Haiku session titling (it needs an API key) |
| `HARBOR_NO_VOICE=1` | No voice features (they need an OpenAI key) |
| `HARBOR_NO_USAGE_FETCH=1` | Never query plan-usage endpoints |
| `HARBOR_NO_MODEL_DISCOVERY=1` | Do not scan the CLI binary for model ids |
| `HARBOR_NO_DAEMON_START=1` | Never auto-start a session daemon |
| `HARBOR_NO_SEND_LOG=1`, `HARBOR_NO_PERF_LOG=1` | Disable those logs |

**Timeouts**, when a machine is slow or a store is on a network filesystem:
`HARBOR_SESSIOND_REQUEST_TIMEOUT_MS`, `HARBOR_SESSIOND_KEEPER_REQUEST_TIMEOUT_MS`,
`HARBOR_SESSIOND_SPAWN_TIMEOUT_MS`, `HARBOR_FRESH_PANE_TIMEOUT_MS`,
`HARBOR_HERDR_CALL_TIMEOUT`, `HARBOR_HERDR_READY_TIMEOUT`.

**Phone server:** `HARBOR_SERVER_HOST`, `HARBOR_SERVER_PORT`,
`HARBOR_TAILNET_LOGINS`, `HARBOR_WEB_DIST`. See section 8.

---

## 5. Skills, slash commands, models, and how a session is launched

**Skills and slash commands are read from the user's own installation**, not
from a list inside Harbor. The capability menu on the command bar shows what
they actually have. If a skill is missing from that menu, it is missing from
their config home, or Harbor is pointed at a different home than they think.

**Model lists are discovered by scanning the installed Claude CLI binary** for
first-party model ids, cached and refreshed periodically. There is deliberately
no hardcoded model table. If a brand-new model is missing, check
`HARBOR_CLAUDE_BIN` points at the CLI they actually use, and that
`HARBOR_NO_MODEL_DISCOVERY` is not set.

**Launching is `bin/ai`, and it needs nothing you do not already have.** It
execs the Claude CLI directly:

```
claude --dangerously-skip-permissions [--model M] [--effort E] [--session-id UUID] [PROMPT]
```

with `CLAUDE_CONFIG_DIR` set from the chosen profile's config home. The binary
comes from `providers.claude.bin` in the config, or `HARBOR_CLAUDE_BIN`, or
plain `claude` on `PATH`, in that order. Codex and Cursor resolve the same way
through `providers.codex.bin` / `providers.cursor.bin` and
`HARBOR_CODEX_BIN` / `HARBOR_CURSOR_BIN`.

Until 2026-08-07 this went through a wrapper called `claude-go` that was not in
this repository, so a fresh clone launched nothing and this section told you to
write the wrapper yourself. If you find any leftover reference to it, that
reference is stale.

**An account is a config home, never a per-account flag.** `bin/ai` takes
`--home <profile-id|config-home-path>`; there are no `--<account>` flags and any
profile id works. Harbor pre-accepts the per-folder trust marker itself, writing
`projects.<cwd>.hasTrustDialogAccepted` into the `.claude.json` of the home the
child will actually read, so a launch into a new folder does not stall on a
dialog in a window that is not on screen yet. Set `HARBOR_NO_TRUST_PREACCEPT=1`
to turn that off and answer the dialog by hand.

---

## 6. Project icons

Harbor draws a per-project image wherever it would otherwise draw a coloured
dot. Icons are read at runtime from `<userData>/project-icons/` (override with
`HARBOR_PROJECT_ICONS_DIR`). The filename is **derived** from the project label,
never mapped: lowercase, `&` becomes `and`, spaces and separators become
hyphens. So a project shown as `Team Tools` looks for `team-tools.png`.
Drop PNGs in that folder and they appear without a restart. No icon is not an
error; the coloured dot is the fallback.

---

## 7. Verify each piece separately

When something is wrong, do not debug "Harbor". Ask each of the four moving
parts what it believes, and find the one that answers something surprising.

```sh
node bin/harbor-sessiond status      # does the daemon exist and answer?
node bin/harbor-sessiond list        # what does it think is running?
pgrep -af "daemon/keeper.js" | wc -l # one real process per live session
ls -la app/dist/index.html           # is the renderer built?
```

**The single most diagnostic comparison in the system:** sessions the daemon
lists versus keeper processes actually alive. They should match. A session
listed with no keeper behind it is a phantom, and everything downstream of it
will lie to you, including the UI.

Logs, in the order they are usually useful:

| What | Where |
|---|---|
| Daemon | `<HARBOR_SESSIOND_DIR>/sessiond.log`, default `~/.local/state/harbor/sessiond/sessiond.log` |
| One session's keeper | `<store>/sessions/<id>.keeper.log` |
| Phone server | its stdout, or `journalctl --user -u harbor-server` |
| Unknown dialogs, captured for later | `~/.cache/harbor/unrecognized-dialogs/` |

---

## 8. The phone client (optional)

A PWA in `app/web/`, built with `npm run build:web`, served by a separate
headless server (`npm run start:server`). It binds loopback or a Tailscale
address only; binding anything else, including `0.0.0.0`, is refused at
startup. Mutating RPCs need a bearer token stored at `<userData>/server-token`
with `0600`. Read `docs/SECURITY-MOBILE.md` before exposing it anywhere.

If it connects and immediately disconnects in a loop, read the server log for
the close code:

| Code | Meaning |
|---|---|
| 1013 | the server closed it: this client could not drain pushes fast enough |
| 1011 | server-side error; the reason string carries it |
| 1006 | dropped with no clean close, usually network or TLS |
| 1005 | **nothing was reported at all** |

1005 is worth knowing about: it means no diagnosis is possible from the code
itself, so anything built on it is a guess. Every close Harbor initiates now
carries a real code and reason.

The usual cause of flapping is volume, not authentication. `queueMaxBytes` in
`app/src/server/compose.js` bounds the per-client backlog; raising it buys
headroom on a slow link but should stay bounded, since the bound is what stops
one stalled client from consuming memory without limit.

---

## 9. When something is off

### Sessions show as live but nothing is behind them (classically after a reboot)

Compare `harbor-sessiond list` against `pgrep -af "daemon/keeper.js"`.

**Why:** a keeper writes its `exit` stamp from its pty's `onExit` handler. A
reboot `SIGKILL`s it, so that line never runs and the state file survives saying
the session is still running. The reaper only removed sessions carrying an exit,
so a reboot's wreckage came back looking alive.

The discriminator is the **boot**, never the pid. A `kill(pid, 0)` check is the
obvious idea and is wrong: pids are reused across a reboot, so it eventually
reports a stale session alive against an unrelated process, which is worse than
the bug. Current code filters sessions from an ended boot and, at startup, asks
the keeper's socket about anything killed within the current boot. **Liveness is
a real connection, never a file existing.**

### A message says "sent" but the session never responds

Check the session has a live process, then read its pane. A bare shell prompt
means the agent CLI died and left its pty at a shell. Harbor guards against
typing into that state, because a send was once executed *by the shell*. Pane
existence is never session liveness.

### Everything that talks to the daemon hangs

Stop the daemon and start it again. Keepers are detached and survive, so
sessions do not die with it. A daemon can half-die with its socket still
accepting connections into a dead queue, so "the socket exists" and even "a
cheap status call answered" are both false signals. Decide liveness with a real
request that has a deadline.

### The wizard does not appear, or shows accounts that are not the user's

Remove the Harbor config file (not `~/.claude`) and relaunch. The
first-run-versus-upgrade guard keys on marker files a *running* Harbor writes;
it used to key on the `~/.cache/harbor` directory existing, which the unit suite
also creates, so anyone who ran the tests before their first launch was
misclassified as an upgrading user.

### The app takes the screen on restart

It is not supposed to, and it checks the outcome rather than trusting a flag. If
it still does, that is worth reporting. An unfocused window still covers a
full-screen game, which is why the guard hands the screen back rather than
merely declining focus.

---

## 10. Do not "fix" these

Each looks like a bug and is a guard. Changing one re-opens a real failure.

- **The context gauge shows a raw token count instead of a percentage** when it
  cannot source a denominator honestly. It never guesses a context window and
  there is deliberately no per-model window table anywhere in the code.
- **A blocked screen refuses a send** and points at the answer panel in that
  window. The refusal and the panel are one decision on one read, on purpose:
  when they were separate they disagreed, and a session showed "ready" while
  refusing every message.
- **Worker close verifies the process died**, not just that the pane closed. A
  clean pane close can leave the agent process running.
- **The composer is a plain field with no highlight overlay.** A mirror layer
  that re-renders the draft underneath cannot stay aligned with the field it
  shadows.
- **`transcript:update` carries two shapes**, a whole-state `replace` and an
  `append` delta. Anything that treats them alike loses messages.

---

## 11. Platform status, stated plainly

**Linux** is the only platform validated end to end.

**Windows** has been run far enough to know exactly where it stands; detail in
`setup/windows/README.md`. Working: install, `node-pty` with a real ConPTY
binding, daemon start, spawning a session, sending input, reading the screen,
closing it. Not working: many unit tests still fail on POSIX assumptions
(`/proc`, file modes, the PATH executable bit), one suite hangs, and the
Electron GUI has never been launched there. Fixes already made, so you do not
rediscover them: `process.getuid` does not exist there; Node's `net` supports
only named pipes, so a filesystem `.sock` path fails with `EACCES`; a named pipe
creates no file, so a readiness check using `fs.existsSync` on a socket path can
never pass; and `node-pty` refuses a signal argument to `kill`.

**macOS** has never been run. `setup/macos/README.md` is a first-run checklist,
not a support statement. Known risk: daemon startup uses `launchctl submit`, a
legacy subcommand, with no exit check.

---

## 12. If you change Harbor itself

Run `npm test` and `npm run test:e2e` from `app/`. The end-to-end gate must pass
**twice consecutively**; a single green run is not accepted, because the
failures that matter here have been intermittent.

The habit that matters most, learned expensively: **a test that asserts
structure is not a test that asserts the product works.** A twenty-spec mobile
gate passed twice while the composer rendered invisible text and a message
silently vanished, because every spec measured geometry and none asked what a
person would see. If you add a gate, make it fail against the broken code first.
If it does not fail there, it is not testing what you think it is.

Its sequel, 2026-08-08: **measure the COST OF A REPEAT, not the cost of one
interaction.** Every spec drove each action once, so nothing could see that one
iOS `visualViewport` scroll event cost one `session:menu-state` RPC. A phone
fires those at the display refresh rate, so ~110 a second overflowed the
server's per-client queue, and Pat's connection died every minute or two for a
whole night. The specs that catch this shape assert a RATE (40 no-op events must
cost at most 3 calls) and are two-sided (the poll must still poll), because
"zero calls" is also what a feature that has stopped working looks like.

And **make the harness reproduce the case the product actually meets.** The
mobile fixture published a launched session synchronously inside the launch
itself, so a client that polled for it succeeded on its first try and the
twelve-second poll it really performs never ran once in the gate. Pointed at the
ordinary case (a session not listed yet), the same spec showed the old client
taking 29 seconds and then opening the WRONG session.
