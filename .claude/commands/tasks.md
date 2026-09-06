---
description: Read, add, update, complete, reorganise and delete tasks in Harbor's Tasks view, via the bin/harbor-tasks CLI. Only ever acts on an explicit request.
argument-hint: <what to do with the task list, in plain language>
---

Drive Harbor's **Tasks** view through the `harbor-tasks` CLI, which is
`bin/harbor-tasks` in this repo (and on `PATH` once Harbor is installed).
It reads and writes the same plain JSON file the Harbor app watches, so
anything changed here shows up in the open app within a second, and
anything done in the app is visible here immediately.

## The one rule

**Act only on an explicit request, and only on what was requested.**

This is the whole reason this task list is trustworthy: it is never
derived or rewritten automatically by an agent's own judgment.

- Do **not** create tasks because work came up in conversation.
- Do **not** mark something done because it looks finished.
- Do **not** tidy, re-tag, re-prioritise, re-order or delete anything
  unasked.
- Do **not** invent due dates, tags or lists the user did not name.

When the user *does* ask, do the **whole** job without making them repeat
themselves: pick the right list, set the fields they mentioned, create the
sub-tasks they described, and report exactly what changed. Asking
permission for each individual field is the hand-holding they don't want.

If a request is genuinely ambiguous (two tasks match, or a named list
doesn't exist), say so with the candidates and ask one short question.
Never guess at a destructive action.

## Commands

`harbor-tasks` takes `--json` on every command for machine-readable
output. Tasks are addressed by id **or by any unique piece of the
title**: an ambiguous phrase errors and lists the candidates rather than
guessing.

```
harbor-tasks list [--view VIEW] [--list NAME] [--tag TAG] [--search TEXT] [--all] [--json]
harbor-tasks show <id|title>  [--json]
harbor-tasks add "TITLE" [--list NAME] [--parent ID|TITLE] [--due DATE]
                         [--star] [--my-day] [--tag TAG]... [--notes TEXT]
harbor-tasks update <id|title> [--title TEXT] [--notes TEXT] [--due DATE]
                         [--star|--no-star] [--my-day|--no-my-day]
                         [--tag TAG]... [--untag TAG]... [--list NAME]
harbor-tasks done <id|title>       complete it (its sub-tasks complete with it)
harbor-tasks undone <id|title>     reopen it (restores exactly the sub-tasks that cascade closed)
harbor-tasks rm <id|title>         DELETE it and its sub-tasks; confirm with the user first
harbor-tasks lists [--json]        every list, plus my-day/important/planned/overdue/due-today counts and tags
harbor-tasks list-add "NAME"  |  list-rename <id|name> "NEW"  |  list-rm <id|name>
harbor-tasks file                  the exact file being edited
```

**VIEW**: `myday`, `important`, `planned`, `all` (default), `completed`.
**DATE**: `YYYY-MM-DD`, `today`, `tomorrow`, `+3d`, `-1d`, `none` to clear.

## What the fields mean

- **My Day** is a per-day stamp, exactly like a daily planner: it clears
  itself each morning. Harbor's day rolls at **6am**, not midnight, so at
  1am "today" is still the day that hasn't ended.
- **Important** is the star.
- **Due date** is a calendar day, never a time.
- **Sub-tasks go three levels deep.** Use `--parent`; a fourth level is
  refused by name. Completing a parent completes everything under it, and
  unticking it restores exactly the ones that cascade closed, never a task
  that had already been finished on its own.
- **Lists** are the user's own (project or category). **Tags** are
  free-form labels and are matched case-insensitively.

## Working patterns

Answering "what's on my plate":

```
harbor-tasks lists --json          # the shape of everything, with counts
harbor-tasks list --view myday     # what was chosen for today
harbor-tasks list --view planned   # everything dated, overdue first
```

Capturing something the user just asked to be written down:

```
harbor-tasks add "Send the renewal schedule" --list Work \
  --due tomorrow --star --tag urgent
```

Breaking down something the user asked you to break down:

```
harbor-tasks add "Q3 review" --list Work --due +7d
harbor-tasks add "Pull last quarter's numbers" --parent "Q3 review"
harbor-tasks add "Reconcile the totals" --parent "Pull last quarter's numbers"
```

Then report back in one or two lines: what was added, to which list, with
what dates. Do not paste the raw JSON output.

## Reporting

Say what changed, in plain terms, with the numbers: "Added 3 tasks to
Work, the parent due Aug 6." If something was refused, say the refusal
verbatim rather than working around it. If anything was deleted, say
exactly what went with it.
