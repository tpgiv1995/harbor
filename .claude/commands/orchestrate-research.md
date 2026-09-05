---
description: Research a goal in the current workspace, break it into actionable worker batches, and replace the local orchestration queue.
argument-hint: <goal>
---

Turn the user's goal into an execution-ready queue for the current
workspace.

This command (together with `/orchestrate-execution` and
`/orchestrate-status`) is the workflow Harbor's own Orch panel drives by
default: clicking "Research" in a project's Orch view opens a new pane and
runs this command there. It expects a delegation queue CLI (referred to
below as `claude-delegate`, matching Harbor's default config) on `PATH`
that can import a batch queue and dispatch batches to worker sessions
(commonly Codex, Cursor, or additional Claude sessions). If your workspace
doesn't have such a tool configured, this command's packet format and
research workflow are still useful on their own: adapt Phase 3 to
whatever dispatch mechanism you actually have.

Rules:

- Treat `$ARGUMENTS` as the mission goal. If it is empty, stop and ask for
  a goal.
- This command is allowed to replace the current local queue for this
  workspace.
- Do a moderate-depth dive, not an exhaustive sweep, unless the user
  explicitly asks for one.
- Prefer 3-10 batches depending on scope. Merge related work; avoid
  unnecessary fragmentation.
- **Keep heavy work off the orchestrator session.** This command runs in
  an interactive session with its own capacity. Bulk, token-heavy work
  (scanning, mining, extraction across many files) belongs on the
  dispatched workers, not as in-session sub-agents of this session. If an
  in-session sub-agent is genuinely unavoidable for a small piece of
  research, pin it to a smaller/cheaper model explicitly rather than
  letting it inherit this session's own model, and never fan out a large
  number of in-session sub-agents; route that to worker batches instead.
- **Check which workers actually exist before recommending them.** The bias
  list below assumes a mixed fleet; a machine with only the Claude CLI
  installed has no Codex or Cursor worker to dispatch to, and a packet that
  names one is a batch that cannot run. `command -v codex cursor-agent` costs
  nothing, and Harbor's own setup wizard records the same answer under
  `providers` in its config. Recommend only what is there, and say in the
  packet when a batch would have suited a worker type the machine does not
  have.
- Bias worker choice like this unless the work strongly suggests
  otherwise:
  - A **Codex-style** worker suits mechanical implementation, scoped code
    fixes, test/fix loops, and new modules that follow a clear existing
    pattern.
  - A **Cursor-style** worker suits review, deployment reasoning, UI/
    template work, runbooks, and infra judgment calls.
  - An **additional Claude worker session** suits medium-to-high judgment
    work that specifically benefits from Claude's own reasoning; use it
    sparingly since it draws on the same account capacity as this
    orchestrator session, and never route bulk scanning/mining/extraction
    there.
- Target a mixed fleet on large sweeps rather than leaning on one worker
  type for everything; the right mix depends on how mechanical vs.
  judgment-heavy the work is.
- If a batch needs a stronger or specific model than your worker's
  default, say so explicitly in `CONSTRAINTS:` rather than assuming the
  default is adequate.
- **Real-shape fixtures, never cartoons.** When a batch's correctness
  depends on a real data shape (a parser's input, a log schema, an API
  response), the packet should ship a real sample captured from the live
  system, or explicitly instruct the worker to capture one before coding.
  A worker allowed to invent its own fixture will pass its own tests and
  fail reality.
- **Design for parallel lanes**, if your delegate tooling supports
  dispatching same-sprint batches concurrently (for example in separate
  git worktrees): list every file a batch may touch, use absolute paths,
  and split sprints so independent batches don't share files. Batches with
  disjoint file lists can run concurrently; batches that share files must
  be sequenced.

## Workflow

### Phase 1: Research the workspace

Before proposing batches, inspect enough context to understand the goal:

- current git status
- recent commits
- top-level structure
- relevant docs/manifests if they materially clarify the goal
- the most relevant code/files for the requested work

Stay focused. Do not perform an audit of unrelated subsystems.

### Phase 2: Produce execution packets

Create a concise research summary and then break the work into actionable
batches.

Use the exact packet format below for each batch:

```text
BATCH TITLE:
FINDING IDS:
PRIORITY:
SPRINT:
ORCHESTRATOR EFFORT:
WORKER EFFORT:
WORKER:
WHY THIS WORKER:
GOAL:
FILES:
SOURCE LINES:
SNIPPET:
CONSTRAINTS:
DONE WHEN:
REPORT BACK WITH:
```

Notes:

- **Always set `SPRINT:`** on every batch when building a multi-phase
  sweep. Group related batches into the same sprint number.
- `ORCHESTRATOR EFFORT` and `WORKER EFFORT` are optional per batch; if your
  delegate tooling supports queue-level defaults (a `sprint_plan`), it can
  resolve them from there instead.
- For non-audit work, `FINDING IDS:` can be a stable synthetic identifier
  like `MISSION-1`, `MISSION-2`, etc.
- Keep packets narrow and shippable.
- Include only the minimum code/context needed.
- Preserve real dependency order when one batch must precede another.
- Avoid broad redesign unless a narrow path is clearly unsafe.

### Phase 3: Import the queue

After you have the packets, build JSON in this shape:

```json
{
  "source_label": "orchestrate-research",
  "source_note": "<brief goal summary>",
  "sprint_plan": {
    "1": {"orchestrator_effort": "high", "label": "Foundation"},
    "2": {"orchestrator_effort": "high", "label": "Go-live paths"}
  },
  "batches": [
    {
      "id": "batch-1",
      "title": "...",
      "finding_ids": "...",
      "priority": "P0",
      "sprint": 1,
      "orchestrator_effort": "high",
      "worker_effort": "high",
      "worker": "...",
      "why_this_worker": "...",
      "goal": "...",
      "files": ["..."],
      "source_lines": ["..."],
      "snippet": "...",
      "constraints": "...",
      "done_when": "...",
      "report_back_with": "..."
    }
  ]
}
```

Use Bash to:

1. write that JSON to a temp file
2. import it with:

```bash
claude-delegate queue import --file "<tempfile>"
```

3. then show the resulting queue with:

```bash
claude-delegate queue status
```

## Final response

End with a compact operator summary:

- mission summary
- batch count
- dependency order
- top 3 batch titles/workers
- any batch that draws on a shared/capacity-limited Claude account, with a
  one-line justification each (or "none")
- exact next command, normally:

```text
/orchestrate-execution
```

Do not start executing the queue in this command.
