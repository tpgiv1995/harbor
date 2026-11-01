'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { fail, insist } = require('./errors.cjs');
const { volumeStamp } = require('./identity.cjs');

const samePath = (a, b) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const fold = value => process.platform === 'win32' ? value.toLowerCase() : value;
const inside = (root, target) => { const rel = path.relative(root, target); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };
function git(cwd, args, { input, allowFailure = false } = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });
  const result = spawnSync('git', ['-c', 'core.hooksPath=' + path.join(__dirname, 'no-hooks'), '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args], {
    cwd, env, input, encoding: 'utf8', windowsHide: true,
    timeout: (args[0] === 'switch' || (args[0] === 'reset' && args.includes('--hard')) || (args[0] === 'worktree' && args[1] === 'add')) ? 1800000 : 120000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    if (allowFailure && !result.error) return null;
    fail('GIT_FAILED', `Git ${args[0]} failed`, { reason: result.error?.message || result.stderr.trim() });
  }
  return result.stdout.trimEnd();
}
function sha(repoPath, ref) {
  insist(typeof ref === 'string' && ref && !ref.startsWith('-'), 'INVALID_ARGUMENT', 'A base ref or SHA is required');
  return git(repoPath, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
}
function noLinks(file) {
  const stat = fs.lstatSync(file);
  insist(!stat.isSymbolicLink() && stat.isDirectory(), 'PATH_UNSAFE', 'Expected an owned directory, not a junction or link', { path: file });
}
function checkVolume(repo) {
  try {
    noLinks(repo.poolRoot);
    const current = volumeStamp(repo.poolRoot);
    insist(['root', 'dev', 'ino'].every(key => current[key] === repo.volume[key]), 'VOLUME_MISSING', 'Configured pool root or volume identity changed');
  } catch (error) { if (error.code === 'VOLUME_MISSING') throw error; fail('VOLUME_MISSING', 'Configured pool root is missing or unsafe', { reason: error.message }); }
}
function commonDir(cwd) { return fs.realpathSync.native(git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])); }
function fileIdentity(file) {
  const stat = fs.statSync(file, { bigint: true });
  return { dev: String(stat.dev), ino: String(stat.ino) };
}
function validateRepo(repo) {
  insist(samePath(fs.realpathSync.native(repo.canonical), repo.canonical), 'PATH_UNSAFE', 'Canonical repository path changed');
  insist(samePath(commonDir(repo.canonical), repo.common), 'REPOSITORY_CHANGED', 'Repository metadata identity changed');
  insist(JSON.stringify(fileIdentity(repo.common)) === JSON.stringify(repo.commonIdentity), 'REPOSITORY_CHANGED', 'Repository metadata directory was replaced');
}
function noFilters(cwd, files, commit) {
  if (!files.length) return;
  const attrs = git(cwd, ['check-attr', ...(commit ? [`--source=${commit}`] : []), '-z', '--stdin', 'filter'], { input: files.join('\0') + '\0' }).split('\0');
  for (let n = 0; n + 2 < attrs.length; n += 3) insist(['unspecified', 'unset'].includes(attrs[n + 2]), 'UNSUPPORTED_REPOSITORY', 'Tracked content uses Git filters; a separate onboarding audit is required', { path: attrs[n], filter: attrs[n + 2] });
}
function validateTarget(repo, commit) {
  const tree = git(repo.canonical, ['ls-tree', '-r', '-z', commit]).split('\0').filter(Boolean);
  insist(!tree.some(line => line.startsWith('160000 ')), 'UNSUPPORTED_REPOSITORY', 'Submodules are unsupported in v1');
  noFilters(repo.canonical, tree.map(line => line.slice(line.indexOf('\t') + 1)), commit);
  for (const line of tree) {
    const file = line.slice(line.indexOf('\t') + 1);
    insist(!repo.allowlist.some(dir => fold(file) === fold(dir) || fold(file).startsWith(`${fold(dir)}/`) || fold(dir).startsWith(`${fold(file)}/`)), 'ALLOWLIST_CONFLICT', 'A reusable directory overlaps tracked content', { file });
  }
}
function validateSlot(repo, slot) {
  checkVolume(repo); validateRepo(repo);
  noLinks(path.dirname(slot.path)); noLinks(slot.path);
  const dotGit = path.join(slot.path, '.git');
  const dotGitStat = fs.lstatSync(dotGit);
  insist(dotGitStat.isFile() && !dotGitStat.isSymbolicLink(), 'PATH_UNSAFE', 'A pool slot must have its own linked-worktree gitfile');
  insist(samePath(git(slot.path, ['rev-parse', '--show-toplevel']), slot.path), 'PATH_UNSAFE', 'Slot is not the registered worktree');
  insist(samePath(commonDir(slot.path), repo.common), 'REPOSITORY_CHANGED', 'Slot belongs to a different repository');
  const admin = fs.realpathSync.native(git(slot.path, ['rev-parse', '--absolute-git-dir']));
  insist(inside(path.join(repo.common, 'worktrees'), admin), 'PATH_UNSAFE', 'Slot cannot use the canonical checkout index');
  insist(samePath(fs.readFileSync(path.join(admin, 'gitdir'), 'utf8').trim(), dotGit), 'PATH_UNSAFE', 'Worktree administrative backpointer does not match this slot');
  const records = git(repo.canonical, ['worktree', 'list', '--porcelain', '-z']).split('\0');
  insist(records.some(row => row.startsWith('worktree ') && samePath(row.slice(9), slot.path)), 'PATH_UNSAFE', 'Slot worktree registration is missing');
  noFilters(slot.path, git(slot.path, ['ls-files', '-z']).split('\0').filter(Boolean));
}
function operations(cwd) {
  const admin = git(cwd, ['rev-parse', '--absolute-git-dir']);
  const names = ['index.lock', 'HEAD.lock', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_START'];
  insist(!names.some(name => fs.existsSync(path.join(admin, name))), 'GIT_OPERATION', 'Slot has an unfinished Git operation or lock');
  insist(git(cwd, ['config', '--bool', 'core.sparseCheckout'], { allowFailure: true }) !== 'true', 'UNSUPPORTED_REPOSITORY', 'Sparse worktrees are unsupported in v1');
}
function clearFlags(cwd) {
  const rows = git(cwd, ['ls-files', '-v', '-z']).split('\0').filter(Boolean);
  const assumed = rows.filter(row => /^[a-z]/.test(row)).map(row => row.slice(2));
  const skipped = rows.filter(row => /^[sS]/.test(row)).map(row => row.slice(2));
  if (!assumed.length && !skipped.length) return;
  // Only touch flagged entries. Combining the two options silently leaves one set.
  for (const [flag, files] of [['--no-assume-unchanged', assumed], ['--no-skip-worktree', skipped]]) {
    if (files.length) git(cwd, ['update-index', flag, '-z', '--stdin'], { input: files.join('\0') + '\0' });
  }
  const flagged = git(cwd, ['ls-files', '-v', '-z']).split('\0').filter(Boolean).filter(row => /^[a-zS]/.test(row));
  insist(!flagged.length, 'HIDDEN_INDEX_FLAGS', 'Could not clear hidden index flags');
}
function cleanTree(cwd) {
  operations(cwd); clearFlags(cwd);
  const status = git(cwd, ['status', '--porcelain=v1', '--untracked-files=all']);
  insist(!status, 'DIRTY', 'Slot has staged, unstaged, or untracked work', { status });
}
function scan(cwd, visit) {
  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const names = new Set(entries.map(entry => entry.name));
    insist(dir === cwd || !(['HEAD', 'objects', 'refs'].every(name => names.has(name))), 'UNSUPPORTED_REPOSITORY', 'Nested bare repository found; no cleanup performed', { path: dir });
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (dir === cwd && entry.name === '.git') continue;
      insist(entry.name.toLowerCase() !== '.git', 'UNSUPPORTED_REPOSITORY', 'Nested repository found; no cleanup performed', { path: file });
      const stat = fs.lstatSync(file);
      visit?.(file, stat);
      if (stat.isDirectory() && !stat.isSymbolicLink()) walk(file);
    }
  }
  walk(cwd);
}
function validateEnvironment(repo, slot) {
  scan(slot.path, (file, stat) => {
    const rel = path.relative(slot.path, file).split(path.sep).join('/');
    if (stat.isSymbolicLink() && repo.allowlist.some(dir => fold(rel) === fold(dir) || fold(rel).startsWith(`${fold(dir)}/`) || fold(dir).startsWith(`${fold(rel)}/`))) {
      insist(!repo.allowlist.some(dir => fold(rel) === fold(dir) || fold(dir).startsWith(`${fold(rel)}/`)), 'ENVIRONMENT_UNSAFE', 'Reusable directory or its parent cannot be a link', { path: file });
      let target; try { target = fs.realpathSync.native(file); } catch { fail('ENVIRONMENT_UNSAFE', 'Reusable environment contains a dangling link', { path: file }); }
      insist(inside(slot.path, target), 'ENVIRONMENT_UNSAFE', 'Reusable environment points outside its slot', { path: file });
    }
  });
}
function cleanGenerated(repo, slot) {
  const tracked = new Set(git(slot.path, ['ls-files', '-z']).split('\0').filter(Boolean).map(fold));
  function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      if (dir === slot.path && name === '.git') continue;
      const file = path.join(dir, name);
      const rel = path.relative(slot.path, file).split(path.sep).join('/');
      if (repo.allowlist.some(dir => fold(dir) === fold(rel))) continue;
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) { if (!tracked.has(fold(rel))) fs.unlinkSync(file); }
      else if (stat.isDirectory()) { walk(file); if (!fs.readdirSync(file).length) fs.rmdirSync(file); }
      else if (!tracked.has(fold(rel))) fs.unlinkSync(file);
    }
  }
  walk(slot.path);
}
function prepare(repo, slot, target, branch, resume, fault = () => {}) {
  checkVolume(repo); validateRepo(repo); validateTarget(repo, target);
  const parent = path.dirname(slot.path);
  fs.mkdirSync(parent, { recursive: true });
  noLinks(parent);
  if (!slot.created) {
    insist(!fs.existsSync(slot.path), 'PATH_UNSAFE', 'Unregistered slot path already exists');
    try {
      git(repo.canonical, ['worktree', 'add', '--detach', '--lock', '--reason', 'harbor-lane permanent pool', slot.path, target]);
    } catch (error) {
      // Only this command's previously absent path is eligible for rollback.
      checkVolume(repo); noLinks(parent);
      const registered = git(repo.canonical, ['worktree', 'list', '--porcelain', '-z']).split('\0').some(row => row.startsWith('worktree ') && samePath(row.slice(9), slot.path));
      if (registered) {
        git(repo.canonical, ['worktree', 'unlock', slot.path], { allowFailure: true });
        git(repo.canonical, ['worktree', 'remove', '--force', slot.path]);
      }
      if (fs.existsSync(slot.path)) removeOwnedTree(slot.path);
      git(repo.canonical, ['worktree', 'prune']);
      insist(!fs.existsSync(slot.path), 'PATH_UNSAFE', 'Failed checkout rollback left a path behind');
      error.checkoutRolledBack = true;
      throw error;
    }
    slot.created = true;
  }
  validateSlot(repo, slot);
  validateEnvironment(repo, slot);
  cleanTree(slot.path);
  insist(git(slot.path, ['symbolic-ref', '-q', 'HEAD'], { allowFailure: true }) === null, 'SLOT_ATTACHED', 'A free slot must be detached before preparation');
  fault('before-clean');
  cleanGenerated(repo, slot);
  fault('after-clean');
  git(slot.path, ['reset', '--hard', target]);
  fault('after-reset');
  if (branch) {
    if (resume && git(repo.canonical, ['show-ref', '--verify', '--hash', `refs/heads/${branch}`], { allowFailure: true })) {
      insist(sha(repo.canonical, `refs/heads/${branch}`) === target, 'TIP_MOVED', 'Recorded branch tip has moved; refusing to reset it');
      git(slot.path, ['switch', branch]);
    } else git(slot.path, ['switch', '-c', branch, target]);
  } else git(slot.path, ['switch', '--detach', target]);
  cleanTree(slot.path);
  insist(sha(slot.path, 'HEAD') === target, 'TIP_MOVED', 'Prepared HEAD does not match pinned commit');
  fault('after-switch');
}
function removeOwnedTree(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return fs.unlinkSync(file);
  for (const name of fs.readdirSync(file)) removeOwnedTree(path.join(file, name));
  fs.rmdirSync(file);
}
function fingerprint(repo, slot, runtimes = {}) {
  const names = /(^|\/)(package(-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|pyproject\.toml|uv\.lock|poetry\.lock|Pipfile(\.lock)?|requirements[^/]*\.txt|Cargo\.(toml|lock)|go\.(mod|sum)|Gemfile(\.lock)?)$/;
  const hash = crypto.createHash('sha256');
  const runtime = { node: process.version, abi: process.versions.modules, platform: process.platform, arch: process.arch, ...runtimes };
  hash.update(JSON.stringify(Object.fromEntries(Object.entries(runtime).sort(([a], [b]) => a.localeCompare(b)))));
  const files = git(slot.path, ['ls-files', '-z']).split('\0').filter(file => file && names.test(file)).sort();
  for (const file of files) {
    const full = path.join(slot.path, file);
    insist(inside(slot.path, fs.realpathSync.native(full)), 'ENVIRONMENT_UNSAFE', 'Dependency manifest points outside slot');
    hash.update(file); hash.update('\0'); hash.update(fs.readFileSync(full)); hash.update('\0');
  }
  hash.update(JSON.stringify(repo.allowlist));
  return { hash: hash.digest('hex'), runtime, files };
}
module.exports = { git, sha, inside, samePath, noLinks, commonDir, fileIdentity, validateRepo, checkVolume, validateTarget, validateSlot, operations, cleanTree, validateEnvironment, prepare, fingerprint };
