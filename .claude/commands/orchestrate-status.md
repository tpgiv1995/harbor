---
description: Show the current orchestration queue, worker handles, and the next recommended action for this workspace.
allowed-tools: Bash(*)
---

Show the orchestration state for this workspace.

This reports on the queue that `/orchestrate-research` builds and
`/orchestrate-execution` drains, via the same delegation queue CLI
(referred to below as `claude-delegate`).

**This command needs a delegation queue CLI that Harbor does not ship.** It is
referred to below as `claude-delegate`, and it is the tool that stores a batch
queue and dispatches batches to worker sessions. If you do not have one on your
`PATH`, every command below fails with "command not found" from its first step,
and Harbor's setup wizard will have defaulted the Orch view off for exactly that
reason. See `docs/COMMANDS.md` for what the queue format is and what parts of
this workflow are still useful without the tool.


Run both:

```bash
claude-delegate queue status
```

and

```bash
claude-delegate list
```

Then give a compact operator summary:

- pending / active / blocked / done batch counts, if visible
- active saved worker handles by engine (for example: codex, cursor,
  claude), if visible
- which account or config home the orchestrator and workers are running
  under, if that's visible and relevant (useful when a project uses more
  than one)
- the next recommended command

Prefer these recommendations:

- `/orchestrate-execution` if there are pending batches
- `/orchestrate-research <goal>` if no queue exists or no pending work
  remains
