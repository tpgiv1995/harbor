'use strict';

// Capabilities provider: the read-only enumeration engine behind the command
// bar's capability menu. Given a session id it resolves the session's config
// HOME via the accounts provider, then reads EVERYTHING
// fresh off disk at call time: the model option cache, plugins, mcp server
// names, and the live slash-command / skill surface. Nothing here is cached and
// nothing is hardcoded that can go stale EXCEPT the clearly-labeled
// version-pinned built-in command list. No secrets ever leave this module: MCP
// servers and env-carrying config are reported by NAME only, never value.

const fsp = require('node:fs/promises');
const path = require('node:path');
const { createModelCatalog } = require('./model-catalog.js');
const { legacyConfig } = require('../config/migrate.js');

// The ONE list allowed to go stale: Claude Code v2.1.214's built-in slash
// commands. Labeled 'built-in' in the menu so its provenance is obvious.
const BUILTIN_COMMANDS = [
  ['/model', 'Switch this session’s model'],
  ['/effort', 'Set reasoning effort (low..max)'],
  ['/permissions', 'View or change permission mode'],
  ['/agents', 'Manage subagents'],
  ['/clear', 'Clear the conversation'],
  ['/compact', 'Compact the conversation to reclaim context'],
  ['/config', 'Open settings'],
  ['/fast', 'Toggle fast mode (direct-API auth only)'],
  ['/output-style', 'Change the output style'],
  ['/mcp', 'Manage MCP servers'],
  ['/init', 'Generate a CLAUDE.md for this project'],
  ['/resume', 'Resume a past session'],
  ['/review', 'Review a pull request'],
  ['/status', 'Show account and session status'],
  ['/vim', 'Toggle vim editing mode'],
  ['/login', 'Sign in'],
  ['/logout', 'Sign out'],
  ['/help', 'Show help'],
];

// The SEED model list: the floor the menus can never fall below. The live
// list comes from the model catalog, which scans the INSTALLED Claude CLI
// binary (the consumer that actually accepts these ids) and merges what it
// finds over this seed, so a new model release lands in the menus on the next
// refresh without a code change (built after Opus 5 shipped 2026-07-24 and
// Harbor's hand-pinned list missed it).
const MODEL_VERSION_SEED = [
  { id: 'claude-opus-5', label: 'Opus 5', family: 'opus' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', family: 'opus' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7', family: 'opus' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6', family: 'opus' },
  { id: 'claude-opus-4-5', label: 'Opus 4.5', family: 'opus' },
  { id: 'claude-opus-4-1', label: 'Opus 4.1', family: 'opus' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', family: 'sonnet' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', family: 'sonnet' },
  { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5', family: 'sonnet' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', family: 'haiku' },
  { id: 'claude-fable-5', label: 'Fable 5', family: 'fable' },
];

let activeModelCatalog;

function configureModelCatalog(config = legacyConfig()) {
  activeModelCatalog = createModelCatalog({
    seedIds: MODEL_VERSION_SEED.map((m) => m.id),
    cacheFile: process.env.HARBOR_MODEL_CACHE_FILE
      || path.join(config.paths.cacheDir, 'claude-models.json'),
  });
  return activeModelCatalog;
}

configureModelCatalog();
const modelCatalog = {
  families: (...args) => activeModelCatalog.families(...args),
  versions: (...args) => activeModelCatalog.versions(...args),
  refresh: (...args) => activeModelCatalog.refresh(...args),
};

// Family aliases the CLI accepts as the argument to /model, labeled with each
// family's current flagship. Live views: always read through the catalog.
const MODEL_FAMILIES = modelCatalog.families();
const MODEL_VERSIONS = modelCatalog.versions();

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_NOTE = 'Higher effort levels are restricted by your organization';
const FAST_MODE_UNAVAILABLE = 'Fast mode: unavailable on subscription auth';

function newSessionOptions(config = legacyConfig()) {
  const configured = config.providers || {};
  const registry = {
      claude: {
        defaultModel: 'default',
        models: [
          { value: 'default', label: 'Account default' },
          ...modelCatalog.families().map(({ alias, label }) => ({ value: alias, label })),
        ],
        efforts: ['default', ...EFFORT_LEVELS],
      },
      // Codex publishes no way to enumerate its models, so unlike Claude (whose
      // list is scanned off the installed binary) this is a written list, and a
      // written list of model ids is a guess about somebody else's account. The
      // DEFAULT is therefore the codex CLI's own default, which is correct on
      // every install; the named ids are offered below it and can be wrong
      // without costing a new user their first launch. It used to default to a
      // named id that reads like one account's alias.
      codex: {
        defaultModel: 'default',
        models: [
          { value: 'default', label: 'Codex default' },
          ...['gpt-5.6-sol', 'gpt-5.6'].map((value) => ({ value, label: value })),
        ],
        efforts: ['low', 'medium', 'high', 'xhigh'],
        defaultEffort: 'medium',
      },
      cursor: {
        defaultModel: 'default',
        models: [{ value: 'default', label: 'Default' }],
        efforts: [],
      },
    };
  for (const [id, provider] of Object.entries(registry)) {
    if (configured[id]?.enabled === false) delete registry[id];
    else provider.bin = configured[id]?.bin || id;
  }
  return {
    accounts: (config.profiles || []).map(({ id }) => id),
    profiles: (config.profiles || []).map(({ id, label, letter, color, provider, isDefault }) => (
      { id, label, letter, color, provider, isDefault }
    )),
    providers: registry,
    defaults: config.newSessionDefaults || { provider: 'claude', model: 'opus', effort: 'xhigh' },
    // The user's OWN quick commands. The command bar's Workflows section used to
    // be four hardcoded buttons naming the author's own slash commands, and
    // since workflows now ship EMPTY (a workflow is a command that exists in
    // somebody's config home, so there is no default that is right for two
    // people) every one of them threw "unknown workflow" for anybody else.
    workflows: (config.workflows || [])
      .filter((workflow) => workflow && workflow.id)
      .map(({ id, label, command }) => ({ id, label: label || command || id })),
  };
}

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function readDir(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// A command/skill markdown file's frontmatter description, if any. Files are
// tiny; read the whole thing and pull the first `description:` inside the
// leading `---` fence.
async function frontmatterDescription(file) {
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
  const fence = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const body = fence ? fence[1] : raw.slice(0, 600);
  const line = body.split(/\r?\n/).find((l) => /^description\s*:/i.test(l));
  if (!line) return null;
  const value = line.replace(/^description\s*:/i, '').trim().replace(/^['"]|['"]$/g, '');
  return value ? clip(value, 160) : null;
}

function clip(s, max) {
  const str = String(s || '');
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

async function markdownCommands(dir, { source, namespace = null } = {}) {
  const entries = await readDir(dir);
  const out = [];
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
    const base = ent.name.slice(0, -3);
    const description = await frontmatterDescription(path.join(dir, ent.name));
    out.push({
      name: namespace ? `/${namespace}:${base}` : `/${base}`,
      source,
      description,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Skills live one dir deep, each with a SKILL.md; the dir name is the invocable
// name. Plugin skills namespace as plugin:skill to match the CLI surface.
async function skillCommands(skillsDir, { namespace = null } = {}) {
  const entries = await readDir(skillsDir);
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const skillFile = path.join(skillsDir, ent.name, 'SKILL.md');
    const description = await frontmatterDescription(skillFile);
    // A directory with no SKILL.md is not a skill; frontmatterDescription
    // returning null on a missing file is fine, but require the file exists.
    try {
      await fsp.access(skillFile);
    } catch {
      continue;
    }
    out.push({
      name: namespace ? `/${namespace}:${ent.name}` : `/${ent.name}`,
      source: 'skill',
      description,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// The active install record for a plugin key. installed_plugins records an
// array per key; prefer the one that actually points somewhere on disk.
function activeInstall(records) {
  if (!Array.isArray(records) || !records.length) return null;
  return records.find((r) => r && r.installPath) || records[0];
}

async function enumeratePlugins(home) {
  const installed = await readJson(path.join(home, 'plugins', 'installed_plugins.json'));
  const settings = await readJson(path.join(home, 'settings.json'));
  const enabledMap = (settings && settings.enabledPlugins) || {};
  const plugins = [];
  const map = (installed && installed.plugins) || {};
  for (const key of Object.keys(map).sort()) {
    const [name, marketplace = null] = key.split('@');
    const rec = activeInstall(map[key]);
    plugins.push({
      name,
      marketplace,
      version: rec?.version || null,
      installPath: rec?.installPath || null,
      enabled: enabledMap[key] === true,
    });
  }
  return plugins;
}

function createCapabilitiesProvider(deps = {}) {
  const accounts = deps.accounts;
  if (!accounts || typeof accounts.resolveSession !== 'function') {
    throw new TypeError('capabilities provider requires an accounts provider with resolveSession(id)');
  }

  // Static scaffolding present regardless of whether a home resolves; the
  // live/per-home lists are layered on when a home is known.
  const staticShell = () => ({
    models: {
      cached: [],
      families: modelCatalog.families(),
      versions: modelCatalog.versions(),
    },
    effort: { levels: [...EFFORT_LEVELS], note: EFFORT_NOTE },
    fastMode: { available: false, reason: FAST_MODE_UNAVAILABLE },
    dynamicWorkflow: {
      keyword: 'ultracode',
      note: 'Inserts the ultracode keyword; the next prompt opts into multi-agent workflow orchestration.',
    },
    plugins: [],
    mcpServers: [],
    commands: BUILTIN_COMMANDS.map(([name, description]) => ({ name, source: 'built-in', description })),
  });

  const get = async (sessionId) => {
    let resolved = null;
    try {
      resolved = await accounts.resolveSession(sessionId);
    } catch {
      resolved = null;
    }
    const account = resolved?.account || null;
    const home = resolved?.home || null;
    const cwd = resolved?.meta?.cwd || null;

    const result = {
      sessionId,
      account,
      home,
      cwd,
      ...staticShell(),
    };
    if (!home) return result;

    const claudeJson = await readJson(path.join(home, '.claude.json'));

    // (1) Live model option cache (currently carries Fable). Value -> id,
    // keeping label/description for the row.
    const cache = Array.isArray(claudeJson?.additionalModelOptionsCache)
      ? claudeJson.additionalModelOptionsCache
      : [];
    result.models.cached = cache
      .filter((o) => o && typeof o.value === 'string')
      .map((o) => ({ id: o.value, label: o.label || o.value, description: o.description || null }));

    // (4) Fast mode: subscription (OAuth) auth cannot use /fast; an API-authed
    // home can. Honest disabled row rather than a dead toggle.
    const subscriptionAuth = Boolean(claudeJson?.oauthAccount?.emailAddress);
    result.fastMode = subscriptionAuth
      ? { available: false, reason: FAST_MODE_UNAVAILABLE }
      : { available: true, reason: null };

    // (6) Plugins (all installed, enabled flag from settings) + MCP server
    // names (config-declared plus plugin-provided). Names only.
    const plugins = await enumeratePlugins(home);
    result.plugins = plugins.map((p) => ({
      name: p.name,
      marketplace: p.marketplace,
      version: p.version,
      enabled: p.enabled,
    }));

    const mcpNames = new Set(Object.keys((claudeJson && claudeJson.mcpServers) || {}));
    for (const p of plugins) {
      if (!p.enabled || !p.installPath) continue;
      const pluginMcp = await readJson(path.join(p.installPath, '.mcp.json'));
      const servers = pluginMcp?.mcpServers || pluginMcp;
      if (servers && typeof servers === 'object') {
        for (const name of Object.keys(servers)) mcpNames.add(name);
      }
    }
    result.mcpServers = [...mcpNames].sort();

    // (7) Live slash-command surface, read fresh: built-ins, home commands,
    // project commands, enabled-plugin commands (namespaced), and skills.
    const commands = [...result.commands];
    commands.push(...await markdownCommands(path.join(home, 'commands'), { source: 'user' }));
    if (cwd) {
      commands.push(...await markdownCommands(path.join(cwd, '.claude', 'commands'), { source: 'project' }));
    }
    for (const p of plugins) {
      if (!p.enabled || !p.installPath) continue;
      commands.push(...await markdownCommands(path.join(p.installPath, 'commands'), {
        source: 'plugin',
        namespace: p.name,
      }));
    }
    commands.push(...await skillCommands(path.join(home, 'skills')));
    for (const p of plugins) {
      if (!p.enabled || !p.installPath) continue;
      commands.push(...await skillCommands(path.join(p.installPath, 'skills'), { namespace: p.name }));
    }
    // De-dupe by name, first occurrence wins (built-ins/user take precedence).
    const seen = new Set();
    result.commands = commands.filter((c) => {
      if (seen.has(c.name)) return false;
      seen.add(c.name);
      return true;
    });

    return result;
  };

  return { get };
}

module.exports = {
  configureModelCatalog,
  createCapabilitiesProvider,
  BUILTIN_COMMANDS,
  MODEL_FAMILIES,
  MODEL_VERSIONS,
  MODEL_VERSION_SEED,
  EFFORT_LEVELS,
  newSessionOptions,
  modelCatalog,
};
