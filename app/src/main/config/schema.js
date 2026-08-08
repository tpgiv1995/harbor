'use strict';

const VERSION = 1;

const SCHEMA = Object.freeze({
  version: VERSION,
  setup: { completed: false, completedAt: null, appVersion: null },
  platform: { os: null, herdrBin: null, herdrSocket: null, shell: null },
  profiles: [{
    id: 'personal',
    label: 'Personal',
    letter: 'P',
    color: '#437FFE',
    provider: 'claude',
    configHome: null,
    email: null,
    isDefault: false,
  }],
  providers: {
    claude: { enabled: true, bin: 'claude' },
    codex: { enabled: true, bin: 'codex' },
    cursor: { enabled: true, bin: 'cursor-agent' },
  },
  // projectIconsDir stays null by default and is resolved against the Electron
  // userData directory at use, which keeps it correct on all three platforms
  // instead of hardcoding one OS's config path here.
  // tasksFile follows projectIconsDir: null by default, resolved against the
  // Electron userData directory at use, so it lands in the right place on every
  // platform instead of hardcoding one OS's config path here.
  paths: {
    projectsDir: null,
    cacheDir: null,
    delegateStateDir: null,
    binDir: null,
    projectIconsDir: null,
    tasksFile: null,
  },
  // WORKFLOWS SHIP EMPTY, and this used to ship one: `/acclimate`, a slash
  // command from the author's own config home. `migrate.js` already states the
  // rule ("there is no such thing as a default one that is right for two
  // different people") and `legacyConfig()` already honoured it, but the SCHEMA
  // default sat underneath both, so every path that falls back to bare defaults
  // handed out that command. The wizard masks it on a normal first run; a config
  // file that fails to parse does not, and that path reaches a user who already
  // had workflows of their own.
  workflows: [],
  orchestration: {
    enabled: true,
    launcher: null,
    researchCommand: '/orchestrate-research',
    executionCommand: '/orchestrate-execution',
    stateDir: null,
  },
  newSessionDefaults: { provider: 'claude', model: 'opus', effort: 'xhigh' },
});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeConfig(base, supplied) {
  if (!isObject(supplied)) return structuredClone(base);
  const result = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(supplied)])) {
    const fallback = base[key];
    const value = supplied[key];
    if (value === undefined) result[key] = structuredClone(fallback);
    else if (isObject(fallback) && isObject(value)) result[key] = mergeConfig(fallback, value);
    else result[key] = structuredClone(value);
  }
  return result;
}

function validateConfig(config) {
  if (!isObject(config)) throw new TypeError('config root must be an object');
  if (config.version !== VERSION) throw new TypeError(`unsupported config version: ${config.version}`);
  if (!Array.isArray(config.profiles) || config.profiles.length === 0) {
    throw new TypeError('config profiles must be a non-empty ordered list');
  }
  const ids = new Set();
  for (const profile of config.profiles) {
    if (!isObject(profile) || typeof profile.id !== 'string' || !profile.id) {
      throw new TypeError('every profile requires a non-empty string id');
    }
    if (ids.has(profile.id)) throw new TypeError(`duplicate profile id: ${profile.id}`);
    ids.add(profile.id);
    for (const field of ['label', 'letter', 'color', 'provider', 'configHome']) {
      if (typeof profile[field] !== 'string' || !profile[field]) {
        throw new TypeError(`profile ${profile.id} requires ${field}`);
      }
    }
    if (profile.email !== null && typeof profile.email !== 'string') {
      throw new TypeError(`profile ${profile.id} email must be a string or null`);
    }
    if (typeof profile.isDefault !== 'boolean') {
      throw new TypeError(`profile ${profile.id} isDefault must be boolean`);
    }
  }
  if (!Array.isArray(config.workflows)) throw new TypeError('config workflows must be an ordered list');
  for (const workflow of config.workflows) {
    if (!isObject(workflow) || typeof workflow.id !== 'string' || !workflow.id) {
      throw new TypeError('every workflow requires a non-empty string id');
    }
  }
  return config;
}

module.exports = { VERSION, SCHEMA, mergeConfig, validateConfig };
