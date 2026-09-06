# Workflow commands

`.claude/commands/` ships a small set of optional [Claude Code slash
commands](https://docs.claude.com/en/docs/claude-code/slash-commands) for
working on this repo (or any repo) with Claude Code. They are plain
markdown files, not part of the Harbor application itself.

## Installing them

Nothing to install. Claude Code discovers project-level slash commands
automatically from `.claude/commands/` when it's run from the repo root,
so cloning this repo and running `claude` from `/harbor` (or wherever you
put it) is enough: the commands below are immediately available as
`/acclimate`, `/handoff`, and so on.

If you'd rather have one of them available in every project, copy the
file into your personal `~/.claude/commands/` instead.

## What's here

| Command | What it does |
| --- | --- |
| `/acclimate` | Get oriented on a project at the start of a session: reads `CLAUDE.md`/`README.md`, walks recent git history, and pulls the latest handoff document(s) if any exist. |
| `/handoff` | Write a thorough session handoff document to `.claude/handoffs/`, so a fresh Claude session (or a teammate) can pick the work back up without re-asking what happened. |
| `/pickup` | Load the most recent handoff document and orient: reports where things stand and detects drift, but doesn't start executing anything on its own. |
| `/orchestrate-research <goal>` | Research a goal in the current workspace and turn it into a queue of execution batches for delegated workers. This is the command Harbor's own Orch panel runs when you click "Research" on a project. |
| `/orchestrate-execution` | Drain the queue `/orchestrate-research` built, dispatching batches to workers until it's exhausted or hits a real blocker. What Harbor's Orch panel runs on "Execute". |
| `/orchestrate-status` | Report the current state of the orchestration queue and recommend the next command. |
| `/tasks` | Read, add, update, complete, and reorganize items in Harbor's **Tasks** view via `bin/harbor-tasks`. Only ever acts on an explicit request; see the command file for the full rule. |

## Two things worth knowing before you use them

- **The `/orchestrate-*` commands assume a delegation queue CLI** (a
  `claude-delegate`-style tool) is installed separately and on `PATH`.
  Harbor's Orch panel is built around this workflow (see
  `app/src/renderer/orchestration/` and
  `app/src/main/actions/orchestration.js`), but the delegation CLI itself
  is a companion tool, not something this repo ships. Without it, the
  research and status phases of these commands are still useful reference
  material for planning delegated work by hand.
- **`/handoff` and `/pickup` write to and read from `.claude/handoffs/`**,
  which this repo's `.gitignore` keeps out of version control (session
  handoffs can contain in-progress, possibly sensitive detail). They're
  local working files, not something you'd commit.

None of these commands are required to build, run, or test Harbor. They're
optional workflow aids that happen to live in the repo so anyone who
clones it gets the same tools Harbor's own development used.

## About the delegation CLI

There is **no public `claude-delegate`**. The one Harbor was developed against
is a private script, so "install it separately" currently has no next step, and
this is worth saying plainly rather than leaving you to discover it.

What is portable is the *packet format*: `/orchestrate-research` documents the
JSON a batch carries (goal, constraints, done-when, the file list, which worker
type suits it), and that research output is useful on its own for planning
delegated work by hand or for feeding whatever dispatch mechanism you do have.
Harbor's setup wizard looks for a `claude-delegate` on your `PATH`, says on the
Orchestration step when it cannot find one, and defaults the whole Orch view off
so you are not offered a button that dead-ends.

## Adding a session journal, if you want one

`/handoff` and `/pickup` write to and read from `.claude/handoffs/` inside the
repo, and `/acclimate` reads those handoffs when they exist. That is the whole
mechanism as shipped: no notes app, no external vault, nothing to install, and
`/acclimate` degrades cleanly to git history plus `CLAUDE.md` when there are no
handoffs at all.

Some people (including this repo's author) keep a longer-lived journal outside
the repo as well, one note per session, so that context survives across
repositories and machines. Harbor does not ship that, because where your notes
live is a personal decision and hardcoding one vault path is exactly the kind of
thing this repo has been pulling back out of itself. If you want it, the pieces
are small:

1. **Pick a folder.** Anything your editor or notes app already syncs works: an
   Obsidian vault, a plain `~/notes/sessions/` directory, a private git repo.
   Nothing about the format is Obsidian-specific.

2. **Give each note a stable front matter block** so it can be searched later.
   The convention that works is one file per session named
   `YYYY-MM-DD-<slug>.md`, with a `project:` field naming the repository:

   ```markdown
   ---
   date: 2026-08-07
   project: harbor
   ---

   ## What I set out to do
   ## What actually happened
   ## What broke, and why
   ## Where it stands
   ```

   The `project:` field is the load-bearing part: it is what lets a later
   session pull only the notes relevant to the repository it is sitting in.

3. **Copy `.claude/commands/acclimate.md` into your own
   `~/.claude/commands/`** and add a phase that greps your folder for
   `^project:.*<slug>` and reads the matches, newest last, alongside the
   existing handoff phase. Keep it in your personal commands directory rather
   than in a project, so it follows you between repositories.

4. **Do the same for `/handoff`** if you want the note written automatically at
   the end of a session rather than by hand.

The reason this is instructions rather than code: a journal command with a path
in it only works on the machine that path exists on, and the version of these
commands that ships here is deliberately the one that works everywhere.
