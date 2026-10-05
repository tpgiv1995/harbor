'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createConfigStore } = require('../../src/main/config/store.js');

async function sandbox() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'harbor-config-store-'));
}

const runtime = {
  homedir: '/home/tester',
  platform: 'linux',
  env: { PATH: '/usr/bin', SHELL: '/bin/bash' },
  findBinary: (name) => `/usr/bin/${name}`,
};

test('an existing empty config boots with complete runtime-derived defaults', async () => {
  const root = await sandbox();
  const file = path.join(root, 'config.json');
  await fs.writeFile(file, '{}');
  const store = createConfigStore({ file, runtime });

  const config = await store.load();

  assert.equal(config.platform.os, 'linux');
  assert.equal(config.platform.shell, '/bin/bash');
  assert.equal(config.profiles[0].configHome, path.join('/home/tester', '.claude'));
  assert.equal(config.paths.projectsDir, path.join('/home/tester', '.claude', 'projects'));
  assert.equal(config.paths.cacheDir, path.join('/home/tester', '.cache', 'harbor'));
  assert.equal(config.paths.delegateStateDir, path.join('/home/tester', '.local', 'state', 'claude-delegate'));
  assert.equal(config.paths.binDir, path.join('/home/tester', '.local', 'bin'));
});

// A CORRUPT CONFIG IS QUARANTINED, NEVER SILENTLY REPLACED.
//
// "Logs loudly and falls back" was the old bar and it is not enough, because
// what happens next is the damage: `setup.completed` reverts to false, the
// wizard opens looking like a first run, and the first Finish writes over the
// unreadable file with no copy taken. So a hand-edit typo cost the user every
// profile, workflow and path they had, and the only notice was a console.error
// nobody sees in a packaged app. The Tasks store already did this correctly
// (`tasks.json.corrupt-<ts>`); this is the same rule for the same reason.
test('a corrupt config is copied aside, logged, and falls back without crashing', async () => {
  const root = await sandbox();
  const file = path.join(root, 'config.json');
  await fs.writeFile(file, '{broken');
  const errors = [];
  const store = createConfigStore({
    file,
    runtime,
    logger: { error: (...args) => errors.push(args.join(' ')) },
  });

  const config = await store.load();

  assert.equal(config.profiles[0].id, 'personal');
  assert.equal(config.platform.shell, '/bin/bash');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /config/i);

  const backup = store.corruptBackup();
  assert.ok(backup, 'the unreadable file must be copied aside, not just complained about');
  assert.match(path.basename(backup), /^config\.json\.corrupt-\d+$/);
  assert.equal(await fs.readFile(backup, 'utf8'), '{broken', 'byte for byte, so nothing is lost');
  assert.match(errors[0], /corrupt-/, 'and the log has to say where it went');

  // The original is left exactly as it was until something deliberately writes.
  assert.equal(await fs.readFile(file, 'utf8'), '{broken');
});

// Two-sided: a readable config must not leave a stray backup lying around every
// launch. A quarantine that always fires is just litter with a scary name.
test('a readable config is never copied aside', async () => {
  const root = await sandbox();
  const file = path.join(root, 'config.json');
  await fs.writeFile(file, JSON.stringify({ version: 1 }));
  const store = createConfigStore({ file, runtime, logger: { error: () => {} } });
  await store.load();
  assert.equal(store.corruptBackup(), null);
  const strays = (await fs.readdir(root)).filter((name) => name.includes('.corrupt-'));
  assert.deepEqual(strays, []);
});

test('explicit save persists, updates the read-mostly snapshot, and emits change', async () => {
  const root = await sandbox();
  const file = path.join(root, 'nested', 'config.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '{}');
  const store = createConfigStore({ file, runtime });
  const initial = await store.load();
  const changed = new Promise((resolve) => store.once('change', resolve));
  const next = { ...initial, setup: { ...initial.setup, completed: true } };

  await store.save(next);

  assert.equal((await changed).setup.completed, true);
  assert.equal(store.get().setup.completed, true);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).setup.completed, true);
});

test('HARBOR_CONFIG_FILE overrides the Electron userData path', () => {
  const store = createConfigStore({
    env: { HARBOR_CONFIG_FILE: '/tmp/harbor-test-config.json' },
    app: { getPath: () => '/must/not/be/used' },
    runtime,
  });
  assert.equal(store.file, path.resolve('/tmp/harbor-test-config.json'));
});

// The failure that produces a quarantine copy is usually PERSISTENT: a file with
// the wrong permissions, or a typo nobody has fixed, makes every single launch
// take another one. Unbounded, that is litter dressed as evidence sitting in the
// user's config directory. The newest few are what anybody would look at.
test('repeated unreadable loads keep only the newest few copies', async () => {
  const root = await sandbox();
  const file = path.join(root, 'config.json');
  await fs.writeFile(file, '{still broken');

  for (let launch = 0; launch < 6; launch += 1) {
    const store = createConfigStore({ file, runtime, logger: { error: () => {} } });
    await store.load();
    // Distinct timestamps, since the name carries one.
    await new Promise((resolve) => setTimeout(resolve, 3));
  }

  const backups = (await fs.readdir(root)).filter((name) => name.includes('.corrupt-')).sort();
  assert.equal(backups.length, 3, `expected 3 kept copies, got ${backups.join(', ')}`);
  // The ones kept are the NEWEST, and each still holds the original bytes.
  for (const name of backups) {
    assert.equal(await fs.readFile(path.join(root, name), 'utf8'), '{still broken');
  }
  assert.equal(await fs.readFile(file, 'utf8'), '{still broken', 'the original is never consumed');
});
