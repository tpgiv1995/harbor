'use strict';

// WHERE GEMINI'S CLI IS, decided in ONE place (2026-11-23, the Gemini provider work).
//
// Google's Antigravity CLI (`agy`) is Harbor's fourth session provider. Everything that has to find it (the plans
// dropdown's usage row, the new-session registry, `bin/ai`'s launch, the model catalog) asks this module, so no two of
// them can disagree about which binary or which home they mean.
//
// Binary: `HARBOR_AGY_BIN` (or the launcher's generic `HARBOR_GEMINI_BIN`), else `~/.harbor/gemini.json` `{ "bin": ... }` (a
// machine's own pinned install, which outranks the config so a re-pin there moves every reader and a path the config
// copied earlier never goes stale), else the config's own `providers.gemini.bin` when it names a real path, else the
// installer's own default (`%LOCALAPPDATA%\agy\bin\agy.exe` on Windows, `~/.local/bin/agy` elsewhere). No file there:
// no Gemini anywhere (no row, no registry entry, no launcher).
//
// Home: agy keeps ALL of its state under `<USERPROFILE>\.gemini\antigravity-cli` and nothing else moves it (HOME does
// nothing; measured on agy 1.5.14), while its sign-in is a Windows Credential Manager entry every USERPROFILE shares.
// So a Gemini session runs with USERPROFILE UNCHANGED unless a Gemini profile names another root. `HARBOR_AGY_HOME`
// or gemini.json's `home` is such a root; it is only ever a USERPROFILE override, never a default for a pane.
//
// Nothing here names a machine path: the pinned install lives in the user's own gemini.json.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Harbor never lets agy replace itself under a pane: the version is pinned by hand (docs/claude/providers.md, the
// Gemini bullet). The variable is agy's own documented switch.
const AGY_NO_UPDATE_ENV = Object.freeze({ AGY_CLI_DISABLE_AUTO_UPDATE: 'true' });

function defaultBinFor({ env, home, platform }) {
  return platform === 'win32' && env.LOCALAPPDATA
    ? path.join(env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe')
    : path.join(home, '.local', 'bin', 'agy');
}

// The pure rule: given what gemini.json said (or null), which binary and which home.
function geminiConfigFrom({
  env = process.env, home = os.homedir(), platform = process.platform, saved = null, configuredBin = null,
} = {}) {
  const pick = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
  const fromEnv = pick(env.HARBOR_AGY_BIN) || pick(env.HARBOR_GEMINI_BIN);
  // A bare name ('agy') is the schema's placeholder, not a choice: only a path counts.
  const fromConfig = pick(configuredBin) && path.isAbsolute(pick(configuredBin)) ? pick(configuredBin) : null;
  const fromFile = typeof saved?.bin === 'string' && saved.bin.trim() ? saved.bin.trim() : null;
  const bin = fromEnv || fromFile || fromConfig || defaultBinFor({ env, home, platform });
  const homeEnv = typeof env.HARBOR_AGY_HOME === 'string' && env.HARBOR_AGY_HOME.trim() ? env.HARBOR_AGY_HOME.trim() : null;
  const homeFile = typeof saved?.home === 'string' && saved.home.trim() ? saved.home.trim() : null;
  return { bin, agyHome: homeEnv || homeFile || null };
}

function savedFile(home) {
  return path.join(home, '.harbor', 'gemini.json');
}

function parseSaved(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// Synchronous reader (bin/ai and the config defaults cannot await). Returns null when the CLI is not installed.
function resolveGeminiConfigSync({
  env = process.env, home = os.homedir(), platform = process.platform, fsImpl = fs, configuredBin = null,
} = {}) {
  let saved = null;
  try { saved = parseSaved(fsImpl.readFileSync(savedFile(home), 'utf8')); } catch { /* no file */ }
  const config = geminiConfigFrom({ env, home, platform, saved, configuredBin });
  try {
    fsImpl.statSync(config.bin);
  } catch {
    return null;
  }
  return config;
}

// Async twin for the plans dropdown (its `io` is fs.promises and is injected by tests).
async function resolveGeminiConfig({
  env = process.env, home = os.homedir(), platform = process.platform, io = fs.promises, configuredBin = null,
} = {}) {
  let saved = null;
  try { saved = parseSaved(await io.readFile(savedFile(home), 'utf8')); } catch { /* no file */ }
  const config = geminiConfigFrom({ env, home, platform, saved, configuredBin });
  try {
    await io.stat(config.bin);
  } catch {
    return null;
  }
  return config;
}

// agy's state folder for a USERPROFILE root (the user's own profile when `root` is empty).
function geminiStateDir(root, home = os.homedir()) {
  return path.join(root || home, '.gemini', 'antigravity-cli');
}

// The environment an agy child needs on top of Harbor's allowlisted one: no self-update, and a relocated USERPROFILE
// only when a Gemini profile named another root. HOME is deliberately untouched (agy ignores it).
function geminiChildEnv(base = {}, { root = null } = {}) {
  const env = { ...base, ...AGY_NO_UPDATE_ENV };
  if (root) env.USERPROFILE = root;
  return env;
}

module.exports = {
  AGY_NO_UPDATE_ENV,
  geminiConfigFrom,
  resolveGeminiConfigSync,
  resolveGeminiConfig,
  geminiStateDir,
  geminiChildEnv,
};
