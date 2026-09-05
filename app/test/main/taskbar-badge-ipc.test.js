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
