'use strict';

// What the migration is allowed to know about the person running it: NOTHING.
//
// This file used to pin the migrated config to one specific developer's three
// accounts, byte for byte, on the reasoning that his machine must behave
// identically after the config store landed. That was true, and it is why the
// app ended up shipping his account list as source: a third profile carrying a
// real person's first name, pointing at a `.claude-<name>` directory nobody else
// owns, plus four workflows holding absolute paths into one notes vault and
// one of his checkouts. On 2026-07-29 that config reached somebody else's Mac.
//
// The fidelity requirement was never wrong, only aimed at the wrong thing. What
// has to survive an upgrade is THE USER'S OWN SETUP, and the only honest source
// for that is the config homes present on the machine actually running. So these
// tests assert the derivation, and every one of them injects its own directory
// listing: if a profile name can be predicted without saying what is on disk,
// the app is shipping somebody's identity again.
//
// The colours are still read out of styles.css rather than restated here,
// because a hex typed twice is a hex that will drift: the first version of the
// migration seeded --ac (#437FFE) for the personal profile when the rail has
// always drawn it in --per (#6FA8D8), which would have collided with the accent
// blue that already means "this session is live".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { legacyConfig } = require('../../src/main/config/migrate.js');

const REPO = path.join(__dirname, '..', '..');
const STYLES = fs.readFileSync(path.join(REPO, 'src', 'renderer', 'styles.css'), 'utf8');

function cssToken(name) {
  const match = STYLES.match(new RegExp(`^\\s*--${name}:\\s*([^;]+);`, 'm'));
  assert.ok(match, `styles.css must still define --${name}`);
  return match[1].trim().toLowerCase();
}

const HOME = '/home/testuser';

// A stand-in for fs.readdirSync(dir, { withFileTypes: true }). Only isFile()
// is consulted, because a config home is legitimately a symlink.
function listing(...names) {
  return () => names.map((name) => ({ name, isFile: () => false }));
}

function configFor(names, extra = {}) {
  return legacyConfig({
    homedir: HOME,
    platform: 'linux',
    env: { HOME, PATH: '' },
    readdir: listing(...names),
    ...extra,
  });
}

test('profiles come from the config homes that exist, with .claude first', () => {
  const config = configFor(['.claude', '.claude-work', '.bashrc', 'Documents', '.claude-lab']);
  assert.deepEqual(
    config.profiles.map((p) => p.id),
    ['personal', 'lab', 'work'],
    '.claude is personal and sorts first; the rest carry their own suffix, alphabetically',
  );
  assert.deepEqual(config.profiles.map((p) => p.configHome), [
    path.join(HOME, '.claude'),
    path.join(HOME, '.claude-lab'),
    path.join(HOME, '.claude-work'),
  ]);
});

test('a DIFFERENT machine yields different profiles, so no account name is baked in', () => {
  const mine = configFor(['.claude', '.claude-team']);
  const theirs = configFor(['.claude-acme', '.claude-beta']);
  assert.deepEqual(mine.profiles.map((p) => p.id), ['personal', 'team']);
  assert.deepEqual(theirs.profiles.map((p) => p.id), ['acme', 'beta']);
  // The old implementation returned the identical three profiles for both.
  assert.notDeepEqual(mine.profiles.map((p) => p.id), theirs.profiles.map((p) => p.id));
});

test('a machine with no Claude home at all still gets one usable personal seed', () => {
  const config = configFor(['Documents', '.bashrc']);
  assert.deepEqual(config.profiles.map((p) => p.id), ['personal']);
  assert.equal(config.profiles[0].configHome, path.join(HOME, '.claude'));
  assert.equal(config.profiles[0].isDefault, true, 'the schema requires exactly one default');
});

test('exactly one profile is default, and it is the primary home when present', () => {
  const withPrimary = configFor(['.claude', '.claude-team']);
  assert.deepEqual(withPrimary.profiles.filter((p) => p.isDefault).map((p) => p.id), ['personal']);

  const withoutPrimary = configFor(['.claude-team', '.claude-work']);
  assert.deepEqual(
    withoutPrimary.profiles.filter((p) => p.isDefault).map((p) => p.id),
    ['team'],
    'with no .claude present the first discovered home takes the default',
  );
});

test('badge letters are unique even when two homes start with the same letter', () => {
  const config = configFor(['.claude', '.claude-team', '.claude-test', '.claude-tin']);
  const letters = config.profiles.map((p) => p.letter);
  assert.equal(new Set(letters).size, letters.length, `letters must be distinct, got ${letters.join('')}`);
  assert.equal(letters[0], 'P', 'personal keeps P');
});

test('profile colours come from the palette, and personal is --per not the --ac accent', () => {
  const config = configFor(['.claude', '.claude-team', '.claude-lab']);
  const colors = config.profiles.map((p) => p.color.toLowerCase());
  assert.equal(colors[0], cssToken('per'), 'the first badge is --per');
  assert.equal(colors[1], cssToken('team'), 'the second badge is --team');
  assert.equal(colors[2], cssToken('plan3'), 'the third badge is the third palette slot');
  assert.notEqual(colors[0], cssToken('ac'), 'a second blue would read as the live-session accent');
});

test('NO workflow ships, because a workflow is a path into one specific checkout', () => {
  const config = configFor(['.claude', '.claude-team']);
  assert.deepEqual(config.workflows, [], 'shipping a default workflow ships somebody folder layout');
});

test('nothing in a migrated config points outside the running user home', () => {
  const config = configFor(['.claude', '.claude-team']);
  const foreign = [
    ...config.profiles.map((p) => p.configHome),
    ...config.workflows.map((w) => w.cwd).filter((cwd) => typeof cwd === 'string' && cwd.startsWith('/')),
    config.paths.projectsDir,
    config.paths.cacheDir,
    config.paths.delegateStateDir,
  ].filter((value) => !String(value).startsWith(HOME));
  assert.deepEqual(foreign, [], 'every derived path is under the running user home');
});

test('an unreadable home directory degrades to the personal seed instead of throwing', () => {
  const config = legacyConfig({
    homedir: HOME,
    platform: 'linux',
    env: { HOME, PATH: '' },
    readdir: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
  });
  assert.deepEqual(config.profiles.map((p) => p.id), ['personal']);
});

test('a migrated config is already set up, so an existing install never sees the wizard', () => {
  assert.equal(configFor(['.claude']).setup.completed, true);
});

test('migrated paths point at the real stores, derived from home', () => {
  const config = configFor(['.claude']);
  assert.equal(config.paths.projectsDir, path.join(HOME, '.claude', 'projects'));
  assert.equal(config.paths.cacheDir, path.join(HOME, '.cache', 'harbor'));
  assert.equal(config.paths.delegateStateDir, path.join(HOME, '.local', 'state', 'claude-delegate'));
  assert.equal(config.orchestration.researchCommand, '/orchestrate-research');
  assert.equal(config.orchestration.executionCommand, '/orchestrate-execution');
});

test('new-session defaults stay opus and xhigh, and the model stays an ALIAS', () => {
  const { newSessionDefaults } = configFor(['.claude']);
  assert.equal(newSessionDefaults.model, 'opus', 'an alias, never a pinned dated id');
  assert.equal(newSessionDefaults.effort, 'xhigh');
  assert.equal(newSessionDefaults.provider, 'claude');
});

test('the herdr socket is a unix path on linux and darwin, and refuses to guess on win32', () => {
  assert.equal(
    configFor(['.claude'], { platform: 'linux' }).platform.herdrSocket,
    path.join(HOME, '.config', 'herdr', 'herdr.sock'),
  );
  assert.equal(
    configFor(['.claude'], { platform: 'darwin' }).platform.herdrSocket,
    path.join(HOME, '.config', 'herdr', 'herdr.sock'),
  );
  assert.equal(
    configFor(['.claude'], { platform: 'win32' }).platform.herdrSocket,
    null,
    'the Windows named pipe name is unverified, so the wizard asks rather than seeding a dead socket',
  );
});

// AN EMPTY LAUNCHER IS A MISSING VALUE, NOT A CHOICE. `??=` fills only null and
// undefined, so a hand-edited `"launcher": ""` survived derivation and then threw
// out of createOrchestrationActions during app startup, taking the whole window
// with it over a view the user may have turned off. Caught while building a
// fixture config that set it blank.
test('a blank orchestration launcher derives to the shipped one', () => {
  const { deriveDefaults } = require('../../src/main/config/defaults.js');
  const shipped = path.resolve(REPO, '..', 'bin', 'ai');
  const runtime = { homedir: HOME, platform: 'linux', env: { HOME, PATH: '' }, findBinary: (n) => n, herdrSocket: () => '/s' };
  const profiles = [{
    id: 'personal', label: 'Personal', letter: 'P', color: '#6fa8d8',
    provider: 'claude', configHome: `${HOME}/.claude`, email: null, isDefault: true,
  }];
  for (const launcher of ['', null, undefined]) {
    const config = deriveDefaults({ profiles, orchestration: { enabled: false, launcher } }, runtime);
    assert.equal(config.orchestration.launcher, shipped, `${JSON.stringify(launcher)} must derive`);
  }
  // A launcher the user actually chose is left exactly alone.
  const custom = deriveDefaults({ profiles, orchestration: { enabled: true, launcher: '/opt/my-launcher' } }, runtime);
  assert.equal(custom.orchestration.launcher, '/opt/my-launcher');
});
