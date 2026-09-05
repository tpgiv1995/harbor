'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

function profilesToHomes(profiles = []) {
  return Object.fromEntries(profiles.map((profile) => [profile.id, profile.configHome]));
}

function createAccountsProvider({ history, homes, profiles = [] } = {}) {
  if (!history || typeof history.sessionMeta !== 'function') {
    throw new TypeError('history provider with sessionMeta(id) is required');
  }
  const resolvedHomes = homes || profilesToHomes(profiles);
  return {
    async resolveSession(id) {
      const meta = await history.sessionMeta(id);
      const account = Object.hasOwn(resolvedHomes, meta.home) ? meta.home : null;
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
