'use strict';

// The app menu offers a FULL restart (2026-10-15, Pat: "i dont have a restart
// option in the hamburger menu in top left but i do have reload"). Reload only
// refreshes the window, so a fix in Harbor's main process could not be picked
// up from inside the app at all; the restart action existed in main but only
// the update banner (window rebuilds) ever sent it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const menu = fs.readFileSync(path.join(__dirname, '../../src/renderer/AppMenu.jsx'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '../../src/main/index.js'), 'utf8');

test('the app menu offers Restart Harbor next to Reload', () => {
  assert.match(menu, /\{ id: 'reload', label: 'Reload'/);
  assert.match(menu, /\{ id: 'restart', label: 'Restart Harbor' \}/);
  assert.ok(menu.indexOf("id: 'restart'") > menu.indexOf("id: 'reload'"), 'restart sits under reload');
});

test('the restart action relaunches the whole app, not just the window', () => {
  const handler = main.slice(main.indexOf("ipcMain.on('window:menu-action'"));
  // The relaunch drops an inherited --no-focus-steal (2026-11-04): a restart Pat
  // asks for from the menu should come up like any launch he makes.
  assert.match(handler, /case 'restart': app\.relaunch\(\{ args: process\.argv\.slice\(1\)\.filter\(\(arg\) => arg !== '--no-focus-steal'\) \}\); app\.exit\(0\); break;/);
  assert.match(handler, /case 'reload':[\s\S]*?wc\.reload\(\);/);
});
