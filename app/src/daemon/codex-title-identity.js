'use strict';
const path = require('node:path');
const os = require('node:os');
const CODEX_IDENTITY_PIN = 'tui.terminal_title=["thread-id"]';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIX_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{5}\.\.\.$/i;
const codexHomeFromEnv = (env = {}) => env.CODEX_HOME || path.join(env.USERPROFILE || env.HOME || os.homedir(), '.codex');
const titlePrefix = title => UUID_RE.test(title || '') ? title.toLowerCase()
  : PREFIX_RE.test(title || '') ? title.slice(0, -3).toLowerCase() : null;

// A title sensor, never an identity resolver. No filesystem, database, process
// query, timer or per-output callback belongs here. Main's linker classifies
// the thread and requests annotation; the keeper only persists this prefix.
function createCodexTitleIdentity({ agent, argv = [], onTitle, isAlive = () => true } = {}) {
  const enabled = agent === 'codex' && argv.includes('--no-daemon') && argv.includes(CODEX_IDENTITY_PIN);
  let previous;
  const observe = title => {
    if (!enabled || !isAlive()) return;
    const prefix = titlePrefix(title);
    if (prefix === null && previous) return; // transient overlays must not erase a known prefix
    if (prefix === previous) return;
    previous = prefix;
    onTitle(prefix);
  };
  observe.enabled = enabled;
  return observe;
}
// Title events may arrive several times in one terminal parse. The keeper
// updates its in-memory guard immediately, then persists the final state once
// on the next turn. There is no polling or terminal.onData callback here.
function coalesceTitleWrites(persist, schedule = setImmediate) {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    schedule(() => { queued = false; persist(); });
  };
}
module.exports = { CODEX_IDENTITY_PIN, createCodexTitleIdentity, codexHomeFromEnv, titlePrefix, coalesceTitleWrites };
