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

**Make every worker findable (Harbor's Orch view joins workers to batches).**
Harbor reads a batch's worker in this order: the queue's `last_session_id`,
then a transcript whose prompt starts with `BATCH TITLE: <batch title>`, then
the first session started in the batch's own lane `worktree` after its
dispatch. A Codex worker gets neither of the first two for free, so when you
(or your delegate tooling) launch one:

- Launch it with `codex exec --json` and read the first stdout event,
  `{"type":"thread.started","thread_id":"<id>"}`. Record that id on the
  batch with your delegate tooling's session-id update, the same field a
  Claude worker's session id goes in.
- Start the worker prompt with the line `BATCH TITLE: <batch title>`.
- Do not launch workers with `--ephemeral`: it writes no transcript, so
  nothing can show the worker's liveness or result.

Run the queue as a **pipeline, never in waves**. Serial-only execution
turns a day's queue into an unnecessarily long night, and so does waiting
for a whole wave to finish before starting the next batch:

- Dispatch every batch whose dependencies are done, up to the worker
  capacity your machine and accounts allow (memory, plan usage), each in
  its own git worktree, if your delegate tooling supports parallel
  dispatch. Claim only what you launch now; a claimed batch reads as
  running.
- Two concurrent batches that share files are a merge to resolve at
  integration, not a reason to wait. A batch waits only for a real data
  dependency, for capacity, or for an exclusive resource another batch is
  using (a device or emulator, one build slot, a deploy target).
- Every time a worker finishes: review it, merge it, run the affected
  checks, mark it done, then dispatch whatever just became ready. A
  dependent batch is cut from the merged result, so it starts from what it
  needs. A failed worker's branch is never merged; keep it for inspection.
- Review what the worker COMMITTED, not only its uncommitted diff: diff
  from the commit its worktree was cut from
  (`git diff "$(git merge-base HEAD <integration branch>)"`, plus `git log`
  over the same range and `git status` for untracked files).
- Mark a batch done only after its merge and checks pass; marking done is
  what releases the batches that depend on it.

**Gate economics:** run whatever verification the target repo defines
(tests, lint, a filtered subset) on the affected slice per merge when a
fast filtered check is available. Run the full, unfiltered verification
before each push, and again at the final ship gate. A filtered green
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
