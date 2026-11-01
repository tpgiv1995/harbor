'use strict';

// Harbor never launches or resumes a session inside a workspace-pool slot (2026-11-01, stage 4).
// A slot is a REUSED checkout: the folder a session recorded may since hold another lane's branch,
// and a lane's launcher owns its slot (it seals the lane when its worker exits), so an
// interactive resume there would write into someone else's work or into a sealed review. Lanes
// come back through a worker launcher (--lane ... --resume), which takes the lane into its own
// slot. Reads the registry snapshot through lookup.cjs only: no lock, no subprocess, no pool
// implementation on the launch path, nothing at all when this machine has no pool. A pool whose
// snapshot cannot be read refuses anything shaped like a slot. Doctrine: docs/claude/lanes.md.

const lookup = require('./lookup.cjs');

const HOW = 'A coordinator continues it by relaunching the lane with a worker launcher (--lane <id> --lane-token <t> --lane-generation <g> --resume <session id>); see docs/claude/lanes.md.';

// A refusal message when `cwd` is inside a pool slot, else null. `session` and `configHome`
// (absolute) name a resume; without them the launch is a new session.
function poolSlotRefusal({ provider, configHome = null, session = null, cwd }, { env = process.env } = {}) {
  if (!cwd) return null;
  const registry = lookup.readRegistry(env);
  if (registry.status === 'absent') return null;
  if (registry.status === 'unreadable') {
    if (!lookup.looksLikeSlot(cwd)) return null;
    return `Harbor does not ${session ? 'resume this session' : 'start sessions'} in ${cwd}: it looks like a workspace-pool slot, and the pool's registry snapshot cannot be read (${registry.reason}), so Harbor cannot tell who owns it.`;
  }
  const { state } = registry;
  const hit = lookup.slotFor(state, cwd);
  if (!hit) return null;
  const where = `workspace-pool slot ${hit.slot.id} of ${hit.repo.id} (${hit.slot.path})`;
  if (!session) return `Harbor does not start sessions in ${where}: pool slots are reused checkouts that only lane launchers work in. Open the project's own folder (${hit.repo.canonical}) instead.`;
  const key = lookup.sessionKey({ provider, configHome, session });
  const binding = key ? state.sessions?.[key] || null : null;
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

// The lane currently holding the slot at `cwd` ({ lane, generation }), null when `cwd` is no
// slot, or undefined when the pool exists but its snapshot cannot be read.
function currentLaneAt(cwd, { env = process.env } = {}) {
  const registry = lookup.readRegistry(env);
  if (registry.status === 'absent') return null;
  if (registry.status === 'unreadable') return undefined;
  const hit = lookup.slotFor(registry.state, cwd);
  if (!hit) return null;
  return { lane: hit.slot.lane || null, generation: hit.slot.generation };
}

module.exports = { poolSlotRefusal, currentLaneAt };
