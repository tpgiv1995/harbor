'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { deriveDefaults, runtimeValues } = require('./defaults.js');
const { discoverProfiles } = require('./homes.js');

// Files that only a RUNNING Harbor produces. The prior-install signal used to be
// the mere existence of `~/.cache/harbor`, which was wrong in the one direction
// that mattered: `npm test`, the indexer and several bin/ scripts all create
// that directory, so a new contributor who ran the suite before their first
// launch was classified as an upgrading user. That is exactly what happened on
// 2026-07-29 (the suite was run first, then the app launched), and Harbor
// answered by skipping the seven-step wizard.
//
// A marker FILE is the honest signal, because each of these is written by the
// app itself during normal operation and by nothing in the test suite, which
// redirects every cache path it touches into a temp directory.
const INSTALL_MARKERS = [
  'artifacts-index.json',
  'claude-models.json',
  'session-titles.json',
  'send-log.jsonl',
  'artifact-thumbs',
];

// Is there a Harbor install here to MIGRATE, or is this somebody's first launch?
// A migration needs something to migrate FROM. Deliberately NOT keyed on
// `~/.claude` existing: a new user installs Claude Code first, so that would
// call every one of them a legacy install.
function hasPriorInstall(overrides = {}) {
  const runtime = runtimeValues(overrides);
  const cacheDir = overrides.cacheDir || path.join(runtime.homedir, '.cache', 'harbor');
  const exists = overrides.exists || ((target) => fs.existsSync(target));
  try {
    if (!fs.statSync(cacheDir).isDirectory()) return false;
  } catch {
    return false;
  }
  return INSTALL_MARKERS.some((marker) => exists(path.join(cacheDir, marker)));
}

// The config an existing install is carried onto, and the seed a brand-new one
// starts from. These used to be two different things: the "legacy" branch handed
// out a hardcoded list of three plans (one labelled with a real person's first
// name, pointing at a `.claude-<name>` directory nobody else owns) plus four
// workflows carrying absolute paths into one specific notes vault and one
// specific checkout. Shipping one person's account list meant that whenever the
// prior-install guard misfired, it misfired by handing somebody else that
// person's setup, which is precisely what it did.
//
// Now both branches derive from the same place: the config homes that actually
// exist on THIS machine (see config/homes.js). An upgrading user gets their own
// homes back under the ids they already had, because the id comes from their own
// directory names; a new user gets whatever they have, or a single `personal`
// seed if they have nothing yet. Nobody gets anybody else's.
//
// Workflows ship EMPTY. A workflow is an absolute path into a specific checkout,
// so there is no such thing as a default one that is right for two different
// people; the setup wizard and the Orch view are where they get added.
function legacyConfig(overrides = {}) {
  const runtime = runtimeValues(overrides);
  return deriveDefaults({
    setup: { completed: true, completedAt: null, appVersion: null },
    profiles: discoverProfiles(runtime.homedir, overrides),
    workflows: [],
  }, runtime);
}

module.exports = { INSTALL_MARKERS, legacyConfig, hasPriorInstall };
