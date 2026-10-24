'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { realTmpDir } = require('../support/real-tmpdir.js');
const { createCliUpdateChecker } = require('../../src/main/providers/cli-updates.js');

for (const provider of ['claude', 'codex']) {
  for (const sameVersion of [false, true]) {
    for (const outcome of ['missing', 'placeholder', 'wrong-version', 'timeout', 'valid']) {
      test(`${provider} executable verification: ${sameVersion ? 'retry' : 'upgrade'} ${outcome}`, async (t) => {
        const root = await fs.mkdtemp(path.join(realTmpDir(), 'cli-executable-'));
        t.after(() => fs.rm(root, { recursive: true, force: true }));
        const pkg = provider === 'claude' ? '@anthropic-ai/claude-code' : '@openai/codex';
        const dir = path.join(root, 'npm', 'node_modules', pkg);
        const bin = provider === 'claude' ? 'bin/claude.exe' : 'bin/codex.js';
        await fs.mkdir(dir, { recursive: true });
        const manifest = (version) => JSON.stringify({ version, bin: { [provider]: bin } });
        await fs.writeFile(path.join(dir, 'package.json'), manifest(sameVersion ? '9.8.7' : '9.8.6'));
        const calls = [];
        const checker = createCliUpdateChecker({
          homedir: () => path.join(root, 'home'),
          env: { HARBOR_NPM_PREFIX: path.join(root, 'npm'), LOCALAPPDATA: root },
          stateFile: path.join(root, 'state.json'),
          execFile: async (file, args, options) => {
            calls.push({ file, args, options });
            if (args.includes('install')) {
              await fs.writeFile(path.join(dir, 'package.json'), manifest('9.8.7'));
              return { stdout: 'installed' };
            }
            assert.equal(args.at(-1), '--version');
            assert.equal(options.windowsHide, true);
            assert.ok(options.timeout > 0 && options.timeout <= 15000);
            assert.equal(options.shell, undefined);
            assert.ok([file, ...args].includes(path.join(dir, bin)), 'probe the installed package, never PATH');
            if (outcome === 'missing' || outcome === 'timeout') throw new Error(outcome);
            if (outcome === 'placeholder') return { stdout: 'Native binary was not installed' };
            const version = outcome === 'wrong-version' ? '9.8.6' : '9.8.7';
            return { stdout: provider === 'claude' ? `${version} (Claude Code)\n` : `codex-cli ${version}\n` };
          },
        });
        const result = await checker.install(provider, '9.8.7');
        assert.equal(result.ok, outcome === 'valid');
        assert.ok(calls.some(c => c.args.includes('--version')), 'package metadata alone is not executable proof');
        if (outcome !== 'valid') {
          assert.match(result.error || result.reason, /executable/i);
          assert.equal((await checker.state()).providers[provider].history[0].ok, false);
        }
      });
    }
  }
}

// A JS bin entry (codex.js) run under Electron's own binary had no console, so
// the native codex.exe it starts opened a NEW, VISIBLE console window at the
// end of every Codex install (2026-10-24, ConsoleSentinel: codex.exe <-
// electron.exe codex.js --version <- Harbor). Under Electron the probe takes a
// real node from PATH, whose hidden console the child inherits; with no node
// on PATH it falls back to Electron as Node.
for (const nodeOnPath of [true, false]) {
  test(`codex executable verification under Electron ${nodeOnPath ? 'runs a real node from PATH' : 'falls back to Electron as Node'}`, async (t) => {
    const root = await fs.mkdtemp(path.join(realTmpDir(), 'cli-executable-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const dir = path.join(root, 'npm', 'node_modules', '@openai/codex');
    await fs.mkdir(dir, { recursive: true });
    const manifest = (version) => JSON.stringify({ version, bin: { codex: 'bin/codex.js' } });
    await fs.writeFile(path.join(dir, 'package.json'), manifest('9.8.6'));
    const nodeDir = path.join(root, 'nodebin');
    const exe = process.platform === 'win32' ? 'node.exe' : 'node';
    const electron = path.join(root, 'electron', process.platform === 'win32' ? 'electron.exe' : 'electron');
    const probes = [];
    const checker = createCliUpdateChecker({
      homedir: () => path.join(root, 'home'),
      env: { HARBOR_NPM_PREFIX: path.join(root, 'npm'), LOCALAPPDATA: root, PATH: [path.join(root, 'empty'), nodeDir].join(path.delimiter) },
      stateFile: path.join(root, 'state.json'),
      execPath: electron,
      isFile: (file) => nodeOnPath && file === path.join(nodeDir, exe),
      execFile: async (file, args, options) => {
        if (args.includes('install')) {
          await fs.writeFile(path.join(dir, 'package.json'), manifest('9.8.7'));
          return { stdout: 'installed' };
        }
        probes.push({ file, args, options });
        return { stdout: 'codex-cli 9.8.7\n' };
      },
    });
    const result = await checker.install('codex', '9.8.7');
    assert.equal(result.ok, true);
    assert.equal(probes.length, 1);
    const [probe] = probes;
    assert.deepEqual(probe.args, [path.join(dir, 'bin/codex.js'), '--version']);
    assert.equal(probe.options.windowsHide, true);
    if (nodeOnPath) {
      assert.equal(probe.file, path.join(nodeDir, exe));
      assert.equal(probe.options.env.ELECTRON_RUN_AS_NODE, undefined);
    } else {
      assert.equal(probe.file, electron);
      assert.equal(probe.options.env.ELECTRON_RUN_AS_NODE, '1');
    }
  });
}
