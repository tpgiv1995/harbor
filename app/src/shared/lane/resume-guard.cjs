'use strict';

// Harbor never launches or resumes a session inside a workspace-pool slot (2026-11-01, stage 4).
// A slot is a REUSED checkout: the folder a session recorded may since hold another lane's branch,
// and a lane's launcher owns its slot (it seals the lane when its worker exits), so an
// interactive resume there would write into someone else's work or into a sealed review. Lanes
// come back through a worker launcher (--lane ... --resume), which takes the lane into its own
// slot. Reads the pool's registry snapshot only: no lock, no subprocess, nothing at all when this
// machine has no pool. Doctrine: docs/claude/lanes.md.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('./pool.cjs');

const HOW = 'A coordinator continues it by relaunching the lane with a worker launcher (--lane <id> --lane-token <t> --lane-generation <g> --resume <session id>); see docs/claude/lanes.md.';

function stateDir(env) {
  return env.HARBOR_LANES_DIR || path.join(env.USERPROFILE || os.homedir(), '.harbor', 'lanes');
}

function pathKey(p) {
  let resolved = path.resolve(p);
  try { resolved = fs.realpathSync.native(resolved); } catch { /* a missing folder keeps its resolved spelling */ }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// The slot holding `cwd`, from the registry snapshot, or null.
function slotFor(state, cwd) {
  const target = pathKey(cwd);
  for (const repo of Object.values(state?.repos || {})) {
    for (const slot of repo.slots || []) {
      const p = pathKey(slot.path);
      if (target === p || target.startsWith(p + path.sep)) return { repo, slot };
    }
  }
  return null;
}

// A refusal message when `cwd` is inside a registered pool slot, else null. `session` and
// `configHome` (absolute) name a resume; without them the launch is a new session.
function poolSlotRefusal({ provider, configHome = null, session = null, cwd }, { env = process.env } = {}) {
  if (!cwd) return null;
  let state;
  try { state = JSON.parse(fs.readFileSync(path.join(stateDir(env), 'registry.json'), 'utf8')); } catch { return null; }
  const hit = slotFor(state, cwd);
  if (!hit) return null;
  const where = `workspace-pool slot ${hit.slot.id} of ${hit.repo.id} (${hit.slot.path})`;
  if (!session) return `Harbor does not start sessions in ${where}: pool slots are reused checkouts that only lane launchers work in. Open the project's own folder (${hit.repo.canonical}) instead.`;
  let binding = null;
  if (configHome && path.isAbsolute(configHome)) {
    try { binding = state.sessions?.[Pool.prototype.sessionKey.call(null, { provider, configHome, session })] || null; } catch { binding = null; }
  }
  const readable = 'Its conversation stays readable in Harbor.';
  if (!binding) return `Harbor does not resume this session: it ran in ${where} without a lane record, so Harbor cannot tell whether that folder still holds its work. ${readable} ${HOW}`;
  const lane = state.lanes?.[binding.lane];
  if (!lane) return `Harbor does not resume this session: its lane ${binding.lane} is no longer registered in the pool. ${readable}`;
  if (hit.slot.lane !== lane.id) {
    const now = hit.slot.lane ? `now holds lane ${hit.slot.lane}, another task's checkout` : 'has been released for the next lane';
    return `Harbor does not resume this session: it belongs to lane ${lane.id}, and ${where} ${now}. ${readable} ${HOW}`;
  }
  return `Harbor does not resume this session: it belongs to lane ${lane.id}, which is ${lane.state}${lane.reason ? ` (${lane.reason})` : ''} in ${where}, and that lane's launcher owns the slot. ${readable} ${HOW}`;
}

module.exports = { poolSlotRefusal, slotFor };
