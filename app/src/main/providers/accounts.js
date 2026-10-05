'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

function profilesToHomes(profiles = []) {
  return Object.fromEntries(profiles.map((profile) => [profile.id, profile.configHome]));
}

// A brand-new session has no transcript yet, so the indexer cannot find it and
// sessionMeta throws. Without a home the command bar's slash menu fell back to
// built-ins only (2026-10-05). Fall back to the profile the launch flow passed
// as `--home`, then, for a session the index has never seen, to the default
// profile. An indexed session the index could not attribute stays null.
function createAccountsProvider({ history, homes, profiles = [], launchedHome = null, defaultAccount = null } = {}) {
  if (!history || typeof history.sessionMeta !== 'function') {
    throw new TypeError('history provider with sessionMeta(id) is required');
  }
  const resolvedHomes = homes || profilesToHomes(profiles);
  const fallbackDefault = defaultAccount ?? profiles.find((profile) => profile?.isDefault)?.id ?? null;
  const known = (account) => (account && Object.hasOwn(resolvedHomes, account) ? account : null);
  const launched = (id) => {
    try { return known(launchedHome ? launchedHome(id) : null); } catch { return null; }
  };
  return {
    async resolveSession(id) {
      let meta;
      try {
        meta = await history.sessionMeta(id);
      } catch {
        const account = launched(id) || known(fallbackDefault);
        return { account, home: account ? resolvedHomes[account] : null, meta: { id, home: null } };
      }
      const account = known(meta?.home) || launched(id);
      return { account, home: account ? resolvedHomes[account] : null, meta };
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

module.exports = { createAccountsProvider, profilesToHomes, readAccountEmails };
