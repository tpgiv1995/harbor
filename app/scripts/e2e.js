#!/usr/bin/env node
'use strict';

// E2E verification runner (ARCHITECTURE-v2 section 4, MISSION-9).
// Runs notify unit tests, then Playwright Electron suite TWICE consecutively.
// ALWAYS runs under xvfb: test windows must never open on the live desktop
// (they steal focus from whatever the user is doing). Set HARBOR_E2E_HEADED=1
// to deliberately watch a run on the real display.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const APP_ROOT = path.join(__dirname, '..');
const E2E_DIR = path.join(APP_ROOT, 'test', 'e2e');
const VERIFY_DIR = path.join(APP_ROOT, 'verify', 'e2e');
const CONFIG = path.join(E2E_DIR, 'playwright.config.js');

function run(cmd, args, opts = {}) {
  const env = { ...process.env, ...opts.env };
  if (opts.scrubDisplay) {
    delete env.DISPLAY;
    delete env.WAYLAND_DISPLAY;
    // Scrubbing the DISPLAY is not enough, and believing it was cost Pat
    // ninety minutes of a GNOME file chooser stealing focus on his real
    // desktop (2026-07-26). Electron does not draw file dialogs itself: it
    // calls org.freedesktop.portal.FileChooser over the SESSION BUS, where
    // xdg-desktop-portal-gnome activates Nautilus and draws it on the real
    // session. xvfb isolates X11 and nothing else, so the bus has to go too.
    // dbus-run-session below gives the suite its own bus; dropping the address
    // here means that even if that is unavailable, a portal call finds no bus
    // to reach rather than the live one.
    delete env.DBUS_SESSION_BUS_ADDRESS;
    delete env.DBUS_SESSION_BUS_PID;
  }
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd || APP_ROOT,
    stdio: 'inherit',
    env,
  });
  return res.status == null ? 1 : res.status;
}

function playwrightCmd() {
  const bin = path.join(APP_ROOT, 'node_modules', '.bin', 'playwright');
  const args = ['test', '-c', CONFIG];
  if (process.env.HARBOR_E2E_HEADED === '1') {
    return { cmd: bin, args, scrubDisplay: false };
  }
  // Scrub the session displays so nothing (including Wayland-aware Electron)
  // can reach the live desktop; xvfb-run provides its own DISPLAY. The suite
  // also gets its OWN session bus, so a portal-backed dialog (file chooser,
  // notifications, screenshot) can never reach the real desktop's portal.
  // The isolation guard in main/isolation.js is the floor; this is the fence.
  const inner = ['-a', bin, ...args];
  if (hasDbusRunSession()) {
    return { cmd: 'dbus-run-session', args: ['--', 'xvfb-run', ...inner], scrubDisplay: true };
  }
  console.warn('[e2e] dbus-run-session not found; running with the session bus address cleared instead');
  return { cmd: 'xvfb-run', args: inner, scrubDisplay: true };
}

function hasDbusRunSession() {
  return spawnSync('sh', ['-c', 'command -v dbus-run-session'], { stdio: 'ignore' }).status === 0;
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
    return { passed, failed, json };
  }
  console.log('(no results.json found)');
  return { passed: 0, failed: 0, json: null };
}

function main() {
  fs.mkdirSync(VERIFY_DIR, { recursive: true });

  console.log('building renderer...');
  const buildCode = run('npm', ['run', 'build'], { cwd: APP_ROOT });
  if (buildCode !== 0) process.exit(buildCode);

  console.log('running notifications unit tests...');
  const notifyCode = run(process.execPath, ['--test', path.join(APP_ROOT, 'test/main/notify.test.js')]);
  if (notifyCode !== 0) process.exit(notifyCode);

  const { cmd, args, scrubDisplay } = playwrightCmd();
  const resultsPath = path.join(E2E_DIR, 'results.json');

  console.log(`\nE2E run 1 (${cmd} ${args.join(' ')})`);
  const run1 = run(cmd, args, { scrubDisplay });
  const summary1 = summarizeRun('RUN 1 SUMMARY', resultsPath);

  console.log(`\nE2E run 2 (${cmd} ${args.join(' ')})`);
  const run2 = run(cmd, args, { scrubDisplay });
  const summary2 = summarizeRun('RUN 2 SUMMARY', resultsPath);

  const logPath = path.join(VERIFY_DIR, 'e2e-run-log.txt');
  const logBody = [
    `run1_exit=${run1}`,
    `run2_exit=${run2}`,
    `run1_passed=${summary1.passed}`,
    `run1_failed=${summary1.failed}`,
    `run2_passed=${summary2.passed}`,
    `run2_failed=${summary2.failed}`,
    `display=${process.env.DISPLAY || ''}`,
    `wayland=${process.env.WAYLAND_DISPLAY || ''}`,
    `finished=${new Date().toISOString()}`,
  ].join('\n');
  fs.writeFileSync(logPath, `${logBody}\n`);

  if (run1 !== 0 || run2 !== 0) {
    console.error('\nE2E verification FAILED: two consecutive green runs required.');
    process.exit(1);
  }

  console.log('\nE2E verification PASSED: two consecutive green runs.');

  console.log('\nRunning mobile E2E gate...');
  const mobileCode = run('node', [path.join(__dirname, 'e2e-mobile.js')], { scrubDisplay: true });
  if (mobileCode !== 0) {
    console.error('\nMobile E2E gate FAILED.');
    process.exit(mobileCode);
  }
}

main();
