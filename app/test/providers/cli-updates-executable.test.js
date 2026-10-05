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
