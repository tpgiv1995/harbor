'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { cliCommand } = require('./cli-command.js');

// 2026-09-20: bin/ai only overrides CODEX_HOME for an explicit profile. With
// no profile, its inherited CODEX_HOME wins, then Codex's own ~/.codex default.
function codexHomes(profiles = [], { env = process.env, homedir = os.homedir } = {}) {
  const configured = profiles.filter((p) => p.provider === 'codex' && p.configHome);
  configured.sort((a, b) => Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)));
  return [...new Set(configured.length ? configured.map((p) => p.configHome)
    : [env.CODEX_HOME || path.join(homedir(), '.codex')])];
}

function readCodexCache(home) {
  try { return JSON.parse(fs.readFileSync(path.join(home, 'models_cache.json'), 'utf8')); }
  catch { return null; }
}

function createCodexModelDiscovery(options = {}) {
  const env = options.env || process.env;
  const execFile = options.execFile || require('node:util').promisify(require('node:child_process').execFile);
  const homes = codexHomes(options.profiles, options);
  let pending = null;
  const refresh = ({ version, force = false } = {}) => {
    if (env.HARBOR_E2E === '1' || env.HARBOR_NO_MODEL_DISCOVERY === '1') return Promise.resolve({ ok: false, reason: 'disabled' });
    if (pending) return pending;
    pending = (async () => {
      const results = [];
      for (const home of homes) {
        // Do not create an unconfigured Codex installation just to fill a menu.
        if (!fs.existsSync(home)) continue;
        const before = readCodexCache(home);
        const populated = (cache) => Array.isArray(cache?.models) && cache.models.some(m => typeof m?.slug === 'string' && m.slug);
        if (!force && version && before?.client_version === version && populated(before)) continue;
        try {
          // Reviewer verified 2026-09-20 on 0.155.1: forced refresh took 2.9s,
          // rewrote the cache, kept config unchanged and left no rollout/process.
          const command = cliCommand(env.HARBOR_CODEX_BIN || options.bin || 'codex', ['debug', 'models'], options.platform);
          await execFile(command.file, command.args, { env: { ...env, CODEX_HOME: home }, windowsHide: true,
            timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
          const after = readCodexCache(home);
          if ((version && after?.client_version !== version) || !populated(after)) throw Error('Codex did not refresh its models cache');
          results.push({ home, ok: true });
        } catch (error) { results.push({ home, ok: false, reason: error.message }); }
      }
      return { ok: results.every((r) => r.ok), results };
    })().finally(() => { pending = null; });
    return pending;
  };
  return { refresh };
}

module.exports = { codexHomes, readCodexCache, createCodexModelDiscovery };
