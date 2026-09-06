#!/usr/bin/env node
'use strict';

// Mobile / harbor-server security E2E gate (MOBILE-9).
// Runs the Playwright suite against harbor-server TWICE consecutively under
// xvfb with an isolated session bus, same posture as scripts/e2e.js.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { SCREEN } = require('../test/support/mobile-viewport.cjs');

const APP_ROOT = path.join(__dirname, '..');
const E2E_DIR = path.join(APP_ROOT, 'test', 'e2e');
const VERIFY_DIR = path.join(APP_ROOT, 'verify', 'e2e');
const CONFIG = path.join(E2E_DIR, 'mobile.playwright.config.js');

function run(cmd, args, opts = {}) {
  const env = { ...process.env, ...opts.env };
  if (opts.scrubDisplay) {
    delete env.DISPLAY;
    delete env.WAYLAND_DISPLAY;
    delete env.DBUS_SESSION_BUS_ADDRESS;
    delete env.DBUS_SESSION_BUS_PID;
  }
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd || APP_ROOT,
    stdio: 'inherit',
    env,
    shell: Boolean(opts.shell),
  });
  return res.status == null ? 1 : res.status;
}

function playwrightCmd() {
  const bin = path.join(APP_ROOT, 'node_modules', '.bin', 'playwright');
  // On Windows Playwright's own CLI is playwright.CMD; Node can still run the
  // JS entry via npx/node. Prefer the platform-native shim.
  const binWin = path.join(APP_ROOT, 'node_modules', '.bin', 'playwright.CMD');
  const playwrightBin = process.platform === 'win32' && fs.existsSync(binWin) ? binWin : bin;
  const args = ['test', '-c', CONFIG];
  if (process.env.HARBOR_E2E_HEADED === '1') {
    return { cmd: playwrightBin, args, scrubDisplay: false, shell: process.platform === 'win32' };
  }
  // Windows: headless Chromium, no xvfb. A visible browser window on this box
  // is a stop-the-line (Pat plays OSRS fullscreen; there is no focus guard).
  if (process.platform === 'win32') {
    return { cmd: playwrightBin, args, scrubDisplay: false, shell: true };
  }
  // Ubuntu 26.04 can load the host NVIDIA EGL shim into Xvfb and crash before
  // Electron starts. This gate needs only software-rendered X11, so disable GLX.
  // The screen must hold the WIDEST and TALLEST case at once. It was pinned to
  // 430x932, the portrait device size, so a landscape viewport (932 wide) had
  // nowhere to go: the browser clamps silently and every measurement taken
  // after that is fiction rather than a failure.
  const inner = ['-a', '-s', `-screen 0 ${SCREEN.width}x${SCREEN.height}x24 -extension GLX`, playwrightBin, ...args];
  if (spawnSync('sh', ['-c', 'command -v dbus-run-session'], { stdio: 'ignore' }).status === 0) {
    return { cmd: 'dbus-run-session', args: ['--', 'xvfb-run', ...inner], scrubDisplay: true };
  }
  console.warn('[e2e-mobile] dbus-run-session not found; running with the session bus address cleared instead');
  return { cmd: 'xvfb-run', args: inner, scrubDisplay: true };
}

function collectSpecs(suites, acc = []) {
  for (const suite of suites || []) {
    if (suite.specs?.length) acc.push(...suite.specs);
    if (suite.suites?.length) collectSpecs(suite.suites, acc);
  }
  return acc;
}

function summarizeRun(label, stdoutPath) {
  console.log(`\n========== ${label} ==========`);
  if (fs.existsSync(stdoutPath)) {
    const json = JSON.parse(fs.readFileSync(stdoutPath, 'utf8'));
    const specs = collectSpecs(json.suites);
    const passed = specs.filter((spec) => spec.ok).length;
    const failed = specs.filter((spec) => !spec.ok).length;
    console.log(`passed: ${passed}, failed: ${failed}`);
    for (const spec of specs) {
      const mark = spec.ok ? 'ok' : 'FAIL';
      console.log(`  [${mark}] ${spec.title}`);
    }
    return { passed, failed };
  }
  console.log('(no mobile-results.json found)');
  return { passed: 0, failed: 0 };
}

function main() {
  fs.mkdirSync(VERIFY_DIR, { recursive: true });

  console.log('building mobile web client...');
  const buildCode = run('npm', ['run', 'build:web'], { cwd: APP_ROOT });
  if (buildCode !== 0) process.exit(buildCode);

  const { cmd, args, scrubDisplay, shell } = playwrightCmd();
  const resultsPath = path.join(E2E_DIR, 'mobile-results.json');

  console.log(`\nMobile E2E run 1 (${cmd} ${args.join(' ')})`);
  const run1 = run(cmd, args, { scrubDisplay, shell, env: { HARBOR_E2E_RUN: '1' } });
  const summary1 = summarizeRun('MOBILE RUN 1 SUMMARY', resultsPath);

  console.log(`\nMobile E2E run 2 (${cmd} ${args.join(' ')})`);
  const run2 = run(cmd, args, { scrubDisplay, shell, env: { HARBOR_E2E_RUN: '2' } });
  const summary2 = summarizeRun('MOBILE RUN 2 SUMMARY', resultsPath);

  const logPath = path.join(VERIFY_DIR, 'e2e-mobile-run-log.txt');
  fs.writeFileSync(logPath, [
    `run1_exit=${run1}`,
    `run2_exit=${run2}`,
    `run1_passed=${summary1.passed}`,
    `run1_failed=${summary1.failed}`,
    `run2_passed=${summary2.passed}`,
    `run2_failed=${summary2.failed}`,
    `finished=${new Date().toISOString()}`,
  ].join('\n') + '\n');

  if (run1 !== 0 || run2 !== 0) {
    console.error('\nMobile E2E verification FAILED: two consecutive green runs required.');
    process.exit(1);
  }

  console.log('\nMobile E2E verification PASSED: two consecutive green runs.');
}

main();
