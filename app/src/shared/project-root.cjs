'use strict';

// EVERY FOLDER BELONGS TO ITS MAIN PARENT PROJECT (Pat, 2026-10-06, on the
// phone: "I have a ton of like sub-projects listed here... I'd like it ideally
// to stay grouped by main parent project", with the side panel showing rows
// like <PROJECT>/BUILD/VIDEO/_NAMING beside <PROJECT> itself).
// project-label.cjs names a folder by its whole path under the dev root, so
// each sub-folder a session ever ran in became a project of its own: 434
// distinct folders on his machine, and the new-session list had to be scrolled
// end to end to find a project that had gone quiet for a few days.
//
// The rule, pure string work so the phone can run it on folder paths alone:
//   1. Under a dev root (<drive>:\dev\<name>, or <home>/dev/<name>) the parent
//      is <dev>\<name>: C:\dev\harbor\app belongs to C:\dev\harbor.
//   2. Elsewhere the parent is the SHORTEST ancestor that is itself one of the
//      known folders, so Reports\Quarterly joins Reports when sessions ran in
//      both. Containers never claim anything: a drive
//      root, the Users/home directory, a home, or a dev root itself would
//      otherwise swallow every project beneath it.
//   3. Otherwise the folder is its own parent.
// Folders compare case-insensitively on Windows, as NTFS does, so the two
// spellings of one directory land in one group.

function parsePath(value) {
  const text = String(value || '').trim();
  const win = /^[A-Za-z]:/u.test(text) || text.includes('\\');
  const drive = win ? (/^([A-Za-z]:)/u.exec(text)?.[1] || '') : '';
  const segs = text.slice(drive.length).split(/[\\/]+/u).filter(Boolean);
  return { win, drive, segs };
}

function keyAt(parsed, depth = parsed.segs.length) {
  const key = [parsed.drive, ...parsed.segs.slice(0, depth)].join('/');
  return parsed.win ? key.toLowerCase() : key;
}

function pathAt(parsed, depth) {
  const segs = parsed.segs.slice(0, depth);
  return parsed.win ? `${parsed.drive}\\${segs.join('\\')}` : `/${segs.join('/')}`;
}

function folderKey(folder) {
  return keyAt(parsePath(folder));
}

// How many leading segments make a home directory: <drive>\Users\<name>,
// /Users/<name>, /home/<name>, and /root.
function homeDepth(parsed) {
  const [first, second] = parsed.segs;
  if (!first) return 0;
  const lower = first.toLowerCase();
  if ((lower === 'users' || lower === 'home') && second) return 2;
  if (!parsed.win && first === 'root') return 1;
  return 0;
}

// The depth of the dev-root project a path sits in, or 0. Posix has no
// drive-level dev root: /dev is the device tree.
function devProjectDepth(parsed) {
  const bases = [];
  if (parsed.win) bases.push(0);
  const home = homeDepth(parsed);
  if (home) bases.push(home);
  for (const base of bases) {
    if (parsed.segs[base]?.toLowerCase() === 'dev' && parsed.segs.length > base + 1) return base + 2;
  }
  return 0;
}

function isContainer(parsed, depth) {
  if (depth === 0) return true;
  const home = homeDepth(parsed);
  if (home && depth <= home) return true;
  if (parsed.segs[depth - 1]?.toLowerCase() !== 'dev') return false;
  return (parsed.win && depth === 1) || (home > 0 && depth === home + 1);
}

// folders: absolute paths, most recent first. Returns Map(folder -> { root, key })
// where `root` is the parent folder spelled as a known folder spells it when one
// does, and `key` is its comparison key.
function projectRoots(folders) {
  const known = new Map();
  for (const folder of folders) {
    const key = folderKey(folder);
    if (!known.has(key)) known.set(key, folder);
  }
  const roots = new Map();
  for (const folder of folders) {
    const parsed = parsePath(folder);
    let depth = devProjectDepth(parsed);
    if (!depth) {
      depth = parsed.segs.length;
      for (let d = 1; d < parsed.segs.length; d += 1) {
        if (isContainer(parsed, d)) continue;
        if (known.has(keyAt(parsed, d))) { depth = d; break; }
      }
    }
    const key = keyAt(parsed, depth);
    roots.set(folder, { root: known.get(key) || pathAt(parsed, depth), key });
  }
  return roots;
}

// The last two segments, as the new-session list has always named a folder.
function folderLabel(folder) {
  const parts = String(folder || '').split(/[\\/]/u).filter(Boolean);
  if (!parts.length) return folder || 'Folder';
  return parts.length > 2 ? parts.slice(-2).join('/') : parts[parts.length - 1];
}

// A child's name inside its group: its path below the parent, else its own label.
function labelWithin(folder, root) {
  const child = parsePath(folder);
  const parent = parsePath(root);
  if (child.segs.length > parent.segs.length
    && keyAt(child, parent.segs.length) === keyAt(parent)) {
    return child.segs.slice(parent.segs.length).join('/');
  }
  return folderLabel(folder);
}

function queryTokens(query) {
  return String(query || '').toLowerCase().replace(/\\/gu, '/').split(/\s+/u).filter(Boolean);
}

function matchesTokens(tokens, ...fields) {
  const haystack = fields.join('\n').toLowerCase().replace(/\\/gu, '/');
  return tokens.every((token) => haystack.includes(token));
}

const ORCHESTRATION_GROUP = 'Orchestration';

// The new-session folder list, grouped. `folders` is the server's candidate
// list, most recent first; `isOrchestration({ cwd })` routes orchestration
// worker folders into one group, matching the side panel. Returns groups in
// recency order:
//   { key, label, folder, children: [{ folder, label }], total, open }
// `folder` is the selectable parent (null when no session ever ran in the
// parent itself), `total` the unfiltered child count, and `open` whether a
// search matched children the user cannot otherwise see.
function groupFolderCandidates(folders, { query = '', isOrchestration = () => false } = {}) {
  const seen = new Set();
  const unique = [];
  for (const folder of folders || []) {
    const key = folderKey(folder);
    if (!folder || seen.has(key)) continue;
    seen.add(key);
    unique.push(folder);
  }
  const roots = projectRoots(unique);
  const groups = new Map();
  for (const folder of unique) {
    const { root, key } = roots.get(folder);
    const orchestration = Boolean(isOrchestration({ cwd: folder }));
    const groupKey = orchestration ? `orchestration:${ORCHESTRATION_GROUP}` : key;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        key: groupKey,
        label: orchestration ? ORCHESTRATION_GROUP : folderLabel(root),
        root: orchestration ? null : root,
        folder: null,
        children: [],
      });
    }
    const group = groups.get(groupKey);
    if (!orchestration && folderKey(folder) === key) group.folder = folder;
    else group.children.push({ folder, label: labelWithin(folder, root) });
  }

  const tokens = queryTokens(query);
  const out = [];
  for (const group of groups.values()) {
    let shaped = group;
    // A parent nobody ever worked in, holding one folder, is just that folder.
    if (!group.folder && group.children.length === 1) {
      const only = group.children[0].folder;
      shaped = { ...group, label: folderLabel(only), folder: only, children: [] };
    }
    const total = shaped.children.length;
    const base = { key: shaped.key, label: shaped.label, folder: shaped.folder, total };
    if (!tokens.length) {
      out.push({ ...base, children: shaped.children, open: false });
      continue;
    }
    const parentMatches = matchesTokens(tokens, shaped.label, shaped.folder || shaped.root || '');
    const childMatches = shaped.children.filter((child) => matchesTokens(tokens, child.label, child.folder));
    if (parentMatches) out.push({ ...base, children: shaped.children, open: false });
    else if (childMatches.length) out.push({ ...base, children: childMatches, open: true });
  }
  return out;
}

// The side panel, grouped by project: folds each sub-project group into its
// parent's group. `projects` is the regrouped, filtered model's project list;
// `allSessions` every session in the unfiltered model, so a parent that the
// time filter hid still names its children. Era and orchestration groups are
// left alone. Each folded session gains `subproject`, its path below the parent.
function mergeSubprojects(projects, allSessions) {
  const labelByKey = new Map();
  const cwds = [];
  for (const session of allSessions || []) {
    if (!session?.cwd) continue;
    const key = folderKey(session.cwd);
    if (!labelByKey.has(key)) {
      labelByKey.set(key, session.project);
      cwds.push(session.cwd);
    }
  }
  const roots = projectRoots(cwds);
  const merged = new Map();
  const subLabels = new Map();
  for (const project of projects || []) {
    const cwd = project.sessions?.find((session) => session.cwd)?.cwd;
    const placed = cwd && !project.isWindowsEra && !project.isOrchestration && !project.isDateGroup
      ? roots.get(cwd) || projectRoots([cwd]).get(cwd)
      : null;
    // The parent's own label when a session ran there; otherwise the first
    // segment of a dev-root label, which IS the dev project's name.
    const parentLabel = placed
      ? (labelByKey.get(placed.key) || String(project.label).split('/')[0])
      : project.label;
    if (placed) subLabels.set(project, labelWithin(cwd, placed.root));
    if (!merged.has(parentLabel)) merged.set(parentLabel, []);
    merged.get(parentLabel).push(project);
  }
  const out = [];
  for (const [label, group] of merged) {
    if (group.length === 1 && group[0].label === label) { out.push(group[0]); continue; }
    const sessions = group.flatMap((project) => (project.label === label
      ? project.sessions
      : project.sessions.map((session) => ({ ...session, subproject: subLabels.get(project) || project.label }))));
    sessions.sort((a, b) => (b.lastActiveMs || 0) - (a.lastActiveMs || 0));
    const own = group.find((project) => project.label === label);
    out.push({
      ...(own || group[0]),
      label,
      sessions,
      sessionCount: sessions.length,
      lastActiveMs: sessions[0]?.lastActiveMs || 0,
      hasLive: sessions.some((session) => session.isLive),
      newSessionCwd: own?.newSessionCwd || group[0].newSessionCwd || null,
    });
  }
  out.sort((a, b) => (b.lastActiveMs || 0) - (a.lastActiveMs || 0));
  return out;
}

module.exports = {
  projectRoots,
  folderLabel,
  groupFolderCandidates,
  mergeSubprojects,
  ORCHESTRATION_GROUP,
};
