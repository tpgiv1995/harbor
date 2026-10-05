---
description: Get up to speed on a project at the start of a new session by reading CLAUDE.md, the codebase structure, recent git history, and any prior handoff documents. Use whenever you're starting a new session, say "get up to speed," "load context," "orient," or ask "where did we leave off."
---

# Acclimate

Primes you on a project before work starts. Detects the project from the
current working directory, walks recent git history, reads project
documentation, and pulls the most recent handoff document(s) if this repo
uses the `/handoff` command. Ends with a synthesized briefing.

## Workflow

Run these phases in order. Batch independent tool calls in parallel within
each phase.

### Phase 1: Detect the project

1. Confirm the current working directory: that's the project root for
   every step below.
2. Read `CLAUDE.md` (if present) and `README.md` (if present) for the
   project's name, purpose, and any explicit orientation notes.

Tell the user one short sentence: "Acclimating on `<project name>`,
pulling git history, docs, and any recent handoffs."

### Phase 2: Project documentation (parallel reads)

In one message, read all of these that exist:

- `CLAUDE.md` (full read, if not already loaded)
- `README.md` (top 200 lines)
- The top-level package manifest (`package.json` / `pyproject.toml` /
  `Cargo.toml` / `go.mod` / etc.) for name and key dependencies
- Any `docs/` index or `ARCHITECTURE.md` at the root

If the project has obvious sub-areas (e.g. `apps/`, `packages/`,
`services/`), list the top level so you know the shape. Don't recursively
read everything.

### Phase 3: Recent git activity

Skip this phase if the working directory isn't a git repo (check for a
`.git` directory).

In parallel:

- `git status`: uncommitted changes, current branch
- `git log --oneline -30`: recent commits
- `git log -1 --format="%h%n%ad%n%s%n%b" --date=short`: full body of the
  most recent commit

If there are uncommitted changes, also run `git diff --stat` so you know
the scope of in-progress work.

### Phase 4: Prior handoffs, if this repo has them

Some repos use a `/handoff` command that writes session handoff documents
to `.claude/handoffs/handoff-YYYY-MM-DD-HHMM.md`. If that directory exists
and has files:

1. List them and pick the most recent 1-3 by filename (they sort
   chronologically since the filename is a timestamp).
2. Read them in full, newest last, so the picture builds toward the
   current state.

If the directory doesn't exist or is empty, skip this phase silently.
That just means the project doesn't use handoffs, or this is its first
session. Don't treat that as a problem.

**This command deliberately reads nothing outside the repository.** No
notes app, no vault, no external journal folder: a path like that only
exists on the machine it was written on. If you keep a longer-lived
session journal and want this command to read it too, `docs/COMMANDS.md`
has the four steps for adding that phase to your own copy.

### Phase 5: Brief the user

Synthesize what you learned into a tight briefing. Default structure:

```
## <project name>, acclimated

**What this is:** <one sentence from CLAUDE.md / README>

**Where it stands:** <state from the latest handoff's status section, if any, plus git status>

**Recent arc:** <one or two bullets on what recent commits / the latest handoff describe>

**Open items / next steps:** <pulled from the latest handoff's to-do list, if one exists>

**Gotchas to remember:** <anything from CLAUDE.md or the handoff that would affect new work>

**Uncommitted state:** <if git status shows changes, flag them and the branch>
```

Keep it tight. The point isn't to summarize everything you read; it's to
give a working mental model so the next message can be productive. If a
section is empty, omit it rather than padding.

End the brief with a single question: "Ready to dig in, or do you want me
to dive deeper on anything?"

## Edge cases

- **No CLAUDE.md, no README, no handoffs:** rely on git history plus a
  top-level `ls` of the directory. Tell the user what's thin.
- **Working directory is not a project** (a home directory, an empty
  folder): say so plainly, don't invent a project, and suggest the user
  `cd` into the right directory and retry.

## Why this matters

Skipping prior context means re-litigating decisions or repeating mistakes
a previous session already worked through. This command exists so a fresh
session starts with as much of the picture as the repo itself can supply.
