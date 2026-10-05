'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { registerSetupIpc } = require('../../src/main/setup/ipc.js');
const { launchLogin, PROVIDER_LOGIN } = require('../../src/main/setup/auth.js');

// 2026-09-19: a copyable command must execute in the shell named by the UI.
// Only these harmless stubs are on PATH; no vendor login can run here.
test('every offered Windows sign-in fallback runs in hidden PowerShell', { skip: process.platform !== 'win32', timeout: 180000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'harbor-manual-'));
  const binDir = path.join(root, "tools with space and 'quote");
  fs.mkdirSync(binDir);
  for (const spec of Object.values(PROVIDER_LOGIN)) {
    fs.writeFileSync(path.join(binDir, spec.defaultBin + '.cmd'),
      '@echo off\r\necho STUB:%~n0:%*\r\necho CLAUDE_HOME=%CLAUDE_CONFIG_DIR%\r\necho CODEX_HOME=%CODEX_HOME%\r\nexit /b 0\r\n');
  }
  const shell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const env = { ...process.env, PATH: binDir + path.delimiter + path.join(process.env.SystemRoot, 'System32'), PATHEXT: '.COM;.EXE;.BAT;.CMD', HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  const branches = ['unsafe binary', 'missing binary', 'approved missing binary', 'relative binary', 'unsafe resolved binary', 'unknown home', 'isolated profile', 'no terminal', 'spawn failure', 'login exception', 'absolute binary', 'extensionless binary'];
  try {
    for (const provider of Object.keys(PROVIDER_LOGIN)) {
      for (const homeName of ['home with spaces', "home's account"]) {
        for (const branch of branches) {
          await t.test(`${provider}: ${branch}: ${homeName}`, async (caseTest) => {
            const handlers = new Map();
            const home = path.join(root, homeName);
            const spec = PROVIDER_LOGIN[provider];
            const binary = path.join(binDir, spec.defaultBin + '.cmd');
            const missing = path.join(root, 'missing', spec.defaultBin + '.cmd');
            const payload = { provider, configHome: home, bin: spec.defaultBin };
            const deps = {
              ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
              getConfig: () => ({ setup: { executableApprovals: branch === 'approved missing binary' ? { [provider]: missing } : {} } }),
              saveConfig: async () => {}, homedir: () => root, platform: 'win32',
              detectEnvironment: async () => ({ claudeHomes: [], providers: {} }),
              launchPolicy: { allowed: false, reason: 'Isolated test profile' },
            };
            let code = 'LAUNCH_BLOCKED';
            if (branch === 'unsafe binary') { payload.bin = 'tool&invalid'; code = 'BIN_UNSAFE'; }
            if (branch.includes('missing binary')) { payload.bin = missing; code = 'BIN_NOT_FOUND'; }
            if (branch === 'relative binary') { payload.bin = 'relative/tool'; code = 'BIN_NOT_FOUND'; }
            if (branch === 'unsafe resolved binary') {
              payload.bin = binary;
              deps.executablePath = async () => path.join(root, 'unsafe&tool.cmd');
              code = 'BIN_UNSAFE';
            }
            if (branch === 'unknown home') { deps.homedir = () => path.join(root, 'different-user'); code = 'HOME_NOT_KNOWN'; }
            if (branch === 'no terminal' || branch === 'spawn failure') {
              deps.launchLogin = (id, options) => launchLogin(id, options, {
                platform: 'win32', launchPolicy: { allowed: true },
                ...(branch === 'no terminal' ? { terminalPlan: () => null } : {}),
                spawn: () => { throw new Error('Test terminal unavailable'); },
              });
              code = branch === 'no terminal' ? 'NO_TERMINAL' : 'SPAWN_FAILED';
            }
            if (branch === 'login exception') {
              deps.launchLogin = async () => { throw new Error('Test login exception'); };
              code = undefined;
            }
            if (branch === 'absolute binary') payload.bin = binary;
            if (branch === 'extensionless binary') payload.bin = binary.slice(0, -4);
            registerSetupIpc(deps);
            const result = await handlers.get('setup:login')({}, payload);
            assert.equal(result.launched, false);
            assert.equal(result.code, code);
            assert.ok(result.reason);
            assert.equal(typeof result.manualCommand, 'string');
            const script = path.join(root, 'displayed-command.ps1');
            fs.writeFileSync(script, "$ErrorActionPreference = 'Stop'\n" + result.manualCommand + '\nexit $LASTEXITCODE\n');
            const run = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { cwd: root, env, windowsHide: true, timeout: 10000, encoding: 'utf8' });
            let alive = false;
            try { process.kill(run.pid, 0); alive = true; } catch { /* exited */ }
            caseTest.diagnostic(JSON.stringify({ provider, branch, home, command: result.manualCommand, pid: run.pid, dead: !alive, status: run.status, stdout: run.stdout, stderr: run.stderr }));
            assert.equal(alive, false);
            assert.equal(run.status, 0, run.stderr);
            assert.ok(run.stdout.includes(`STUB:${spec.defaultBin}:${spec.args.join(' ')}`), run.stdout);
            if (provider !== 'cursor') assert.ok(run.stdout.includes(`${provider === 'claude' ? 'CLAUDE_HOME' : 'CODEX_HOME'}=${home}`), run.stdout);
          });
        }
      }
    }
    for (const provider of Object.keys(PROVIDER_LOGIN)) {
      await t.test(`${provider}: a nonlocal home offers no command to execute`, async () => {
        const handlers = new Map();
        registerSetupIpc({ ipcMain: { handle: (key, fn) => handlers.set(key, fn) }, getConfig: () => ({}), saveConfig: async () => {}, homedir: () => root, detectEnvironment: async () => ({}), launchLogin: () => { throw new Error('must not launch'); } });
        const result = await handlers.get('setup:login')({}, { provider, configHome: '//example.invalid/share' });
        assert.equal(result.code, 'HOME_NOT_LOCAL');
        assert.equal(result.manualCommand, null);
      });
    }
  } finally {
    // root is the exact directory returned by mkdtemp under the resolved temp.
    fs.rmSync(root, { recursive: true, force: true });
  }
});
