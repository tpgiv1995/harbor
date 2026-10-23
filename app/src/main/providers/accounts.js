'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { jwtClaims } = require('./plan-usage.js');

function profilesToHomes(profiles = []) {
  return Object.fromEntries(profiles.map((profile) => [profile.id, profile.configHome]));
}

// A Codex home's signed-in account. Codex keeps no email in config.toml, but
// its `auth.json` carries the ChatGPT login's OpenID `id_token`, whose claims
// name the account (the same read plan-usage.js already does for the title-bar
// menu). Only the `email` claim leaves this function: the token is decoded in
// memory and never logged, returned or forwarded. An API-key login has no
// id_token and honestly answers null.
async function readCodexAccountEmail(home, readFile = fs.readFile) {
  if (!home) return null;
  try {
    const auth = JSON.parse(await readFile(path.join(home, 'auth.json'), 'utf8'));
    const email = jwtClaims(auth?.tokens?.id_token).email;
    return typeof email === 'string' && email ? email : null;
  } catch {
    return null;
  }
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
  const providerOf = new Map((options.profiles || []).map((profile) => [profile.id, profile.provider || 'claude']));
  const readFile = options.readFile || fs.readFile;
  const result = {};
  for (const [account, home] of Object.entries(homes)) {
    const provider = providerOf.get(account) || 'claude';
    if (provider === 'codex') {
      result[account] = await readCodexAccountEmail(home, readFile);
      continue;
    }
    if (provider !== 'claude') {
      result[account] = null;
      continue;
    }
    try {
      const raw = await readFile(path.join(home, '.claude.json'), 'utf8');
      result[account] = JSON.parse(raw)?.oauthAccount?.emailAddress || null;
    } catch {
      result[account] = null;
    }
  }
  return result;
}

module.exports = { createAccountsProvider, profilesToHomes, readAccountEmails, readCodexAccountEmail };
