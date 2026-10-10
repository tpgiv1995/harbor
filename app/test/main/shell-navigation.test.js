'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { isShellNavigation, navigationReplacesPage } = require('../../src/main/shell-navigation.js');

// 2026-10-09: one click on a link in a conversation released the transcript
// reader of every open window, because did-start-navigation fires BEFORE
// will-navigate refuses the link, and the release took "a navigation started"
// to mean "the page is reloading". Every window froze on its last update.
const SHELL = 'file:///C:/dev/harbor/app/dist/index.html';
const DEV = 'http://127.0.0.1:5173/';
const mainFrame = (url, currentUrl = SHELL, extra = {}) => ({ url, currentUrl, isMainFrame: true, isSameDocument: false, ...extra });

test('a link clicked in a conversation does not replace the page', () => {
  assert.equal(isShellNavigation('https://www.dallascounty.org/courts', SHELL), false);
  assert.equal(navigationReplacesPage(mainFrame('https://www.dallascounty.org/courts')), false);
  assert.equal(navigationReplacesPage(mainFrame('https://example.com/x', DEV)), false);
});

test('a file dropped on the window does not replace the page', () => {
  assert.equal(navigationReplacesPage(mainFrame('file:///C:/Users/someone/Downloads/Details.pdf')), false);
  assert.equal(navigationReplacesPage(mainFrame('file:///C:/dev/harbor/app/dist/other.html')), false);
});

test('a reload of the app page replaces it, with or without a query', () => {
  assert.equal(navigationReplacesPage(mainFrame(SHELL)), true);
  assert.equal(navigationReplacesPage(mainFrame(`${SHELL}?window=main`)), true);
  assert.equal(navigationReplacesPage(mainFrame(DEV, DEV)), true);
});

test('same-document and subframe navigations never replace the page', () => {
  assert.equal(navigationReplacesPage(mainFrame(`${SHELL}#notes`, SHELL, { isSameDocument: true })), false);
  assert.equal(navigationReplacesPage(mainFrame(SHELL, SHELL, { isMainFrame: false })), false);
});

test('an unparseable or missing address is never the app page', () => {
  assert.equal(isShellNavigation('not a url', SHELL), false);
  assert.equal(isShellNavigation(SHELL, 'not a url'), false);
  // The very first load starts from an empty URL; nothing is open yet.
  assert.equal(isShellNavigation(SHELL, ''), false);
});

test('the main window guard and the transcript release both use the shared rule', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/main/index.js'), 'utf8');
  const release = source.slice(source.indexOf("on('did-start-navigation'"));
  assert.match(release.slice(0, 400), /navigationReplacesPage\(/, 'the release must ask whether the page is really being replaced');
  assert.match(source, /on\('will-navigate', \(event, url\) => \{\s*if \(isShellNavigation\(url, window\.webContents\.getURL\(\)\)\) return;/,
    'the main window guard must allow exactly what the shared rule calls the page');
  assert.doesNotMatch(source, /target\.origin === current\.origin/, 'no handler may keep its own copy of the rule');
});
