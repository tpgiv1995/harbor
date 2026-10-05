# The Harbor handbook

> **Historical document.** This handbook describes the Linux/Herdr-era Harbor:
> the Herdr backend was retired 2026-08-14, and the Linux install it was
> written against was retired 2026-08-10. The current architecture record is
> `CLAUDE.md` at the repository root and `docs/SESSION-DAEMON-CUTOVER.md`; the
> Herdr sections below are preserved as history, not as instructions.

**Who this is for.** You are setting Harbor up on a machine it has never run on,
something has gone wrong, and the step-by-step in `setup/` has run out of
answers. Or you are an AI agent helping someone do that, and you need to know
*why* a thing is the way it is so you can build the equivalent rather than guess.

This document is deliberately qualitative. It explains intent, reasoning and
failure modes. It is the "why" to the setup folders' "how". Where a decision
looks arbitrary or over-engineered, there is almost always a specific incident
behind it, and those are named, because knowing what broke is the fastest route
to not breaking it again on a new platform.

**How to use it when you are stuck.** Find the subsystem in "The map", read what
it is *for*, then read its "what this means on another OS" note. The rule
throughout: **reproduce the guarantee, not the mechanism.** Copying a Linux
mechanism to a platform that does not have it is how ports get subtly broken.

---

## 1. What Harbor is, and the problem it solves

Claude Code is a terminal program. One session is one terminal. If you are
running six of them, you have six terminals, no shared view of what any of them
is doing, and no way to see at a glance which one is waiting on you.

Harbor's premise is that **the terminal is the wrong surface for supervising
many agents, but the right surface for driving one.** So it does both:

- Sessions render as **conversation windows** built by parsing the transcript
  files Claude Code already writes to disk.
- A **`>_` toggle** on each window flips it to a real terminal attached to that
  session's pty, for the moments when you need the pty itself.

The consequences of that split are the single most important thing to
understand, because most of the architecture follows from it:

1. **Harbor can render a session it is not running.** A session started in a
   plain terminal outside Harbor still has a transcript, so it still renders. It
   also means a window survives a Harbor restart, a daemon restart, and a crash.
2. **Reading is decoupled from driving.** The read path (transcripts) and the
   write path (pty) fail independently and are debugged separately. If a window
   shows a conversation but typing does nothing, that is a pty problem. If
   typing works but the window is stale, that is a transcript problem. Always
   establish which half is broken first.
3. **Harbor does not own your data.** It reads `~/.claude/projects/**/*.jsonl`
   and never writes them. Uninstalling Harbor leaves every transcript intact.
   This is why pointing it at an existing Claude Code install is safe.

## 2. The three-layer stack

```
  Harbor (Electron)          the GUI: rail, stage, command bar
        |
        |  reads             ~/.claude/projects/**/*.jsonl   (conversations)
        |  drives            Herdr's client API              (pty control)
        v
  Herdr daemon               owns the ptys, panes, workspaces
        |
        v
  claude / codex / cursor    the actual agent processes
```

**Harbor never forks, patches or replaces Herdr.** It is a third-party client of
a stock, pinned daemon. This is a deliberate constraint: it means Herdr can be
upgraded, debugged and reasoned about independently, and it means a Harbor bug
can never corrupt terminal state that other tools depend on. If you find
yourself wanting to modify Herdr to make Harbor work, that is a strong signal
you are solving the problem in the wrong layer.

### Why a daemon at all

Because ptys die with their parent. The daemon owns them, so closing Harbor does
not kill your agents, and reopening it reattaches. On any platform, whatever
supervises the daemon must preserve that property: **the agent processes must
outlive the GUI.**

## 3. The protocol pin, and why it is an allowlist

Harbor checks the daemon's protocol number on connect and shows a
degraded-daemon banner on anything unexpected, rather than proceeding.

It is an **allowlist** (`[16, 17]`), never a `>=` comparison. The reasoning:
a protocol number going up does not tell you the methods you depend on still
mean what they meant. A newer daemon that renamed one method would sail through
a `>=` check and fail confusingly at runtime. An allowlist fails immediately,
loudly, with a number you can look up.

**Why 17 is on the list.** Herdr publishes Windows binaries only on its preview
channel, and the preview speaks 17 while stable speaks 16. Without 17 on the
list there is no build of Herdr that Harbor can talk to on Windows at all.

**How 17 was added, and how to add an 18.** Not by bumping a number. Dump both
schemas (`herdr api schema --json`), diff the method surface, and check every
method the client actually calls against the new schema. For 16 to 17 the delta
was one method removed (`agent.send`) and five added; Harbor calls none of them,
and all 49 herdr names in `main/herdr/client.js` exist in both. Do that work
before widening the list, and keep `client.js` and `lifecycle.js` in step, since
they each hold a copy and drifting apart is exactly how the harness ended up
refusing a daemon the app accepted.

## 4. The map: subsystems, intent, and porting notes

### 4.1 Session discovery and the rail

**Intent.** Show every session that exists, grouped by project, newest first,
with live ones marked, without the user having to remember where anything was.

**How.** A Python indexer scans the transcript store and caches metadata.
Live-ness comes from the daemon.

**The rule worth knowing: the index is a cache, never the source of truth.**
This has caused the same bug three times in three different consumers. A session
younger than the index has no index entry, and any code that resolves a
transcript *only* through the index concludes the session has no transcript and
gives up. Symptoms have included a window stuck on "No transcript yet", a
question card with no question on it, and a missing workflow strip.

The fix pattern, which you should follow for any new consumer: try the index,
then **derive the path** (the working directory munged into a directory name,
plus `<session-id>.jsonl`), then **scan the project directories** for that
filename, because a session id is unique across the store. And **never cache a
miss** as though it were an answer: a brand-new session writes its transcript on
its first message, so "not found" means "not yet", not "never".

*On another OS:* the munging rule (every non-alphanumeric character becomes a
dash) is Claude Code's, not Harbor's, so it is the same everywhere. But it
**preserves case**, and a case-insensitive filesystem (default on macOS, and on
Windows) can therefore produce two different directory names that the filesystem
treats as one, or resolve a name you did not expect. If sessions render blank on
those platforms, this is the first thing to check.

### 4.2 The conversation renderer

**Intent.** Make an agent session readable at a glance: what you asked, what it
said, what it did, without terminal noise.

**How.** The transcript is tailed and parsed into blocks. Consecutive tool
actions collapse behind a summary so a hundred file reads do not bury one
sentence of reasoning.

*On another OS:* pure file parsing, no platform coupling. If conversations
render, this layer is fine, and any remaining problem is in the pty half.

### 4.3 The pty bridge

**Intent.** Let one window drive one session's terminal, without two windows
ever fighting over the same pane.

**How.** Harbor spawns one observe/control child per visible pane and enforces
**exclusive control: acquire on focus, release on blur.** Only a controller may
resize a pane.

*On another OS:* Herdr on Windows uses ConPTY rather than the Unix pty model, and
upstream marks several behaviours as beta or unverified there, notably clipboard
image paste and live working-directory tracking after a shell `cd`. Expect the
byte bridge to work and the edges to be rough. The guarantee to preserve is
exclusivity: if two windows can control one pane, input interleaves and the
session becomes unusable in a way that looks like the agent has gone mad.

### 4.4 Process identity, and the most dangerous code in the repo

**Intent.** Harbor sometimes needs to end a process: adopting a session that is
running outside it, or closing a worker. Killing the wrong process means
destroying someone's live work.

**How, on Linux.** Identity is established by reading `/proc/<pid>/cmdline` and
verifying it is actually the agent, cross-checked against the session id. A pid
alone is never enough, because pids are recycled.

**The rule: never signal a process you identified by inference.** Not by working
directory, not by start time, not by "it must be mine". Identify by session id,
verified against the process's own command line, or do not signal at all.

*On another OS:* there is no `/proc` on macOS or Windows, so identity comes from
`ps` output or a CIM query instead. Two specific hazards:

- macOS `ps` has historically **truncated** long command lines. If the session id
  is truncated away, Harbor concludes nobody owns a session that is in fact
  running, and may start a second writer on one transcript. This is the single
  highest-consequence porting risk in the codebase, and `setup/macos/README.md`
  has an explicit check for it.
- If a platform cannot verify identity, the correct behaviour is to **refuse and
  say so**, never to guess. A refusal is recoverable; a wrong kill is not.

### 4.5 Daemon lifecycle and the one sanctioned starter

**Intent.** The daemon must start with a clean environment and must not die
because the window that launched it died.

**How, on Linux.** One script starts it, with an explicit environment allowlist,
inside its own systemd unit.

Two reasons this is not fussiness:

1. **Environment leakage.** A daemon started from inside an agent session
   inherits that session's environment, including its session id and any API
   keys, and then hands them to every pane it spawns. The allowlist exists so
   that cannot happen.
2. **Blast radius.** Detaching from the process *tree* is not the same as
   detaching from the *cgroup*. Started naively, the daemon lands in the
   desktop session's scope along with every pane and every agent, and one
   out-of-memory event takes all of them at once. Its own unit isolates that,
   and a stable unit name also means a second daemon cannot quietly appear.

**Liveness is decided by a real request, never by a status reply.** A daemon can
half-die: the main thread stops while worker threads keep the listening socket,
so it *accepts connections* and answers nothing. Worse, it can still answer
`herdr status` with "running", because that reply does not need the main thread.
Any check that trusts a status reply will report a wedged daemon as healthy.
Harbor probes with an actual snapshot request, on a timeout.

*On another OS:* macOS has launchd (and `launchctl submit`, which is deprecated
and may not work at all on current releases); Windows has its own service model.
Neither gives you the cgroup guarantee for free. Reproduce what you can and
**document honestly what you cannot**, because a supervisor that silently does
not restart is worse than a documented absence.

### 4.6 First run and configuration

**Intent.** Someone else's machine is not yours. Nothing about accounts, paths
or projects may be assumed.

**How.** A seven-step wizard writes a config file. Every launcher, profile and
path comes from it.

**The rule: a missing config means a NEW USER, not a broken install.** This one
shipped as a bug and is worth understanding as a category. The config loader
treated "no config file" as "an existing install that needs migrating" and
seeded the original author's own three accounts and personal workflows. A brand
new user therefore never saw the wizard and inherited a stranger's setup. A
migration needs something to migrate *from*: check for evidence of a prior
install before assuming one.

*On another OS:* config and cache locations differ. The failure mode to watch for
is Harbor writing to, or reading from, a path that does not exist on the target
platform and silently falling back to defaults, which looks exactly like "my
settings did not save".

### 4.7 Answering questions in the window

**Intent.** When an agent asks a question, you should be able to answer it where
you are looking, without hunting for the terminal.

**How, and why it is more complicated than it sounds.** Two sources are merged,
and the split matters:

- **The transcript says what was asked.** The full question, every option, every
  description, unclipped and unwrapped.
- **The pty is the authority on the live interaction.** Whether the dialog is
  still up, which row the pointer is on, what the footer offers.

Neither substitutes for the other. Building the card from the transcript alone
would render a question that was answered ten minutes ago. Building it from the
screen alone loses the question text whenever the dialog is taller than the pane,
which it frequently is.

**The floor: a blocked session must always be answerable in its window.** When
the dialog shape is not recognised, the window shows the raw screen plus direct
keys rather than a dead end. Recognised shapes are an enhancement on top of that
floor, never a replacement for it.

*On another OS:* the terminal geometry is the thing to check. Harbor grows a pane
to fit a dialog, because the default pane was smaller than the dialogs being
drawn into it, and the pane keeps no scrollback, so the question was simply gone
before any parser saw it. If cards come up empty on your platform, measure the
pane before touching the parser.

## 5. The invariants

Break these and things fail in ways that are hard to diagnose.

1. **Never start the daemon except through the sanctioned starter.** Environment
   leakage is invisible until it is a credential in someone else's pane.
2. **Never decide liveness from a reply a dead daemon can produce.**
3. **Never signal a process identified by inference.**
4. **Never treat the index as the source of truth, and never cache a miss.**
5. **Never let a blocked session become a dead end.** Always render something
   answerable.
6. **Never invent a number you cannot source.** Harbor shows a raw token count
   rather than a percentage it would have to guess a denominator for. Prefer an
   honest gap to a plausible fabrication; this applies to your porting reports
   too.
7. **Never widen the protocol allowlist without diffing the schemas.**
8. **Fix every sibling of a bug you find.** Grep for the pattern. The
   index-as-truth bug above was fixed three times in three consumers because the
   first two fixes did not sweep.

## 6. Debugging: the order of operations

When something is wrong, resist fixing the first plausible cause. Establish
which layer is broken, in this order:

1. **Is the daemon actually usable?** Not "is it running": run the health probe,
   which makes a real request on a timeout. A wedged daemon answers status and
   nothing else.
2. **Is it a protocol mismatch?** The degraded-daemon banner says so explicitly.
   Check the daemon's version against the allowlist.
3. **Read or write?** If the conversation renders but input does nothing, it is
   the pty half: pane resolution, control acquisition, exclusivity. If input
   works but the window is stale or empty, it is the transcript half: path
   resolution first, parsing second.
4. **Is the pane what you think it is?** A pane can outlive the agent that was in
   it and drop to a bare shell prompt. Harbor refuses to type into one, because
   a shell will happily *execute* a message meant for an agent. If sends are
   being refused, check whether the agent process is still alive before assuming
   the guard is wrong.
5. **Read the logs before restarting anything.** Daemon stderr is kept
   deliberately. A restart destroys the evidence and usually does not fix the
   cause.

**One known false alarm.** Two specs talk to a real Herdr daemon and one of them
proves it leaked no processes by diffing the process table around itself. Any
other herdr process appearing or exiting during the run reads as a leak, and the
commonest cause is Harbor being open at the time. A single failure in
`test/herdr/bridge.test.js` or `test/herdr/control-latency.test.js` is worth
re-running on a quiet machine before you investigate it. Everything else in the
suite is deterministic.

**For agents helping with this:** prefer one diagnostic that distinguishes two
hypotheses over three speculative fixes. Every rule in this document exists
because someone shipped a fix that merely fit the symptoms.

## 7. Platform status, stated plainly

- **Linux** is validated end to end: the full unit suite three times
  consecutively, a two-run end-to-end gate, and a cold-start drive from an empty
  home directory through the wizard.
- **Windows** is now the platform Harbor runs and is developed on: the full app
  (GUI included) has run there since 2026-08-11, the unit gate is green, and CI
  runs on `windows-latest`.
- **macOS** has **never executed on real hardware**. Every darwin path is written
  and unit-tested against an injected adapter on Linux. `setup/macos/README.md`
  is a numbered validation pass, and whoever runs it first is doing the
  validation.

If you are that first runner: report what you observe, including the failures,
verbatim. A checklist that comes back with three honest failures is worth more
than one that comes back green because the checks were skipped.
