'use strict';

// THE TEAM CHART IS A FUNCTION OF WHAT IS RUNNING NOW (2026-11-02, Pat's
// decisions in docs/orchestration/2026-11-02-org-chart-panel-scope/SCOPE.md
// section 8). `deriveTeam` turns the machine's own records into cards,
// reporting lines and warnings. Nothing it returns is stored: the provider
// (main/providers/team.js) gathers the inputs on events and calls this again.
//
// Reporting lines come from the launches themselves, never from a drawing:
//   - a launch record (claude-worker, astra-run, cursor-worker, cursor-run write
//     the launching session into ~/.harbor/team-launches.jsonl),
//   - the process tree (a worker running under a pane's process),
//   - Harbor's delegation links (a `codex exec` a parent's Bash call started),
//   - Codex `thread_spawn` parents and Claude `subagents\` folders (helpers),
//   - TEAM.json, optional, only for role labels and "reviews".
// Main-process and test use only, so there is no ESM twin.

const IDLE_ROW_MS = 30 * 60 * 1000;
const ENDED_WINDOW_MS = 6 * 60 * 60 * 1000;
const STUCK_TOOL_MS = 10 * 60 * 1000;
const QUIET_PANE_MS = 30 * 60 * 1000;
const STARTING_MS = 2 * 60 * 1000;
const WORKING_FRESH_MS = 3 * 60 * 1000;
const PLAN_NEAR_LIMIT_PCT = 90;
const MANY_TEST_RUNS = 4;
const USAGE_STALE_MS = 6 * 60 * 60 * 1000;

// Which evidence wins when two sources name a different parent. A team's own
// declaration (TEAM.json reports_to) wins: whoever STARTS a run is not always
// its boss, and in a lead-and-reviewer team the lead routinely launches the
// reviewer's thread to ask for a ruling (cdt-app, 2026-11-02: Fable resumes
// Astra's thread, yet Astra directs Fable; Pat: "it should be the astra agent
// -> fable agent -> all others"). Then the launcher's own record; delegation
// links proven by exact ids; and the process tree, which is only where a
// worker happens to run.
const DIRECT_SOURCES = ['declared', 'launch', 'delegation', 'process'];

function isUuidLike(value) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || '')); }

function slashes(value) { return String(value || '').replace(/\\/g, '/'); }

// Inside a project root: the root itself or a folder below it, never a sibling
// that merely shares its prefix (C:/dev/cdt-app-other is not C:/dev/cdt-app).
function underRoot(folder, root) {
  const a = slashes(folder).toLowerCase().replace(/\/+$/, '');
  const b = slashes(root).toLowerCase().replace(/\/+$/, '');
  return Boolean(b) && (a === b || a.startsWith(`${b}/`));
}

// A worktree, pool slot or orchestration scratch folder belongs to the project
// it was cut from: `C:\dev\.orch\cdt-app\rebuild-DX1` and
// `C:\dev\.orch\pool\cdt-app\slot-03` are cdt-app's agents, which is what a
// project filter must find. String-only: the provider labels the answer.
function canonicalProjectCwd(cwd) {
  const text = slashes(cwd).replace(/\/+$/, '');
  const match = /^(.*?)\/\.orch\/(?:pool\/)?([^/]+)(?:\/|$)/i.exec(text);
  if (!match) return cwd || null;
  if (/^pool$/i.test(match[2])) return cwd || null;
  const base = match[1];
  const sep = String(cwd).includes('\\') ? '\\' : '/';
  return `${base}/${match[2]}`.replace(/\//g, sep);
}

// A brief's first line, as a name: no markdown heading marks, no batch prefix,
// and a long line loses its parenthetical tail ("A1: harbor lights (from the
// lead, Nov 2; lane A1 on ...)" reads "A1: harbor lights").
function cleanTitle(value) {
  const text = String(value || '').replace(/^\s*BATCH TITLE:\s*/i, '').split(/\r?\n/).find((line) => line.trim()) || '';
  let trimmed = text.trim().replace(/^#+\s*/, '').replace(/^\*\*(.+?)\*\*/, '$1');
  if (trimmed.length > 48 && trimmed.indexOf(' (') > 12) trimmed = trimmed.slice(0, trimmed.indexOf(' (')).trim();
  if (trimmed.length > 64) {
    const comma = trimmed.indexOf(', ', 24);
    if (comma > 0 && comma <= 64) trimmed = trimmed.slice(0, comma);
  }
  if (trimmed.length > 64) {
    const cut = trimmed.lastIndexOf(' ', 60);
    trimmed = `${trimmed.slice(0, cut > 30 ? cut : 60).replace(/[\s,;:.-]+$/, '')}…`;
  }
  return trimmed;
}

// "claude-opus-5-5" reads "Opus 5.5"; "gpt-6-astra" reads "GPT-6 Astra".
// Unknown ids are shown as recorded, never guessed.
function modelLabel(id) {
  if (!id) return null;
  const raw = String(id).replace(/\[1m\]$/i, '').trim();
  const claude = /^(?:claude-)?(opus|sonnet|haiku|fable)(?:-(\d+)(?:[-.](\d+))?)?(?:-\d{8})?$/i.exec(raw);
  if (claude) {
    const family = claude[1][0].toUpperCase() + claude[1].slice(1).toLowerCase();
    if (!claude[2]) return family;
    return `${family} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`;
  }
  const gpt = /^gpt-(\d+(?:\.\d+)?)(?:-(.+))?$/i.exec(raw);
  if (gpt) {
    const rest = gpt[2] ? ` ${gpt[2].split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join(' ')}` : '';
    return `GPT-${gpt[1]}${rest}`;
  }
  return raw;
}

function argvValue(argv, ...names) {
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i += 1) {
    const word = String(list[i]);
    for (const name of names) {
      if (word === name) return list[i + 1] ?? null;
      if (word.startsWith(`${name}=`)) return word.slice(name.length + 1);
    }
  }
  return null;
}

// What the agent is doing, as a kind a reader can filter on plus the evidence
// time; the renderer turns it into "Working", "Idle 12m", "Bash open 4m".
function memberStatus({ alive, facts, pane, createdMs, endedMs }, now) {
  if (!alive) return { kind: 'ended', sinceMs: endedMs || facts?.lastEventMs || null };
  const open = facts?.openTools || [];
  if (open.length) {
    const oldest = open.reduce((a, b) => (a.startedMs <= b.startedMs ? a : b));
    return { kind: 'tool', sinceMs: oldest.startedMs || null, tool: oldest.name || 'Tool' };
  }
  const freshTurn = facts?.working && facts.lastInTurnMs && now - facts.lastInTurnMs < WORKING_FRESH_MS;
  if (freshTurn || pane?.agentStatus === 'working') return { kind: 'working', sinceMs: facts?.turnStartedMs || facts?.lastEventMs || null };
  if (!facts?.lastEventMs && createdMs && now - createdMs < STARTING_MS) return { kind: 'starting', sinceMs: createdMs };
  if (facts?.working && facts.lastInTurnMs) return { kind: 'quiet', sinceMs: facts.lastInTurnMs };
  return { kind: 'idle', sinceMs: facts?.turnEndedMs || facts?.lastEventMs || createdMs || null };
}

function deriveTeam(inputs = {}, now = Date.now()) {
  const sessions = inputs.sessions || {};
  const facts = inputs.facts || {};
  const descriptions = inputs.descriptions || {};
  const sessionHomes = inputs.sessionHomes || {};
  const usage = inputs.usage || {};
  const homes = inputs.homes || [];
  const homeByDir = new Map(homes.filter((h) => h.configHome).map((h) => [slashes(h.configHome).toLowerCase().replace(/\/+$/, ''), h.id]));
  const homeForDir = (dir) => (dir ? homeByDir.get(slashes(dir).toLowerCase().replace(/\/+$/, '')) || null : null);
  const projectLabel = inputs.projectLabel || ((cwd) => (cwd ? slashes(cwd).split('/').filter(Boolean).at(-1) : null));

  const members = new Map();
  const edges = [];
  const edgeKeys = new Set();
  const addEdge = (from, to, kind, source) => {
    if (!from || !to || from === to) return;
    const key = `${from}>${to}>${kind}>${source}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ from, to, kind, source });
  };

  const upsert = (id, patch) => {
    const existing = members.get(id);
    if (existing) {
      for (const [key, value] of Object.entries(patch)) if (existing[key] == null && value != null) existing[key] = value;
      return existing;
    }
    const member = { id, ...patch };
    members.set(id, member);
    return member;
  };

  // 1. Live panes. A pane is the strongest liveness fact Harbor has.
  const paneBySession = new Map();
  const panePid = new Map();
  const sessionPanes = new Map();
  for (const pane of inputs.panes || []) {
    if (pane.exited) continue;
    const id = pane.sessionId || `pane:${pane.paneId}`;
    if (pane.sessionId) {
      if (!sessionPanes.has(pane.sessionId)) sessionPanes.set(pane.sessionId, []);
      sessionPanes.get(pane.sessionId).push(pane.paneId);
    }
    paneBySession.set(id, pane);
    if (pane.pid) panePid.set(pane.pid, id);
    upsert(id, {
      sessionId: isUuidLike(pane.sessionId) ? pane.sessionId : (pane.sessionId || null),
      provider: pane.provider || 'claude',
      runMode: 'pane',
      alive: true,
      pid: pane.pid || null,
      paneId: pane.paneId,
      cwd: pane.cwd || null,
      createdMs: pane.createdMs || null,
      launchModel: argvValue(pane.argv, '--model', '-m'),
      launchEffort: argvValue(pane.argv, '--effort'),
    });
  }

  // A launcher started from a Codex shell that a Claude session opened sees
  // both CODEX_THREAD_ID and the inherited CLAUDE_CODE_SESSION_ID. The nearer
  // one is the thread whose own parent is the other.
  const childOfLaunch = new Map((inputs.launches || []).filter((l) => l.child?.session).map((l) => [l.child.session, l.parent?.session || null]));
  const parentOfSession = (id) => sessions[id]?.delegatedBy || sessions[id]?.parentThreadId || childOfLaunch.get(id) || null;
  const launchParent = (launch) => {
    const both = launch.parents;
    if (both?.claude && both?.codex && both.claude !== both.codex) {
      if (parentOfSession(both.codex) === both.claude) return both.codex;
      if (parentOfSession(both.claude) === both.codex) return both.claude;
    }
    return launch.parent?.session || null;
  };

  // 2. Launch records: the launcher said who started it.
  const launchByChildPid = new Map();
  for (const launch of inputs.launches || []) {
    const child = launch.child || {};
    const id = child.session || `launch:${launch.launch}`;
    const alive = Boolean(launch.alive) && !launch.endedMs;
    if (!alive) continue;
    if (launch.childPid) launchByChildPid.set(launch.childPid, id);
    if (launch.pid) launchByChildPid.set(launch.pid, id);
    upsert(id, {
      sessionId: child.session || null,
      provider: child.provider || 'claude',
      runMode: 'worker',
      launcher: launch.launcher || null,
      alive: true,
      pid: launch.childPid || launch.pid || null,
      launcherPid: launch.pid || null,
      cwd: child.cwd || null,
      createdMs: launch.startedMs || null,
      launchModel: child.model || null,
      launchEffort: child.effort || null,
      launchHome: homeForDir(child.home),
      launchTitle: child.title ? cleanTitle(child.title) : null,
      lane: child.lane || null,
    });
    const parentId = launchParent(launch);
    if (parentId) addEdge(parentId, id, 'directs', 'launch');
  }

  // 3. Worker processes found in the process table (launches from before the
  // launchers wrote records, and a cross-check for those that do). The pane
  // whose process tree holds a worker keeps it alive.
  const testRuns = new Map();
  for (const proc of inputs.processes || []) {
    if (proc.kind === 'test') {
      const key = proc.paneId ? `pane:${proc.paneId}` : proc.ownerPid ? `pid:${proc.ownerPid}` : 'machine';
      if (!testRuns.has(key)) testRuns.set(key, []);
      testRuns.get(key).push(proc);
      continue;
    }
    const known = launchByChildPid.get(proc.pid) || launchByChildPid.get(proc.launcherPid) || (proc.sessionId && members.has(proc.sessionId) ? proc.sessionId : null);
    const id = known || proc.sessionId || `proc:${proc.pid}`;
    const member = upsert(id, {
      sessionId: proc.sessionId || null,
      provider: proc.provider || 'claude',
      runMode: 'worker',
      launcher: proc.launcher || null,
      alive: true,
      pid: proc.pid || null,
      launcherPid: proc.launcherPid || null,
      cwd: proc.cwd || null,
      createdMs: proc.startedMs || null,
      launchModel: proc.model || null,
      launchEffort: proc.effort || null,
      launchHome: proc.home ? homeForDir(proc.home) || (homes.some((h) => h.id === proc.home) ? proc.home : null) : null,
      launchTitle: proc.title ? cleanTitle(proc.title) : null,
    });
    if (proc.paneId) {
      const paneMember = paneBySession.has(proc.paneId) ? proc.paneId : [...paneBySession.entries()].find(([, pane]) => pane.paneId === proc.paneId)?.[0];
      if (paneMember && paneMember !== member.id) {
        member.processParent = paneMember;
        addEdge(paneMember, member.id, 'directs', 'process');
      }
    }
  }

  // 4. Delegated agents: a `codex exec` (or astra-run) a parent's Bash call
  // started, linked by exact ids in providers/delegations.js.
  for (const group of inputs.delegations || []) {
    for (const agent of group.agents || []) {
      if (!agent.sessionId) continue;
      const running = ['running', 'quiet', 'no signal'].includes(agent.state);
      if (!running && !members.has(agent.sessionId)) continue;
      const row = sessions[agent.sessionId] || {};
      upsert(agent.sessionId, {
        sessionId: agent.sessionId,
        provider: agent.provider || row.provider || 'codex',
        runMode: 'worker',
        launcher: agent.launcher || null,
        alive: running || members.get(agent.sessionId)?.alive || false,
        cwd: row.cwd || null,
        createdMs: agent.rounds?.[0]?.startedMs || null,
        launchModel: agent.model || null,
        launchTitle: agent.description ? cleanTitle(agent.description) : null,
        delegationState: agent.state,
        rounds: agent.rounds || [],
      });
      addEdge(group.parentId, agent.sessionId, 'directs', 'delegation');
    }
  }
  for (const [id, row] of Object.entries(sessions)) {
    if (row.delegatedBy && members.has(id) && row.delegatedBy !== id && !row.parentThreadId) addEdge(row.delegatedBy, id, 'directs', 'delegation');
  }

  // 5. TEAM.json: optional. Names, roles, reports_to, reviewed_by; `top` for
  // the member nobody above it on this chart directs; and
  // everyone_else_reports_to, which puts every other agent of the project
  // that has no line of its own under one member (a lead's lanes, without
  // listing them one by one or rewriting the file at every relaunch).
  const declaredBy = new Map();
  const declaredAbsent = [];
  const declaredTop = new Set();
  const everyoneElse = [];
  for (const declaration of inputs.declarations || []) {
    const nameToId = new Map();
    for (const entry of declaration.members || []) {
      let id = null;
      if (entry.session && members.has(entry.session)) id = entry.session;
      if (!id && entry.session) {
        const byName = [...members.values()].find((m) => m.alive && (sessions[m.id]?.title === entry.session || m.launchTitle === entry.session));
        id = byName?.id || null;
      }
      if (!id && entry.match?.cwd) {
        const needle = slashes(entry.match.cwd).toLowerCase();
        const byCwd = [...members.values()].find((m) => m.alive && slashes(m.cwd).toLowerCase().endsWith(needle));
        id = byCwd?.id || null;
      }
      if (entry.name) nameToId.set(entry.name, id);
      if (!id) { declaredAbsent.push({ name: entry.name || entry.session || 'member', role: entry.role || null, file: declaration.file }); continue; }
      declaredBy.set(id, { name: entry.name || null, role: entry.role || null, file: declaration.file, team: declaration.title || null });
      if (entry.top === true) declaredTop.add(id);
    }
    const leadId = declaration.everyoneElse ? nameToId.get(declaration.everyoneElse) : null;
    if (leadId) everyoneElse.push({ leadId, root: slashes(declaration.root).toLowerCase() });
    for (const entry of declaration.members || []) {
      const id = nameToId.get(entry.name);
      if (!id) continue;
      const boss = entry.reports_to ? nameToId.get(entry.reports_to) : null;
      if (boss) addEdge(boss, id, 'directs', 'declared');
      for (const reviewer of entry.reviewed_by || []) {
        const reviewerId = nameToId.get(reviewer);
        if (reviewerId) addEdge(reviewerId, id, 'reviews', 'declared');
      }
    }
  }

  // Fill each member from its session row, transcript facts and description.
  const helpersByParent = inputs.helpers || {};
  for (const member of members.values()) {
    const row = (member.sessionId && sessions[member.sessionId]) || {};
    const fact = (member.sessionId && facts[member.sessionId]) || null;
    const declared = declaredBy.get(member.id) || null;
    member.cwd = member.cwd || row.cwd || null;
    member.provider = member.provider || row.provider || 'claude';
    member.projectCwd = canonicalProjectCwd(member.cwd);
    member.project = member.projectCwd ? projectLabel(member.projectCwd) : (row.project || 'No project');
    const homeId = sessionHomes[member.sessionId] || row.home || member.launchHome || homeForDir(fact?.homeDir) || null;
    member.home = homeId;
    member.model = fact?.model || member.launchModel || row.model || null;
    member.modelLabel = modelLabel(member.model);
    member.effort = fact?.effort || member.launchEffort || null;
    member.name = declared?.name
      || member.launchTitle
      || (row.title ? cleanTitle(row.title) : null)
      || row.nickname
      || (row.firstPrompt ? cleanTitle(row.firstPrompt) : null)
      // A worker only the process table knows has no title yet; its worktree
      // folder (foundation-rebuild-L5) says more than "Untitled session".
      || (member.runMode === 'worker' && member.cwd ? slashes(member.cwd).replace(/\/+$/, '').split('/').at(-1) || null : null)
      || (member.provider === 'cursor' ? 'Cursor worker' : 'Untitled session');
    member.role = declared?.role || null;
    member.declaredTeam = declared?.team || null;
    const description = member.sessionId ? descriptions[member.sessionId] : null;
    member.description = description?.text || null;
    member.descriptionAtMs = description?.atMs || null;
    member.lastPrompt = fact?.lastPrompt || row.lastPrompt || null;
    member.lastText = fact?.lastText || null;
    member.actions = fact?.actions || [];
    member.openTools = fact?.openTools || [];
    member.lastEventMs = fact?.lastEventMs || null;
    member.transcriptPath = row.path || null;
    member.status = memberStatus({ alive: member.alive, facts: fact, pane: paneBySession.get(member.id), createdMs: member.createdMs }, now);
    const helpers = (member.sessionId && helpersByParent[member.sessionId]) || [];
    member.helpers = helpers.map((helper) => ({ ...helper, modelLabel: modelLabel(helper.model) }));
    member.panes = member.sessionId ? (sessionPanes.get(member.sessionId) || []) : [];
    const u = homeId ? usage[homeId] : null;
    member.usage = u ? {
      weeklyPct: Number.isFinite(u.weeklyPct) ? u.weeklyPct : null,
      weeklyResetsAt: u.weeklyResetsAt || null,
      fiveHourPct: Number.isFinite(u.fiveHourPct) ? u.fiveHourPct : null,
      fiveHourResetsAt: u.fiveHourResetsAt || null,
      sampledMs: u.updatedAtMs || null,
      stale: Boolean(u.updatedAtMs && now - u.updatedAtMs > USAGE_STALE_MS),
    } : null;
  }

  // Each member gets ONE reporting line to draw the tree: the strongest
  // direct source whose other end is on the chart. The rest stay as evidence
  // in the drawer, and a process parent that differs from the reporting line
  // is drawn as a dotted "keeps alive" line.
  const directs = edges.filter((edge) => edge.kind === 'directs');
  for (const member of members.values()) {
    const candidates = directs.filter((edge) => edge.to === member.id)
      .sort((a, b) => DIRECT_SOURCES.indexOf(a.source) - DIRECT_SOURCES.indexOf(b.source));
    member.launchedBy = candidates.find((edge) => edge.source !== 'process')?.from || null;
    // A worker found only in the process table whose launching process has
    // ended: it started before the launchers recorded launches, so who
    // launched it is not on any record. Said plainly, never "by hand".
    member.parentUnknown = member.runMode === 'worker' && !candidates.length;
    const onChart = declaredTop.has(member.id) ? null : candidates.find((edge) => members.has(edge.from) && members.get(edge.from).alive);
    member.parent = onChart?.from || null;
    member.parentSource = onChart?.source || null;
  }
  // Break any cycle by cutting the weakest line in it.
  for (const member of members.values()) {
    const seen = new Set([member.id]);
    let cursor = member;
    while (cursor.parent) {
      if (seen.has(cursor.parent)) { member.parent = null; member.parentSource = null; break; }
      seen.add(cursor.parent);
      cursor = members.get(cursor.parent);
      if (!cursor) break;
    }
  }

  // everyone_else_reports_to: every live agent of that project with no line
  // of its own, except the lead and anyone above the lead, reports to the lead.
  for (const { leadId, root } of everyoneElse) {
    if (!members.get(leadId)?.alive) continue;
    const above = new Set([leadId]);
    for (let cursor = members.get(leadId); cursor?.parent && !above.has(cursor.parent); cursor = members.get(cursor.parent)) above.add(cursor.parent);
    for (const member of members.values()) {
      if (!member.alive || member.parent || above.has(member.id) || declaredTop.has(member.id)) continue;
      if (!underRoot(member.projectCwd, root)) continue;
      member.parent = leadId;
      member.parentSource = 'declared';
    }
  }

  const drawn = [];
  for (const member of members.values()) {
    if (member.parent) drawn.push({ from: member.parent, to: member.id, kind: 'directs', source: member.parentSource });
    if (member.processParent && member.processParent !== member.parent && members.has(member.processParent)) {
      drawn.push({ from: member.processParent, to: member.id, kind: 'keeps-alive', source: 'process' });
    }
  }
  for (const edge of edges) if (edge.kind === 'reviews' && members.has(edge.from) && members.has(edge.to)) drawn.push(edge);

  // Dependents: the workers whose process lives inside a pane. Named so the
  // card can say "3 workers depend on this pane" (Pat, section 8 item 2).
  for (const member of members.values()) {
    member.dependents = [...members.values()].filter((other) => other.alive && other.processParent === member.id).map((other) => other.id);
    member.children = [...members.values()].filter((other) => other.parent === member.id).map((other) => other.id);
  }

  const warnings = [];
  const warn = (warning) => { warnings.push({ id: `${warning.kind}:${(warning.memberIds || []).join(',')}${warning.home ? `:${warning.home}` : ''}`, ...warning }); };
  const live = [...members.values()].filter((m) => m.alive);

  // Plan near limit with live agents on it.
  const byHome = new Map();
  for (const member of live) if (member.home) { if (!byHome.has(member.home)) byHome.set(member.home, []); byHome.get(member.home).push(member.id); }
  for (const [home, ids] of byHome) {
    const u = usage[home];
    if (!u || !Number.isFinite(u.weeklyPct) || u.weeklyPct < PLAN_NEAR_LIMIT_PCT) continue;
    if (u.updatedAtMs && now - u.updatedAtMs > USAGE_STALE_MS) continue;
    warn({ kind: 'plan-near-limit', home, pct: u.weeklyPct, resetsAt: u.weeklyResetsAt || null, memberIds: ids });
  }
  // A pane whose process tree holds live workers.
  for (const member of live) if (member.dependents.length) warn({ kind: 'process-parent', memberIds: [member.id], dependents: member.dependents });
  // Two writers: one session open in two panes, or two live members in one worktree.
  for (const [sessionId, panes] of sessionPanes) if (panes.length > 1) warn({ kind: 'two-writers-session', memberIds: [sessionId], panes });
  const byCwd = new Map();
  for (const member of live) {
    if (!member.cwd || member.runMode === 'pane' && !/[\\/]\.orch[\\/]/i.test(member.cwd)) continue;
    const key = slashes(member.cwd).toLowerCase().replace(/\/+$/, '');
    if (!byCwd.has(key)) byCwd.set(key, []);
    byCwd.get(key).push(member.id);
  }
  for (const [cwd, ids] of byCwd) if (ids.length > 1) warn({ kind: 'two-writers-folder', cwd: members.get(ids[0]).cwd || cwd, memberIds: ids });
  // Duplicate names among live sessions.
  const byName = new Map();
  for (const member of live) { const key = member.name.toLowerCase(); if (!byName.has(key)) byName.set(key, []); byName.get(key).push(member.id); }
  for (const [, ids] of byName) if (ids.length > 1 && members.get(ids[0]).name !== 'Untitled session') warn({ kind: 'duplicate-name', name: members.get(ids[0]).name, memberIds: ids });
  // Possibly stuck: an open tool older than ten minutes.
  for (const member of live) {
    const open = member.openTools.filter((tool) => tool.startedMs && now - tool.startedMs >= STUCK_TOOL_MS);
    if (open.length) warn({ kind: 'tool-stuck', memberIds: [member.id], tool: open[0].name, sinceMs: open[0].startedMs });
  }
  // A pane alive with nothing happening for 30 minutes and nothing open.
  for (const member of live) {
    if (member.runMode !== 'pane' || member.openTools.length || member.status.kind === 'working') continue;
    const last = member.lastEventMs || member.createdMs;
    const busy = member.helpers.some((helper) => !helper.finished) || member.dependents.length || member.children.some((id) => members.get(id)?.alive);
    if (last && now - last >= QUIET_PANE_MS && busy) warn({ kind: 'quiet-parent', memberIds: [member.id], sinceMs: last });
  }
  // Many test runs at once.
  for (const [paneKey, runs] of testRuns) {
    if (runs.length < MANY_TEST_RUNS) continue;
    const owner = paneKey === 'machine' ? null
      : paneKey.startsWith('pane:') ? [...members.values()].find((m) => m.paneId === paneKey.slice(5))?.id || null
        : [...members.values()].find((m) => String(m.pid) === paneKey.slice(4) || String(m.launcherPid) === paneKey.slice(4))?.id || null;
    warn({ kind: 'many-test-runs', memberIds: owner ? [owner] : [], count: runs.length, commands: runs.map((run) => run.label || run.cmdline || 'test') });
  }
  // Declared but absent, and live but undeclared when a team file exists.
  // Not before the pane list has arrived (Harbor just started): every pane
  // member would read as absent for a moment, which is not news. One warning
  // per file and name, however many root spellings read the file.
  if (inputs.panesKnown !== false) {
    const said = new Set();
    for (const absent of declaredAbsent) {
      const key = `${absent.file}|${absent.name}`;
      if (said.has(key)) continue;
      said.add(key);
      warn({ kind: 'declared-absent', memberIds: [], name: absent.name, file: absent.file });
    }
  }
  if ((inputs.declarations || []).length) {
    for (const declaration of inputs.declarations) {
      if (declaration.everyoneElse) continue;
      const root = slashes(declaration.root).toLowerCase();
      for (const member of live) {
        if (declaredBy.has(member.id) || !underRoot(member.projectCwd, root)) continue;
        if (member.parent && declaredBy.has(member.parent)) continue;
        warn({ kind: 'undeclared', memberIds: [member.id], file: declaration.file });
      }
    }
  }
  for (const warning of warnings) for (const id of warning.memberIds || []) {
    const member = members.get(id);
    if (member) (member.warnings ||= []).push(warning.id);
  }

  // Group: project -> trees (roots and their descendants) -> idle chips.
  const projects = new Map();
  const rootOf = (member) => { let cursor = member; const seen = new Set(); while (cursor.parent && members.has(cursor.parent) && !seen.has(cursor.parent)) { seen.add(cursor.id); cursor = members.get(cursor.parent); } return cursor; };
  for (const member of live) {
    const root = rootOf(member);
    const project = root.project || 'No project';
    if (!projects.has(project)) projects.set(project, { project, roots: new Set(), idle: [], members: [] });
    projects.get(project).members.push(member.id);
    member.teamProject = project;
  }
  for (const member of live) {
    if (member.parent) continue;
    const group = projects.get(member.teamProject);
    const idleLong = ['idle', 'quiet'].includes(member.status.kind) && member.status.sinceMs && now - member.status.sinceMs >= IDLE_ROW_MS;
    const hasLiveChildren = member.children.some((id) => members.get(id)?.alive);
    if (idleLong && !hasLiveChildren && !(member.warnings || []).length) group.idle.push(member.id);
    else group.roots.add(member.id);
  }
  const statusCounts = (ids) => {
    const counts = { working: 0, tool: 0, idle: 0, quiet: 0, starting: 0, total: ids.length };
    for (const id of ids) { const kind = members.get(id)?.status.kind; if (Object.hasOwn(counts, kind)) counts[kind] += 1; }
    return counts;
  };
  const order = (ids) => ids.sort((a, b) => (members.get(b).lastEventMs || members.get(b).createdMs || 0) - (members.get(a).lastEventMs || members.get(a).createdMs || 0));
  const projectList = [...projects.values()].map((group) => ({
    project: group.project,
    counts: statusCounts(group.members),
    roots: order([...group.roots]),
    idle: order(group.idle),
    memberIds: group.members,
    warningIds: warnings.filter((w) => w.memberIds?.some((id) => group.members.includes(id))).map((w) => w.id),
  })).sort((a, b) => (b.counts.working + b.counts.tool) - (a.counts.working + a.counts.tool) || b.counts.total - a.counts.total || a.project.localeCompare(b.project));

  const runs = (inputs.runs || []).map((run) => ({
    queueId: run.summary?.queueId || null,
    workspace: run.summary?.workspace || null,
    project: run.summary?.workspace ? projectLabel(canonicalProjectCwd(run.summary.workspace)) : null,
    goal: run.queue?.goal || null,
    done: run.summary?.done ?? null,
    total: run.summary?.total ?? null,
    summary: run.summary || null,
    batches: (run.queue?.batches || []).map((batch) => {
      const liveRow = (run.liveBatches || []).find((row) => row.batchId === batch.id) || {};
      return { id: batch.id, title: batch.title || batch.id, status: batch.status, workerState: liveRow.workerState || null, sessionId: liveRow.sessionId || batch.last_session_id || null, waitingOn: liveRow.waitingOn || [] };
    }),
  }));
  for (const run of runs) for (const batch of run.batches) {
    const member = batch.sessionId && members.get(batch.sessionId);
    if (member) member.batch = { title: batch.title, run: run.goal || run.project };
  }

  const ended = (inputs.ended || []).filter((entry) => entry.endedMs && now - entry.endedMs <= ENDED_WINDOW_MS && !members.get(entry.id)?.alive)
    .sort((a, b) => b.endedMs - a.endedMs);

  return {
    builtMs: now,
    projects: projectList,
    members: Object.fromEntries([...members.values()].filter((m) => m.alive).map((m) => [m.id, m])),
    edges: drawn.filter((edge) => members.get(edge.from)?.alive && members.get(edge.to)?.alive),
    warnings,
    runs,
    ended,
  };
}

module.exports = {
  IDLE_ROW_MS, ENDED_WINDOW_MS, STUCK_TOOL_MS, QUIET_PANE_MS, PLAN_NEAR_LIMIT_PCT, MANY_TEST_RUNS, USAGE_STALE_MS,
  canonicalProjectCwd, cleanTitle, modelLabel, argvValue, memberStatus, deriveTeam,
};
