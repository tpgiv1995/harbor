'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let verdict;

function canSymlink() {
  if (verdict !== undefined) return verdict;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-symlink-probe-'));
  try {
    fs.symlinkSync(dir, path.join(dir, 'probe'));
    verdict = true;
  } catch {
    verdict = false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return verdict;
}

module.exports = { canSymlink };
