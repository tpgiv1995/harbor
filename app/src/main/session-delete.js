'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Delete a session for good by moving its transcript into a recoverable trash
// folder rather than rm-ing it. Session ids are UUIDs (unique across project
// dirs), and ~/.claude-team/projects is a symlink to ~/.claude/projects, so one
// move covers both accounts. Refuses a live session: its Claude process is
// actively appending to that file. A missing transcript reports honestly rather
// than silently succeeding.
async function deleteSessionTranscript({
  sessionId,
  isLive = false,
  projectsDir = path.join(os.homedir(), '.claude', 'projects'),
  trashDir = path.join(os.homedir(), '.local', 'share', 'harbor', 'trash'),
  now = Date.now,
} = {}) {
  if (!sessionId || /[/\\]/.test(String(sessionId))) return { ok: false, reason: 'invalid session id' };
  if (isLive) return { ok: false, reason: 'session is live; stop it before deleting' };

  let src = null;
  try {
    for (const dir of await fs.readdir(projectsDir)) {
      const candidate = path.join(projectsDir, dir, `${sessionId}.jsonl`);
      if (fsSync.existsSync(candidate)) { src = candidate; break; }
    }
  } catch { /* projects dir unreadable */ }
  if (!src) return { ok: false, reason: 'transcript not found' };

  const dest = path.join(trashDir, `${now()}-${sessionId}.jsonl`);
  try {
    await fs.mkdir(trashDir, { recursive: true });
    try {
      await fs.rename(src, dest);
    } catch {
      // Different filesystem: copy then unlink.
      await fs.copyFile(src, dest);
      await fs.unlink(src);
    }
    return { ok: true, trashed: dest };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

module.exports = { deleteSessionTranscript };
