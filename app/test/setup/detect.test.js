'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const detect = require('../../src/main/setup/detect.js');

async function scratch() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-setup-detect-'));
}

test('a config home reports the account email read back from .claude.json', async () => {
  const dir = await scratch();
  const home = path.join(dir, '.claude');
  await fsp.mkdir(home, { recursive: true });
  await fsp.writeFile(
    path.join(home, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'someone@example.com' }, mcpServers: { secret: {} } }),
  );

  const result = await detect.readClaudeHome(home, fsp.readFile);
  assert.equal(result.exists, true);
  assert.equal(result.authed, true);
  assert.equal(result.email, 'someone@example.com');
  // Confirmation, not extraction: nothing else from that file comes back.
  assert.deepEqual(Object.keys(result).sort(), ['authed', 'email', 'exists', 'path', 'reason']);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('every not-signed-in shape is reported as itself, never as a guess', async () => {
  const dir = await scratch();

  const missing = await detect.readClaudeHome(path.join(dir, 'nope'), fsp.readFile);
  assert.equal(missing.exists, false);
  assert.equal(missing.email, null);
  assert.match(missing.reason, /does not exist/);

  const bare = path.join(dir, 'bare');
  await fsp.mkdir(bare);
  const noJson = await detect.readClaudeHome(bare, fsp.readFile);
  assert.equal(noJson.exists, true);
  assert.equal(noJson.authed, false);
  assert.match(noJson.reason, /has not run here yet/);

  const broken = path.join(dir, 'broken');
  await fsp.mkdir(broken);
  await fsp.writeFile(path.join(broken, '.claude.json'), '{ not json');
  const badJson = await detect.readClaudeHome(broken, fsp.readFile);
  assert.equal(badJson.authed, false);
  assert.match(badJson.reason, /not readable JSON/);

  // An API-key home is legitimately signed in with no oauthAccount. Saying
  // "not signed in" there would be a confident wrong answer.
  const apiKey = path.join(dir, 'apikey');
  await fsp.mkdir(apiKey);
  await fsp.writeFile(path.join(apiKey, '.claude.json'), JSON.stringify({ projects: {} }));
  const keyed = await detect.readClaudeHome(apiKey, fsp.readFile);
  assert.equal(keyed.email, null);
  assert.match(keyed.reason, /API key/);

  await fsp.rm(dir, { recursive: true, force: true });
});

test('detection only OFFERS config homes that exist', async () => {
  const dir = await scratch();
  await fsp.mkdir(path.join(dir, '.claude'), { recursive: true });
  await fsp.writeFile(path.join(dir, '.claude', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'x@y.z' } }));

  const detected = await detect.detectEnvironment({
    env: { PATH: '' },
    homedir: dir,
    platform: 'linux',
    probeVersion: false,
  });
  // Three candidates are checked; only the one on disk is offered, because
  // listing two empty paths is exactly the plausible-looking guess this
  // module refuses to make.
  assert.equal(detected.claudeHomes.length, 1);
  assert.equal(detected.claudeHomes[0].email, 'x@y.z');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a config home suggests the id the rest of the app already uses', () => {
  // `.claude` is the PERSONAL home by convention across bin/ and the rail, so
  // the literal folder name "claude" would be the wrong id to seed.
  assert.equal(detect.homeId('/home/tester/.claude'), 'personal');
  assert.equal(detect.homeId('/home/tester/.claude-team'), 'team');
  assert.equal(detect.homeId('/home/tester/.claude-lab'), 'lab');
});

test('all three platforms are supported and each picks its own link style', async () => {
  const dir = await scratch();
  for (const [platform, style, label] of [
    ['linux', 'symlink', 'Linux'],
    ['darwin', 'symlink', 'macOS'],
    ['win32', 'junction', 'Windows'],
  ]) {
    const detected = await detect.detectEnvironment({
      env: { PATH: '' }, homedir: dir, platform, probeVersion: false,
    });
    assert.equal(detected.os, platform);
    assert.equal(detected.osLabel, label);
    assert.equal(detected.symlinkStyle, style, `${platform} link style`);
  }
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a binary is found on PATH by its real executable bit, not by name alone', {
  skip: process.platform === 'win32' && 'NTFS has no executable permission bit; Windows uses PATHEXT',
}, async () => {
  const dir = await scratch();
  const bin = path.join(dir, 'bin');
  await fsp.mkdir(bin);
  const notExecutable = path.join(bin, 'sample-tool');
  await fsp.writeFile(notExecutable, '#!/bin/sh\n');
  await fsp.chmod(notExecutable, 0o644);

  const options = { env: { PATH: bin }, platformName: 'linux' };
  assert.equal(await detect.findOnPath('sample-tool', options), null, 'a non-executable file is not a binary');

  await fsp.chmod(notExecutable, 0o755);
  assert.equal(await detect.findOnPath('sample-tool', options), notExecutable);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('the command catalogue comes from the user’s real config home', async () => {
  const dir = await scratch();
  const home = path.join(dir, '.claude');
  await fsp.mkdir(path.join(home, 'commands'), { recursive: true });
  await fsp.mkdir(path.join(home, 'skills', 'my-skill'), { recursive: true });
  await fsp.writeFile(
    path.join(home, 'commands', 'deploy.md'),
    '---\ndescription: Ship it\n---\nbody\n',
  );
  await fsp.writeFile(
    path.join(home, 'skills', 'my-skill', 'SKILL.md'),
    '---\ndescription: Does a thing\n---\n',
  );

  const catalog = await detect.detectCatalog([home], {});
  const names = catalog.commands.map((command) => command.name);
  assert.ok(names.includes('/deploy'), 'the user’s own command is offered');
  assert.ok(names.includes('/my-skill'), 'the user’s own skill is offered');
  const deploy = catalog.commands.find((command) => command.name === '/deploy');
  assert.equal(deploy.description, 'Ship it');
  assert.equal(deploy.source, 'user');
  await fsp.rm(dir, { recursive: true, force: true });
});

// -- Gemini (Google's Antigravity CLI, `agy`), 2026-11-23 ------------------------------------------------

test('Gemini is found through the shared resolver, with the home it keeps its state under', async () => {
  const dir = await scratch();
  const calls = [];
  const geminiResolver = async (args) => { calls.push(args); return { bin: path.join(dir, 'agy-install', 'agy.exe'), agyHome: null }; };
  await fsp.mkdir(path.join(dir, '.gemini', 'antigravity-cli'), { recursive: true });
  const detected = await detect.detectEnvironment({
    env: { PATH: '' }, homedir: dir, platform: 'win32', geminiResolver,
  });
  assert.equal(detected.providers.gemini.found, true);
  assert.equal(detected.providers.gemini.path, path.join(dir, 'agy-install', 'agy.exe'));
  assert.equal(detected.providers.gemini.source, 'resolver');
  assert.equal(detected.providers.gemini.home, dir, 'the user’s own profile, where agy keeps .gemini');
  // The resolver is asked about THIS machine (the injected one), never the real one.
  assert.deepEqual(calls, [{ env: { PATH: '' }, home: dir, platform: 'win32' }]);
  // The sign-in is the CLI's own: no email is read or claimed.
  assert.equal(detected.providers.gemini.email, null);
  assert.match(detected.providers.gemini.emailReason, /signs in through Google in its own CLI/);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('Gemini is found on PATH when the resolver knows nothing, and reported absent when neither does', async () => {
  const dir = await scratch();
  const bin = path.join(dir, 'bin');
  await fsp.mkdir(bin);
  await fsp.writeFile(path.join(bin, 'agy.cmd'), '@echo off\r\n');
  const found = await detect.detectEnvironment({
    env: { PATH: bin, PATHEXT: '.CMD' }, homedir: dir, platform: 'win32', geminiResolver: async () => null,
  });
  assert.equal(found.providers.gemini.found, true);
  assert.equal(found.providers.gemini.path.toLowerCase(), path.join(bin, 'agy.cmd').toLowerCase());
  assert.equal(found.providers.gemini.source, 'PATH');
  assert.equal(found.providers.gemini.home, null, 'no .gemini folder yet: reported as absent, not assumed');

  const absent = await detect.detectEnvironment({
    env: { PATH: '' }, homedir: dir, platform: 'win32', geminiResolver: async () => null,
  });
  assert.equal(absent.providers.gemini.found, false);
  assert.equal(absent.providers.gemini.path, null);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a resolver that throws costs Gemini, never the whole detection', async () => {
  const dir = await scratch();
  const detected = await detect.detectEnvironment({
    env: { PATH: '' }, homedir: dir, platform: 'linux',
    geminiResolver: async () => { throw new Error('resolver exploded'); },
  });
  assert.equal(detected.providers.gemini.found, false);
  assert.ok(detected.providers.claude, 'the other providers are still reported');
  assert.ok('codex' in detected.providers && 'cursor' in detected.providers);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a named agy home (HARBOR_AGY_HOME through the resolver) is where Gemini’s state is looked for', async () => {
  const dir = await scratch();
  const root = path.join(dir, 'agy-root');
  await fsp.mkdir(path.join(root, '.gemini', 'antigravity-cli'), { recursive: true });
  const detected = await detect.detectEnvironment({
    env: { PATH: '' }, homedir: dir, platform: 'win32',
    geminiResolver: async () => ({ bin: path.join(dir, 'agy.exe'), agyHome: root }),
  });
  assert.equal(detected.providers.gemini.home, root);
  await fsp.rm(dir, { recursive: true, force: true });
});
