'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { realTmpDir } = require('./real-tmpdir.js');
function testSendLog(t) {
  const dir = fs.mkdtempSync(path.join(realTmpDir(), 'harbor-send-log-'));
  t.after(async () => {
    // Diagnostics are deliberately fire-and-forget. Let their queued writes
    // finish before this fixture removes the directory it alone owns.
    await new Promise(resolve => setTimeout(resolve, 100));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return path.join(dir, 'send-log.jsonl');
}
module.exports = { testSendLog };
