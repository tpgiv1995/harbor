---
description: Run the current workspace's orchestration queue autonomously until it is exhausted, a hard blocker appears, or an optional batch cap is reached.
argument-hint: [max-batches]
allowed-tools: Bash(*)
---

Execute the already-loaded orchestration queue for this workspace.

This is the companion to `/orchestrate-research` (which builds the queue)
and `/orchestrate-status` (which reports on it). It expects the same
delegation queue CLI, referred to below as `claude-delegate`, on `PATH`.

**This command needs a delegation queue CLI that Harbor does not ship.** It is
referred to below as `claude-delegate`, and it is the tool that stores a batch
queue and dispatches batches to worker sessions. If you do not have one on your
`PATH`, every command below fails with "command not found" from its first step,
and Harbor's setup wizard will have defaulted the Orch view off for exactly that
reason. See `docs/COMMANDS.md` for what the queue format is and what parts of
this workflow are still useful without the tool.


**Harbor refuses to open a second `/orchestrate-execution` session in the
same workspace while one is already active.** If Harbor's Orch panel
already has an execution pane open for this project, or the queue already
has an active batch in progress, a second "Execute" kickoff is blocked
rather than started: the same underlying job cannot safely run twice at
once against one queue. If you're running this command by hand outside
Harbor, apply the same rule yourself: check `/orchestrate-status` first,
and don't run a second execution loop concurrently against the same
queue.

Rules:

- If `$ARGUMENTS` is empty, process until the queue is exhausted or a hard
  blocker stops the run.
- If `$ARGUMENTS` is a number, use it as the maximum number of batches to
  process.
- Do not ingest or research new work here. This command operates on the
  existing queue only.

## Workflow

### Phase 1: Inspect queue

Run:

```bash
claude-delegate queue status
```

If there are no pending batches, stop and say there is nothing to
execute. Recommend either:

```text
/orchestrate-research <goal>
```

or

```text
/orchestrate-status
```

### Phase 2: Autonomous dispatch loop

Track the current sprint number. Start this session at the default
orchestrator effort shown in the Sprint Plan (usually **high**).

Each dispatch response should carry, if your delegate tooling supports it:

- `Sprint:` sprint number for this batch (from queue metadata)
- `Orchestrator Effort:` how deep **you** should think when classifying
  the worker result
- `Worker Effort:` applied to the dispatched worker

**Default orchestration behavior (every queue):**

1. Read the Sprint Plan from `queue status` before the first dispatch.
2. On every dispatch, read `Orchestrator Effort` and `Worker Effort` from
   the delegate response if present. Don't guess or override them.
3. When the sprint number changes between batches, acknowledge the sprint
   transition in one line, then continue at the new orchestrator effort.
4. Never reassign workers or effort mid-run unless the user explicitly
   asks.
5. **Keep gap-fills and retries on the workers, not on this session.**
   When a worker dies or under-delivers, re-dispatch the remediation to a
   worker. Never absorb it into this session as a large in-session
   sub-agent fan-out, and never silently reroute it onto a different,
   capacity-limited account. Surface any mid-run addition of work onto a
   shared/limited account in the final operator summary.
6. **Worker liveness should be structural, not something you watch for.**
   If your delegate tooling supervises worker processes (killing a worker
   with no output and no fresh session activity past a stall timeout), rely
   on that rather than polling by hand. If it doesn't, arm your own
   watchdog before the first dispatch and check on it periodically rather
   than trusting a silent queue. On a stall: don't kill processes by
   pattern match, only by exact identifier. Salvage a worker's tree if the
   implementation is substantially complete and you can verify it
   yourself, otherwise re-dispatch. Never run two verification gates (for
   example two full test/e2e suites) concurrently against the same
   workspace: concurrent runs of the same gate can deadlock each other.

Dispatch parallel lanes whenever the queue allows it, if your delegate
tooling supports it. Serial-only execution turns a day's queue into an
unnecessarily long night:

```bash
claude-delegate dispatch-parallel --max 3
```

A parallel dispatch typically picks same-sprint pending batches with
pairwise-disjoint file lists, runs each worker concurrently (for example
in its own git worktree), and merges successful lanes back; a failed
worker's lane should never be merged, and its work should be kept around
for inspection. Verify the merged tree once per wave, not once per batch.
Fall back to one batch at a time when batches genuinely share files:

```bash
claude-delegate dispatch-next
```

**Gate economics:** run whatever verification the target repo defines
(tests, lint, a filtered subset) on the affected slice per batch when a
fast filtered check is available. Run the full, unfiltered verification
once per merged wave, and again at the final ship gate. A filtered green
result is never a substitute for the ship-gate green.

For each worker result, classify it using this aggressive bias:

#### Case A: complete enough to continue

If the worker reports a concrete implementation, review, or analysis
result, stayed in scope, and did not hit a real external blocker, mark it
done and continue.

```bash
claude-delegate queue done <batch-id>
```

Bias toward continuing. Do not stop for soft ambiguity alone.

#### Case B: hard blocker

Stop only for real blockers such as:

- missing credentials or secrets
- missing permissions or access
- waiting for a safe deploy/live window
- unresolved external dependency
- explicit "cannot proceed safely until X happens"
- a worker's usage limit hit, with no working alternative account
  configured

When that happens, mark it blocked:

```bash
claude-delegate queue blocked <batch-id> <short-note>
```

Then stop immediately.

#### Case C: queue exhausted

If there are no more pending batches, stop and say the queue is
exhausted.

## Final response

When you stop, return a compact operator summary:

- `Completed this run:`
- `Blocked:` if any
- `Remaining pending:`
- `Recommended next command:`

Keep it operational and concise.
