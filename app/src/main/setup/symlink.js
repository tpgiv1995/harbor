'use strict';

// Sharing one set of config files across several Claude config homes.
//
// This is the optional step that makes a multi-account install pleasant: one
// CLAUDE.md, one commands/, one skills/, one settings.json, one transcript
// store, seen by every home. It is also the step that WRITES INSIDE THE USER'S
// CONFIG HOMES, so it is built defensively:
//
//   1. THE SPLIT IS STRUCTURAL, NOT ADVISORY. `.credentials.json` and
//      `.claude.json` are refused by this module by name, at plan time and
//      again at apply time. They are precisely what makes each home a
//      DIFFERENT account, and linking them would quietly point every plan at
//      one login. A wrong state here must be impossible, not discouraged, so
//      the refusal is a code path and not a sentence in the UI.
//   2. PLAN, SHOW, THEN APPLY. planShared() touches nothing and returns the
//      exact action for every entry, including the ones it will refuse and the
//      real files it would have to move aside. The screen renders that plan
//      before the user agrees to it.
//   3. NOTHING IS DESTROYED. An existing real file in a target home is RENAMED
//      to a backup beside itself, never deleted, and the backup path is
//      reported. A user who dislikes the result can put it back by hand.
//
// Platform behaviour, which is the whole reason this is not six lines:
//   linux, darwin  real symlinks for both files and directories.
//   win32          DIRECTORY symlinks need Developer Mode or an elevated
//                  shell, junctions need neither, so directories are junctions.
//                  FILE symlinks have the same privilege requirement and there
//                  is no junction for files, so a file symlink is attempted and
//                  falls back to a HARD LINK, which needs no privilege on NTFS.
//                  That fallback is reported, not hidden, because a hard link
//                  is not a symlink: edits are shared, but an editor that saves
//                  by writing a temp file and renaming over the target breaks
//                  the link silently.

const fsp = require('node:fs/promises');
const path = require('node:path');

// Shared by design. Order matters only for readability of the plan.
const SHARED_ENTRIES = [
  { name: 'CLAUDE.md', kind: 'file', why: 'One set of instructions for every account.' },
  { name: 'settings.json', kind: 'file', why: 'One set of settings, hooks and permissions.' },
  { name: 'settings.local.json', kind: 'file', why: 'One set of local overrides.' },
  { name: 'commands', kind: 'dir', why: 'Your slash commands, available from every account.' },
  { name: 'skills', kind: 'dir', why: 'Your skills, available from every account.' },
  { name: 'projects', kind: 'dir', why: 'One transcript store, so the rail shows every session whichever account ran it.' },
];

// NEVER shared. This list is the safety property of the whole feature.
const NEVER_SHARED = ['.credentials.json', '.claude.json'];

function isRefused(name) {
  return NEVER_SHARED.includes(path.basename(name));
}

async function lstatOrNull(target) {
  try {
    return await fsp.lstat(target);
  } catch {
    return null;
  }
}

async function readLinkOrNull(target) {
  try {
    return await fsp.readlink(target);
  } catch {
    return null;
  }
}

function samePath(a, b) {
  if (!a || !b) return false;
  return path.resolve(a) === path.resolve(b);
}

// One entry, one target home: what would happen, and why. Every branch returns
// an `action` the UI can render and the apply step can execute, so the plan and
// the execution can never diverge into different decisions.
async function planEntry(entry, sourceHome, targetHome, deps) {
  const source = path.join(sourceHome, entry.name);
  const target = path.join(targetHome, entry.name);
  const result = { name: entry.name, kind: entry.kind, source, target };

  if (isRefused(entry.name)) {
    return {
      ...result,
      action: 'refuse',
      reason: 'This file is what makes each home a separate account; sharing it would point every plan at one login.',
    };
  }
  const sourceStat = await deps.lstat(source);
  if (!sourceStat) {
    return {
      ...result,
      action: 'skip',
      reason: `${entry.name} does not exist in the home that holds the real files, so there is nothing to share.`,
    };
  }
  const targetStat = await deps.lstat(target);
  if (targetStat && targetStat.isSymbolicLink()) {
    const existing = await deps.readlink(target);
    if (samePath(existing, source) || samePath(path.resolve(targetHome, existing || ''), source)) {
      return { ...result, action: 'already-linked' };
    }
    return {
      ...result,
      action: 'relink',
      reason: `Currently links to ${existing}.`,
      backup: null,
    };
  }
  if (targetStat) {
    return {
      ...result,
      action: 'replace',
      reason: `${entry.name} already exists here as a real ${targetStat.isDirectory() ? 'folder' : 'file'}; it will be renamed beside itself, never deleted.`,
      backup: `${target}.harbor-backup`,
    };
  }
  return { ...result, action: 'create' };
}

// The whole plan: every chosen entry against every target home. Touches
// nothing.
async function planShared(options = {}, deps = {}) {
  const lstat = deps.lstat || lstatOrNull;
  const readlink = deps.readlink || readLinkOrNull;
  const platformName = deps.platform || process.platform;
  const source = options.primary;
  const targets = (options.targets || []).filter(Boolean);
  const chosen = options.entries && options.entries.length
    ? SHARED_ENTRIES.filter((entry) => options.entries.some((e) => (e.name || e) === entry.name))
    : SHARED_ENTRIES;

  if (!source) throw new Error('planShared requires the home that holds the real files');

  const homes = [];
  for (const targetHome of targets) {
    if (samePath(targetHome, source)) {
      homes.push({
        home: targetHome,
        skipped: 'This is the home that holds the real files.',
        entries: [],
      });
      continue;
    }
    const entries = [];
    for (const entry of chosen) {
      entries.push(await planEntry(entry, source, targetHome, { lstat, readlink }));
    }
    homes.push({ home: targetHome, skipped: null, entries });
  }
  return {
    source,
    platform: platformName,
    style: platformName === 'win32' ? 'junction' : 'symlink',
    // Surfaced so the Windows screen can be honest before anything is applied.
    note: platformName === 'win32'
      ? 'On Windows, folders are linked with junctions, which need no special privileges. Files need Developer Mode or an elevated shell for a real symlink; without it Harbor falls back to a hard link and tells you it did.'
      : null,
    homes,
    neverShared: [...NEVER_SHARED],
  };
}

// Make one link, choosing the mechanism the platform can actually deliver, and
// reporting which one it used.
async function linkOne(entry, deps) {
  const { platform: platformName, symlink, link } = deps;
  if (entry.kind === 'dir') {
    // 'junction' is ignored on POSIX and is the privilege-free option on
    // Windows, so one call covers all three platforms.
    await symlink(entry.source, entry.target, platformName === 'win32' ? 'junction' : 'dir');
    return { mechanism: platformName === 'win32' ? 'junction' : 'symlink' };
  }
  try {
    await symlink(entry.source, entry.target, 'file');
    return { mechanism: 'symlink' };
  } catch (error) {
    if (platformName !== 'win32' || (error.code !== 'EPERM' && error.code !== 'EACCES')) throw error;
    await link(entry.source, entry.target);
    return {
      mechanism: 'hardlink',
      warning: 'Linked as a hard link because a file symlink needs Developer Mode or an elevated shell. '
        + 'Edits are shared, but an app that saves by replacing the file will silently break the link.',
    };
  }
}

async function uniqueBackupPath(target, deps) {
  const base = `${target}.harbor-backup`;
  for (let n = 0; n < 100; n += 1) {
    const candidate = n === 0 ? base : `${base}-${n}`;
    if (!(await deps.lstat(candidate))) return candidate;
  }
  throw new Error(`could not find an unused backup name beside ${target}`);
}

// Execute a plan produced above. Re-checks the refusal list rather than
// trusting the plan it was handed, because this is the function that can do
// damage and a caller could have built the plan itself.
async function applyShared(plan, deps = {}) {
  const fs = deps.fs || fsp;
  const lstat = deps.lstat || lstatOrNull;
  const platformName = deps.platform || plan.platform || process.platform;
  const helpers = {
    platform: platformName,
    symlink: deps.symlink || fs.symlink.bind(fs),
    link: deps.link || fs.link.bind(fs),
  };
  const results = [];
  for (const home of plan.homes || []) {
    if (home.skipped) continue;
    for (const entry of home.entries || []) {
      if (isRefused(entry.name)) {
        results.push({ ...entry, applied: false, action: 'refuse', reason: 'refused by name' });
        continue;
      }
      if (entry.action === 'skip' || entry.action === 'already-linked') {
        results.push({ ...entry, applied: false });
        continue;
      }
      try {
        let backup = null;
        if (entry.action === 'replace') {
          backup = await uniqueBackupPath(entry.target, { lstat });
          await fs.rename(entry.target, backup);
        } else if (entry.action === 'relink') {
          await fs.unlink(entry.target);
        }
        await fs.mkdir(path.dirname(entry.target), { recursive: true });
        const { mechanism, warning } = await linkOne(entry, helpers);
        results.push({ ...entry, applied: true, backup, mechanism, warning: warning || null });
      } catch (error) {
        results.push({ ...entry, applied: false, error: error.message });
      }
    }
  }
  const failed = results.filter((entry) => entry.error);
  return {
    ok: failed.length === 0,
    applied: results.filter((entry) => entry.applied).length,
    failed: failed.length,
    results,
  };
}

module.exports = {
  SHARED_ENTRIES,
  NEVER_SHARED,
  isRefused,
  planEntry,
  planShared,
  applyShared,
  linkOne,
};
