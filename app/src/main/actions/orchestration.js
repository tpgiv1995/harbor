'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { legacyConfig } = require('../config/migrate.js');
const { createControlClient } = require('../session-daemon/factory.js');
const { shellWords, canonicalCwd } = require('../providers/delegations.js');

function sanitizeGoal(goal) {
  // Control characters (\r, \n, C0) could break out of the pane's prompt
  // context; the single-quote escaping below handles everything printable.
  return String(goal).replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// The command is run INSIDE a pane that already exists, so Harbor's own
// launcher has to be told to stay there. `bin/ai` without `--here` starts a new
// session in the daemon, which inside an already-created pane
// would open a second one and leave this pane empty. A launcher the user
// supplied instead of ours has never heard of `--here`, so it gets exactly what
// it got before: the config home and the prompt.
const SHIPPED_LAUNCHER = path.resolve(__dirname, '../../../../bin/ai');
const WINDOWS_LAUNCHER_EXTENSIONS = ['.cmd', '.exe', '.bat'];

function launcherFlags(launcher) {
  const value = String(launcher || '').replace(/\\/g, '/');
  if (!value) return [];
  // IDENTITY, not a name. This asks whether the launcher IS the file this
  // repository ships, because `--here` is our flag and a launcher the user
  // supplied has never heard of it. An earlier version accepted any `ai` inside
  // a directory called `bin`, which matches `~/.local/bin/ai` and
  // `/usr/local/bin/ai`: precisely where somebody's own unrelated `ai`
  // dispatcher lives, and this field invites customising. The only tolerance is
  // a Windows wrapper extension on the same path, and a case-insensitive
  // compare, because that filesystem is.
  const shipped = SHIPPED_LAUNCHER.replace(/\\/g, '/');
  const same = (candidate) => candidate.toLowerCase() === shipped.toLowerCase();
  if (same(value)) return ['--here'];
  for (const extension of WINDOWS_LAUNCHER_EXTENSIONS) {
    if (same(value.slice(0, -extension.length)) && value.toLowerCase().endsWith(extension)) return ['--here'];
  }
  return [];
}

// The pane runs this as a SHELL STRING (`$SHELL -lc`, session-daemon/client.js)
// with none of the caller's env, so `bin/ai`'s `#!/bin/sh` → `exec node`
// polyglot has to resolve `node` from the login shell's own PATH. That is the
// exact packaged-app 127 the daemon start was cured of (script-exec.js) — and
// this lane kept it, invisibly, because the static exec guard only matches
// execFile call sites. Under Electron the SHIPPED launcher is therefore run
// through the Electron binary as node, inline in the string; a user-supplied
// launcher is not ours to reinterpret and keeps the bare form, as does every
// non-Electron caller (CLI, tests). win32 panes do not take this path at all.
function launcherCommand(launcher, {
  electron = Boolean(process.versions.electron),
  execPath = process.execPath,
  platform = process.platform,
} = {}) {
  const flags = launcherFlags(launcher);
  const interpret = flags.length > 0 && electron && platform !== 'win32';
  const head = interpret
    ? `ELECTRON_RUN_AS_NODE=1 ${shellQuote(execPath)} ${shellQuote(launcher)}`
    : `${launcher}`;
  return `${head} ${flags.map((flag) => `${flag} `).join('')}`;
}

// THE ROLE IS IN THE ARGV, BECAUSE THAT IS THE ONLY LABEL A PANE HAS. sessiond
// labels a tab with its joined argv (`session-daemon/client.js`
// snapshotFromSessions), so a mutex looking for a tab LABELLED
// `orchestrate-execution` never matched a real pane, and two Execute clicks
// started two orchestrators against one queue. Every kickoff leads its shell
// string with an inert env assignment naming its role, and the mutex reads the
// label back as shell words: a goal cannot forge the marker, because a goal is
// always inside one quoted word.
const ROLE_ENV = 'HARBOR_ORCH_ROLE';
const roleAssignment = (role) => `${ROLE_ENV}=${role}`;
const ORCH_PROVIDERS = new Set(['claude', 'codex']);

// Only Harbor's own bin/ai understands --provider; a user-supplied launcher
// gets exactly what it always got (createOrchestrationActions refuses a codex
// orchestrator on one). bin/ai launches codex with approvals and the sandbox
// bypassed, which a codex orchestrator needs: it spawns `codex exec` workers,
// creates lane worktrees outside the project root and writes the delegate
// queue, and a workspace-write sandbox refuses all three.
function providerFlags(launcher, { provider = 'claude' } = {}) {
  if (!launcherFlags(launcher).length || provider === 'claude') return '';
  return `--provider ${provider} `;
}

function buildResearchCommand(launcher, home, researchCommand, goal, overrides = {}) {
  const prompt = overrides.prompt ?? `${researchCommand} ${sanitizeGoal(goal)}`;
  return `${roleAssignment('research')} ${launcherCommand(launcher, overrides)}${providerFlags(launcher, overrides)}--home ${shellQuote(home)} ${shellQuote(prompt)}`;
}

function buildExecuteCommand(launcher, home, executionCommand, overrides = {}) {
  const prompt = overrides.prompt ?? executionCommand;
  return `${roleAssignment('execution')} ${launcherCommand(launcher, overrides)}${providerFlags(launcher, overrides)}--home ${shellQuote(home)} ${shellQuote(prompt)}`;
}

function isExecutionTabLabel(label, executionCommand = '/orchestrate-execution') {
  const words = shellWords(String(label || ''));
  // The role word is the marker; the bare command word still catches an
  // execution pane started before the marker existed.
  return words.includes(roleAssignment('execution'))
    || Boolean(executionCommand && words.includes(executionCommand));
}

function checkExecuteMutex({ projectLabel, projectRoot = null, terminalState, queue, executionCommand }) {
  // EVERY workspace of the project, not the first: sessiond makes one
  // workspace per session, so with any other pane open in the project the
  // execution pane sat in a workspace `.find` never reached. The root is
  // matched too, because two folders can share a label and a label can change.
  const root = projectRoot ? canonicalCwd(projectRoot) : null;
  const workspaceIds = new Set((terminalState?.workspaces || [])
    .filter((w) => (projectLabel && w.label === projectLabel) || (root && w.cwd && canonicalCwd(w.cwd) === root))
    .map((w) => w.workspace_id));
  const orchTab = (terminalState?.tabs || []).find(
    (t) => workspaceIds.has(t.workspace_id) && isExecutionTabLabel(t.label, executionCommand),
  );
  if (orchTab) {
    return {
      blocked: true,
      reason: 'An orchestrate-execution session is already open in this workspace.',
    };
  }
  const activeBatches = (queue?.batches || []).filter((b) => b.status === 'active');
  if (activeBatches.length > 0) {
    // Not "wait for completion": the executing session that owns these
    // batches dispatches the ready ones as each lands, and telling the user to
    // wait for the whole wave was the sequential habit itself (2026-10-12).
    const count = activeBatches.length;
    return {
      blocked: true,
      reason: `${count} batch${count === 1 ? ' is' : 'es are'} active under the execution session running this queue; it starts the ready ones as capacity frees. A second execution would claim the same batches, so Execute opens again once none is active.`,
    };
  }
  return { blocked: false, reason: null };
}

// The pane kickoffExecute creates is the durable reservation, but main only
// learns of it on the terminal bridge's next poll (~1 s). Until then the mutex
// reads an empty project, so a second Execute in that gap started a second
// orchestrator. A reservation per project root covers the gap: it holds until
// the bridge shows the launched tab or pane, or until ttlMs passes (a pane
// that never shows up must not lock Execute forever).
const EXECUTE_RESERVATION_MS = 15_000;

function createExecuteReservations({ ttlMs = EXECUTE_RESERVATION_MS, now = Date.now } = {}) {
  const held = new Map();
  const keyOf = (projectRoot) => canonicalCwd(projectRoot);
  const bridgeShows = (entry, terminalState) => (
    (entry.tabId && (terminalState?.tabs || []).some((tab) => tab.tab_id === entry.tabId))
    || (entry.paneId && Object.values(terminalState?.layouts || {})
      .some((layout) => (layout?.panes || []).some((pane) => pane.pane_id === entry.paneId)))
  );
  function blockedReason(projectRoot, terminalState) {
    if (!projectRoot) return null;
    const at = now();
    for (const [key, entry] of held) {
      if (at - entry.at >= ttlMs || bridgeShows(entry, terminalState)) held.delete(key);
    }
    return held.has(keyOf(projectRoot))
      ? 'An orchestrate-execution session was just started in this workspace and is still opening.'
      : null;
  }
  function reserve(projectRoot, launched = {}) {
    if (!projectRoot) return;
    held.set(keyOf(projectRoot), { at: now(), tabId: launched?.tab_id || null, paneId: launched?.pane_id || null });
  }
  return { blockedReason, reserve, size: () => held.size };
}

// The Orch view's parsed-liveness cache (index.js) is keyed by transcript
// path, and the corpus of orch workers only grows, so a plain Map kept one
// entry for every worker transcript any poll ever read. Least recently used,
// capped.
const ORCH_LIVENESS_CACHE_MAX = 200;

function createLruCache(max = ORCH_LIVENESS_CACHE_MAX) {
  const map = new Map();
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key);
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, value);
      while (map.size > max) map.delete(map.keys().next().value);
      return this;
    },
    has: (key) => map.has(key),
    get size() { return map.size; },
  };
}

// CODEX HAS NO CLAUDE SLASH COMMANDS, so a Codex orchestrator gets the
// workflow as its opening prompt: the same command file Claude would expand,
// frontmatter dropped and $ARGUMENTS substituted. Not Codex custom prompts:
// installing one would write into the user's CODEX_HOME (a config home Harbor
// only reads), and a prompt named on the launch argv is sent as text, never
// expanded as a /prompts: command. The lookup order is Claude's own: the
// project's commands, then the Claude home's, then the copy Harbor ships.
// Source tree: <repo>/app/src/main/actions -> <repo>/.claude/commands.
// Packaged: <Resources>/app/src/main/actions -> <Resources>/.claude/commands,
// which exists only because package.json's build.extraResources copies it.
function shippedCommandsDir(actionsDir = __dirname) {
  return path.resolve(actionsDir, '../../../../.claude/commands');
}
const SHIPPED_COMMANDS = shippedCommandsDir();

async function readWorkflowCommand(command, dirs, readFile = fs.promises.readFile) {
  const name = String(command || '').replace(/^\//, '');
  if (!/^[\w.-]+$/.test(name)) throw new Error(`orchestration command ${command} is not a command name`);
  for (const dir of dirs.filter(Boolean)) {
    try { return { file: path.join(dir, `${name}.md`), text: await readFile(path.join(dir, `${name}.md`), 'utf8') }; }
    catch { /* next location */ }
  }
  throw new Error(`Codex cannot run ${command}: no ${name}.md in the project, the Claude home or Harbor's shipped commands`);
}

function codexWorkflowPrompt(command, text, args = '') {
  // A function replacer: a string one would expand $`, $', $& and $$ from the
  // user's goal ("budget $` dollars" arrived as the text before the token).
  const body = String(text).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').replace(/\$ARGUMENTS/g, () => args).trim();
  return [
    `Run Harbor's ${command} workflow. These are its instructions verbatim (Codex has no Claude slash commands, so they arrive as this prompt).`,
    `Its arguments ($ARGUMENTS) are: ${args || '(none)'}`,
    'Where they name Claude-only tools or sub-agents, use your own shell and tools to the same effect.',
    '',
    body,
  ].join('\n');
}

// The provider's own profile, never another provider's home: a codex launch
// handed a CLAUDE config home (or the reverse) is the provider-scoping bug
// docs/claude/providers.md forbids. Same order as launch.js: the default,
// then the first.
function orchestrationProfile(profiles, provider) {
  const matching = (profiles || []).filter((profile) => (profile.provider || 'claude') === provider && profile.configHome);
  return matching.find((profile) => profile.isDefault) || matching[0] || null;
}

function createOrchestrationActions(options = {}) {
  const config = options.config || legacyConfig();
  const launcher = options.launcher || config.orchestration?.launcher;
  const readFile = options.readFile || fs.promises.readFile;
  if (!launcher || !(config.profiles || []).some((profile) => profile.configHome)) {
    throw new TypeError('orchestration requires a launcher and profile');
  }
  const controlClient = options.controlClient || createControlClient({
    env: options.env || process.env,
    sessionStorePolicy: options.sessionStorePolicy,
  });

  function profileFor(provider) {
    if (!ORCH_PROVIDERS.has(provider)) throw new TypeError(`orchestration cannot run on provider ${provider}`);
    const profile = orchestrationProfile(config.profiles, provider);
    if (!profile) throw new Error(`No ${provider} plan with a config home is set up, so a ${provider} orchestrator has nowhere to run.`);
    // --provider is bin/ai's flag; a user-supplied launcher would hand a
    // codex request to whatever it wraps, most likely claude.
    if (provider !== 'claude' && !launcherFlags(launcher).length) {
      throw new Error(`A ${provider} orchestrator needs Harbor's own bin/ai launcher; orchestration.launcher names another one.`);
    }
    return profile;
  }

  async function overridesFor(provider, projectRoot, command, args) {
    if (provider !== 'codex') return { provider };
    const claudeHome = orchestrationProfile(config.profiles, 'claude')?.configHome;
    const { text } = await readWorkflowCommand(command, [path.join(projectRoot, '.claude', 'commands'),
      claudeHome && path.join(claudeHome, 'commands'), SHIPPED_COMMANDS], readFile);
    return { provider, prompt: codexWorkflowPrompt(command, text, args) };
  }

  // The pane runs `$SHELL -lc <string>`, so the daemon's argv[0] detection
  // reads a shell and records agent null, and the provider linker's annotate
  // then refuses (the keeper only rebinds a codex/cursor agent). The kickoff
  // knows which CLI it started, so a codex orchestrator says so.
  async function launchInSession({ projectRoot, command, tabLabel, profile, provider }) {
    const created = await controlClient.createWorkspace({ cwd: projectRoot, command, ...(provider === 'claude' ? {} : { agent: provider }) });
    const paneId = created?.pane_id || created?.id;
    if (!paneId) throw new Error(`session daemon spawn returned no pane_id (got: ${JSON.stringify(created)})`);
    return {
      tab_id: created.tab_id || paneId,
      pane_id: paneId,
      command,
      cwd: projectRoot,
      tabLabel,
      account: profile.id,
      provider,
    };
  }

  async function kickoffResearch({ projectRoot, projectLabel, goal, provider = 'claude' }) {
    if (!projectRoot) throw new TypeError('kickoffResearch requires projectRoot');
    if (!projectLabel) throw new TypeError('kickoffResearch requires projectLabel');
    const trimmedGoal = String(goal || '').trim();
    if (!trimmedGoal) throw new TypeError('kickoffResearch requires a non-empty goal');
    const profile = profileFor(provider);
    const overrides = await overridesFor(provider, projectRoot, config.orchestration.researchCommand, sanitizeGoal(trimmedGoal));
    const command = buildResearchCommand(
      launcher, profile.configHome, config.orchestration.researchCommand, trimmedGoal, overrides,
    );
    return launchInSession({ projectRoot, command, tabLabel: 'orchestrate-research', profile, provider });
  }

  async function kickoffExecute({ projectRoot, projectLabel, provider = 'claude' }) {
    if (!projectRoot) throw new TypeError('kickoffExecute requires projectRoot');
    if (!projectLabel) throw new TypeError('kickoffExecute requires projectLabel');
    const profile = profileFor(provider);
    const overrides = await overridesFor(provider, projectRoot, config.orchestration.executionCommand, '');
    const command = buildExecuteCommand(
      launcher, profile.configHome, config.orchestration.executionCommand, overrides,
    );
    return launchInSession({ projectRoot, command, tabLabel: 'orchestrate-execution', profile, provider });
  }

  return {
    kickoffResearch,
    kickoffExecute,
    LAUNCHER: launcher,
    EXECUTION_COMMAND: config.orchestration.executionCommand,
    CONTROL_CLIENT: controlClient,
  };
}

module.exports = {
  LAUNCHER: legacyConfig().orchestration.launcher,
  ROLE_ENV,
  buildResearchCommand,
  buildExecuteCommand,
  codexWorkflowPrompt,
  isExecutionTabLabel,
  launcherFlags,
  checkExecuteMutex,
  createExecuteReservations,
  EXECUTE_RESERVATION_MS,
  createLruCache,
  ORCH_LIVENESS_CACHE_MAX,
  createOrchestrationActions,
  SHIPPED_COMMANDS,
  shippedCommandsDir,
};
