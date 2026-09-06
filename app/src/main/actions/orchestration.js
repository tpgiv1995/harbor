'use strict';
const { legacyConfig } = require('../config/migrate.js');
const { createControlClient } = require('../session-daemon/factory.js');

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
  const config = options.config || legacyConfig();
  const launcher = options.launcher || config.orchestration?.launcher;
  const profile = (config.profiles || []).find((item) => item.isDefault) || config.profiles?.[0];
  if (!launcher || !profile?.configHome) throw new TypeError('orchestration requires a launcher and profile');
  const controlClient = options.controlClient || createControlClient({
    env: options.env || process.env,
    sessionStorePolicy: options.sessionStorePolicy,
  });

  async function launchInSession({ projectRoot, command, tabLabel }) {
    const created = await controlClient.createWorkspace({ cwd: projectRoot, command });
    const paneId = created?.pane_id || created?.id;
    if (!paneId) throw new Error(`session daemon spawn returned no pane_id (got: ${JSON.stringify(created)})`);
    return {
      tab_id: created.tab_id || paneId,
      pane_id: paneId,
      command,
      cwd: projectRoot,
      tabLabel,
      account: profile.id,
    };
  }

  async function kickoffResearch({ projectRoot, projectLabel, goal }) {
    if (!projectRoot) throw new TypeError('kickoffResearch requires projectRoot');
    if (!projectLabel) throw new TypeError('kickoffResearch requires projectLabel');
    const trimmedGoal = String(goal || '').trim();
    if (!trimmedGoal) throw new TypeError('kickoffResearch requires a non-empty goal');
    const command = buildResearchCommand(
      launcher, profile.configHome, config.orchestration.researchCommand, trimmedGoal,
    );
    return launchInSession({ projectRoot, command, tabLabel: 'orchestrate-research' });
  }

  async function kickoffExecute({ projectRoot, projectLabel }) {
    if (!projectRoot) throw new TypeError('kickoffExecute requires projectRoot');
    if (!projectLabel) throw new TypeError('kickoffExecute requires projectLabel');
    const command = buildExecuteCommand(
      launcher, profile.configHome, config.orchestration.executionCommand,
    );
    return launchInSession({ projectRoot, command, tabLabel: 'orchestrate-execution' });
  }

  return {
    kickoffResearch,
    kickoffExecute,
    LAUNCHER: launcher,
    CONTROL_CLIENT: controlClient,
  };
}

module.exports = {
  LAUNCHER: legacyConfig().orchestration.launcher,
  buildResearchCommand,
  buildExecuteCommand,
  launcherFlags,
  checkExecuteMutex,
  createOrchestrationActions,
};
