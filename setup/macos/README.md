# Harbor on macOS: first-run validation checklist

**Harbor has never been run on real Mac hardware.** Every macOS code path in this
repository is written, type-checked by review, and covered by unit tests that run
on Linux with the darwin adapter injected. Not one of them has executed against a
real kernel, a real `ps`, a real APFS volume, or a real launchd.

So this document is not a support statement. It is the validation pass, and you
are the person performing it. Work through the numbered checks in order. Each one
gives you the exact command, the result that means PASS, and what to capture if
you get anything else. A check that fails is expected and useful: it is the whole
reason this file exists. Record the failure and move to the next check, because
most of them are independent.

When you are done, send the completed checklist back. An honest gap is worth more
than a false green.

## A note on the `.dmg` installer, if you got here from one

`electron-builder` (`.github/workflows/build.yml`, or `cd app && npm install
&& npm run dist:mac` run on an actual Mac) can produce a `.dmg` for both
`x64` and `arm64`, unsigned and non-notarized (see `docs/PACKAGING.md` for
why signing is deliberately absent, and for a specific unresolved risk: the
build only ran its native-module install step on one runner architecture, so
the `.dmg` for the *other* architecture may ship a native module built for
the wrong CPU). **That a `.dmg` can be produced changes nothing about the
sentence at the top of this document.** It has never been opened, and Harbor
has never run, on a real Mac. If you are validating from the `.dmg` rather
than from source, everything below still applies exactly as written; the only
difference is check 8 ("Gatekeeper and the unsigned app"), where you are
now looking at Gatekeeper's reaction to an installed, unsigned `.app`
instead of one running out of `node_modules/electron/dist/`, which is
arguably the more realistic version of that check to run. Report which one
you actually ran.

## Before you start

```sh
# Point this at your clone. Every command below uses it.
export HARBOR_REPO="$HOME/dev/harbor"
cd "$HARBOR_REPO/app"

# Record what you are testing on. Paste this into your report.
sw_vers
uname -m
node --version
echo "shell: $BASH_VERSION"
```

Harbor targets Node 22. `node --version` below v22 is itself finding number zero.

**A note on Herdr before you install it.** Harbor's default session backend is
its own daemon, `sessiond` (`app/src/daemon/`), which needs no Herdr install at
all. Herdr is an optional fallback backend (`HARBOR_SESSION_BACKEND=herdr`),
detail in `docs/SESSION-DAEMON-CUTOVER.md`. Checks 4, 9, and 10 below talk
about the Herdr daemon by name because that is what this checklist was
originally written against; treat them as covering the Herdr fallback path
specifically, and note in your report which backend you actually validated.

Install dependencies and build the renderer once:

```sh
cd "$HARBOR_REPO/app"
npm install
npm run build
```

**Expected:** both complete without error.
**If it differs:** capture the full npm output. A native module that fails to
build on arm64 is the most likely cause and is worth knowing before anything else.

---

## 1. The unit suite, which is the cheapest signal you will get

```sh
cd "$HARBOR_REPO/app"
npm test
```

**Expected:** every test passes and the process exits 0. This is the full unit
suite; on Linux, every file under `test/**/*.test.js` passes.

**If it differs:** capture the name of every failing test verbatim plus its
assertion output. Failures here are pure logic or path assumptions and are the
easiest for us to fix remotely, so this is the single most valuable thing you can
send back.

## 2. Process identity without `/proc`

This is the highest-risk area on macOS. Linux reads `/proc/<pid>/cmdline` to
decide whether a process is really Claude before it will ever signal it. macOS has
no `/proc`, so `app/src/main/platform/darwin.js` reimplements the same decisions
on top of `ps`. If `ps` behaves differently than assumed, Harbor either refuses to
adopt sessions that are alive, or, much worse, mis-identifies one.

```sh
# Start any long-lived process you can identify, then inspect it the way Harbor does.
sleep 300 &
SLEEP_PID=$!
ps -p "$SLEEP_PID" -o state=,etime=,command=
kill "$SLEEP_PID"
```

**Expected:** exactly one line, three fields, in the order state, elapsed, command,
for example `S    0:03 sleep 300`. The elapsed field must match
`[[dd-]hh:]mm:ss`.

**If it differs:** paste the raw line. Harbor parses it with
`/^(\S+)\s+(\S+)\s+(.*)$/` and treats any state beginning with `Z` as dead, so a
different column order or a padded state column breaks process identity outright.

## 3. `ps` command-line truncation, which would break session ownership silently

Harbor finds the process that owns a session by scanning for the session id in the
full command line (`findSessionOwner` in
`app/src/main/platform/darwin.js`). macOS `ps` has historically truncated the
command column. If it truncates here, the session id is cut off, Harbor concludes
nobody owns the session, and adopt-on-send will resume a session that is already
running: **two writers on one transcript.**

```sh
# A stand-in process that really does carry a long command line. It has to be a
# script rather than `sleep` with extra arguments, because sleep rejects them and
# exits before ps can see anything.
cat > /tmp/harbor-ps-probe.sh <<'EOF'
#!/bin/sh
sleep 300
EOF
chmod +x /tmp/harbor-ps-probe.sh
/tmp/harbor-ps-probe.sh --standing-in-for-a-real-claude-command-line --session-id 1234abcd-5678-90ef-ghij-klmnopqrstuv &
PROBE_PID=$!
sleep 1

ps -ax -o pid=,state=,command= | grep "^ *$PROBE_PID " | grep -c "klmnopqrstuv"

kill "$PROBE_PID" ; rm -f /tmp/harbor-ps-probe.sh
```

**Expected:** `1`. The tail of the argument list survives. (Verified to print `1`
on Linux; whether it does on macOS is exactly what this check exists to find out.)

**If it differs (you get `0`):** this is a **blocking** finding. Report it
immediately and do not use adopt-on-send. Note whether `ps -axww` returns 1
instead, because that is the fix.

## 4. Daemon supervision, and the fact that macOS has no cgroup

On Linux the herdr daemon is started into its own systemd unit
(`systemd-run --user --unit=herdr-daemon --collect`). That gives two guarantees:
one OOM kill cannot take the daemon plus every session with it, and a second
daemon cannot hide behind a different name. **Neither guarantee exists on macOS.**
`createDarwinPlatform.startDaemon` shells out to
`launchctl submit -l com.harbor.herdr-daemon`.

```sh
launchctl submit -l com.harbor.probe-test -- /bin/sleep 30
launchctl list | grep com.harbor.probe-test
launchctl remove com.harbor.probe-test
```

**Expected:** the job appears in `launchctl list`.

**If it differs:** `launchctl submit` has been deprecated for several releases and
prints a deprecation warning or fails outright on current macOS. Capture the exact
message. If it fails, Harbor cannot supervise the daemon at all on your machine
and you should report that as blocking for daemon lifecycle, though the app will
still run against a daemon you start by hand:

```sh
"$HARBOR_REPO/bin/herdr-server-clean"
```

Also state plainly in your report whether a second Harbor launch produced a second
daemon, because without the unit name there is nothing preventing it.

## 5. The focus guard must report itself unavailable, not pretend

On Linux, Harbor reads `_NET_ACTIVE_WINDOW` from X to verify that a restart did not
steal the screen. There is no X11 on macOS, and the darwin adapter deliberately
returns `{ available: false, reason: 'focus guard is not implemented on darwin' }`.
The requirement here is honesty, not capability.

```sh
cd "$HARBOR_REPO/app"
node -e "
const { createDarwinPlatform } = require('./src/main/platform/darwin.js');
const p = createDarwinPlatform({ logger: { warn(){} } });
console.log(JSON.stringify(p.capabilities().focusGuard));
console.log(JSON.stringify(p.focusGuard()));
"
```

**Expected:** both lines report unavailable with a reason, and neither throws.

**If it differs:** report it. A focus guard that claims to be available on macOS
would be worse than one that is absent, because Harbor would trust a check that
cannot run.

## 6. GNU coreutils and bash 3.2

macOS ships bash 3.2 and BSD userland. The organs in `bin/` were rewritten for
exactly this reason and no longer contain `timeout`, `stat -c`, `date -Is` or
`readlink -f`.

One thing to understand before you run this check, because it will otherwise look
broken: those organs are **Node programs wearing a `#!/bin/sh` hat.** The first two
lines are a polyglot,

```sh
#!/bin/sh
':' //; exec node "$0" "$@"
```

so the only shell that ever executes is that single `exec` line, and everything
below it is JavaScript. This means `sh -n bin/ai` **fails by design** (it parses
the JavaScript as shell), and it means **`node` must be on your PATH** for any of
them to run at all. Check them as what they are:

```sh
cd "$HARBOR_REPO"
grep -rnE '\btimeout \b|stat -c|date -Is|readlink -f' bin/ ; echo "grep exit: $?"

for f in ai claude-sessions herdr-server-clean harbor-hydrate; do
  node --check "bin/$f" && echo "ok: $f"
done

# herdr-health.sh is the same polyglot but its .sh extension makes `node --check`
# refuse it, so exercise it instead of parsing it.
./bin/herdr-health.sh ; echo "health exit: $?"
```

**Expected:** the grep prints nothing and reports `grep exit: 1`; all four organs
report `ok`; `herdr-health.sh` exits 0 when a daemon is running and non-zero with
an honest message when one is not.

**If it differs:** paste the offending line and the error. A GNU-ism that survived
the rewrite fails differently on BSD rather than loudly, which is why this check
greps rather than trusting the port.

## 7. APFS case-insensitivity in the project-directory munge

Claude Code stores transcripts in a directory derived from the working directory,
with every non-alphanumeric character replaced by a dash. Harbor recomputes that
name to find a session's transcript on disk (`mungeCwd` in
`app/src/main/providers/transcript.js`). **The munge preserves case, and a default
APFS volume is case-insensitive.** So `/Users/Casey/dev` and `/Users/casey/dev` are
the same directory to the filesystem but produce two different names, and the same
name can resolve to a directory written with different capitalisation.

```sh
cd "$HARBOR_REPO/app"
node -e "
const m = (cwd) => String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
console.log(m('/Users/Casey/dev/harbor'));
console.log(m('/Users/casey/dev/harbor'));
"
ls ~/.claude/projects/ | head -20
pwd
```

**Expected:** the two lines differ, which is the hazard. Then compare the real
directory names under `~/.claude/projects/` against the capitalisation your shell
reports for `pwd` and for your home directory.

**If your home directory's real capitalisation differs from what you type** (macOS
often creates `/Users/casey` while Finder and some tools display `Casey`), say so and
paste both. Then open a session in Harbor from that directory and report whether
its conversation renders or shows "No transcript yet", because that is the symptom
this would produce.

## 8. Gatekeeper and the unsigned app

Harbor is not signed and not notarized. You are running it from source through
Electron, which is the path that usually avoids Gatekeeper entirely, but the first
launch may still be quarantined.

```sh
cd "$HARBOR_REPO/app"
xattr -l node_modules/electron/dist/Electron.app 2>/dev/null | head
npm start
```

**Expected:** the app window opens.

**If it differs:** capture the exact Gatekeeper dialog text. Note whether
`xattr -dr com.apple.quarantine node_modules/electron/dist/Electron.app` clears it.
Do not disable Gatekeeper system-wide, and do not run anything with `sudo` to get
past this.

## 9. First run: the setup wizard

With the checks above recorded, this is the real test.

```sh
cd "$HARBOR_REPO/app"
npm start
```

**Expected:** because you have no Harbor config yet, the seven-step setup wizard
opens by itself: Welcome, Claude plans, Codex and Cursor, Commands, Shared config,
Orchestration, Defaults. It should detect your Claude config home, show the
account in it, and let you finish. Screenshot each step.

**If it differs:** capture the step you are stuck on and the exact validation
message. The wizard is built so that no step can be skipped into a dead end, so a
step that will not advance is telling you something real about detection on macOS.
Report whether the platform step correctly says macOS, and whether the herdr
install hint it shows you (`curl -fsSL https://herdr.dev/install.sh | sh`) actually
works on your machine.

## 10. The daemon and a real session

On the default backend, Harbor starts `sessiond` itself; confirm it directly:

```sh
"$HARBOR_REPO/bin/harbor-sessiond" status
```

If you are specifically validating the Herdr fallback backend
(`HARBOR_SESSION_BACKEND=herdr`), use its own start and health check instead:

```sh
"$HARBOR_REPO/bin/herdr-server-clean"
"$HARBOR_REPO/bin/herdr-health.sh" ; echo "health exit: $?"
```

**Expected:** whichever backend you are validating starts and reports healthy.
Then, in Harbor, open a project, launch a session, and confirm: a pane opens,
the conversation window renders from the transcript, and a message typed into
the command bar lands in the session.

**If it differs:** say which of those four stopped, and which backend you were
on. For the Herdr path, also paste `~/.cache/harbor/herdr-daemon.log`.

## 11. Thumbnails in the Artifacts view

```sh
which pdftoppm ffmpeg
```

**Expected:** either both resolve, or they do not and Harbor degrades to a glyph
placeholder rather than erroring. Neither ships with macOS; both come from
`brew install poppler ffmpeg`.

**If it differs:** report any error surfaced in the Artifacts view rather than a
silent placeholder, since degrading quietly is the intended behaviour.

---

## What to send back

For each of the eleven checks: the number, PASS or FAIL, and for anything that is
not a clean pass, the verbatim output. Plus the `sw_vers` / `uname -m` /
`node --version` block from the top, and the wizard screenshots from check 9.

Checks 3 and 4 are the two most likely to be genuinely broken, and check 3 is the
one that could cause data loss rather than an error message. If you only have time
for two, do those.
