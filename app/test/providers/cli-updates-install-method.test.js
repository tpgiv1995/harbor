'use strict';

// The install METHOD decides the version read, the latest check and the
// upgrader (2026-10-15, the first macOS seat): a Homebrew cask codex must be
// upgraded with brew, never shadowed by a second npm copy, and a Mac's npm
// globals live under <prefix>/lib/node_modules, not <prefix>/node_modules.
// Everything is injected or synthetic: no brew, no npm, no network, no PATH.

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { realTmpDir } = require('../support/real-tmpdir.js');
const {
  createCliUpdateChecker,
  classifyInstall,
  describeInstall,
  npmModulesDir,
} = require('../../src/main/providers/cli-updates.js');

async function makeRoot(t) {
  const root = await fsp.mkdtemp(path.join(realTmpDir(), 'cli-install-method-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.mkdir(path.join(root, 'home'), { recursive: true });
  return root;
}

function fakeFetch({ claude = '2.1.301', codex = '0.160.1' } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    if (String(url).endsWith('@anthropic-ai/claude-code/latest')) return json({ version: claude });
    if (String(url).endsWith('@openai/codex/latest')) return json({ version: codex });
    if (String(url).includes('GetCliDownloadUrl')) return json({ version: '2026.09.02-c22c1a3' });
    return { ok: true, status: 200, json: async () => [], text: async () => '' };
  };
  impl.calls = calls;
  return impl;
}

const brewInfo = (version) => ({ stdout: JSON.stringify({ formulae: [], casks: [{ token: 'codex', version, installed: '0.160.0' }] }) });

test('npm globals live under <prefix>/node_modules on win32 and <prefix>/lib/node_modules elsewhere', () => {
  assert.equal(npmModulesDir('P', 'win32'), path.join('P', 'node_modules'));
  assert.equal(npmModulesDir('P', 'darwin'), path.join('P', 'lib', 'node_modules'));
  assert.equal(npmModulesDir('P', 'linux'), path.join('P', 'lib', 'node_modules'));
});

for (const platform of ['win32', 'darwin', 'linux']) {
  test(`${platform}: the installed npm version is read from that platform's layout`, async (t) => {
    const root = await makeRoot(t);
    const prefix = path.join(root, 'npm');
    const pkgDir = path.join(npmModulesDir(prefix, platform), '@anthropic-ai', 'claude-code');
    await fsp.mkdir(pkgDir, { recursive: true });
    await fsp.writeFile(path.join(pkgDir, 'package.json'), JSON.stringify({ version: '2.1.300' }));
    // A decoy in the OTHER layout must never be read.
    const other = platform === 'win32' ? 'darwin' : 'win32';
    const decoy = path.join(npmModulesDir(prefix, other), '@anthropic-ai', 'claude-code');
    await fsp.mkdir(decoy, { recursive: true });
    await fsp.writeFile(path.join(decoy, 'package.json'), JSON.stringify({ version: '1.0.0' }));
    const checker = createCliUpdateChecker({
      platform,
      homedir: () => path.join(root, 'home'),
      env: { HARBOR_NPM_PREFIX: prefix, LOCALAPPDATA: root },
      stateFile: path.join(root, 'state.json'),
      fetchImpl: () => assert.fail('reconcile used network'),
      execFile: async () => assert.fail('reading a version must not spawn'),
    });
    const state = await checker.state();
    assert.equal(state.providers.claude.installed, '2.1.300');
    assert.equal(state.providers.claude.install.method, 'npm');
  });
}

test('classifyInstall names each method from the resolved binary path', () => {
  // This Mac's codex: a Homebrew cask.
  assert.deepEqual(
    classifyInstall('codex', { bin: '/opt/homebrew/bin/codex', real: '/opt/homebrew/Caskroom/codex/0.160.0/bin/codex' }),
    { method: 'homebrew-cask', brewPrefix: '/opt/homebrew', token: 'codex', version: '0.160.0' },
  );
  // This Mac's claude: the npm package under Homebrew node's own prefix, which
  // is npm (not a brew formula) even though the path runs through Cellar.
  assert.deepEqual(
    classifyInstall('claude', {
      bin: '/opt/homebrew/bin/claude',
      real: '/opt/homebrew/Cellar/node/25.9.0_2/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe',
    }),
    { method: 'npm', prefix: '/opt/homebrew/Cellar/node/25.9.0_2', layout: 'posix', fromBin: true },
  );
  assert.deepEqual(
    classifyInstall('codex', { bin: '/opt/homebrew/bin/codex', real: '/opt/homebrew/Cellar/codex/0.160.0_1/bin/codex' }),
    { method: 'homebrew-formula', brewPrefix: '/opt/homebrew', formula: 'codex', version: '0.160.0' },
  );
  assert.deepEqual(
    classifyInstall('claude', { bin: '/Users/u/.local/bin/claude', real: '/Users/u/.local/share/claude/versions/2.1.301' }),
    { method: 'native', version: '2.1.301' },
  );
  assert.deepEqual(
    classifyInstall('claude', { bin: 'C:\\Users\\u\\.local\\bin\\claude.exe', real: 'C:\\Users\\u\\.local\\bin\\claude.exe' }),
    { method: 'native', version: null },
  );
  // A win32 npm shim is a plain file: nothing in its path proves npm (the
  // checker then looks for the package beside it).
  assert.deepEqual(classifyInstall('codex', { bin: 'C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd' }), { method: 'unknown' });
  assert.deepEqual(classifyInstall('codex', { bin: '/usr/local/bin/codex', real: '/opt/tools/codex' }), { method: 'unknown' });
});

test('describeInstall tells the chip what will run, or how to update when Harbor will not', () => {
  assert.equal(describeInstall('codex', { method: 'homebrew-cask', token: 'codex', brewPrefix: '/opt/homebrew' }).manual, false);
  assert.match(describeInstall('codex', { method: 'homebrew-cask', token: 'codex' }).hint, /brew upgrade --cask codex/);
  const native = describeInstall('claude', { method: 'native', bin: '/Users/u/.local/bin/claude' });
  assert.equal(native.manual, true);
  assert.match(native.hint, /claude update/);
  const unknown = describeInstall('codex', { method: 'unknown', real: '/opt/tools/codex' });
  assert.equal(unknown.manual, true);
  assert.match(unknown.hint, /will not install a second copy/);
});

function caskCodexChecker(root, { brewVersion = '0.160.1', versionAnswer, upgrade } = {}) {
  let caskVersion = '0.160.0';
  const calls = [];
  const brewPrefix = path.join(root, 'brew');
  const checker = createCliUpdateChecker({
    platform: 'darwin',
    homedir: () => path.join(root, 'home'),
    env: { LOCALAPPDATA: root },
    stateFile: path.join(root, 'state', 'cli-updates.json'),
    fetchImpl: fakeFetch(),
    now: () => new Date('2026-10-15T12:00:00.000Z'),
    resolveBin: async (id) => (id === 'codex'
      ? { bin: path.join(brewPrefix, 'bin', 'codex'), real: path.join(brewPrefix, 'Caskroom', 'codex', caskVersion, 'bin', 'codex') }
      : null),
    execFile: async (file, args, options) => {
      calls.push({ file, args, options });
      if (args[0] === 'info') return brewInfo(brewVersion);
      if (args[0] === 'upgrade') {
        if (upgrade) return upgrade();
        caskVersion = brewVersion;
        return { stdout: `==> Upgrading codex 0.160.0 -> ${brewVersion}\n`, stderr: '' };
      }
      if (args.at(-1) === '--version') {
        assert.equal(options.windowsHide, true);
        assert.ok(options.timeout > 0 && options.timeout <= 15000);
        return { stdout: versionAnswer ? versionAnswer(caskVersion) : `codex-cli ${caskVersion}\n` };
      }
      if (args.includes('prefix')) return { stdout: path.join(root, 'npm') };
      throw new Error(`unexpected spawn: ${file} ${args.join(' ')}`);
    },
  });
  return { checker, calls, brewPrefix };
}

test('a Homebrew cask codex reads its version off the Caskroom path and checks latest with brew info, never npm', async (t) => {
  const root = await makeRoot(t);
  const { checker, calls, brewPrefix } = caskCodexChecker(root);
  const state = await checker.check();
  const codex = state.providers.codex;
  assert.equal(codex.installed, '0.160.0');
  assert.equal(codex.latest, '0.160.1');
  assert.equal(codex.install.method, 'homebrew-cask');
  assert.equal(codex.install.manual, false);
  const info = calls.find((c) => c.args[0] === 'info');
  assert.equal(info.file, path.join(brewPrefix, 'bin', 'brew'), 'the brew that owns the cask, never PATH');
  assert.deepEqual(info.args, ['info', '--json=v2', '--cask', 'codex']);
  assert.equal(info.options.env.HOMEBREW_NO_AUTO_UPDATE, '1', 'a check must never become a brew update');
  assert.equal(info.options.windowsHide, true);
  assert.ok(info.options.timeout > 0);
});

test('Install on a Homebrew cask runs brew upgrade --cask, never npm, and verifies the relinked binary', async (t) => {
  const root = await makeRoot(t);
  const { checker, calls, brewPrefix } = caskCodexChecker(root);
  await checker.check();
  const result = await checker.install('codex', '0.160.1');
  assert.equal(result.ok, true, result.error || result.reason);
  assert.equal(result.installed, '0.160.1');
  assert.equal(calls.some((c) => c.args.includes('install') || c.args.some((a) => String(a).startsWith('@openai/codex'))), false, 'no second copy from npm');
  const upgrade = calls.find((c) => c.args[0] === 'upgrade');
  assert.equal(upgrade.file, path.join(brewPrefix, 'bin', 'brew'));
  assert.deepEqual(upgrade.args, ['upgrade', '--cask', 'codex']);
  assert.equal(upgrade.options.env.HOMEBREW_NO_AUTO_UPDATE, '1', 'the install cannot drift past the reviewed version');
  const probe = calls.find((c) => c.args.at(-1) === '--version');
  assert.equal(probe.file, path.join(brewPrefix, 'Caskroom', 'codex', '0.160.1', 'bin', 'codex'), 'probe the binary the upgrade linked');
  const entry = (await checker.state()).providers.codex.history[0];
  assert.equal(entry.ok, true);
  assert.equal(entry.to, '0.160.1');
  assert.ok(entry.snapshot, 'the config snapshot still precedes a brew upgrade');
});

test('a Homebrew upgrade whose binary does not answer the exact target is a FAILED install', async (t) => {
  const root = await makeRoot(t);
  const { checker } = caskCodexChecker(root, { versionAnswer: () => 'Native binary was not installed' });
  await checker.check();
  const result = await checker.install('codex', '0.160.1');
  assert.equal(result.ok, false);
  assert.match(result.error, /executable verification failed/);
});

test('Install refuses when brew would install a version other than the reviewed one', async (t) => {
  const root = await makeRoot(t);
  const { checker, calls } = caskCodexChecker(root);
  await checker.check();
  // The npm registry is ahead of brew's index; a click for that version must
  // not run brew, which cannot pin it.
  const result = await checker.install('codex', '0.161.0');
  assert.equal(result.ok, false);
  assert.match(result.reason, /Homebrew would install 0\.160\.1, not the reviewed 0\.161\.0/);
  assert.equal(calls.some((c) => c.args[0] === 'upgrade'), false);
  assert.deepEqual(await checker.listSnapshots('codex'), []);
});

test('a brew index behind upstream says so instead of offering a target brew cannot install', async (t) => {
  const root = await makeRoot(t);
  const { checker } = caskCodexChecker(root, { brewVersion: '0.160.0' });
  const state = await checker.check();
  assert.equal(state.providers.codex.latest, '0.160.0', 'the target is what brew can install');
  assert.equal(state.providers.codex.install.upstream, '0.160.1');
  assert.match(state.providers.codex.install.hint, /brew update/);
});

test('an npm claude under Homebrew node installs into the prefix its binary lives in, on the POSIX layout', async (t) => {
  const root = await makeRoot(t);
  const prefix = path.join(root, 'Cellar', 'node', '25.9.0_2');
  const pkgDir = path.join(prefix, 'lib', 'node_modules', '@anthropic-ai', 'claude-code');
  await fsp.mkdir(path.join(pkgDir, 'bin'), { recursive: true });
  const manifest = (version) => JSON.stringify({ version, bin: { claude: 'bin/claude.exe' } });
  await fsp.writeFile(path.join(pkgDir, 'package.json'), manifest('2.1.300'));
  const calls = [];
  const checker = createCliUpdateChecker({
    platform: 'darwin',
    homedir: () => path.join(root, 'home'),
    env: {},
    stateFile: path.join(root, 'state', 'cli-updates.json'),
    fetchImpl: fakeFetch(),
    resolveBin: async (id) => (id === 'claude'
      ? { bin: path.join(root, 'bin', 'claude'), real: path.join(pkgDir, 'bin', 'claude.exe') }
      : null),
    execFile: async (file, args, options) => {
      calls.push({ file, args, options });
      if (args.includes('install')) {
        await fsp.writeFile(path.join(pkgDir, 'package.json'), manifest('2.1.301'));
        return { stdout: 'changed 1 package\n' };
      }
      if (args.at(-1) === '--version') return { stdout: `${JSON.parse(await fsp.readFile(path.join(pkgDir, 'package.json'), 'utf8')).version} (Claude Code)\n` };
      if (args.includes('prefix')) return { stdout: path.join(root, 'other-npm') };
      throw new Error(`unexpected spawn: ${file} ${args.join(' ')}`);
    },
  });
  const state = await checker.check();
  assert.equal(state.providers.claude.installed, '2.1.300');
  assert.equal(state.providers.claude.install.method, 'npm');
  const result = await checker.install('claude', '2.1.301');
  assert.equal(result.ok, true, result.error || result.reason);
  const install = calls.find((c) => c.args.includes('install'));
  assert.deepEqual(install.args, ['install', '-g', '--prefix', prefix.replace(/\\/g, '/'), '@anthropic-ai/claude-code@2.1.301']);
  const probe = calls.find((c) => c.args.at(-1) === '--version');
  assert.equal(probe.file, path.join(pkgDir, 'bin', 'claude.exe'), 'verification runs the package bin, never PATH');
});

test('a native-installer claude is described with its own update command and never gets an npm copy', async (t) => {
  const root = await makeRoot(t);
  const calls = [];
  const checker = createCliUpdateChecker({
    platform: 'darwin',
    homedir: () => path.join(root, 'home'),
    env: {},
    stateFile: path.join(root, 'state', 'cli-updates.json'),
    fetchImpl: fakeFetch(),
    resolveBin: async (id) => (id === 'claude'
      ? { bin: path.join(root, 'home', '.local', 'bin', 'claude'), real: path.join(root, 'home', '.local', 'share', 'claude', 'versions', '2.1.300') }
      : null),
    execFile: async (file, args) => {
      calls.push({ file, args });
      if (args.includes('prefix')) return { stdout: path.join(root, 'npm') };
      throw new Error(`unexpected spawn: ${file} ${args.join(' ')}`);
    },
  });
  const state = await checker.check();
  assert.equal(state.providers.claude.installed, '2.1.300');
  assert.equal(state.providers.claude.latest, '2.1.301', 'the update is still announced');
  assert.equal(state.providers.claude.install.manual, true);
  const result = await checker.install('claude', '2.1.301');
  assert.equal(result.ok, false);
  assert.equal(result.manual, true);
  assert.match(result.reason, /claude update/);
  assert.equal(calls.some((c) => c.args.includes('install')), false, 'no npm install beside a native install');
  assert.deepEqual(await checker.listSnapshots('claude'), [], 'nothing ran, so nothing was snapshotted');
});

test('a win32 npm shim is recognised by the package beside it', async (t) => {
  const root = await makeRoot(t);
  const shimDir = path.join(root, 'Roaming', 'npm');
  const pkgDir = path.join(shimDir, 'node_modules', '@openai', 'codex');
  await fsp.mkdir(pkgDir, { recursive: true });
  await fsp.writeFile(path.join(pkgDir, 'package.json'), JSON.stringify({ version: '0.160.0' }));
  const checker = createCliUpdateChecker({
    platform: 'win32',
    homedir: () => path.join(root, 'home'),
    env: { LOCALAPPDATA: root },
    stateFile: path.join(root, 'state.json'),
    fetchImpl: () => assert.fail('no network on a local read'),
    resolveBin: async (id) => (id === 'codex' ? { bin: path.join(shimDir, 'codex.cmd'), real: path.join(shimDir, 'codex.cmd') } : null),
    execFile: async () => assert.fail('a local read must not spawn'),
  });
  const state = await checker.state();
  assert.equal(state.providers.codex.installed, '0.160.0');
  assert.equal(state.providers.codex.install.method, 'npm');
  assert.deepEqual(checker.installCommand('codex', '0.160.1').args, ['/c', 'npm', 'install', '-g', '--prefix', shimDir, '@openai/codex@0.160.1']);
});

// 2026-10-16 review finding 9: a Homebrew FORMULA that wraps the npm package
// (Cellar/codex/<v>/libexec/lib/node_modules/@openai/codex/...) read as npm with
// the keg's libexec as its prefix, and Install then ran `npm install -g
// --prefix <keg>` over Homebrew's own files. Brew paths win over the npm marker;
// only node's own keg (where `npm install -g` put the package) stays npm.
test('a Homebrew formula wrapping the npm package is Homebrew, never npm into the keg', () => {
  for (const brew of ['/opt/homebrew', '/usr/local', '/home/linuxbrew/.linuxbrew']) {
    assert.deepEqual(
      classifyInstall('codex', {
        bin: `${brew}/bin/codex`,
        real: `${brew}/Cellar/codex/0.1.2504/libexec/lib/node_modules/@openai/codex/bin/codex.js`,
      }),
      { method: 'homebrew-formula', brewPrefix: brew, formula: 'codex', version: '0.1.2504' },
    );
    assert.deepEqual(
      classifyInstall('claude', {
        bin: `${brew}/bin/claude`,
        real: `${brew}/Cellar/claude-code/2.1.300_1/libexec/lib/node_modules/@anthropic-ai/claude-code/cli.js`,
      }),
      { method: 'homebrew-formula', brewPrefix: brew, formula: 'claude-code', version: '2.1.300' },
    );
    assert.deepEqual(
      classifyInstall('codex', {
        bin: `${brew}/bin/codex`,
        real: `${brew}/Caskroom/codex/0.160.0/node_modules/@openai/codex/bin/codex.js`,
      }),
      { method: 'homebrew-cask', brewPrefix: brew, token: 'codex', version: '0.160.0' },
    );
  }
  // node's own keg, including a versioned node@22, is still npm's.
  assert.deepEqual(
    classifyInstall('codex', { real: '/opt/homebrew/Cellar/node@22/22.11.0/lib/node_modules/@openai/codex/bin/codex.js' }),
    { method: 'npm', prefix: '/opt/homebrew/Cellar/node@22/22.11.0', layout: 'posix', fromBin: true },
  );
});

test('Install on a Homebrew formula that wraps npm runs brew upgrade, never npm --prefix into the keg', async (t) => {
  const root = await makeRoot(t);
  const brewPrefix = path.join(root, 'brew');
  const keg = (v) => path.join(brewPrefix, 'Cellar', 'codex', v, 'libexec', 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  let kegVersion = '0.160.0';
  const calls = [];
  const checker = createCliUpdateChecker({
    platform: 'darwin',
    homedir: () => path.join(root, 'home'),
    env: {},
    stateFile: path.join(root, 'state', 'cli-updates.json'),
    fetchImpl: fakeFetch(),
    resolveBin: async (id) => (id === 'codex' ? { bin: path.join(brewPrefix, 'bin', 'codex'), real: keg(kegVersion) } : null),
    execFile: async (file, args) => {
      calls.push({ file, args });
      if (args[0] === 'info') return { stdout: JSON.stringify({ formulae: [{ name: 'codex', versions: { stable: '0.160.1' }, installed: [{ version: '0.160.0' }] }], casks: [] }) };
      if (args[0] === 'upgrade') { kegVersion = '0.160.1'; return { stdout: '' }; }
      if (args.at(-1) === '--version') return { stdout: `codex-cli ${kegVersion}\n` };
      if (args.includes('prefix')) return { stdout: path.join(root, 'npm') };
      throw new Error(`unexpected spawn: ${file} ${args.join(' ')}`);
    },
  });
  const state = await checker.check();
  assert.equal(state.providers.codex.install.method, 'homebrew-formula');
  assert.equal(state.providers.codex.installed, '0.160.0');
  assert.deepEqual(checker.installCommand('codex', '0.160.1'), { file: path.join(brewPrefix, 'bin', 'brew'), args: ['upgrade', 'codex'] });
  const result = await checker.install('codex', '0.160.1');
  assert.equal(result.ok, true, result.error || result.reason);
  assert.equal(calls.some((c) => c.args.includes('install') || c.args.includes('--prefix')), false, 'npm never writes into the Homebrew keg');
});

// 2026-10-16 review finding 8: the updater resolved the CLI from PATH alone
// while the launcher (bin/harbor-bin.cjs providerBin) runs the wizard-saved
// config.providers.<id>.bin. With an npm codex configured and a cask first on
// PATH, Install upgraded the cask and the copy Harbor launches never moved.
// These run the REAL resolveBin against real files and a synthetic PATH.
async function twoCodexes(root) {
  const exe = async (file, body = '#!/bin/sh\n') => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, body);
    await fsp.chmod(file, 0o755);
  };
  // The npm copy the wizard saved: <prefix>/bin/codex -> lib/node_modules/@openai/codex/bin/codex.js
  const npmPrefix = path.join(root, 'npm-global');
  const pkgDir = path.join(npmPrefix, 'lib', 'node_modules', '@openai', 'codex');
  await exe(path.join(pkgDir, 'bin', 'codex.js'));
  await fsp.writeFile(path.join(pkgDir, 'package.json'), JSON.stringify({ version: '0.150.0', bin: { codex: 'bin/codex.js' } }));
  await fsp.mkdir(path.join(npmPrefix, 'bin'), { recursive: true });
  await fsp.symlink(path.join(pkgDir, 'bin', 'codex.js'), path.join(npmPrefix, 'bin', 'codex'));
  // The cask PATH resolves first: <brew>/bin/codex -> Caskroom/codex/0.160.0/bin/codex
  const brew = path.join(root, 'brew');
  await exe(path.join(brew, 'Caskroom', 'codex', '0.160.0', 'bin', 'codex'));
  await fsp.mkdir(path.join(brew, 'bin'), { recursive: true });
  await fsp.symlink(path.join(brew, 'Caskroom', 'codex', '0.160.0', 'bin', 'codex'), path.join(brew, 'bin', 'codex'));
  // A third copy only the env pin names.
  const pinnedPrefix = path.join(root, 'pinned');
  const pinnedPkg = path.join(pinnedPrefix, 'lib', 'node_modules', '@openai', 'codex');
  await exe(path.join(pinnedPkg, 'bin', 'codex.js'));
  await fsp.writeFile(path.join(pinnedPkg, 'package.json'), JSON.stringify({ version: '0.140.0', bin: { codex: 'bin/codex.js' } }));
  await fsp.mkdir(path.join(pinnedPrefix, 'bin'), { recursive: true });
  await fsp.symlink(path.join(pinnedPkg, 'bin', 'codex.js'), path.join(pinnedPrefix, 'bin', 'codex'));
  return { npmPrefix, brew, pinnedPrefix };
}

function launchChecker(root, { env, configuredBin }) {
  const calls = [];
  const checker = createCliUpdateChecker({
    platform: 'darwin',
    homedir: () => path.join(root, 'home'),
    env,
    configuredBin,
    stateFile: path.join(root, 'state', 'cli-updates.json'),
    fetchImpl: () => assert.fail('a local read must not use the network'),
    execFile: async (file, args) => { calls.push({ file, args }); throw new Error(`unexpected spawn: ${file} ${args.join(' ')}`); },
  });
  return { checker, calls };
}

test('the updater inspects and upgrades the configured bin the launcher runs, not the PATH copy', { skip: process.platform === 'win32' && 'POSIX symlinks and exec bits' }, async (t) => {
  const root = await makeRoot(t);
  const { npmPrefix, brew } = await twoCodexes(root);
  const { checker, calls } = launchChecker(root, {
    env: { PATH: path.join(brew, 'bin') },
    configuredBin: (id) => (id === 'codex' ? `  ${path.join(npmPrefix, 'bin', 'codex')}  ` : undefined),
  });
  const state = await checker.state();
  assert.equal(state.providers.codex.install.method, 'npm', 'the cask on PATH is not what Harbor launches');
  assert.equal(state.providers.codex.installed, '0.150.0', 'the chip shows the launched copy');
  const command = checker.installCommand('codex', '0.160.1');
  assert.equal(command.file, 'npm');
  assert.deepEqual(command.args, ['install', '-g', '--prefix', npmPrefix, '@openai/codex@0.160.1']);
  assert.equal(command.args.includes('upgrade'), false);
  assert.equal(calls.some((c) => /brew$/.test(c.file) || c.args.includes('upgrade')), false, 'Homebrew is never asked about a copy Harbor does not launch');
});

test('the env pin outranks the configured bin, and with neither the PATH copy is used', { skip: process.platform === 'win32' && 'POSIX symlinks and exec bits' }, async (t) => {
  const root = await makeRoot(t);
  const { npmPrefix, brew, pinnedPrefix } = await twoCodexes(root);
  const pinned = launchChecker(root, {
    env: { PATH: path.join(brew, 'bin'), HARBOR_CODEX_BIN: path.join(pinnedPrefix, 'bin', 'codex') },
    configuredBin: (id) => (id === 'codex' ? path.join(npmPrefix, 'bin', 'codex') : null),
  });
  const pinnedState = await pinned.checker.state();
  assert.equal(pinnedState.providers.codex.installed, '0.140.0');
  assert.deepEqual(pinned.checker.installCommand('codex', '0.160.1').args, ['install', '-g', '--prefix', pinnedPrefix, '@openai/codex@0.160.1']);

  // A blank configured value (and a throwing reader) falls through to PATH, as providerBin does.
  for (const configuredBin of [() => '   ', () => { throw new Error('config unreadable'); }, undefined]) {
    const plain = launchChecker(root, { env: { PATH: path.join(brew, 'bin') }, configuredBin });
    const plainState = await plain.checker.state();
    assert.equal(plainState.providers.codex.install.method, 'homebrew-cask');
    assert.equal(plainState.providers.codex.installed, '0.160.0');
  }
});

// D5 (review 2026-10-15): on win32 npm runs through `cmd.exe /c`, and Node
// quotes an argument only when it holds a space, so a --prefix with a cmd.exe
// metacharacter (C:\Users\R&D\...) split into a second command. The shim
// fallback always set fromBin, so %APPDATA%\npm, npm's own default, was always
// passed. Synthetic win32 shapes only: the real cmd.exe path is not runnable here.
async function win32Shim(t, { appDataName = 'Roaming', shimParts = ['Roaming', 'npm'] } = {}) {
  const root = await makeRoot(t);
  const shimDir = path.join(root, ...shimParts);
  const pkgDir = path.join(shimDir, 'node_modules', '@openai', 'codex');
  await fsp.mkdir(pkgDir, { recursive: true });
  await fsp.writeFile(path.join(pkgDir, 'package.json'), JSON.stringify({ version: '0.160.0' }));
  const spawned = [];
  const checker = createCliUpdateChecker({
    platform: 'win32',
    homedir: () => path.join(root, 'home'),
    env: { LOCALAPPDATA: root, APPDATA: path.join(root, appDataName) },
    stateFile: path.join(root, 'state.json'),
    snapshotRoot: path.join(root, 'snapshots'),
    fetchImpl: fakeFetch(),
    resolveBin: async (id) => (id === 'codex' ? { bin: path.join(shimDir, 'codex.cmd'), real: path.join(shimDir, 'codex.cmd') } : null),
    execFile: async (file, args) => { spawned.push([file, ...args]); throw new Error('no spawning in this test'); },
  });
  await checker.state();
  return { checker, shimDir, spawned };
}

test('win32: npm\'s own default prefix (%APPDATA%\\npm) is not passed to cmd.exe', async (t) => {
  const { checker } = await win32Shim(t);
  assert.deepEqual(checker.installCommand('codex', '0.160.1').args, ['/c', 'npm', 'install', '-g', '@openai/codex@0.160.1']);
});

test('win32: a default prefix under a user folder with & is dropped, not passed', async (t) => {
  const { checker } = await win32Shim(t, { appDataName: 'R&D', shimParts: ['R&D', 'npm'] });
  const command = checker.installCommand('codex', '0.160.1');
  assert.equal(command.refused, undefined);
  assert.ok(!command.args.some((arg) => arg.includes('&')), 'the & path never reaches cmd.exe');
});

test('win32: any other prefix with a cmd.exe metacharacter refuses the install by name and spawns nothing', async (t) => {
  for (const name of ['R&D', 'a|b', 'x^y', 'p(1)', '100%', 'l<g>']) {
    const { checker, spawned } = await win32Shim(t, { shimParts: [name, 'npm'] });
    const command = checker.installCommand('codex', '0.160.1');
    assert.match(command.refused || '', /cmd\.exe treats as a command/, `refused for ${name}`);
    const result = await checker.install('codex', '0.160.1');
    assert.equal(result.ok, false);
    assert.match(result.reason, /will not run npm with the install folder/);
    assert.ok(!spawned.some((argv) => argv.includes('install')), `no npm install ran for ${name}`);
  }
});

test('win32: a non-default prefix without metacharacters is still passed', async (t) => {
  const { checker, shimDir } = await win32Shim(t, { shimParts: ['Tools', 'npm'] });
  assert.deepEqual(checker.installCommand('codex', '0.160.1').args, ['/c', 'npm', 'install', '-g', '--prefix', shimDir, '@openai/codex@0.160.1']);
});
