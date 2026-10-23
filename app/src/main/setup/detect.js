'use strict';

// What the first-run wizard is allowed to claim about this machine.
//
// The rule the whole module is built around: DETECTION IS SHOWN, NEVER
// ASSUMED, and a value we could not determine comes back null with a reason
// rather than a confident-looking default. Every field here therefore carries
// its own `found` flag, so the screen can render "not found, here is how to
// install it" instead of an editable box pre-filled with a path that does not
// exist. A wizard that seeds a plausible wrong value teaches the user to trust
// it, and the first thing they will hit is a provider that never launches.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PRIMARY_HOME, homeId, listHomeDirs } = require('../config/homes.js');
const { readCodexAccountEmail } = require('../providers/accounts.js');
const { execFile } = require('node:child_process');

function run(command, args, { timeout = 4000 } = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function statOrNull(target) {
  try {
    return await fsp.stat(target);
  } catch {
    return null;
  }
}

async function isExecutable(file) {
  try {
    await fsp.access(file, require('node:fs').constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// PATH lookup done here rather than shelling out to which/where, so detection
// works identically on all three platforms and stays testable without a shell.
async function findOnPath(name, { env, platformName }) {
  const isWindows = platformName === 'win32';
  const exts = isWindows
    ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      const stat = await statOrNull(candidate);
      if (!stat || !stat.isFile()) continue;
      if (isWindows || await isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

async function detectBinary(name, options) {
  const explicit = options.env[`HARBOR_${name.toUpperCase().replace(/-/g, '_')}_BIN`];
  if (explicit) {
    const stat = await statOrNull(explicit);
    return { found: Boolean(stat), path: explicit, source: 'env' };
  }
  const found = await findOnPath(name, options);
  return found
    ? { found: true, path: found, source: 'PATH' }
    : { found: false, path: null, source: null };
}

// A Claude config home is a directory that carries a .claude.json. The email
// is READ BACK from that file's oauthAccount purely so the user can confirm
// they picked the right home; it is not a credential and nothing else in the
// file is read, stored or forwarded.
async function readClaudeHome(dir, readFile) {
  const stat = await statOrNull(dir);
  if (!stat || !stat.isDirectory()) {
    return { path: dir, exists: false, authed: false, email: null, reason: 'folder does not exist' };
  }
  const configFile = path.join(dir, '.claude.json');
  let raw;
  try {
    raw = await readFile(configFile, 'utf8');
  } catch {
    return {
      path: dir,
      exists: true,
      authed: false,
      email: null,
      reason: 'no .claude.json in this folder; the Claude CLI has not run here yet',
    };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { path: dir, exists: true, authed: false, email: null, reason: '.claude.json is not readable JSON' };
  }
  const email = parsed?.oauthAccount?.emailAddress || null;
  return {
    path: dir,
    exists: true,
    authed: Boolean(email),
    email,
    // An API-key home is legitimately signed in without an oauthAccount, so
    // "no email" is reported as what it is rather than as "not signed in".
    reason: email ? null : 'signed in with an API key, or not signed in; no account email recorded',
  };
}

// Where this Codex home keeps its login: config.toml's top-level
// `cli_auth_credentials_store` ("file", "keyring" or "auto"). A keyring home
// has no auth.json at all, so its absence is not "not signed in". Only
// this one key is read; the keyring itself is never touched.
async function codexCredentialStore(dir, readFile) {
  let raw;
  try { raw = await readFile(path.join(dir, 'config.toml'), 'utf8'); } catch { return null; }
  for (const line of String(raw).split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break; // past the top-level table
    const match = /^\s*cli_auth_credentials_store\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/.exec(line);
    if (match) return String(match[1] ?? match[2]).trim().toLowerCase() || null;
  }
  return null;
}

// A Codex home's signed-in account, read back the same way: the email claim of
// the ChatGPT login's id_token in `auth.json` (accounts.js decodes it in memory
// and returns ONLY the email; no token is ever stored, shown or forwarded). An
// API-key login carries no id_token, so "no email" is reported as what it is.
async function readCodexHome(dir, readFile) {
  const stat = await statOrNull(dir);
  if (!stat || !stat.isDirectory()) {
    return { path: dir, exists: false, authed: false, email: null, reason: 'folder does not exist' };
  }
  if (!(await statOrNull(path.join(dir, 'auth.json')))) {
    if (await codexCredentialStore(dir, readFile) === 'keyring') {
      return {
        path: dir,
        exists: true,
        authed: false,
        email: null,
        credentialStore: 'keyring',
        reason: 'signed in via the OS keyring (not verified)',
      };
    }
    return {
      path: dir,
      exists: true,
      authed: false,
      email: null,
      reason: 'no auth.json in this folder; sign in with the codex CLI first',
    };
  }
  const email = await readCodexAccountEmail(dir, readFile);
  return {
    path: dir,
    exists: true,
    authed: Boolean(email),
    email,
    reason: email ? null : 'signed in with an API key, or not signed in; no account email recorded',
  };
}

// Candidate homes, in the order the wizard should seed them. A multi-account
// install has several; a fresh machine has one or none. Everything found is
// offered and nothing is required.
//
// This used to be a literal list of three directory names, the third of which
// was one specific person's, so the wizard could only ever offer that person's
// accounts. It now SCANS, through the same helper the config migration uses, so
// the two cannot disagree about what a profile is.
function candidateHomes(homedir, overrides = {}) {
  // `exists` is threaded for the same reason `readdir` is: the comment above
  // says the wizard and the migration must not disagree about what a profile
  // is, and a home is now a directory holding a `.claude.json`, not merely one
  // named `.claude-*`. Dropping it here would leave the WIZARD offering the
  // phantom accounts the migration had just learned to reject, which is the
  // surface the user actually sees.
  const found = listHomeDirs(homedir, overrides.readdir || fs.readdirSync, overrides.exists || fs.existsSync);
  return found.length ? found : [path.join(homedir, PRIMARY_HOME)];
}

async function detectClaudeHomes(options) {
  const out = [];
  for (const dir of candidateHomes(options.homedir, options)) {
    const home = await readClaudeHome(dir, options.readFile);
    // Only OFFER a home that exists. Listing empty paths on a fresh machine is
    // the confident guess this module refuses to make.
    if (home.exists) out.push({ ...home, id: homeId(dir) });
  }
  return out;
}

async function detectProviders(options) {
  const claude = await detectBinary('claude', options);
  const codex = await detectBinary('codex', options);
  const cursor = await detectBinary('cursor-agent', options);
  const codexHome = path.join(options.homedir, '.codex');
  const cursorHome = path.join(options.homedir, '.cursor');
  const codexAccount = await readCodexHome(codexHome, options.readFile);
  return {
    claude: { ...claude },
    codex: {
      ...codex,
      home: codexAccount.exists ? codexHome : null,
      email: codexAccount.email,
      emailReason: codexAccount.email ? null : codexAccount.reason,
    },
    cursor: {
      ...cursor,
      home: (await statOrNull(cursorHome)) ? cursorHome : null,
      email: null,
      emailReason: 'Cursor does not record an account email Harbor can read.',
    },
  };
}

// The user's REAL skills and slash commands, enumerated the way the capability
// menu already does it, so step 4 offers what they actually have rather than a
// shipped list. Runs after the Claude step on purpose: it needs a config home
// to read, and reading it before the user has picked one would offer nothing.
async function detectCatalog(homes, options) {
  const { createCapabilitiesProvider } = require('../providers/capabilities.js');
  const commands = [];
  const seen = new Set();
  for (const home of homes.filter(Boolean)) {
    // A stub accounts provider is the whole point: capabilities resolves a
    // session id to a home, and here the home is already known, so this hands
    // it the answer directly instead of touching the session index.
    const provider = createCapabilitiesProvider({
      accounts: { resolveSession: async () => ({ account: home, home, meta: { cwd: options.cwd || null } }) },
    });
    let result;
    try {
      result = await provider.get(null);
    } catch {
      continue;
    }
    for (const command of result.commands || []) {
      if (seen.has(command.name)) continue;
      seen.add(command.name);
      commands.push({ ...command, home });
    }
  }
  return { commands, homes };
}

// WHAT THE ORCH VIEW ACTUALLY NEEDS, which is not what this used to look for.
//
// It used to stat `~/.local/bin/claude-go`: a POSIX-only path to a wrapper that
// ships with nothing, so on Windows it could never be found and on Linux it
// answered a question about the author's machine. The launcher is now the
// repository's own `bin/ai`, which is always present, so it is not the thing
// that decides whether orchestration is usable.
//
// The real dependency is a DELEGATE QUEUE CLI: the tool the `/orchestrate-*`
// commands hand a batch queue to. Harbor does not ship one, and without it the
// Research and Execute buttons open a session that fails on its first command.
// So that is what is detected, cross-platform, through the same PATH lookup
// everything else here uses, and the wizard defaults the whole view off when it
// is absent rather than offering a control with nothing behind it.
const DELEGATE_CLI = 'claude-delegate';

async function detectOrchestration(options) {
  const launcher = path.resolve(__dirname, '../../../../bin/ai');
  const launcherStat = await statOrNull(launcher);
  const delegate = await detectBinary(options.delegateCli || DELEGATE_CLI, options);
  return {
    launcher: launcherStat ? launcher : '',
    launcherFound: Boolean(launcherStat),
    delegateCli: options.delegateCli || DELEGATE_CLI,
    delegatePath: delegate.path || null,
    delegateFound: delegate.found,
    // `found` is what the wizard seeds `enabled` from, and it must mean "this
    // view will work", not "a file exists".
    found: Boolean(launcherStat) && delegate.found,
  };
}

// The one entry point. Everything is injectable so the tests can drive a
// synthetic machine, and NOTHING here writes.
async function detectEnvironment(deps = {}) {
  const env = deps.env || process.env;
  const homedir = deps.homedir || os.homedir();
  const platformName = deps.platform || os.platform();
  const readFile = deps.readFile || fsp.readFile;
  const options = { env, homedir, platformName, readFile, probeVersion: deps.probeVersion };

  const [providers, claudeHomes, orchestration] = await Promise.all([
    detectProviders(options),
    detectClaudeHomes(options),
    detectOrchestration(options),
  ]);

  return {
    os: platformName,
    osLabel: { linux: 'Linux', win32: 'Windows', darwin: 'macOS' }[platformName] || platformName,
    homedir,
    shell: env.SHELL || env.ComSpec || null,
    // Windows directory symlinks need Developer Mode or an elevated shell;
    // junctions need neither. macOS and Linux use real symlinks. Reported so
    // the sharing step can be honest about it instead of failing at apply.
    symlinkStyle: platformName === 'win32' ? 'junction' : 'symlink',
    providers,
    claudeHomes,
    orchestration,
  };
}

module.exports = {
  detectEnvironment,
  detectProviders,
  detectClaudeHomes,
  detectCatalog,
  readClaudeHome,
  readCodexHome,
  findOnPath,
  homeId,
};
