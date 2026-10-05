'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '../..');

test('taskbar badge crosses the context bridge over one typed IPC channel', () => {
  const preload = fs.readFileSync(path.join(APP, 'src/preload/index.js'), 'utf8');
  const main = fs.readFileSync(path.join(APP, 'src/main/index.js'), 'utf8');

  assert.match(preload, /badge:\s*\{\s*set:\s*\(payload\)\s*=>\s*ipcRenderer\.send\('taskbar-badge:set', payload\)/s);
  assert.match(main, /ipcMain\.on\('taskbar-badge:set',/);
  assert.match(main, /nativeImage\.createFromDataURL\(payload\.dataUrl\)/);
});

// 2026-10-04: on Windows app.setBadgeCount writes the same overlay slot as the badge, and notify
// set it to 0 whenever Harbor had focus, wiping the blue/amber badge every few seconds (filmed:
// overlay applied, setBadgeCount(0) erased it). The 09-29 "blink" was that wipe-and-resend cycle.
test('notify never touches the Windows overlay through app.setBadgeCount', () => {
  const main = fs.readFileSync(path.join(APP, 'src/main/index.js'), 'utf8');
  const fn = main.slice(main.indexOf('function setAppBadgeCount('), main.indexOf('app.setBadgeCount(count)'));
  assert.ok(fn.length > 0, 'setAppBadgeCount found');
  assert.match(fn, /if \(process\.platform === 'win32'\) return;/, 'win32 returns before app.setBadgeCount');
  assert.equal(main.match(/app\.setBadgeCount\(/g).length, 1, 'setAppBadgeCount is the only caller');
});

// And main applies every set the renderer sends (the renderer already sends only changes): a
// repeat guard here kept a reloaded renderer from healing an overlay something else had cleared.
test('main applies every badge the renderer sends', () => {
  const main = fs.readFileSync(path.join(APP, 'src/main/index.js'), 'utf8');
  const handler = main.slice(main.indexOf("ipcMain.on('taskbar-badge:set'"), main.indexOf("ipcMain.on('perf:stall'"));
  assert.doesNotMatch(handler, /__harborBadgeKey/, 'no per-window repeat guard');
});

test('the renderer sends the badge only through the scheduler', () => {
  const renderer = fs.readFileSync(path.join(APP, 'src/renderer/index.jsx'), 'utf8');
  assert.match(renderer, /createTaskbarBadgeScheduler\(/);
  assert.match(renderer, /updateTaskbarBadge\(planTaskbarBadge\(badgeCounts\(/);
  assert.doesNotMatch(renderer, /badge\?\.set\(renderTaskbarBadge\(/, 'no direct, undeduped set remains');
  // 2026-10-04: a timer re-armed on every recompute starved the badge while any window streamed.
  assert.doesNotMatch(renderer, /setTimeout\(\(\) => \{\s*(?:send|update)TaskbarBadge/, 'the effect does not arm its own timer');
});
