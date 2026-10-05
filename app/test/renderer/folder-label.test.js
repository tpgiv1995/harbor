'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { folderLabel } = require('../../src/renderer/folder-label.cjs');

for (const [input, expected] of [
  ['C:\\', 'C:/'],
  ['D:/', 'D:/'],
  ['\\\\server\\share\\project', '//server/share/project'],
  ['//server/share/team/project/', '//server/share/team/project'],
  ['\\\\server\\share\\', '//server/share'],
  ['project', 'project'],
  ['C:\\dev\\project\\', 'dev/project'],
  ['/home/fixture/project/', 'fixture/project'],
  ['/', '/'],
  ['', ''],
]) {
  test(`folder label ${JSON.stringify(input)} preserves its useful identity`, () => {
    assert.equal(folderLabel(input), expected);
  });
}
