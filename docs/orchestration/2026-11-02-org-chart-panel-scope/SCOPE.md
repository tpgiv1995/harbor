# Scope: live agent team org chart in Harbor's Orch view

Status: scoping only. Nothing is built. Written 2026-11-02 from a read of the code and of one hand-built chart for a large multi-agent project.

## 1. What exists today

The Orch view (`ViewSwitch.jsx`, view `orch`, mounted in `renderer/index.jsx`) has three layers.

- **Live runs** (`renderer/orchestration/OrchLiveRuns.jsx`): one card per delegate queue, with batch groups and worker state. Data comes from `main/providers/delegate.js` through `orchestration:list-runs`, reloaded every 30 seconds. The project panel (`OrchPanel.jsx`) watches the queue file and also polls every 10 seconds. It has the Research and Execute kickoff buttons (`main/actions/orchestration.js`).
- **Delegated agents** (`Delegations.jsx`): parent session, child agents, rounds, states such as "quiet 12m, possibly hung". Data comes from `main/providers/delegations.js` and its worker thread, which tails transcripts with saved byte offsets (`background-fold.json` holds offset, open tools, tasks, working flag, last signal time and model per file). A scan reruns on the sidebar bridge's `pane-agent-status` event. Codex parent links are already read (`lineage.parentThreadId`).
- **Sub-sessions** (`SubSessions.jsx`): searchable list of agent runs by parent, 30 second poll.

Missing: who directs and reviews whom, plan and usage per agent, how each runs, process parents, watch-outs. Most raw readers exist, so phase 1 is mostly composition.

## 2. Data model: one live derived view

No stored diagram. A pure function `deriveTeam(inputs, now)` returns `{ teams, agents, edges, warnings }`. Nothing it returns is saved, except an optional pin (section 3).

| Field | Source | Refresh |
|---|---|---|
| Exists, pid, cwd, argv (model, effort as launched), session id | sessiond pane files in `~/.local/state/harbor/sessiond/sessions/*.json`, already in the bridge's live state | sessiond events |
| Alive or ended | pane `exit` plus pid check | event |
| Claude plan home | which `.claude*\session-env\<session id>` folder exists (6 stats, cached forever per id) | once |
| Model actually used | last assistant `message.model` in the transcript tail (a session can switch model) | transcript tail |
| Codex model, effort, seat | `turn_context` in the rollout; `.codex*` folder | rollout tail |
| Usage (5-hour, weekly) | `~/.cache/harbor/usage-<home>.json` via `main/providers/usage.js` (rolls expired windows to 0) | file watch |
| Working, idle, open tool and its age | transcript tail: turn boundaries (`turn_duration`, `end_turn`, user text row) and a `tool_use` id open until its `tool_result` (from the agenttrail review) | transcript tail |
| Current task | last user prompt or assistant text, clipped | transcript tail |
| Helpers | `<session>\subagents\*.jsonl`; Codex `thread_spawn.parent_thread_id` (confirmed in current rollouts) | directory watch |
| How it runs | pane, `claude -p` worker, `codex exec`, subagent: argv and process command line | once |
| Process parent | walk ppid from a worker pid up to a pane pid; `daemon/process-intel.js` already holds ppid | worker start and exit |
| Worktree, branch | cwd, then one `git rev-parse`, refreshed on a `HEAD` change | event |
| Messages in and out | in no machine record today (phase 3) | |

**Staleness.** Pane existence and exits: instant. Transcript fields: watcher delay, under 2 seconds when the watch fires. Usage: written only while that home runs, so a card shows "sample 14m old", and a days-old reading is labelled stale, never shown as current. The usage file also carries `transcript_path`, which names the home of that home's newest session: a useful cross-check.

**Events, not polling.** Triggers are the bridge `update` and `pane-agent-status` events plus `fs.watch` on the specific files of live members only, never the whole projects tree. Honest weak spot: Windows file watching misses events on junctions and fast appends. Backstop: re-stat live members' files whenever any pane event fires, plus a slow sweep only while the view is visible. The only renderer timer redraws "3m ago" text. The existing 30 second polls in Live runs and Sub-sessions should move to the same feed in the same change.

**What needs a project declaration.** Roles and reporting lines are in no machine record. Smallest form, one file in the run folder:

`docs/orchestration/<date>-<slug>/TEAM.json`
```
{ "title": "Release team",
  "members": [
    { "name": "lead", "role": "Technical owner", "session": "<id or name>", "reports_to": "owner" },
    { "name": "lane-a", "role": "Console lane", "match": {"cwd": "...-lane-a"},
      "reports_to": "manager", "reviewed_by": ["lead"] } ],
  "notes": ["Lanes share one venv; run tests one at a time."] }
```
`session` or `match` ties a member to a live pane. `reports_to` and `reviewed_by` are the only relations. No dates, no status: status is always derived. A session can add itself through a one-line CLI later, but a hand-edited file is enough. Without the file the chart still draws inferred edges (process parent, Codex parent, subagent parent, `delegatedBy`) with no roles.

## 3. Anti-graveyard rules

1. The chart is a function of what is running now. No diagram list, no New, no Save.
2. A team exists while at least one member is alive (pane not exited, or worker pid present). Declared and inferred teams follow the same rule.
3. An ended member leaves the chart and goes to a collapsed strip, "Ended in the last 6 hours": one line each (name, model, outcome, time). After that it is gone from this view. History stays in Sub-sessions and the transcripts.
4. A team with no live member for 6 hours disappears. `TEAM.json` stays in the repo as an ordinary project document: the only persistent artifact, and it is a declaration, not a drawing.
5. The chart lives with its run: keyed by the run folder (or the project root when inferred). When the last session of the run ends, the chart closes.
6. No saved snapshots. Pat can pin one moment (small JSON in Harbor's cache dir, not the repo). A pin shows its expiry (7 days), expired pins are deleted at startup, and at most 5 exist.
7. Warnings are never stored; they exist only while the condition holds.

## 4. The card

**Collapsed** (about 220 px wide): provider logo tile, name and role; model and effort on one line; plan home with a thin weekly-usage bar and the percent as text; run mode; status as word plus icon (working, idle 12m, tool open 4m, ended), never colour alone; one or two plain-English sentences on what it is working on now (section 8, item 6); the Copy session id control; a warning glyph with a count. No coloured bar down a card's left edge, no row of equal big-number cards.

**Expanded** (click; a side drawer so the chart does not reflow): full current task; last 5 actions with times; open tool call and age; helpers and their states; worktree, branch, cwd; pid and process parent; usage with reset time and sample age; open pane, copy session id. Read-only (Pat, section 8).

**20 or more agents.**
- Group by project, then team, with counts in the header ("6 working, 3 idle").
- Helpers fold into the parent as a count and expand on click.
- Idle over 30 minutes and ended agents render as one-line chips in a collapsed "Idle" row per team.
- Layout: top-down tiers by `reports_to` depth from a small layered layout in our own code. Line style is explained in a legend and on hover: solid directs, dashed reviews, dotted keeps alive.
- Filters: project, plan home, provider, state, "warnings only".
- Honest empty states: "No agents running". No prompt to add a TEAM.json; roles are optional (section 8).

## 5. Watch-outs

Computed automatically:
- **Plan near limit with live agents on it**: weekly above 90 percent and a live member on that home; name the home, percent, reset time and agents.
- **Process parent that must not be closed**: a pane that is the ppid ancestor of live workers. Card says "Closing this ends N workers."
- **Two writers**: two live members with one session id (one thread open in two panes) or one worktree path.
- **Duplicate session names** among live sessions.
- **Many test runs at once**: live test-runner processes (pytest, node --test, vitest) above a threshold; shown on the team header.
- **Stale or idle-but-open pane**: pane alive, no transcript event for 30 minutes, no open tool. Separately, an open tool older than 10 minutes is "possibly stuck", with the tool name.
- **Unknown member** (live in the project, not in `TEAM.json`) and **declared but absent**.

Needs judgment, so a person writes it in `notes[]`: shared venv or database collisions, a stale context on an old pane, which look-alike pane is the real owner, an approval only the owner can give.

## 6. Phases

**Phase 1, smallest useful slice (5 to 6 days).** The Orch view's Live runs and Delegated agents lists become the team chart (an upgrade of that view, not a new tab; Pat, section 8), read-only. Live roster, collapsed and expanded cards, grouped by project, with the project filter, the Copy session id control and the one-to-two sentence description (titler extension in `main/providers/titles.js`). Fields from the pane registry, usage files and the existing transcript worker (model, working state, open tool, parent links). Edges inferred plus `TEAM.json` when present. Three warnings: plan near limit, process parent, two writers. Ended strip, no pins. Files: new `shared/team-model.cjs` (pure, unit-tested), `renderer/orchestration/TeamChart.jsx` and `AgentCard.jsx`, one IPC channel `orchestration:team` with an update push (`main/rpc/channels.js`, `main/index.js`), a small `main/providers/` reader for `TEAM.json` and the home lookup, styles. Risk: low; the cost is layout and card design.

**Phase 2, depth and speed (3 to 4 days).** Hardened home detection, Codex effort, subagent folders, branch, last 5 actions, remaining warnings, move the 30 second polls to events. Files: `delegations-worker.js` (expose last actions and tool start time), `sidebar-bridge.js`, `usage.js` (sample age). Risk: transcript size. Some exceed 100 MB, so tail from saved offsets, cap a first read to the last 2 MiB, reset on truncation, and never load a file whole.

**Phase 3, pins (1 to 2 days).** Pins with expiry and a `harbor-team` CLI. The message log is dropped (Pat, section 8); filters moved to phase 1.

**Phase 4, polish (2 to 3 days).** Keyboard navigation, large-team performance (draw visible tiers only), accessibility pass.

**Cross-cutting.** Windows watching (above). Whether `process-intel.js` can read command lines, not just ppid, needs confirming. A team can span projects; `session` ids handle that. Privacy is not a concern on this machine, but Harbor is public, so test fixtures use invented names.

## 7. Open questions for Pat (all answered 2026-11-02; see section 8)

1. Should Team replace Live runs and Delegations on the Orch tab, or sit beside them as a new tab for now?
2. Is read-only enough for v1, or should the chart also open, close or message an agent?
3. Is a message log (phase 3) worth building so cards show messages in and out?
4. Are 6 hours (ended agents and finished teams) and 7 days (pins) the right times?
5. Should reporting lines come from a file the lead session writes (`TEAM.json`), or do you want to draw them in Harbor?

## 8. Pat's answers (2026-11-02, about 04:30Z)

1. **An upgrade of the Orch view, not a separate tab.** The same information Live runs and Delegated agents show today, laid out as the team chart, with the detail one click into an agent card. It replaces those lists once it carries everything they show. QOL he named: **filter to one project and see only that one** (the project filter moves from phase 3 into phase 1).
2. **Read-only. No stop, resume, message or reassign buttons.** Today's Orch lists are read-only apart from the Research and Execute kickoff buttons on Live runs, which stay as they are. Every card (collapsed and expanded) carries Harbor's existing one-click **Copy session id** control, the same one as on session tiles (`renderer/stage/SessionTile.jsx`, aria-label "Copy session id"); Pat uses it all the time. Pat cannot close or keep open any of these panes, so no warning or card phrases a fix as Pat closing or keeping a pane: every warning names the agent who acts (Fable, the dispatcher). The section 5 warning "Closing this ends N workers" becomes "N workers depend on this pane".
3. **No message log.** Dropped entirely: bloat without enough benefit. Phase 3 keeps only pins; "messages in and out" leaves the expanded card.
4. **6 hours and 7 days: accepted.**
5. **The chart updates in real time; Pat never draws lines.** He constantly assigns new owners and subagents, so reporting lines come from the launches themselves: claude-worker, astra-run and cursor-worker record the launching session as `reports_to` at launch, subagent and Codex parent links come from transcripts, Harbor delegations from `delegatedBy`. `TEAM.json` shrinks to the few role labels no launch can show (who is the owner, who reviews whom), kept by the lead session, and is **entirely optional**: Pat does not need roles, so the chart must be complete and useful with no `TEAM.json` anywhere (no "add a TEAM.json" nag in the empty state).
6. **New requirement: every card says, in one or two plain-English sentences, what that session or agent is working on now.** This replaces the collapsed card's "one clipped line of current task". Source: extend Harbor's titler (`main/providers/titles.js`, `claude -p` on Haiku through Pat's plan, which already names each session twice from its opening and later prompts) to also write this description from the opening prompt or brief plus the latest prompts and turns. Refresh on an event, never a timer: when a live member finishes a turn and its description is more than 10 minutes old. Cached per session; ended members keep their last one in the ended strip. Words a reader would use, no ids or function names.

What was explained to Pat for 2 and 3:
- **Read-only** means the cards only show. The alternative is actions on a card: send a message to that agent, stop or end it, resume a stalled one, reassign its owner. That would also give Pat the way to end a stale pane he does not have today.
- **Message log** means each card shows the traffic in and out of that agent with times: briefs sent to it, reports it returned, courier notes, packets to Astra, Pat's pastes; one line each, click to read the full text. The cost is that no single record exists: messages travel through Harbor sends, courier files, worker briefs and Codex resumes, and each route would have to log a line.
