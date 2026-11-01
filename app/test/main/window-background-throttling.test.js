'use strict';
// The main window keeps drawing while minimized (2026-10-31): with background
// throttling on, a restored Harbor showed its bare background for 1.0 to 1.3 s.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('the main window turns background throttling off; the board window keeps the default', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/main/index.js'), 'utf8');
  const main = src.slice(src.indexOf('function createWindow()'));
  const prefs = main.slice(main.indexOf('webPreferences: {'), main.indexOf('mainWindow = window;'));
  assert.match(prefs, /\bbackgroundThrottling: false,/);
  const board = src.slice(src.indexOf("title: 'Harbor Board'"), src.indexOf('function createWindow()'));
  assert.doesNotMatch(board, /backgroundThrottling/);
});
