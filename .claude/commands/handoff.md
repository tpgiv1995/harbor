---
description: Write a thorough session handoff document so a fresh Claude instance can continue this work without asking the user any questions.
argument-hint: [optional note to weave into the document]
---

Write a thorough session handoff document so a fresh Claude instance can
continue this work without asking the user any questions.

## Steps

1. **Inspect the repo first, do not write from memory alone.** Run, in
   parallel where possible:
   - `git status` (working tree state)
   - `git log --oneline -10` (recent commits)
   - `git branch --show-current` (current branch)
   - `git diff --stat` (uncommitted change summary, if any)
   - Read `CLAUDE.md`, `README.md`, and the top-level package manifest
     (`package.json` / `pyproject.toml` / `Cargo.toml` / `go.mod` / etc.)
     if present
   - Glance at the top-level directory structure (one `ls` is fine, no
     deep recursion)

2. **Ensure the handoffs folder exists.** Create `.claude/handoffs/` if it
   doesn't.

3. **Check `.gitignore`** at the repo root: if `.claude/handoffs/` (or a
   pattern covering it) isn't already ignored, add it. If there is no
   `.gitignore`, skip this, don't create one. Handoffs capture
   in-progress, possibly sensitive session detail; they aren't meant to be
   committed by default.

4. **Construct the filename** using local time:
   `handoff-YYYY-MM-DD-HHMM.md`. Use the Bash tool: `date "+%Y-%m-%d-%H%M"`.

5. **Write the document** to `.claude/handoffs/handoff-YYYY-MM-DD-HHMM.md`
   with the exact section structure below. Use clean markdown, H2 headers,
   code blocks for paths/commands/snippets. No filler, no padding, no
   recap of obvious things. Every section should earn its space.

## Required sections (use these exact H2 headers, in this order)

```
## Project Overview
## Current State of the Codebase
## This Session's Work
## Other Recent Important Work
## Where Things Stand Today
## Lessons Learned / Gotchas
## To-Do List
## Remaining Challenges / Open Questions
```

### What goes in each section

- **Project Overview**: what this project is and its objective. Tech
  stack, key dependencies, runtime environment. High-level architecture:
  key folders, entry points, important files. Brief; a fresh Claude needs
  orientation, not a tour.

- **Current State of the Codebase**: what works, what's wired up, what's
  stubbed. Current branch, uncommitted changes, dirty working tree (paste
  the relevant `git status` / `git log` output). Known broken or
  in-progress areas.

- **This Session's Work**: what was set out to do this session and what
  actually got done. Use file paths and function/feature names. Decisions
  made and the reasoning, especially anything non-obvious. Pull from
  conversation context.

- **Other Recent Important Work**: threads from prior sessions still
  relevant. Mine recent commits, recent file modifications, and
  conversation context. Skip anything fully resolved and unrelated to
  current work.

- **Where Things Stand Today**: status of each active workstream. What's
  blocking, what's waiting on external input, what's ready to ship.

- **Lessons Learned / Gotchas**: environment quirks, library bugs,
  workarounds. Wrong turns taken this session so the next one doesn't
  repeat them. Anything that surprised you.

- **To-Do List**: specific next actions, ordered by priority. Each item
  must be actionable cold, with enough context (file paths, what changed,
  what's expected) that no follow-up question is needed.

- **Remaining Challenges / Open Questions**: unsolved hard problems.
  Decisions the user needs to make before work can continue.

## After writing

Print the full absolute path of the written file so the user can confirm.
No summary of the contents; they can open the file.

## Notes

- Optimize for a future Claude reading this cold. Be precise, not verbose.
- Do not invent details. If something is unknown, say so.
- `$ARGUMENTS`, if provided, is an optional freeform note from the user to
  weave into the document (e.g. "focus on the auth refactor thread"). If
  empty, ignore.
