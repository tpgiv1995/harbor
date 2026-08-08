'use strict';
const { legacyConfig } = require('../config/migrate.js');

const HERDR_BIN = 'herdr';

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
// session in whichever backend is selected, which inside an already-created pane
// would open a second one and leave this pane empty. A launcher the user
// supplied instead of ours has never heard of `--here`, so it gets exactly what
// it got before: the config home and the prompt.
const SHIPPED_LAUNCHER = require('node:path').resolve(__dirname, '../../../../bin/ai');
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

function buildResearchCommand(launcher, home, researchCommand, goal) {
  const escaped = sanitizeGoal(goal).replace(/'/g, "'\\''");
  const flags = launcherFlags(launcher).map((flag) => `${flag} `).join('');
  return `${launcher} ${flags}--home ${shellQuote(home)} '${researchCommand} ${escaped}'`;
}

function buildExecuteCommand(launcher, home, executionCommand) {
  const flags = launcherFlags(launcher).map((flag) => `${flag} `).join('');
  return `${launcher} ${flags}--home ${shellQuote(home)} ${shellQuote(executionCommand)}`;
}

function checkExecuteMutex({ projectLabel, terminalState, queue }) {
  const ws = (terminalState?.workspaces || []).find((w) => w.label === projectLabel);
  if (ws) {
    const orchTab = (terminalState?.tabs || []).find(
      (t) => t.workspace_id === ws.workspace_id && t.label === 'orchestrate-execution',
    );
    if (orchTab) {
      return {
        blocked: true,
        reason: 'An orchestrate-execution session is already open in this workspace.',
      };
    }
  }
  const activeBatches = (queue?.batches || []).filter((b) => b.status === 'active');
  if (activeBatches.length > 0) {
    return {
      blocked: true,
      reason: `Queue has ${activeBatches.length} active batch${activeBatches.length === 1 ? '' : 'es'} in progress. Wait for completion.`,
    };
  }
  return { blocked: false, reason: null };
}

function createOrchestrationActions(options = {}) {
  const { execFile } = options;
  if (typeof execFile !== 'function') {
    throw new TypeError('createOrchestrationActions requires an injectable execFile function');
  }
  const config = options.config || legacyConfig();
  const herdrBin = options.herdrBin || config.platform?.herdrBin || HERDR_BIN;
  const launcher = options.launcher || config.orchestration?.launcher;
  const profile = (config.profiles || []).find((item) => item.isDefault) || config.profiles?.[0];
  if (!launcher || !profile?.configHome) throw new TypeError('orchestration requires a launcher and profile');
  const getTerminalState = options.getTerminalState || null;

  function herdrCall(args) {
    return new Promise((resolve, reject) => {
      execFile(herdrBin, args, { encoding: 'utf8' }, (err, stdout) => {
        if (err) { reject(err); return; }
        try { resolve(JSON.parse(stdout)); } catch (e) {
          reject(new Error(`herdr ${args.slice(0, 2).join('.')}: non-JSON: ${String(stdout).slice(0, 200)}`));
        }
      });
    });
  }

  function paneRunCall(paneId, command) {
    return new Promise((resolve, reject) => {
      execFile(herdrBin, ['pane', 'run', paneId, command], (err) => {
        if (err) reject(err); else resolve();
      });
    });
  }

  async function ensureWorkspace({ projectLabel, projectRoot }) {
    // Workspace records carry no cwd on protocol 16 (round-2 verified), so
    // label equality is the whole match; labels are full (untruncated) since
    // the emit fix. Cross-root label collisions remain a documented gap.
    const pick = (workspaces) => (workspaces || []).find((w) => w.label === projectLabel) || null;
    if (typeof getTerminalState === 'function') {
      const ws = pick(getTerminalState().workspaces);
      if (ws) return ws.workspace_id;
    }
    const list = await herdrCall(['workspace', 'list']);
    const ws = pick(list?.result?.workspaces);
    if (ws) return ws.workspace_id;
    const created = await herdrCall([
      'workspace', 'create', '--cwd', projectRoot, '--label', projectLabel, '--focus',
    ]);
    const workspaceId = created?.result?.workspace?.workspace_id;
    if (!workspaceId) throw new Error('workspace create returned no workspace_id');
    return workspaceId;
  }

  async function createNamedTab({ workspaceId, projectRoot, tabLabel }) {
    const created = await herdrCall([
      'tab', 'create',
      '--workspace', workspaceId,
      '--cwd', projectRoot,
      '--label', tabLabel,
      '--focus',
    ]);
    const result = created?.result;
    const paneId = result?.root_pane?.pane_id || result?.pane?.pane_id;
    const tabId = result?.tab?.tab_id;
    if (!paneId) throw new Error(`tab create returned no pane_id (got: ${JSON.stringify(result)})`);
    return { tab_id: tabId, pane_id: paneId };
  }

  async function kickoffResearch({ projectRoot, projectLabel, goal }) {
    if (!projectRoot) throw new TypeError('kickoffResearch requires projectRoot');
    if (!projectLabel) throw new TypeError('kickoffResearch requires projectLabel');
    const trimmedGoal = String(goal || '').trim();
    if (!trimmedGoal) throw new TypeError('kickoffResearch requires a non-empty goal');
    const workspaceId = await ensureWorkspace({ projectLabel, projectRoot });
    const { tab_id, pane_id } = await createNamedTab({
      workspaceId, projectRoot, tabLabel: 'orchestrate-research',
    });
    const command = buildResearchCommand(
      launcher, profile.configHome, config.orchestration.researchCommand, trimmedGoal,
    );
    await paneRunCall(pane_id, command);
    return { tab_id, pane_id, command, cwd: projectRoot, tabLabel: 'orchestrate-research', account: profile.id };
  }

  async function kickoffExecute({ projectRoot, projectLabel }) {
    if (!projectRoot) throw new TypeError('kickoffExecute requires projectRoot');
    if (!projectLabel) throw new TypeError('kickoffExecute requires projectLabel');
    const workspaceId = await ensureWorkspace({ projectLabel, projectRoot });
    const { tab_id, pane_id } = await createNamedTab({
      workspaceId, projectRoot, tabLabel: 'orchestrate-execution',
    });
    const command = buildExecuteCommand(
      launcher, profile.configHome, config.orchestration.executionCommand,
    );
    await paneRunCall(pane_id, command);
    return { tab_id, pane_id, command, cwd: projectRoot, tabLabel: 'orchestrate-execution', account: profile.id };
  }

  return {
    kickoffResearch,
    kickoffExecute,
    LAUNCHER: launcher,
    HERDR_BIN: herdrBin,
  };
}

module.exports = {
  LAUNCHER: legacyConfig().orchestration.launcher,
  HERDR_BIN,
  buildResearchCommand,
  buildExecuteCommand,
  launcherFlags,
  checkExecuteMutex,
  createOrchestrationActions,
};
