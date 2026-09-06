'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createConfigStore } = require('../../src/main/config/store.js');
const { createAccountsProvider } = require('../../src/main/providers/accounts.js');
const { newSessionOptions } = require('../../src/main/providers/capabilities.js');
const { buildNewArgv } = require('../../src/main/actions/launch.js');

// Both filesystem signals are INJECTED here on purpose, and this file is the
// reason why. Left to derive from the real machine, these tests asked the real
// filesystem two questions: does `<home>/.cache/harbor` exist, and which
// `.claude*` homes are present. Both answers are one developer's, so the suite
// was green on his machine and red on anyone else's for reasons having nothing
// to do with the code under test. That is exactly how it failed on a Mac on
// 2026-07-29. `readdir` fixes the profile discovery; `cacheDir` plus a marker
// file fixes the prior-install signal; the migration path is now selected
// explicitly by each test below.
const HOME = '/home/testuser';
const PRIOR_INSTALL_CACHE = fsSync.mkdtempSync(path.join(os.tmpdir(), 'harbor-prior-install-'));
// hasPriorInstall wants a file only a RUNNING Harbor writes, not just the
// directory: `npm test` and the indexer both create the directory, which is how
// a first-time contributor got classified as an upgrading user.
fsSync.writeFileSync(path.join(PRIOR_INSTALL_CACHE, 'artifacts-index.json'), '{}');

const HOMES = ['.claude', '.claude-team', '.claude-lab'];
const listing = (...names) => () => names.map((name) => ({ name, isFile: () => false }));

const runtime = {
  homedir: HOME,
  platform: 'linux',
  env: { PATH: '/usr/local/bin:/usr/bin', SHELL: '/bin/bash' },
  findBinary: (name) => name,
  cacheDir: PRIOR_INSTALL_CACHE,
  readdir: listing(...HOMES),
};

async function missingFile() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-config-migrate-'));
  return path.join(root, 'user-data', 'config.json');
}

test('a missing file on an existing install migrates the homes THIS machine has', async () => {
  const file = await missingFile();
  const store = createConfigStore({ file, runtime });

  const config = await store.load();

  // Derived from the injected listing, not from a list in the source. The ids
  // are the directory suffixes; `.claude` is `personal` by convention.
  assert.deepEqual(config.profiles.map(({ id }) => id), ['personal', 'lab', 'team']);
  assert.deepEqual(config.profiles.map(({ configHome }) => configHome), [
    path.join(HOME, '.claude'),
    path.join(HOME, '.claude-lab'),
    path.join(HOME, '.claude-team'),
  ]);
  assert.equal(config.profiles.filter((p) => p.isDefault).length, 1);
  assert.deepEqual(config.workflows, [], 'no workflow ships: every one is a path into a specific checkout');
  assert.equal(config.paths.projectsDir, path.join(HOME, '.claude', 'projects'));
  // `cacheDir` on the runtime is only the prior-install PROBE; the stored path
  // still derives from home like every other one.
  assert.equal(config.paths.cacheDir, path.join(HOME, '.cache', 'harbor'));
  assert.equal(config.paths.delegateStateDir, path.join(HOME, '.local', 'state', 'claude-delegate'));
  assert.equal(config.paths.binDir, path.join(HOME, '.local', 'bin'));
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), config);
});

test('one profile with an unusual opaque id remains usable', async () => {
  const file = await missingFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({
    profiles: [{
      id: 'work / + [east]',
      label: 'East',
      letter: 'E',
      color: '#123456',
      provider: 'claude',
      configHome: path.resolve('/srv/claude east'),
      email: null,
      isDefault: true,
    }],
  }));

  const config = await createConfigStore({ file, runtime }).load();

  assert.equal(config.profiles.length, 1);
  assert.equal(config.profiles[0].id, 'work / + [east]');
  assert.equal(config.profiles[0].configHome, path.resolve('/srv/claude east'));
  const accounts = createAccountsProvider({
    profiles: config.profiles,
    history: { sessionMeta: async () => ({ home: 'work / + [east]' }) },
  });
  assert.equal((await accounts.resolveSession('session')).home, path.resolve('/srv/claude east'));
  assert.deepEqual(newSessionOptions(config).accounts, ['work / + [east]']);
  assert.deepEqual(buildNewArgv({ account: 'work / + [east]', profiles: config.profiles }), [
    '--home', path.resolve('/srv/claude east'),
  ]);
});

test('five ordered profiles validate and retain order', async () => {
  const file = await missingFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const profiles = Array.from({ length: 5 }, (_, index) => ({
    id: `profile-${index}`,
    label: `Profile ${index}`,
    letter: String(index),
    color: '#123456',
    provider: index > 2 ? 'codex' : 'claude',
    configHome: `/tmp/profile-${index}`,
    email: null,
    isDefault: index === 0,
  }));
  await fs.writeFile(file, JSON.stringify({ profiles }));

  const config = await createConfigStore({ file, runtime }).load();

  assert.deepEqual(config.profiles.map(({ id }) => id), profiles.map(({ id }) => id));
  assert.deepEqual(newSessionOptions(config).accounts, profiles.map(({ id }) => id));
});

// Found by DRIVING it, which was the only way it could have been found: every
// unit test in this file used to supply a homedir that looked like the author's,
// so "missing config" and "brand-new machine" were the same input and the wizard
// was never in the picture. Launched against a genuinely empty HOME, Harbor
// reported `setup.completed: true`, skipped the seven-step wizard, and wrote
// that user a config carrying three plans they did not have, one of them
// labelled with a real person's name, plus workflows aimed at somebody else's
// Notes vault. That is what a first launch on a borrowed machine looked like.
test('a brand-new machine gets the wizard and only its own homes', async () => {
  const file = await missingFile();
  const coldHome = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-cold-home-'));
  const store = createConfigStore({
    file,
    // Same runtime, except nothing has ever run Harbor here and the home is
    // genuinely empty: the real readdir runs against a real empty directory.
    runtime: {
      ...runtime,
      homedir: coldHome,
      cacheDir: path.join(coldHome, '.cache', 'harbor'),
      readdir: undefined,
    },
  });

  const config = await store.load();

  assert.equal(config.setup.completed, false, 'the wizard must open on a first run');
  assert.deepEqual(config.profiles.map(({ id }) => id), ['personal']);
  for (const profile of config.profiles) {
    assert.ok(
      profile.configHome.startsWith(coldHome),
      `profile ${profile.id} points outside the new user home: ${profile.configHome}`,
    );
  }
  const foreign = config.workflows.filter((w) => typeof w.cwd === 'string' && w.cwd.startsWith('/') && !w.cwd.startsWith(coldHome));
  assert.deepEqual(foreign, [], 'no workflow may point at another machine paths');
});

// The cache DIRECTORY is not the signal, because `npm test`, the indexer and
// several bin/ scripts all create it. A contributor who ran the suite before
// their first launch was classified as an upgrading user and never saw the
// wizard; that is the 2026-07-29 report, and this is its guard.
test('a cache directory with no Harbor artifact in it is still a first run', async () => {
  const file = await missingFile();
  const coldHome = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-cold-home-'));
  const emptyCache = path.join(coldHome, '.cache', 'harbor');
  await fs.mkdir(emptyCache, { recursive: true });

  const config = await createConfigStore({
    file,
    runtime: { ...runtime, homedir: coldHome, cacheDir: emptyCache, readdir: undefined },
  }).load();

  assert.equal(config.setup.completed, false, 'an empty cache dir is not a prior install');
});

// The other half, which is what makes the guard safe to ship: an upgrade of a
// real Harbor install must still migrate silently, or the user loses their
// plans on the next launch after this change.
test('an existing Harbor install still migrates silently and never sees the wizard', async () => {
  const file = await missingFile();
  const store = createConfigStore({ file, runtime });

  const config = await store.load();

  assert.equal(config.setup.completed, true, 'a migrated install is already set up');
  assert.deepEqual(config.profiles.map(({ id }) => id), ['personal', 'lab', 'team']);
});
