#!/usr/bin/env node
'use strict';

// Wrapper for the wizard drive. It exists so the drive can never be run
// unfenced: xvfb keeps the Electron window off the live desktop, and
// dbus-run-session gives it its own session bus so anything portal-backed
// (a file chooser, a notification) cannot reach the real desktop's portal.
// Scrubbing DISPLAY alone is NOT enough and believing it was cost ninety
// minutes of a GNOME file chooser stealing focus on the real desktop.

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const APP_ROOT = path.join(__dirname, '..', '..');
const DRIVE = path.join(__dirname, 'drive-wizard.mjs');

function has(command) {
  return spawnSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' }).status === 0;
}

const env = { ...process.env };
delete env.DISPLAY;
delete env.WAYLAND_DISPLAY;
delete env.DBUS_SESSION_BUS_ADDRESS;
delete env.DBUS_SESSION_BUS_PID;

const scenario = process.argv[2] || 'all';
let cmd = process.execPath;
let args = [DRIVE, scenario];
if (process.env.HARBOR_E2E_HEADED === '1') {
  // The one way to watch it on the real display, and deliberately opt-in.
  env.DISPLAY = process.env.DISPLAY;
} else {
  args = ['-a', process.execPath, DRIVE, scenario];
  cmd = 'xvfb-run';
  if (has('dbus-run-session')) {
    args = ['--', 'xvfb-run', ...args];
    cmd = 'dbus-run-session';
  } else {
    console.warn('[drive] dbus-run-session not found; running with the bus address cleared instead');
  }
}

const result = spawnSync(cmd, args, { cwd: APP_ROOT, stdio: 'inherit', env });
process.exit(result.status == null ? 1 : result.status);
