'use strict';

// Which pid, if any, this daemon's life is tied to.
//
// A daemon spawned by a test harness outlives an aborted run forever: its
// suite's teardown is correct and none of it runs when the runner dies. 28
// orphans were found on 2026-08-08, three interrupted `npm test` runs deep,
// the second pile of this shape (daemon.js's shutdown comment records the
// first). The floor lives here rather than in each suite, same philosophy as
// resolveUnitPolicy in bin/harbor-bin.cjs: a relocated store is by definition
// not the real installation, so its daemon defaults to dying with whoever
// spawned it, and no future suite has to remember to ask for that.
//
//   HARBOR_SESSIOND_PARENT_PID=<pid>  watch that pid (a harness naming itself)
//   HARBOR_SESSIOND_PARENT_PID=0      never watch: the CLI's deliberate
//                                     detached start, whose spawner exiting is
//                                     the plan, not an abort
//   unset, store relocated            watch the spawner (ppid at boot)
//   unset, default store              never watch: this is the real daemon,
//                                     and its whole job is to outlive callers
function resolveHarnessWatchPid(env = {}, ppid = 0) {
  const explicit = env.HARBOR_SESSIOND_PARENT_PID;
  if (explicit !== undefined && explicit !== null && String(explicit).trim() !== '') {
    const parsed = Number(explicit);
    return Number.isInteger(parsed) && parsed > 1 ? parsed : null;
  }
  if (!env.HARBOR_SESSIOND_DIR && !env.HARBOR_SESSIOND_SOCKET) return null;
  return Number.isInteger(ppid) && ppid > 1 ? ppid : null;
}

module.exports = { resolveHarnessWatchPid };
