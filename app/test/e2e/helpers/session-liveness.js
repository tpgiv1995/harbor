'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A rail row can look dead (transcript quiet 15+ minutes) while its claude
// process is alive in an outside terminal; the window then flips to watch-only
// when the async process-alive probe lands, and a test that typed into it
// fails at whatever line the flip interrupts (live-caught 2026-07-20: the
// suite picked the exact session that was parked on a hook dialog in an
// outside terminal). The statusline context tee records the owning pid, so a
// candidate whose pid is still alive is not a drivable dead session.
function sessionProcessAlive(sessionId) {
  try {
    const teePath = path.join(os.homedir(), '.cache/harbor/context', `${sessionId}.json`);
    const tee = JSON.parse(fs.readFileSync(teePath, 'utf8'));
    if (!tee || tee.session_id !== sessionId || !tee.pid) return false;
    process.kill(tee.pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

module.exports = { sessionProcessAlive };
