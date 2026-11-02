'use strict';

// The team chart's provider (2026-11-02; SCOPE.md in
// docs/orchestration/2026-11-02-org-chart-panel-scope). It gathers the inputs
// for shared/team-model.cjs `deriveTeam` ON EVENTS and pushes the result:
//   - sidebar bridge `update` / `panes-changed` / `history-refreshed`
//     (panes, history rows, delegation groups),
//   - the launch records file the worker launchers append to,
//   - the transcript tailer worker (team-worker.js), which watches only the
//     transcripts of live members,
//   - the statusline usage files (usage-<home>.json) in the cache dir,
//   - describer updates.
// There is no polling clock in here. Everything that changes on its own is
// read when an event says it changed.

const { EventEmitter } = require('node:events');
const { Worker } = require('node:worker_threads');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { deriveTeam, canonicalProjectCwd, ENDED_WINDOW_MS } = require('../../shared/team-model.cjs');
const { buildDescribeContext, isTitlerChildPrompt } = require('./titles.js');

const RECOMPUTE_MS = 250;
const DISCOVER_MS = 1000;
const LAUNCH_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const LAUNCH_ROTATE_BYTES = 2 * 1024 * 1024;
const PIN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PINS = 5;
const RUNS_MIN_MS = 15_000;
const CODEX_USAGE_MIN_MS = 5 * 60 * 1000;
const LAUNCHERS = [
  { needle: 'claude-worker.mjs', launcher: 'claude-worker' },
  { needle: 'astra-run.mjs', launcher: 'astra-run' },
  { needle: 'cursor-worker.mjs', launcher: 'cursor-worker' },
  { needle: 'cursor-run.mjs', launcher: 'cursor-run' },
];
// A test run is a test RUNNER process, never a command line that merely
// mentions one (a worker's brief, a shell wrapper, `timeout ... npx vitest`).
// Each entry: the needle the daemon searches, the process names that can be
// the runner, and the command-line shape that makes it one.
const TEST_RUNNERS = [
  { needle: '--test', names: /^node(\.exe)?$/i, shape: /\s--test(\s|$)/, label: 'node --test' },
  { needle: 'pytest', names: /^(python\d*|pythonw|py|pytest)(\.exe)?$/i, shape: /(^|[\s\\/])pytest(\.exe)?("|\s|$)|\s-m\s+pytest\b/i, label: 'pytest' },
  { needle: 'vitest', names: /^node(\.exe)?$/i, shape: /[\\/](vitest[\\/]|\.bin[\\/]vitest)|vitest\.mjs/i, label: 'vitest' },
  { needle: 'jest', names: /^node(\.exe)?$/i, shape: /[\\/](jest[\\/]|\.bin[\\/]jest)|jest\.js/i, label: 'jest' },
];

function realHome() {
  try { return os.userInfo().homedir; } catch { return os.homedir(); }
}

function defaultLaunchesFile(env = process.env) {
  if (env.HARBOR_TEAM_LAUNCHES_FILE && path.isAbsolute(env.HARBOR_TEAM_LAUNCHES_FILE)) return env.HARBOR_TEAM_LAUNCHES_FILE;
  return path.join(realHome(), '.harbor', 'team-launches.jsonl');
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

// Claude's per-character project-folder munge: every character that is not a
// letter or digit becomes '-'. Used only to find a brand-new worker's transcript
// before the history index has listed it.
function mungeCwd(cwd) { return String(cwd || '').replace(/[^A-Za-z0-9]/g, '-'); }

// Shell words for a process command line (Windows quoting, enough for argv flags).
function commandWords(cmdline) {
  const words = [];
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let match;
  while ((match = re.exec(String(cmdline || '')))) words.push(match[1] != null ? match[1].replace(/\\"/g, '"') : match[2]);
  return words;
}

function wordValue(words, ...names) {
  for (let i = 0; i < words.length; i += 1) {
    for (const name of names) {
      if (words[i] === name) return words[i + 1] ?? null;
      if (words[i].startsWith(`${name}=`)) return words[i].slice(name.length + 1);
    }
  }
  return null;
}

// The launch records: one JSON object per line, start / bind / end, keyed by
// the launch id the launcher minted. Read from a saved offset; the file is
// rotated (renamed to .1) at startup once it passes 2 MB.
function createLaunchReader(file, { now = () => Date.now() } = {}) {
  const launches = new Map();
  let offset = 0;
  let carry = '';
  const applyRecord = (record) => {
    if (!record || record.v !== 1 || !record.launch) return;
    const at = Date.parse(record.at) || null;
    let entry = launches.get(record.launch);
    if (record.type === 'start') {
      entry = { ...(entry || {}), launch: record.launch, launcher: record.launcher || null, pid: record.pid || null, childPid: record.childPid || null,
        parent: record.parent || null, parents: record.parents || null, child: { ...(record.child || {}), ...(entry?.child?.session ? { session: entry.child.session } : {}) }, startedMs: at };
      launches.set(record.launch, entry);
    } else if (record.type === 'bind' && record.child?.session) {
      entry = entry || { launch: record.launch, child: {} };
      entry.child = { ...(entry.child || {}), session: record.child.session };
      launches.set(record.launch, entry);
    } else if (record.type === 'end') {
      entry = entry || { launch: record.launch, child: {} };
      Object.assign(entry, { endedMs: at || now(), exit: record.exit ?? null, signal: record.signal ?? null });
      launches.set(record.launch, entry);
    }
  };
  const readFrom = async (target, from) => {
    let handle;
    try { handle = await fsp.open(target, 'r'); } catch { return { size: 0, text: '' }; }
    try {
      const stat = await handle.stat();
      if (stat.size <= from) return { size: stat.size, text: '' };
      const buffer = Buffer.alloc(stat.size - from);
      await handle.read(buffer, 0, buffer.length, from);
      return { size: stat.size, text: buffer.toString('utf8') };
    } finally { await handle.close(); }
  };
  const consume = (text) => {
    const lines = (carry + text).split('\n');
    carry = lines.pop();
    for (const line of lines) { if (!line.trim()) continue; try { applyRecord(JSON.parse(line)); } catch { /* torn line */ } }
  };
  return {
    file,
    async load() {
      try {
        const stat = await fsp.stat(file);
        if (stat.size > LAUNCH_ROTATE_BYTES) await fsp.rename(file, `${file}.1`).catch(() => {});
      } catch { /* no file yet */ }
      const old = await readFrom(`${file}.1`, 0);
      carry = ''; consume(`${old.text}\n`);
      carry = ''; offset = 0;
      await this.read();
    },
    async read() {
      let stat;
      try { stat = await fsp.stat(file); } catch { return false; }
      if (stat.size < offset) { offset = 0; carry = ''; }
      const { size, text } = await readFrom(file, offset);
      offset = size;
      if (!text) return false;
      consume(text);
      return true;
    },
    list() {
      const cutoff = now() - LAUNCH_KEEP_MS;
      const out = [];
      for (const entry of launches.values()) {
        if (!entry.startedMs || entry.startedMs < cutoff) continue;
        const alive = !entry.endedMs && (pidAlive(entry.pid) || pidAlive(entry.childPid));
        out.push({ ...entry, alive });
      }
      return out;
    },
  };
}

// One TEAM.json, resolved. A member may name its session through a file the
// team already keeps current instead of a fixed id: `session_file` is read
// (relative to the project root) and its first session id is used, so a lead
// that hands over to a new session moves on the chart when that file changes.
// `everyone_else_reports_to` and `top` pass through to the model.
async function readDeclaration(parsed, { file, root, readFile, onSessionFile = () => {} }) {
  const members = [];
  for (const entry of parsed.members) {
    if (!entry || typeof entry !== 'object') continue;
    const copy = { ...entry };
    if (typeof entry.session_file === 'string' && entry.session_file && !entry.session) {
      const target = path.resolve(root, entry.session_file);
      onSessionFile(target);
      try {
        const match = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(await readFile(target));
        if (match) copy.session = match[0].toLowerCase();
      } catch { /* the file is missing: the member reads as declared but absent */ }
    }
    members.push(copy);
  }
  return {
    file, root, title: parsed.title || null, members,
    everyoneElse: typeof parsed.everyone_else_reports_to === 'string' ? parsed.everyone_else_reports_to : null,
    notes: Array.isArray(parsed.notes) ? parsed.notes : [],
  };
}

function createTeamProvider(options = {}) {
  const emitter = new EventEmitter();
  const bridge = options.bridge;
  const now = options.now || (() => Date.now());
  const env = options.env || process.env;
  const cacheDir = options.cacheDir || path.join(os.homedir(), '.cache', 'harbor');
  const projectsRoot = options.projectsRoot || path.join(os.homedir(), '.claude', 'projects');
  const profiles = options.profiles || [];
  const launches = createLaunchReader(options.launchesFile || defaultLaunchesFile(env), { now });
  const endedFile = options.endedFile || path.join(cacheDir, 'team-ended.json');
  const pinsDir = options.pinsDir || path.join(cacheDir, 'team-pins');
  const describer = options.describer || null;
  const projectLabel = options.projectLabelForCwd || ((cwd) => path.basename(String(cwd || '')) || null);
  const watchImpl = options.watchImpl || fs.watch;
  const platform = options.platform || process.platform;

  let started = false;
  let closed = false;
  let worker = null;
  let facts = {};
  let processes = [];
  let usage = {};
  let runs = [];
  let runsAt = 0;
  let codexUsageAt = 0;
  let declarations = [];
  // Files a TEAM.json names with session_file (cdt-app's FABLE-SESSION.txt):
  // a change to one re-reads the declarations, so a handover moves the line.
  let sessionFiles = new Set();
  const declarationWatchers = new Map();
  let ended = [];
  let previousLive = new Map();
  let team = null;
  let teamKey = '';
  let recomputeTimer = null;
  let discoverTimer = null;
  const watchers = [];
  const describedOnce = new Set();
  const subscribers = new Set();

  try {
    const parsed = JSON.parse(fs.readFileSync(endedFile, 'utf8'));
    if (Array.isArray(parsed?.ended)) ended = parsed.ended.filter((entry) => entry?.endedMs && now() - entry.endedMs <= ENDED_WINDOW_MS);
  } catch { /* none yet */ }

  const saveEnded = () => {
    try {
      fs.mkdirSync(path.dirname(endedFile), { recursive: true });
      const temporary = `${endedFile}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ v: 1, ended }));
      fs.renameSync(temporary, endedFile);
    } catch { /* the strip is a convenience; a lost write loses one line */ }
  };

  const scheduleRecompute = () => {
    if (closed || recomputeTimer) return;
    recomputeTimer = setTimeout(() => { recomputeTimer = null; recompute(); }, RECOMPUTE_MS);
    recomputeTimer.unref?.();
  };

  const scheduleDiscover = () => {
    if (closed || discoverTimer) return;
    discoverTimer = setTimeout(() => { discoverTimer = null; discover().catch(() => {}); }, DISCOVER_MS);
    discoverTimer.unref?.();
  };

  const homeByDir = (dir) => {
    if (!dir) return null;
    const key = String(dir).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    return profiles.find((p) => String(p.configHome || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === key)?.id || null;
  };

  // Worker processes from the process table, through the daemon's resident
  // snapshot (proc-find / proc-tree / proc-info answer in milliseconds). Run
  // on events only: start, a pane created or closed, a launch record, a
  // headless member finishing a turn.
  async function discover() {
    const request = bridge?.daemonRequest;
    if (!request || platform !== 'win32') { processes = []; return; }
    const panes = bridge.getLivePanes?.() || [];
    const panePids = new Map(panes.filter((p) => p.pid).map((p) => [p.pid, p.pane_id]));
    const found = [];
    // The nearest ancestor that is one of `stops` (pid -> answer), walking
    // ppid through the daemon's snapshot. A dead link ends the walk.
    const ancestorIn = async (pid, stops) => {
      let cursor = pid;
      for (let depth = 0; depth < 14 && cursor; depth += 1) {
        if (stops.has(cursor)) return stops.get(cursor);
        const info = await request('proc-info', { pid: cursor }).catch(() => null);
        if (!info?.alive || !info.ppid || info.ppid === cursor) return null;
        cursor = info.ppid;
      }
      return null;
    };
    const ancestorPane = (pid) => ancestorIn(pid, panePids);
    for (const { needle, launcher } of LAUNCHERS) {
      const result = await request('proc-find', { needle }).catch(() => null);
      for (const proc of result?.processes || []) {
        if (!/node(\.exe)?$/i.test(proc.name || '') && !/node(\.exe)?"?\s/i.test(proc.cmdline || '')) continue;
        const words = commandWords(proc.cmdline);
        const tree = await request('proc-tree', { pid: proc.pid }).catch(() => null);
        const childProc = (tree?.processes || []).find((row) => row.pid !== proc.pid && /(claude|codex|cursor-agent)(\.exe|\.js|\.cmd)?/i.test(row.cmdline || row.name || '')
          && !/claude-worker|astra-run|cursor-worker|cursor-run/i.test(row.cmdline || ''));
        const childWords = commandWords(childProc?.cmdline || '');
        const provider = launcher === 'astra-run' ? 'codex' : launcher.startsWith('cursor') ? 'cursor' : 'claude';
        const resume = wordValue(childWords, '--resume', '-r') || (childWords.includes('resume') ? childWords[childWords.indexOf('resume') + 1] : null);
        const sessionId = provider === 'claude' ? (wordValue(childWords, '--session-id') || resume || wordValue(words, '--session-id', '--resume')) : (resume && /^[0-9a-f-]{36}$/i.test(resume) ? resume : null);
        const prompt = wordValue(words, '--prompt');
        found.push({
          pid: childProc?.pid || proc.pid,
          launcherPid: proc.pid,
          launcher,
          provider,
          sessionId: sessionId || null,
          model: wordValue(childWords, '--model', '-m') || wordValue(words, '--model', '-m'),
          effort: wordValue(childWords, '--effort') || wordValue(words, '--effort'),
          // claude-worker and astra-run take the plan as --home <profile id>.
          home: wordValue(words, '--home') || null,
          cwd: wordValue(words, '--cd', '-C') || null,
          title: prompt || null,
          startedMs: Number(proc.created) ? Number(proc.created) / 10000 - 11644473600000 : null,
          paneId: await ancestorPane(proc.ppid),
        });
      }
    }
    const tests = [];
    for (const { needle, names, shape, label } of TEST_RUNNERS) {
      const result = await request('proc-find', { needle }).catch(() => null);
      for (const proc of result?.processes || []) {
        if (!names.test(proc.name || '') || !shape.test(proc.cmdline || '')) continue;
        if (tests.some((row) => row.pid === proc.pid)) continue;
        tests.push({ kind: 'test', pid: proc.pid, ppid: proc.ppid, label, cmdline: String(proc.cmdline || '').slice(0, 200) });
      }
    }
    // One run, one count: a runner's own forks and shims are not more runs.
    const testPids = new Set(tests.map((row) => row.pid));
    const owners = new Map([...panePids].map(([pid, paneId]) => [pid, { paneId }]));
    for (const row of found) {
      if (row.pid) owners.set(row.pid, { pid: row.pid });
      if (row.launcherPid) owners.set(row.launcherPid, { pid: row.pid || row.launcherPid });
    }
    for (const row of tests) {
      if (testPids.has(row.ppid)) continue;
      const owner = await ancestorIn(row.ppid, owners);
      found.push({ ...row, paneId: owner?.paneId || null, ownerPid: owner?.pid || null });
    }
    const key = JSON.stringify(found);
    if (key !== JSON.stringify(processes)) { processes = found; scheduleRecompute(); }
  }

  async function refreshUsage(homeIds) {
    if (!options.usageProvider) return;
    let changed = false;
    for (const id of homeIds) {
      const profile = profiles.find((p) => p.id === id);
      if (!profile || (profile.provider && profile.provider !== 'claude')) continue;
      const result = await options.usageProvider.getUsage(id).catch(() => null);
      if (!result || result.unavailable) continue;
      const next = { weeklyPct: result.weeklyPct, weeklyResetsAt: result.weeklyResetsAt, fiveHourPct: result.fiveHourPct, fiveHourResetsAt: result.fiveHourResetsAt, updatedAtMs: Date.parse(result.updatedAt) || null };
      if (JSON.stringify(next) !== JSON.stringify(usage[id])) { usage[id] = next; changed = true; }
    }
    if (changed) scheduleRecompute();
  }

  async function refreshCodexUsage(force = false) {
    if (!options.planUsageProvider?.getCodexPlans || (!force && now() - codexUsageAt < CODEX_USAGE_MIN_MS)) return;
    codexUsageAt = now();
    const plans = await options.planUsageProvider.getCodexPlans().catch(() => []);
    let changed = false;
    for (const plan of plans || []) {
      const id = homeByDir(plan.home);
      if (!id) continue;
      const weekly = (plan.windows || []).find((w) => w.kind === 'weekly');
      const five = (plan.windows || []).find((w) => w.kind === 'fiveHour');
      const next = { weeklyPct: weekly?.usedPct ?? null, weeklyResetsAt: weekly?.resetsAt ?? null, fiveHourPct: five?.usedPct ?? null, fiveHourResetsAt: five?.resetsAt ?? null, updatedAtMs: Date.parse(plan.updatedAt) || null };
      if (JSON.stringify(next) !== JSON.stringify(usage[id])) { usage[id] = next; changed = true; }
    }
    if (changed) scheduleRecompute();
  }

  async function refreshRuns(force = false) {
    if (!options.listRuns || (!force && now() - runsAt < RUNS_MIN_MS)) return;
    runsAt = now();
    const next = await options.listRuns().catch(() => null);
    if (next && JSON.stringify(next) !== JSON.stringify(runs)) { runs = next; scheduleRecompute(); }
  }

  // TEAM.json files under <project root>/docs/orchestration/*/, for the roots
  // of live members only. Optional: no file is a normal state, never a nag.
  async function refreshDeclarations(roots) {
    const next = [];
    const referenced = new Set();
    for (const root of roots) {
      const base = path.join(root, 'docs', 'orchestration');
      let names = [];
      try { names = await fsp.readdir(base); } catch { continue; }
      if (!declarationWatchers.has(base)) {
        try {
          const watcher = watchImpl(base, { recursive: true }, (_event, name) => {
            const changed = String(name || '').replace(/\\/g, '/').toLowerCase();
            if (!name || /team\.json$/.test(changed) || [...sessionFiles].some((file) => file.endsWith(changed))) { declarationsKey = ''; scheduleRecompute(); }
          });
          watcher.on?.('error', () => {});
          declarationWatchers.set(base, watcher);
        } catch { declarationWatchers.set(base, null); }
      }
      for (const name of names) {
        const file = path.join(base, name, 'TEAM.json');
        try {
          const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
          if (parsed && Array.isArray(parsed.members)) next.push(await readDeclaration(parsed, { file, root, readFile: (target) => fsp.readFile(target, 'utf8'), onSessionFile: (target) => referenced.add(target.replace(/\\/g, '/').toLowerCase()) }));
        } catch { /* absent or unreadable */ }
      }
    }
    sessionFiles = referenced;
    if (JSON.stringify(next) !== JSON.stringify(declarations)) { declarations = next; scheduleRecompute(); }
  }
  let declarationsKey = '';

  const ensureWorker = () => {
    if (worker || closed || options.WorkerClass === null) return;
    const WorkerClass = options.WorkerClass || Worker;
    worker = new WorkerClass(path.join(__dirname, 'team-worker.js'));
    worker.unref?.();
    worker.on('message', (message) => {
      if (message?.type !== 'facts') return;
      for (const [id, snapshot] of Object.entries(message.changed || {})) facts[id] = snapshot;
      for (const id of message.removed || []) delete facts[id];
      for (const event of message.events || []) onMemberEvent(event);
      scheduleRecompute();
    });
    worker.on('error', () => { worker = null; });
  };

  const memberContext = (member) => {
    const row = bridge?.getHistoryRow?.(member.sessionId) || {};
    const fact = facts[member.sessionId] || {};
    return buildDescribeContext({
      brief: row.firstPrompt || member.launchTitle || member.lastPrompt,
      requests: [fact.lastPrompt].filter((item) => item && item !== row.firstPrompt),
      actions: fact.actions || [],
      reply: fact.lastText,
    });
  };

  function onMemberEvent(event) {
    const member = team?.members?.[event.id];
    if (!member) return;
    if (describer && member.sessionId) describer.request(member.sessionId, memberContext(member));
    if (member.runMode === 'worker' && event.kind === 'turn-ended') scheduleDiscover();
    if (member.home) refreshUsage([member.home]);
    if (member.provider === 'codex') refreshCodexUsage();
  }

  function collectInputs() {
    const panes = (bridge?.getLivePanes?.() || []).map((pane) => {
      const id = typeof pane.agent_session === 'string' ? pane.agent_session : pane.agent_session?.value;
      return { paneId: pane.pane_id, sessionId: id || null, provider: pane.agent || 'claude', pid: pane.pid || null, cwd: pane.cwd || null,
        createdMs: Date.parse(pane.created_at) || null, argv: pane.argv || [], exited: Boolean(pane.exited), agentStatus: pane.agent_status || null };
    });
    const sessions = {};
    const sessionHomes = {};
    const want = new Set([...panes.map((p) => p.sessionId), ...launches.list().map((l) => l.child?.session), ...processes.map((p) => p.sessionId)].filter(Boolean));
    for (const group of bridge?.listDelegations?.() || []) { want.add(group.parentId); for (const agent of group.agents || []) if (agent.sessionId) want.add(agent.sessionId); }
    for (const id of want) {
      const row = bridge?.getHistoryRow?.(id);
      if (!row) continue;
      if (isTitlerChildPrompt(row.firstPrompt)) continue;
      sessions[id] = { title: row.title || null, project: row.project || null, cwd: row.cwd || null, provider: row.provider || 'claude', home: row.home || row.profileId || null,
        firstPrompt: row.firstPrompt || null, nickname: row.lineage?.nickname || null, parentThreadId: row.lineage?.parentThreadId || null,
        delegatedBy: row.delegatedBy || null, path: row.path || null };
      const launchedHome = bridge?.getLaunchedHome?.(id);
      if (row.home || row.profileId || launchedHome) sessionHomes[id] = row.home || row.profileId || launchedHome;
    }
    return { panes, sessions, sessionHomes };
  }

  function recompute() {
    if (closed) return;
    const { panes, sessions, sessionHomes } = collectInputs();
    const descriptions = {};
    if (describer) for (const [id, entry] of Object.entries(describer.all())) descriptions[id] = { text: entry.text, atMs: entry.at };
    const helpers = {};
    for (const [id, fact] of Object.entries(facts)) if (fact.helpers?.length) helpers[id] = fact.helpers;
    const next = deriveTeam({
      // Until the daemon has delivered its panes (the first moments after
      // Harbor starts), a TEAM.json member that is a pane cannot match yet.
      panesKnown: panes.length > 0,
      panes,
      launches: launches.list(),
      processes,
      sessions,
      facts,
      helpers,
      descriptions,
      homes: profiles,
      sessionHomes,
      usage,
      delegations: bridge?.listDelegations?.() || [],
      runs,
      declarations,
      ended,
      projectLabel,
    }, now());

    // Members that left the chart go to the ended strip, keeping their last
    // description; the strip forgets them after six hours.
    const live = new Map(Object.entries(next.members));
    let endedChanged = false;
    for (const [id, member] of previousLive) {
      if (live.has(id)) continue;
      const launch = launches.list().find((entry) => (entry.child?.session || `launch:${entry.launch}`) === id);
      const outcome = launch?.endedMs ? (launch.exit === 0 ? 'finished' : launch.exit != null ? `exited with code ${launch.exit}` : 'stopped')
        : member.runMode === 'pane' ? 'pane closed' : 'ended';
      ended = ended.filter((entry) => entry.id !== id);
      ended.unshift({ id, sessionId: member.sessionId, name: member.name, provider: member.provider, modelLabel: member.modelLabel, home: member.home,
        project: member.teamProject || member.project, runMode: member.runMode, description: member.description, outcome, endedMs: launch?.endedMs || now() });
      endedChanged = true;
    }
    if (endedChanged) {
      ended = ended.filter((entry) => now() - entry.endedMs <= ENDED_WINDOW_MS).slice(0, 200);
      saveEnded();
      next.ended = ended;
    }
    previousLive = live;

    // Track the live members' transcripts in the worker.
    const files = [];
    for (const member of live.values()) {
      if (!member.sessionId) continue;
      let file = sessions[member.sessionId]?.path || member.transcriptPath;
      if (!file && member.provider === 'claude' && member.cwd) file = path.join(projectsRoot, mungeCwd(member.cwd), `${member.sessionId}.jsonl`);
      if (file) files.push({ id: member.sessionId, path: file, provider: member.provider });
    }
    ensureWorker();
    const trackKey = JSON.stringify(files);
    if (worker && trackKey !== lastTrackKey) { lastTrackKey = trackKey; worker.postMessage({ type: 'track', files }); }

    // First sight of a live member with no description: write one once its
    // transcript facts are in (or straight away when it has none to read).
    if (describer) {
      for (const member of live.values()) {
        if (!member.sessionId || member.description || describedOnce.has(member.sessionId)) continue;
        if (!facts[member.sessionId] && files.some((file) => file.id === member.sessionId)) continue;
        describedOnce.add(member.sessionId);
        describer.request(member.sessionId, memberContext(member), { force: true });
      }
    }

    const homes = [...new Set([...live.values()].map((member) => member.home).filter(Boolean))].filter((id) => !Object.hasOwn(usage, id));
    if (homes.length) refreshUsage(homes);
    // One root per FOLDER: a lane's worktree maps to C:/dev/x while a pane says
    // C:\dev\x, and two spellings read the same TEAM.json twice (two
    // "declared but absent" warnings for one member, 2026-11-02).
    const rootByKey = new Map();
    for (const member of live.values()) if (member.projectCwd) rootByKey.set(member.projectCwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(), member.projectCwd);
    const roots = [...rootByKey.values()].sort();
    const rootsKey = JSON.stringify(roots);
    if (rootsKey !== declarationsKey) { declarationsKey = rootsKey; refreshDeclarations(roots).catch(() => {}); }

    const key = JSON.stringify({ ...next, builtMs: 0 });
    if (key === teamKey) return;
    teamKey = key;
    team = next;
    emitter.emit('update', team);
    for (const listener of subscribers) { try { listener(team); } catch { /* a bad listener never stops the rest */ } }
  }
  let lastTrackKey = '';

  function onBridgeUpdate() { scheduleRecompute(); }
  function onPanesChanged() { worker?.postMessage({ type: 'rescan' }); scheduleDiscover(); scheduleRecompute(); }
  function onHistoryRefreshed() { refreshRuns().catch(() => {}); scheduleRecompute(); }

  function watchLaunches() {
    const dir = path.dirname(launches.file);
    const name = path.basename(launches.file);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const watcher = watchImpl(dir, (_event, changed) => {
        if (changed && String(changed) !== name) return;
        launches.read().then((moved) => { if (moved) { scheduleDiscover(); scheduleRecompute(); } }).catch(() => {});
      });
      watcher.on?.('error', () => {});
      watchers.push(watcher);
    } catch { /* no launch records then; the process table still finds workers */ }
  }

  function watchUsage() {
    try {
      const watcher = watchImpl(cacheDir, (_event, changed) => {
        const match = /^usage-(.+)\.json$/.exec(String(changed || ''));
        if (!match) return;
        if (team && Object.values(team.members).some((member) => member.home === match[1])) refreshUsage([match[1]]);
      });
      watcher.on?.('error', () => {});
      watchers.push(watcher);
    } catch { /* usage refreshes on member turns instead */ }
  }

  async function start() {
    if (started) return;
    started = true;
    await launches.load().catch(() => {});
    watchLaunches();
    watchUsage();
    pruneExpiredPins();
    if (bridge?.emitter) {
      bridge.emitter.on('update', onBridgeUpdate);
      bridge.emitter.on('panes-changed', onPanesChanged);
      bridge.emitter.on('history-refreshed', onHistoryRefreshed);
    }
    refreshRuns(true).catch(() => {});
    discover().catch(() => {});
    recompute();
  }

  // A renderer opening the chart: refresh the slower inputs once, then push.
  function subscribe(listener) {
    subscribers.add(listener);
    refreshRuns(true).catch(() => {});
    refreshCodexUsage(true).catch(() => {});
    if (team) refreshUsage([...new Set(Object.values(team.members).map((member) => member.home).filter(Boolean))]);
    scheduleDiscover();
    if (team) listener(team);
    return () => subscribers.delete(listener);
  }

  // PINS: one moment kept for seven days, at most five, in the cache dir (not
  // the repo). Expired pins are deleted at startup; pinning a sixth removes
  // the oldest.
  function readPins() {
    let names = [];
    try { names = fs.readdirSync(pinsDir).filter((name) => /^pin-\d+\.json$/.test(name)); } catch { return []; }
    const pins = [];
    for (const name of names) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(pinsDir, name), 'utf8'));
        pins.push({ id: name.slice(4, -5), file: path.join(pinsDir, name), pinnedMs: parsed.pinnedMs, expiresMs: parsed.expiresMs, label: parsed.label || null, team: parsed.team });
      } catch { /* unreadable pin is skipped */ }
    }
    return pins.sort((a, b) => b.pinnedMs - a.pinnedMs);
  }
  function pruneExpiredPins() {
    for (const pin of readPins()) if (!pin.expiresMs || pin.expiresMs <= now()) { try { fs.rmSync(pin.file, { force: true }); } catch { /* best effort */ } }
  }
  function pin(label) {
    if (!team) return { ok: false, reason: 'The chart has not loaded yet.' };
    fs.mkdirSync(pinsDir, { recursive: true });
    const pinnedMs = now();
    const record = { v: 1, pinnedMs, expiresMs: pinnedMs + PIN_TTL_MS, label: label || null, team };
    fs.writeFileSync(path.join(pinsDir, `pin-${pinnedMs}.json`), JSON.stringify(record));
    const pins = readPins();
    for (const old of pins.slice(MAX_PINS)) { try { fs.rmSync(old.file, { force: true }); } catch { /* best effort */ } }
    return { ok: true, id: String(pinnedMs), expiresMs: record.expiresMs, removed: Math.max(0, pins.length - MAX_PINS) };
  }
  function listPins() {
    pruneExpiredPins();
    return readPins().map(({ id, pinnedMs, expiresMs, label, team: snapshot }) => ({ id, pinnedMs, expiresMs, label,
      agents: Object.keys(snapshot?.members || {}).length, projects: (snapshot?.projects || []).map((p) => p.project) }));
  }
  function getPin(id) { return readPins().find((p) => p.id === String(id)) || null; }
  function unpin(id) {
    const found = getPin(id);
    if (!found) return { ok: false, reason: 'That pin no longer exists.' };
    fs.rmSync(found.file, { force: true });
    return { ok: true };
  }

  function close() {
    closed = true;
    clearTimeout(recomputeTimer);
    clearTimeout(discoverTimer);
    for (const watcher of watchers) { try { watcher.close(); } catch { /* gone */ } }
    for (const watcher of declarationWatchers.values()) { try { watcher?.close(); } catch { /* gone */ } }
    if (bridge?.emitter) {
      bridge.emitter.off('update', onBridgeUpdate);
      bridge.emitter.off('panes-changed', onPanesChanged);
      bridge.emitter.off('history-refreshed', onHistoryRefreshed);
    }
    try { worker?.postMessage({ type: 'close' }); worker?.terminate(); } catch { /* gone */ }
    worker = null;
    subscribers.clear();
  }

  return {
    emitter,
    start,
    subscribe,
    get: () => team,
    recompute,
    scheduleRecompute,
    discover,
    pin,
    listPins,
    getPin: (id) => { const found = getPin(id); return found ? { id: found.id, pinnedMs: found.pinnedMs, expiresMs: found.expiresMs, label: found.label, team: found.team } : null; },
    unpin,
    close,
    _state: () => ({ facts, processes, usage, runs, declarations, ended }),
  };
}

module.exports = { createTeamProvider, readDeclaration, createLaunchReader, defaultLaunchesFile, commandWords, wordValue, mungeCwd, canonicalProjectCwd, MAX_PINS, PIN_TTL_MS };
