'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { claudeConfigFile, preacceptFolderTrust } = require('../../../bin/harbor-bin.cjs');

// WHY THIS EXISTS. Harbor launches a session into a pty whose window may not be
// on screen yet, so Claude Code's per-folder "do you trust the files in this
// folder?" dialog is an invisible blocker on the one action the user just asked
// for. Pre-accepting it used to be done by `claude-go`, a bash wrapper that
// shipped with nothing, and that wrapper chose which config file to write into
// from its own FLAG rather than from the environment, so it wrote personal
// account trust into `$HOME/.claude.json` while Harbor had already pointed the
// child at `~/.claude`. Measured on the machine this was written on: the same
// folder read trusted in the file the session was not reading and untrusted in
// the one it was.
//
// The write is the only thing in bin/ that touches a config home, so most of
// what follows is about it refusing to do damage.

function box(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-trust-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  return { root, home, project };
}

function withEnv(overrides, run) {
  const saved = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const CLEAN = { HARBOR_NO_TRUST_PREACCEPT: undefined, HARBOR_E2E: undefined };

test('the trust marker lands in the config file the launched session will actually read', (t) => {
  const { home, project } = box(t);
  // With a config home, that home's own .claude.json. Without one, the CLI
  // falls back to $HOME/.claude.json, and so must this.
  assert.equal(claudeConfigFile('/some/home'), path.join('/some/home', '.claude.json'));
  assert.equal(claudeConfigFile(null), path.join(os.homedir(), '.claude.json'));

  const configHome = path.join(home, '.claude-work');
  fs.mkdirSync(configHome, { recursive: true });
  const file = path.join(configHome, '.claude.json');
  fs.writeFileSync(file, JSON.stringify({ oauthAccount: { emailAddress: 'you@example.com' }, projects: {} }));

  const wrote = withEnv(CLEAN, () => preacceptFolderTrust(configHome, project));
  assert.equal(wrote, true);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.projects[project].hasTrustDialogAccepted, true);
  // Everything else in a config file that is routinely 100KB survives.
  assert.equal(after.oauthAccount.emailAddress, 'you@example.com');
});

test('an already trusted folder is not rewritten', (t) => {
  const { home, project } = box(t);
  const configHome = path.join(home, '.claude');
  fs.mkdirSync(configHome, { recursive: true });
  const file = path.join(configHome, '.claude.json');
  fs.writeFileSync(file, JSON.stringify({ projects: { [project]: { hasTrustDialogAccepted: true } } }));
  const before = fs.statSync(file).mtimeMs;

  assert.equal(withEnv(CLEAN, () => preacceptFolderTrust(configHome, project)), false);
  assert.equal(fs.statSync(file).mtimeMs, before, 'the common case must not touch the file at all');
});

// A CONFIG THAT WILL NOT PARSE IS LEFT ALONE. A trust prompt is a far better
// outcome than a clobbered config, and this function has no way to know whether
// the garbage it is looking at is a half-written file or something it would
// destroy.
test('an unparseable config is left exactly as it was', (t) => {
  const { home, project } = box(t);
  const configHome = path.join(home, '.claude');
  fs.mkdirSync(configHome, { recursive: true });
  const file = path.join(configHome, '.claude.json');
  const garbage = '{ this is not json';
  fs.writeFileSync(file, garbage);

  assert.equal(withEnv(CLEAN, () => preacceptFolderTrust(configHome, project)), false);
  assert.equal(fs.readFileSync(file, 'utf8'), garbage);
  assert.deepEqual(
    fs.readdirSync(configHome).filter((name) => name.startsWith('.claude.json.')),
    [],
    'no temp file may be left behind either',
  );
});

test('a missing config file is created rather than refused', (t) => {
  const { home, project } = box(t);
  const configHome = path.join(home, '.claude-fresh');
  assert.equal(withEnv(CLEAN, () => preacceptFolderTrust(configHome, project)), true);
  const after = JSON.parse(fs.readFileSync(path.join(configHome, '.claude.json'), 'utf8'));
  assert.equal(after.projects[project].hasTrustDialogAccepted, true);
});

// TWO-SIDED ON PURPOSE. A refusal alone passes just as well if the write were
// dead everywhere, which is exactly how a guard rots: the case above proves the
// write happens, these prove each escape actually stops it. Four separate
// incidents in this repository were a drive reaching real user state through a
// channel nobody isolated, and this is the one thing in bin/ that edits a config
// home, so a suite that shells bin/ai for its argv must not be able to edit the
// developer's own account file as a side effect.
test('the write is refused under the harness marker and under its own opt out', (t) => {
  for (const escape of [{ HARBOR_E2E: '1' }, { HARBOR_NO_TRUST_PREACCEPT: '1' }]) {
    const { home, project } = box(t);
    const configHome = path.join(home, '.claude');
    fs.mkdirSync(configHome, { recursive: true });
    const file = path.join(configHome, '.claude.json');
    fs.writeFileSync(file, JSON.stringify({ projects: {} }));

    assert.equal(
      withEnv({ ...CLEAN, ...escape }, () => preacceptFolderTrust(configHome, project)),
      false,
      `${Object.keys(escape)[0]} must stop the write`,
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).projects, {});

    // And the same call, same fixture, with the escape removed, does write.
    assert.equal(withEnv(CLEAN, () => preacceptFolderTrust(configHome, project)), true);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).projects[project].hasTrustDialogAccepted, true);
  }
});

test('a relative or empty cwd is never turned into a projects key', (t) => {
  const { home } = box(t);
  const configHome = path.join(home, '.claude');
  fs.mkdirSync(configHome, { recursive: true });
  fs.writeFileSync(path.join(configHome, '.claude.json'), JSON.stringify({ projects: {} }));
  for (const cwd of ['', null, undefined, 'relative/path', '../escape']) {
    assert.equal(withEnv(CLEAN, () => preacceptFolderTrust(configHome, cwd)), false, `${cwd} must be refused`);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(configHome, '.claude.json'), 'utf8')).projects, {});
});

// CONCURRENT LAUNCHES MUST NOT LOSE EACH OTHER'S WRITES, and before the lock
// they did. Two sessions started on the same account at once (the rail's
// per-project buttons, a worker fleet, an orchestration batch) both read the
// same `.claude.json`, each added its own project, and the second rename threw
// the first away. Both calls returned success, so the launch that lost sat on
// the trust dialog inside a pty nobody was watching.
//
// Real processes, not a simulated interleaving: the failure was a race between
// two `bin/ai` invocations, so the proof has to be two of them.
test('two processes pre-accepting different folders at once keep both entries', async (t) => {
  const { home } = box(t);
  // A config home that does NOT exist yet, deliberately: that is the case the
  // lock had to be taught about (mkdir of the lock fails ENOENT rather than
  // EEXIST when its parent is missing, which used to drop both writers straight
  // through unlocked), and pre-creating it is how a spec can pass while leaving
  // the very first two concurrent launches into a fresh account racing.
  const configHome = path.join(home, 'nested', '.claude-brand-new');
  const file = path.join(configHome, '.claude.json');

  const runner = path.join(home, 'preaccept.js');
  fs.writeFileSync(runner, `
    const { preacceptFolderTrust } = require(${JSON.stringify(path.resolve(__dirname, '../../../bin/harbor-bin.cjs'))});
    const startAt = Number(process.argv[4]);
    while (Date.now() < startAt) { /* line both processes up on the same instant */ }
    process.stdout.write(String(preacceptFolderTrust(process.argv[2], process.argv[3])));
  `);

  const { spawn } = require('node:child_process');
  const startAt = Date.now() + 300;
  const folders = [path.join(home, 'projA'), path.join(home, 'projB')];
  const env = { ...process.env };
  delete env.HARBOR_E2E;
  delete env.HARBOR_NO_TRUST_PREACCEPT;
  await Promise.all(folders.map((folder) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, configHome, folder, String(startAt)], { env, stdio: 'ignore' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}`))));
    child.on('error', reject);
  })));

  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const folder of folders) {
    assert.equal(
      after.projects[folder]?.hasTrustDialogAccepted,
      true,
      `${folder} lost its trust entry to the other process`,
    );
  }
});

// A `.claude.json` that is a SYMLINK stays a symlink. Renaming over a link
// replaces the link and leaves the real file behind, stale and diverged, which
// silently breaks anybody sharing one config file across homes on purpose.
test('a symlinked config is written through, not replaced', (t) => {
  const { home, project } = box(t);
  const shared = path.join(home, 'shared-claude.json');
  fs.writeFileSync(shared, JSON.stringify({ projects: {}, marker: 'shared' }));
  const configHome = path.join(home, '.claude-linked');
  fs.mkdirSync(configHome, { recursive: true });
  const link = path.join(configHome, '.claude.json');
  fs.symlinkSync(shared, link);

  assert.equal(withEnv(CLEAN, () => preacceptFolderTrust(configHome, project)), true);
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link must survive the write');
  const target = JSON.parse(fs.readFileSync(shared, 'utf8'));
  assert.equal(target.projects[project].hasTrustDialogAccepted, true, 'the real file is what got written');
  assert.equal(target.marker, 'shared');
});

test('existing file permissions are preserved rather than forced', (t) => {
  const { home, project } = box(t);
  const configHome = path.join(home, '.claude-modes');
  fs.mkdirSync(configHome, { recursive: true });
  const file = path.join(configHome, '.claude.json');
  fs.writeFileSync(file, JSON.stringify({ projects: {} }), { mode: 0o644 });
  fs.chmodSync(file, 0o644);

  assert.equal(withEnv(CLEAN, () => preacceptFolderTrust(configHome, project)), true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
});
