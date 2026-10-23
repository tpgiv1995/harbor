'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

function profilesToHomes(profiles = []) {
  return Object.fromEntries(profiles.map((profile) => [profile.id, profile.configHome]));
}

// The home a Codex session runs against when no profile names one: an
// inherited CODEX_HOME, else Codex's own ~/.codex (bin/ai's order).
function defaultCodexHome({ env = process.env, homedir = os.homedir } = {}) {
  return env.CODEX_HOME || path.join(homedir(), '.codex');
}

// A brand-new session has no transcript yet, so the indexer cannot find it and
// sessionMeta throws. Without a home the command bar's slash menu fell back to
// built-ins only (2026-10-05). Fall back to the profile the launch flow passed
// as `--home`, then, for a session the index has never seen, to the default
// profile. An indexed session the index could not attribute stays null.
//
// Resolution is PROVIDER-SCOPED (2026-10-15). A Codex window used to resolve
// to the default (Claude) profile, so its slash menu offered Claude's commands
// and skills; an indexed Codex session carries `profileId`/`configHome` from
// the provider scan, never `home`, so it resolved to nothing at all. The
// provider comes from the session's own metadata, else from the caller's hint
// (the renderer knows a provisional `pane:` window's provider and launch
// profile before any rollout exists). A Codex session never borrows a Claude
// profile and vice versa.
function createAccountsProvider({
  history, homes, profiles = [], launchedHome = null, defaultAccount = null, env = process.env, homedir = os.homedir,
} = {}) {
  if (!history || typeof history.sessionMeta !== 'function') {
    throw new TypeError('history provider with sessionMeta(id) is required');
  }
  const resolvedHomes = homes || profilesToHomes(profiles);
  const providerOf = new Map(profiles.map((profile) => [profile.id, profile.provider || 'claude']));
  const fallbackDefault = defaultAccount ?? profiles.find((profile) => profile?.isDefault)?.id ?? null;
  const known = (account) => (account && Object.hasOwn(resolvedHomes, account) ? account : null);
  // A profile only answers for its own provider. Bare `homes` maps (no
  // profile list) carry no provider and are Claude's, as they always were.
  const knownFor = (provider, account) => {
    const id = known(account);
    return id && (providerOf.get(id) || 'claude') === provider ? id : null;
  };
  const launched = (id, provider = 'claude') => {
    try { return knownFor(provider, launchedHome ? launchedHome(id) : null); } catch { return null; }
  };
  const defaultCodexProfile = () => {
    const codex = profiles.filter((profile) => profile?.provider === 'codex');
    return (codex.find((profile) => profile.isDefault) || codex[0])?.id || null;
  };

  function resolveCodex(id, { meta = null, hint = null } = {}) {
    // A rollout found under a configured home belongs to that home's profile
    // even when the scan carried no profile id (the default-root scan).
    const byHome = meta?.configHome
      ? profiles.find((profile) => profile?.provider === 'codex' && profile.configHome === meta.configHome)?.id
      : null;
    const account = knownFor('codex', meta?.profileId)
      || knownFor('codex', byHome)
      || knownFor('codex', hint)
      || launched(id, 'codex')
      || (meta?.configHome ? null : defaultCodexProfile());
    const home = meta?.configHome
      || (account ? resolvedHomes[account] : null)
      || defaultCodexHome({ env, homedir });
    return { provider: 'codex', account, home, meta: meta || { id, home: null } };
  }

  return {
    async resolveSession(id, hints = {}) {
      let meta;
      try {
        meta = await history.sessionMeta(id);
      } catch {
        const provider = hints?.provider || 'claude';
        if (provider === 'codex') return resolveCodex(id, { hint: hints.profileId });
        if (provider !== 'claude') return { provider, account: null, home: null, meta: { id, home: null } };
        const account = knownFor('claude', hints?.profileId) || launched(id) || known(fallbackDefault);
        return { provider, account, home: account ? resolvedHomes[account] : null, meta: { id, home: null } };
      }
      const provider = meta?.provider || hints?.provider || 'claude';
      if (provider === 'codex') return resolveCodex(id, { meta, hint: hints?.profileId });
      if (provider !== 'claude') return { provider, account: null, home: null, meta };
      const account = known(meta?.home) || launched(id);
      return { provider, account, home: account ? resolvedHomes[account] : null, meta };
    },
  };
}

async function readAccountEmails(options = {}) {
  const homes = options.homes || profilesToHomes(options.profiles);
  const readFile = options.readFile || fs.readFile;
  const result = {};
  for (const [account, home] of Object.entries(homes)) {
    try {
      const raw = await readFile(path.join(home, '.claude.json'), 'utf8');
      result[account] = JSON.parse(raw)?.oauthAccount?.emailAddress || null;
    } catch {
      result[account] = null;
    }
  }
  return result;
}

module.exports = {
  createAccountsProvider, profilesToHomes, readAccountEmails, defaultCodexHome,
};
