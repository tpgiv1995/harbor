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
const os = require('node:os');
const path = require('node:path');
const { createModelCatalog } = require('./model-catalog.js');
const { legacyConfig } = require('../config/migrate.js');
const { codexHomes, readCodexCache } = require('./codex-model-catalog.js');
const { cursorModelOptions } = require('./cursor-model-catalog.js');

// The ONE list allowed to go stale: Claude Code's built-in slash commands,
// written against v2.1.214 and re-checked against the v2.1.284 binary on
// 2026-09-28. /rate-limit-options is now visible to subscribers. The previous
// pass dropped three rows the CLI no longer offers: /agents
// (registered as "(removed)" and hidden from the menu since 2.1.281), and
// /review and /vim. The latter has a hidden compatibility registration in
// 2.1.284; vim is a /config setting now. Labeled 'built-in' in the menu so its
// provenance is obvious.
const BUILTIN_COMMANDS = [
  ['/model', 'Switch this session’s model'],
  ['/effort', 'Set reasoning effort (low..max)'],
  ['/permissions', 'View or change permission mode'],
  ['/clear', 'Clear the conversation'],
  ['/compact', 'Compact the conversation to reclaim context'],
  ['/config', 'Open settings'],
  ['/fast', 'Toggle fast mode (direct-API auth only)'],
  ['/output-style', 'Change the output style'],
  ['/mcp', 'Manage MCP servers'],
  ['/init', 'Generate a CLAUDE.md for this project'],
  ['/resume', 'Resume a past session'],
  ['/status', 'Show account and session status'],
  ['/rate-limit-options', 'Manage usage-limit options (subscription accounts)'],
  ['/login', 'Sign in'],
  ['/logout', 'Sign out'],
  ['/help', 'Show help'],
];

// Codex's OWN built-in slash commands (2026-10-15). A Codex window used to be
// offered Claude's list above (/effort, /fast, /output-style, /init "Generate
// a CLAUDE.md"), none of which Codex understands. Like the Claude list this one
// is version-pinned, and it was read from the INSTALLED CLI, not recalled:
// codex-cli 0.160.0's `SlashCommand` enum (codex-rs/tui/src/slash_command.rs at
// tag rust-v0.160.0; enum order IS the popup's presentation order), whose
// descriptions appear verbatim, in that order, in the strings of the installed
// 0.160.0 binary. The rows are exactly what the
// TUI's own `/` popup lists in a release build (bottom_pane/command_popup.rs):
// it drops every `debug*` command and `/apps`; `/rollout` and `/test-approval`
// exist only under debug_assertions; `/quit` and `/btw` are aliases of `/exit`
// and `/side` the popup hides. Some rows are feature-gated in the CLI (/plan,
// /plugins, /usage, /goal, /worktree, /voice, /setup-default-sandbox): Codex
// answers a gated one with its own "unavailable" note, so they stay listed.
// 0.160 has NO custom-prompt commands: the old `/prompts:<name>` files under
// `$CODEX_HOME/prompts` are gone from the TUI (its popup items are only
// Builtin and ServiceTier), so none are offered.
const CODEX_BUILTIN_COMMANDS = [
  ['/model', 'choose what model and reasoning effort to use'],
  ['/ide', 'include current selection, open files, and other context from your IDE'],
  ['/permissions', 'choose what Codex is allowed to do'],
  ['/keymap', 'remap TUI shortcuts'],
  ['/vim', 'toggle Vim mode for the composer'],
  ['/setup-default-sandbox', 'set up elevated agent sandbox'],
  ['/experimental', 'toggle experimental features'],
  ['/approve', 'approve one retry of a recent auto-review denial'],
  ['/memories', 'configure memory use and generation'],
  ['/skills', 'use skills to improve how Codex performs specific tasks'],
  ['/import', 'import setup, this project, and recent chats from Claude Code'],
  ['/hooks', 'view and manage lifecycle hooks'],
  ['/review', 'review my current changes and find issues'],
  ['/rename', 'rename the current thread'],
  ['/new', 'start a new chat during a conversation'],
  ['/archive', 'archive this session'],
  ['/delete', 'permanently delete this session'],
  ['/resume', 'resume a saved chat'],
  ['/fork', 'fork the current chat'],
  ['/worktree', 'start or continue a conversation in a new worktree'],
  ['/app', 'continue this session in the Desktop app'],
  ['/init', 'create an AGENTS.md file with instructions for Codex'],
  ['/compact', 'summarize conversation to prevent hitting the context limit'],
  ['/recap', 'summarize the current conversation now'],
  ['/plan', 'switch to Plan mode'],
  ['/voice', 'start or stop voice; use /voice settings to choose a voice'],
  ['/goal', 'set or view the goal for a long-running task'],
  ['/agents', 'open the agent command center'],
  ['/side', 'start a side conversation in an ephemeral fork'],
  ['/copy', 'copy the last response or part of it'],
  ['/export', 'export the conversation as markdown'],
  ['/raw', 'toggle raw scrollback mode for copy-friendly terminal selection'],
  ['/tui', 'choose the TUI mode for the next launch'],
  ['/diff', 'show git diff (including untracked files)'],
  ['/mention', 'mention a file'],
  ['/status', 'show current session configuration and token usage'],
  ['/daemon', 'Manage the local background server'],
  ['/warnings', 'view retained warnings and diagnostic details'],
  ['/cd', 'change the current working directory'],
  ['/pwd', 'show the current working directory'],
  ['/usage', 'view account usage or use a usage limit reset'],
  ['/title', 'configure which items appear in the terminal title'],
  ['/statusline', 'configure which items appear in the status line'],
  ['/theme', 'choose a syntax highlighting theme'],
  ['/pets', 'choose or hide the terminal pet'],
  ['/mcp', 'list configured MCP tools; use /mcp verbose for details'],
  ['/plugins', 'browse plugins'],
  ['/logout', 'log out of Codex'],
  ['/exit', 'exit Codex'],
  ['/feedback', 'send logs to maintainers'],
  ['/ps', 'list background terminals'],
  ['/stop', 'stop all background terminals'],
  ['/clear', 'clear the terminal and start a new chat'],
  ['/subagents', "switch between this session's subagents"],
];

// The SEED model list: the floor the menus can never fall below. The live
// list comes from the model catalog, which scans the INSTALLED Claude CLI
// binary (the consumer that actually accepts these ids) and merges what it
// finds over this seed, so a new model release lands in the menus on the next
// refresh without a code change (built after Opus 5 shipped 2026-07-24 and
// Harbor's hand-pinned list missed it).
const MODEL_VERSION_SEED = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', family: 'opus' },
  { id: 'claude-opus-5', label: 'Opus 5', family: 'opus' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', family: 'opus' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7', family: 'opus' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6', family: 'opus' },
  { id: 'claude-opus-4-5', label: 'Opus 4.5', family: 'opus' },
  { id: 'claude-opus-4-1', label: 'Opus 4.1', family: 'opus' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', family: 'sonnet' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', family: 'sonnet' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', family: 'sonnet' },
  { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5', family: 'sonnet' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', family: 'haiku' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', family: 'haiku' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', family: 'fable' },
  { id: 'claude-fable-5', label: 'Fable 5', family: 'fable' },
];

// Codex's model catalog. Codex writes `$CODEX_HOME/models_cache.json` (each entry
// carries `slug`, `display_name`, and a `visibility` flag) and refreshes it on
// use, so the offerable codex model list is DISCOVERED from the launch home
// rather than hand-pinned, the same posture as the Claude model catalog
// above. A hand-pinned list goes stale the moment codex ships a new family and
// then 400s: `gpt-5.6` was pinned here and is rejected as "not supported when
// using Codex with a ChatGPT account" on the 0.151 line. Only `visibility: "list"`
// entries are user-facing (`gpt-reserve` / `codex-auto-review` are hidden
// internals). The DEFAULT row is always codex's own default; named slugs come
// from the cache, falling back to the current frontier slug when that cache
// is absent so a first launch still has a valid option. The fallback must be a
// model with NO migration target in the bundled catalog (2026-09-30): with no
// cache, bin/harbor-bin.cjs has no pair to acknowledge, so a slug carrying an
// `upgrade` (gpt-5.6-sol has pointed at gpt-6-sol since 0.157.0) opens codex's
// migration screen, which eats the first message. gpt-6-sol is listed with no
// upgrade from 0.157.0 through 0.159.2; gpt-6.1-sol only exists from 0.159.1.
const CODEX_MODEL_FALLBACK = [{ value: 'gpt-6-sol', label: 'GPT-6-Sol' }];

// Codex reasoning levels are DISCOVERED from the same models_cache.json, so a
// codex release that adds a level surfaces without a code change: the 0.151 line
// added `max` and `ultra` above the old low/medium/high/xhigh set, which this
// menu was pinned to and had gone stale against. Since 2026-09-20 each model
// carries its own levels; the highest-priority listed model supplies Default.
// Read supported_reasoning_levels (the cache stores them as
// `{ effort, description }` objects, but tolerate a bare string). The hardcoded
// floor stands when no codex home or cache is present, the same seed/floor
// posture as the model list.
const CODEX_EFFORT_FLOOR = ['low', 'medium', 'high', 'xhigh'];

// Every configured Codex home is read, not just the first (2026-10-15): a
// second account's cache can list a model the first has not fetched yet. The
// default home is read first (codexHomes orders it so) and its row wins a slug
// both list, so each model keeps one home's own levels, never a union of them.
function codexOptions(profiles, deps) {
  const caches = codexHomes(profiles, deps).map(readCodexCache).filter(Boolean);
  const anyCatalog = caches.some((cache) => Array.isArray(cache?.models));
  const listed = [];
  const seen = new Set();
  for (const cache of caches) {
    for (const m of Array.isArray(cache.models) ? cache.models : []) {
      if (!m || typeof m.slug !== 'string' || m.visibility !== 'list' || seen.has(m.slug)) continue;
      seen.add(m.slug);
      listed.push(m);
    }
  }
  const effortsByModel = {};
  for (const model of listed) {
    const levels = (Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : [])
      .map((level) => typeof level === 'string' ? level : level?.effort)
      .filter((level) => typeof level === 'string' && level);
    effortsByModel[model.slug] = levels.length ? [...new Set(levels)] : [...CODEX_EFFORT_FLOOR];
  }
  const primary = [...listed].sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity))[0];
  const efforts = effortsByModel[primary?.slug] || [...CODEX_EFFORT_FLOOR];
  return {
    // An explicit provider can invalidate its catalog to an empty models array.
    // Preserve that absence instead of offering a bundled OpenAI model there.
    models: anyCatalog ? listed.map((m) => ({ value: m.slug, label: m.display_name || m.slug })) : [...CODEX_MODEL_FALLBACK],
    efforts, effortsByModel: { ...effortsByModel, default: efforts },
  };
}

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

function newSessionOptions(rawConfig, deps = {}) {
  // Forensics for the profile-order incident (2026-08-13): the fallback below
  // silently substitutes DISCOVERY-ordered profiles (alphabetical, palette
  // colours) for the user's saved config whenever a caller passes nothing,
  // which is exactly the wrong rendering Pat keeps seeing. If it ever fires
  // inside the app, this names the caller. (Was a default parameter, which
  // could fire without leaving any trace at all.)
  const config = rawConfig || legacyConfig();
  if (!rawConfig) {
    try {
      const os = require('node:os');
      const fsSync = require('node:fs');
      const dir = path.join(os.homedir(), '.cache', 'harbor');
      fsSync.mkdirSync(dir, { recursive: true });
      fsSync.appendFileSync(path.join(dir, 'config-load.log'), `${JSON.stringify({
        at: new Date().toISOString(),
        pid: process.pid,
        branch: 'newSessionOptions-DISCOVERY-DEFAULT',
        stack: new Error('discovery default fired').stack,
      })}\n`);
    } catch { /* never break the caller */ }
  }
  const configured = config.providers || {};
  const codex = codexOptions(config.profiles, deps);
  const registry = {
      claude: {
        defaultModel: 'default',
        modelVersions: modelCatalog.versions(),
        models: [
          { value: 'default', label: 'Account default' },
          ...modelCatalog.families().map(({ alias, label }) => ({ value: alias, label })),
        ],
        efforts: ['default', ...EFFORT_LEVELS],
      },
      // Codex model list is DISCOVERED from a configured codex home's
      // models_cache.json (see codexModelOptions); the DEFAULT row is always
      // codex's own default, correct on every install, with the cache's
      // visibility:"list" slugs offered below it. It used to be hand-pinned and
      // carried `gpt-5.6`, which 400s as "not supported ... ChatGPT account".
      codex: {
        defaultModel: 'default',
        models: [
          { value: 'default', label: 'Codex default' },
          ...codex.models,
        ],
        efforts: codex.efforts,
        effortsByModel: codex.effortsByModel,
        defaultEffort: 'medium',
      },
      cursor: {
        defaultModel: 'default',
        models: cursorModelOptions(config.paths?.cacheDir && path.join(config.paths.cacheDir, 'cursor-models.json')),
        efforts: [],
      },
    };
  for (const [id, provider] of Object.entries(registry)) {
    if (configured[id]?.enabled === false) delete registry[id];
    else provider.bin = configured[id]?.bin || (id === 'cursor' ? 'cursor-agent' : id);
  }
  const profiles = (config.profiles || []).map(({
    id, label, letter, color, provider, configHome, isDefault,
  }) => ({ id, label, letter, color, provider: provider || 'claude', configHome: configHome || null, isDefault }));
  const profilesByProvider = {};
  const defaultProfiles = {};
  for (const provider of Object.keys(registry)) {
    profilesByProvider[provider] = profiles.filter((profile) => profile.provider === provider);
    const preferred = profilesByProvider[provider].find((profile) => profile.isDefault)
      || profilesByProvider[provider][0]
      || null;
    defaultProfiles[provider] = preferred?.id || null;
    registry[provider].profiles = profilesByProvider[provider];
    registry[provider].defaultProfile = defaultProfiles[provider];
  }
  return {
    accounts: profiles.map(({ id }) => id),
    profiles,
    profilesByProvider,
    defaultProfiles,
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
  const value = await frontmatterField(file, 'description');
  return value ? clip(value, 160) : null;
}

async function frontmatterField(file, field) {
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
  const fence = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const body = fence ? fence[1] : raw.slice(0, 600);
  const key = new RegExp(`^${field}\\s*:`, 'i');
  const lines = body.split(/\r?\n/);
  const index = lines.findIndex((l) => key.test(l));
  if (index < 0) return null;
  let value = lines[index].replace(key, '').trim();
  // A YAML block scalar (`description: >`) carries its text on the indented
  // lines that follow, not after the colon.
  if (/^[>|][+-]?$/.test(value)) {
    const block = [];
    for (const next of lines.slice(index + 1)) {
      if (!/^\s+\S/.test(next)) break;
      block.push(next.trim());
    }
    value = block.join(' ');
  }
  value = value.replace(/^['"]|['"]$/g, '');
  return value || null;
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

// Codex skills, inserted the way Codex's own composer inserts them: `$name`
// (codex-cli 0.160.0, tui/src/bottom_pane/chat_composer.rs builds each skill
// mention's insert_text as format!("${skill_name}")), never as a slash command.
// The name is the SKILL.md frontmatter `name`, else the directory name, and a
// SKILL.md without a description is rejected by Codex's parser, so it is not
// offered here either (codex-rs/skills/src/parser.rs). Roots follow 0.160's
// ext/skills/src/host_roots.rs: `$CODEX_HOME/skills` (deprecated but still
// read), its `.system` cache of bundled skills, `~/.agents/skills`, and the
// project's `.agents/skills` and `.codex/skills`. Harbor reads one directory
// level under each root and only the session's own cwd for the project roots
// (Codex walks deeper and up to the project root); a skill this misses can
// still be typed.
async function codexSkillCommands(roots) {
  const out = [];
  const seen = new Set();
  for (const root of roots) {
    for (const ent of await readDir(root)) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
      const skillFile = path.join(root, ent.name, 'SKILL.md');
      const description = await frontmatterDescription(skillFile);
      if (!description) continue;
      const name = `$${(await frontmatterField(skillFile, 'name')) || ent.name}`;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, source: 'skill', description });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// MCP server NAMES from a Codex home's config.toml (`[mcp_servers.<name>]`
// tables). Names only, the same rule as Claude's: no command, url, env or
// header value is read into the result.
async function codexMcpServers(home) {
  let raw;
  try {
    raw = await fsp.readFile(path.join(home, 'config.toml'), 'utf8');
  } catch {
    return [];
  }
  const names = new Set();
  for (const match of raw.matchAll(/^\s*\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]\s*$/gm)) {
    names.add(match[1] || match[2]);
  }
  return [...names].sort();
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
  const homedir = deps.homedir || os.homedir;
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

  // A non-Claude window gets its OWN surface, never Claude's: none of Claude's
  // models, effort levels, fast mode, ultracode keyword, plugins, MCP servers
  // or slash commands mean anything to the Codex or Cursor CLI.
  const otherProviderShell = () => ({
    models: { cached: [], families: [], versions: [] },
    effort: { levels: [], note: null },
    fastMode: { available: false, reason: 'Fast mode is a Claude Code setting' },
    dynamicWorkflow: null,
    plugins: [],
    mcpServers: [],
    commands: [],
  });

  const codexSurface = async (result, home, cwd) => {
    const roots = [];
    if (home) roots.push(path.join(home, 'skills'), path.join(home, 'skills', '.system'));
    roots.push(path.join(homedir(), '.agents', 'skills'));
    if (cwd) roots.push(path.join(cwd, '.agents', 'skills'), path.join(cwd, '.codex', 'skills'));
    result.commands = [
      ...CODEX_BUILTIN_COMMANDS.map(([name, description]) => ({ name, source: 'built-in', description })),
      ...await codexSkillCommands(roots),
    ];
    result.mcpServers = home ? await codexMcpServers(home) : [];
    return result;
  };

  // `hints` ({ provider, profileId, cwd }) come from the window asking: the only
  // place a provisional `pane:` window's provider and launch profile are known
  // before its first rollout exists. The session's own metadata outranks them.
  const get = async (sessionId, hints = {}) => {
    let resolved = null;
    try {
      resolved = await accounts.resolveSession(sessionId, hints || {});
    } catch {
      resolved = null;
    }
    const provider = resolved?.provider || hints?.provider || 'claude';
    const account = resolved?.account || null;
    const home = resolved?.home || null;
    // A provisional window's cwd is only known to the window itself.
    const cwd = resolved?.meta?.cwd || (typeof hints?.cwd === 'string' && hints.cwd) || null;

    if (provider !== 'claude') {
      const result = { sessionId, provider, account, home, cwd, ...otherProviderShell() };
      return provider === 'codex' ? codexSurface(result, home, cwd) : result;
    }

    const result = {
      sessionId,
      provider,
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
  CODEX_BUILTIN_COMMANDS,
  MODEL_FAMILIES,
  MODEL_VERSIONS,
  MODEL_VERSION_SEED,
  EFFORT_LEVELS,
  newSessionOptions,
  modelCatalog,
};
