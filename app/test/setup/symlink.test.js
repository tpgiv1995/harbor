'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const symlink = require('../../src/main/setup/symlink.js');

async function homes() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-setup-links-'));
  const primary = path.join(dir, '.claude');
  const target = path.join(dir, '.claude-team');
  await fsp.mkdir(path.join(primary, 'commands'), { recursive: true });
  await fsp.mkdir(path.join(primary, 'skills'), { recursive: true });
  await fsp.mkdir(path.join(primary, 'projects'), { recursive: true });
  await fsp.mkdir(target, { recursive: true });
  await fsp.writeFile(path.join(primary, 'CLAUDE.md'), '# shared\n');
  await fsp.writeFile(path.join(primary, 'settings.json'), '{}\n');
  // The two that must NEVER be linked exist in both homes, as they would in a
  // real multi-account install.
  await fsp.writeFile(path.join(primary, '.credentials.json'), '{"real":"primary"}');
  await fsp.writeFile(path.join(target, '.credentials.json'), '{"real":"target"}');
  await fsp.writeFile(path.join(primary, '.claude.json'), '{"oauthAccount":{"emailAddress":"a@x"}}');
  await fsp.writeFile(path.join(target, '.claude.json'), '{"oauthAccount":{"emailAddress":"b@x"}}');
  return { dir, primary, target };
}

test('the plan touches nothing and names every action before anything happens', async () => {
  const { dir, primary, target } = await homes();
  const before = (await fsp.readdir(target)).sort();

  const plan = await symlink.planShared({ primary, targets: [target] }, { platform: 'linux' });
  assert.equal(plan.source, primary);
  assert.equal(plan.style, 'symlink');
  const actions = Object.fromEntries(plan.homes[0].entries.map((entry) => [entry.name, entry.action]));
  assert.equal(actions['CLAUDE.md'], 'create');
  assert.equal(actions.commands, 'create');
  assert.equal(actions.projects, 'create');
  // settings.local.json is not in the source home, so there is nothing to share.
  assert.equal(actions['settings.local.json'], 'skip');

  assert.deepEqual((await fsp.readdir(target)).sort(), before, 'planning wrote nothing');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('THE SAFETY PROPERTY: credential files are refused, in the plan and at apply', async () => {
  const { dir, primary, target } = await homes();

  // Even when a caller explicitly asks for them.
  const forced = await symlink.planShared(
    { primary, targets: [target], entries: [{ name: '.credentials.json' }, { name: '.claude.json' }, { name: 'CLAUDE.md' }] },
    { platform: 'linux' },
  );
  const names = forced.homes[0].entries.map((entry) => entry.name);
  assert.deepEqual(names, ['CLAUDE.md'], 'the never-shared names are not even in the plan');

  // And a hand-built plan that names them is refused at apply time, because
  // this is the function that can do damage and it does not trust its input.
  const smuggled = {
    source: primary,
    platform: 'linux',
    homes: [{
      home: target,
      skipped: null,
      entries: [{
        name: '.credentials.json',
        kind: 'file',
        action: 'replace',
        source: path.join(primary, '.credentials.json'),
        target: path.join(target, '.credentials.json'),
      }],
    }],
  };
  const result = await symlink.applyShared(smuggled, { platform: 'linux' });
  assert.equal(result.results[0].applied, false);
  assert.equal(result.results[0].action, 'refuse');

  // The target's own credentials are byte-for-byte untouched: two accounts, two
  // logins, which is the whole point of the split.
  assert.equal(await fsp.readFile(path.join(target, '.credentials.json'), 'utf8'), '{"real":"target"}');
  assert.equal(await fsp.readFile(path.join(target, '.claude.json'), 'utf8'), '{"oauthAccount":{"emailAddress":"b@x"}}');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('applying links files and folders, and a second run is a no-op', async () => {
  const { dir, primary, target } = await homes();

  const plan = await symlink.planShared({ primary, targets: [target] }, { platform: 'linux' });
  const result = await symlink.applyShared(plan, { platform: 'linux' });
  assert.equal(result.ok, true, JSON.stringify(result.results.filter((entry) => entry.error)));

  assert.equal(await fsp.readFile(path.join(target, 'CLAUDE.md'), 'utf8'), '# shared\n');
  assert.ok((await fsp.lstat(path.join(target, 'commands'))).isSymbolicLink());
  assert.ok((await fsp.lstat(path.join(target, 'projects'))).isSymbolicLink());
  // Edits through the link land in the one real file.
  await fsp.writeFile(path.join(target, 'CLAUDE.md'), '# edited\n');
  assert.equal(await fsp.readFile(path.join(primary, 'CLAUDE.md'), 'utf8'), '# edited\n');

  const second = await symlink.planShared({ primary, targets: [target] }, { platform: 'linux' });
  const repeated = second.homes[0].entries.filter((entry) => entry.action === 'already-linked');
  // The five the fixture actually has: CLAUDE.md, settings.json, commands,
  // skills, projects. settings.local.json is absent, so it stays a skip.
  assert.equal(repeated.length, 5);
  assert.equal(
    second.homes[0].entries.find((entry) => entry.name === 'settings.local.json').action,
    'skip',
  );
  await fsp.rm(dir, { recursive: true, force: true });
});

test('an existing real file is BACKED UP, never deleted', async () => {
  const { dir, primary, target } = await homes();
  await fsp.writeFile(path.join(target, 'CLAUDE.md'), '# the user wrote this\n');

  const plan = await symlink.planShared({ primary, targets: [target] }, { platform: 'linux' });
  const entry = plan.homes[0].entries.find((item) => item.name === 'CLAUDE.md');
  assert.equal(entry.action, 'replace');
  assert.match(entry.reason, /renamed beside itself, never deleted/);

  const result = await symlink.applyShared(plan, { platform: 'linux' });
  const applied = result.results.find((item) => item.name === 'CLAUDE.md');
  assert.equal(applied.applied, true);
  assert.equal(await fsp.readFile(applied.backup, 'utf8'), '# the user wrote this\n');
  assert.equal(await fsp.readFile(path.join(target, 'CLAUDE.md'), 'utf8'), '# shared\n');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a second backup does not clobber the first', async () => {
  const { dir, primary, target } = await homes();
  await fsp.writeFile(path.join(target, 'CLAUDE.md'), '# first\n');
  await symlink.applyShared(
    await symlink.planShared({ primary, targets: [target] }, { platform: 'linux' }),
    { platform: 'linux' },
  );
  await fsp.unlink(path.join(target, 'CLAUDE.md'));
  await fsp.writeFile(path.join(target, 'CLAUDE.md'), '# second\n');

  const result = await symlink.applyShared(
    await symlink.planShared({ primary, targets: [target] }, { platform: 'linux' }),
    { platform: 'linux' },
  );
  const applied = result.results.find((item) => item.name === 'CLAUDE.md');
  assert.equal(await fsp.readFile(applied.backup, 'utf8'), '# second\n');
  assert.equal(await fsp.readFile(`${path.join(target, 'CLAUDE.md')}.harbor-backup`, 'utf8'), '# first\n');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('linking a home to itself is skipped rather than allowed to eat the source', async () => {
  const { dir, primary } = await homes();
  const plan = await symlink.planShared({ primary, targets: [primary] }, { platform: 'linux' });
  assert.equal(plan.homes[0].entries.length, 0);
  assert.match(plan.homes[0].skipped, /holds the real files/);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('Windows uses junctions for folders and says what it will do', async () => {
  const { dir, primary, target } = await homes();
  const plan = await symlink.planShared({ primary, targets: [target] }, { platform: 'win32' });
  assert.equal(plan.style, 'junction');
  assert.match(plan.note, /junctions, which need no special privileges/);
  assert.match(plan.note, /Developer Mode/);

  const calls = [];
  await symlink.linkOne(
    { kind: 'dir', source: 'S', target: 'T' },
    { platform: 'win32', symlink: async (...args) => calls.push(args), link: async () => {} },
  );
  assert.deepEqual(calls[0], ['S', 'T', 'junction']);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a Windows file symlink that hits EPERM falls back to a hard link and SAYS SO', async () => {
  // A hard link is not a symlink: an app that saves by replacing the file
  // breaks it silently, so the fallback is reported rather than hidden.
  const linked = [];
  const result = await symlink.linkOne(
    { kind: 'file', source: 'S', target: 'T' },
    {
      platform: 'win32',
      symlink: async () => { const error = new Error('denied'); error.code = 'EPERM'; throw error; },
      link: async (...args) => linked.push(args),
    },
  );
  assert.equal(result.mechanism, 'hardlink');
  assert.match(result.warning, /Developer Mode/);
  assert.match(result.warning, /silently break the link/);
  assert.deepEqual(linked[0], ['S', 'T']);
});

test('on Linux an EPERM is a real failure, not quietly hard-linked', async () => {
  await assert.rejects(
    () => symlink.linkOne(
      { kind: 'file', source: 'S', target: 'T' },
      {
        platform: 'linux',
        symlink: async () => { const error = new Error('denied'); error.code = 'EPERM'; throw error; },
        link: async () => { throw new Error('must not be reached on linux'); },
      },
    ),
    /denied/,
  );
});
