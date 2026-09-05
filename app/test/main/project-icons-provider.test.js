'use strict';

// The user icon directory: what it indexes, what it refuses to serve, and that a
// dropped file repaints without a restart.
//
// Every case runs against a throwaway directory named by HARBOR_PROJECT_ICONS_DIR,
// never the real userData one. The env override is checked BEFORE the composed
// config on purpose (the 2026-07-28 lesson), and spec 2 is the guard for that
// ordering: a relocated harness must not be able to read the real store just
// because config composition ran.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { realTmpDir } = require('../support/real-tmpdir.js');
const path = require('node:path');

const { createProjectIconProvider, resolveIconsDir } = require('../../src/main/providers/project-icons.js');

function tempDir() {
  return fs.mkdtempSync(path.join(realTmpDir(), 'harbor-icons-test-'));
}

function providerOn(dir, extra = {}) {
  return createProjectIconProvider({ env: { HARBOR_PROJECT_ICONS_DIR: dir }, ...extra });
}

// A 1x1 PNG, so the bytes served are a real image rather than a text file.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

test('the icons directory comes from the env override before the composed config', () => {
  const dir = resolveIconsDir({
    env: { HARBOR_PROJECT_ICONS_DIR: '/tmp/harness-icons' },
    configuredDir: '/home/someone/.config/harbor/project-icons',
  });
  assert.equal(dir, path.resolve('/tmp/harness-icons'));
});

test('a configured directory is used when no env override is set', () => {
  const dir = resolveIconsDir({ env: {}, configuredDir: '/somewhere/icons' });
  assert.equal(dir, path.resolve('/somewhere/icons'));
});

test('the directory defaults under userData, so it is never a repo path', () => {
  const dir = resolveIconsDir({ env: {}, app: { getPath: () => '/home/someone/.config/harbor' } });
  assert.equal(dir, path.join('/home/someone/.config/harbor', 'project-icons'));
});

test('a missing directory lists empty and is created so it is discoverable', async () => {
  const parent = tempDir();
  const dir = path.join(parent, 'project-icons');
  const provider = providerOn(dir);
  const listed = await provider.list();
  assert.deepEqual(listed.icons, {});
  assert.equal(listed.dir, dir);
  assert.ok(fs.existsSync(dir), 'the icons directory should have been created');
});

test('every image file becomes a slug, and the slug is its lowercased basename', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'harbor.png'), PNG);
  fs.writeFileSync(path.join(dir, 'team-tools.png'), PNG);
  fs.writeFileSync(path.join(dir, 'Data-Pipeline.PNG'), PNG);
  const { icons } = await providerOn(dir).list();
  assert.deepEqual(Object.keys(icons).sort(), ['data-pipeline', 'harbor', 'team-tools']);
});

test('the served URL carries the file mtime, so a replaced icon repaints', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'harbor.png');
  fs.writeFileSync(file, PNG);
  const first = (await providerOn(dir).list()).icons.harbor;
  assert.match(first, /^harbor-icon:\/\/local\/harbor\.png\?v=\d+$/);
  fs.utimesSync(file, new Date(1e9), new Date(2e9));
  const second = (await providerOn(dir).list()).icons.harbor;
  assert.notEqual(second, first, 'a new mtime must produce a new URL');
});

test('a slug owning two extensions resolves deterministically, png first', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'harbor.svg'), '<svg/>');
  fs.writeFileSync(path.join(dir, 'harbor.png'), PNG);
  fs.writeFileSync(path.join(dir, 'harbor.webp'), PNG);
  const provider = providerOn(dir);
  const { icons } = await provider.list();
  assert.match(icons.harbor, /harbor\.png/);
});

test('non-image files and directories are ignored', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello');
  fs.writeFileSync(path.join(dir, 'script.sh'), '#!/bin/sh');
  fs.mkdirSync(path.join(dir, 'harbor.png'), { recursive: true }); // a DIRECTORY named like an icon
  const { icons } = await providerOn(dir).list();
  assert.deepEqual(icons, {});
});

test('a filename that is not slug-shaped is not indexed', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, '.hidden.png'), PNG);
  fs.writeFileSync(path.join(dir, 'has space.png'), PNG);
  const { icons } = await providerOn(dir).list();
  assert.deepEqual(icons, {});
});

test('filePathFor answers only for an indexed file', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'harbor.png'), PNG);
  const provider = providerOn(dir);
  assert.equal(await provider.filePathFor('harbor.png'), path.join(dir, 'harbor.png'));
  assert.equal(await provider.filePathFor('never-added.png'), null);
});

test('filePathFor refuses every shape that could reach outside the directory', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'harbor.png'), PNG);
  // A real, readable file outside the icons directory: the thing a traversal
  // would be aiming at. If any of these resolved, it would be served.
  const outside = path.join(dir, '..', 'outside-secret.txt');
  fs.writeFileSync(outside, 'not yours');
  const provider = providerOn(dir);
  for (const hostile of [
    '../outside-secret.txt',
    '../../etc/passwd',
    '..\\outside-secret.txt',
    '/etc/passwd',
    path.join(dir, 'harbor.png'), // an absolute path, even to an indexed file
    './harbor.png',
    '',
    null,
    undefined,
    42,
  ]) {
    assert.equal(await provider.filePathFor(hostile), null, `${String(hostile)} must be refused`);
  }
});

test('mimeFor names the type from the extension and refuses an unknown one', () => {
  const provider = providerOn(tempDir());
  assert.equal(provider.mimeFor('harbor.png'), 'image/png');
  assert.equal(provider.mimeFor('harbor.SVG'), 'image/svg+xml');
  assert.equal(provider.mimeFor('harbor.jpeg'), 'image/jpeg');
  assert.equal(provider.mimeFor('harbor.exe'), null);
});

test('dropping an icon in publishes a fresh list without a restart', async () => {
  const dir = tempDir();
  const provider = providerOn(dir);
  await provider.list();
  const seen = [];
  const stop = provider.watch((payload) => seen.push(payload));
  fs.writeFileSync(path.join(dir, 'acme-reporting.png'), PNG);
  const deadline = Date.now() + 5000;
  while (seen.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  stop();
  assert.ok(seen.length > 0, 'the watcher should have published a change');
  assert.ok('acme-reporting' in seen[seen.length - 1].icons, 'the new icon should be in the list');
});
