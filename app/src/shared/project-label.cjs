'use strict';

// The rail groups sessions by PROJECT LABEL, and a live pane joins a history
// row's group by matching that label as a plain string. So a backend that
// reports a different label for the same directory does not merely look wrong,
// it SPLITS the directory into two groups: live sessions under one name and
// their own history under another. Live-caught 2026-08-05 driving the sessiond
// gate, where the rail showed both
//   /home/you/dev/harbor/app/.e2e-home/sessiond-qf7jJl/home/dev/project
//   project
// for one folder, because the sessiond adapter labelled its workspaces with the
// raw cwd while the history index labelled the same folder `project`.
//
// This is that one rule. providers/history-index.js, main/index.js and
// server/compose.js all delegate here; the history rows define the groups, so
// every producer has to agree with THIS, not with a reasonable-looking variant.
//
// The era rule is keyed on the HOST, not on the path shape (2026-08-12). The
// `win: ` prefix was written during the Linux era, when a Windows-shaped cwd
// could only mean the restored pre-Linux history: label it, disable it, done.
// The moment the machine became Windows again that assumption inverted, and the
// same branch branded every CURRENT project "win: ..." - which reads as junk in
// the rail and, through isWindowsEra, disabled every row, blocked every open,
// and hid every launch chip on the machine Pat actually works on. A path native
// to the host gets the friendly rules; a path from the OTHER OS gets an era
// prefix (`win: ` history seen from Linux, `linux: ` history seen from
// Windows), because that folder genuinely does not exist on this host.
function projectLabelForCwd(cwd, home, platform = process.platform) {
  if (!cwd) return null;
  const isWindowsPath = cwd.includes('\\') || /^[A-Za-z]:/u.test(cwd);
  const hostIsWindows = platform === 'win32';

  if (isWindowsPath && !hostIsWindows) {
    const withoutDrive = cwd.replace(/^[A-Za-z]:[\\/]?/u, '');
    const parts = withoutDrive.split(/[\\/]+/u).filter(Boolean);
    return parts.length ? `win: ${parts.slice(-2).join('/')}` : 'win: ?';
  }
  if (!isWindowsPath && hostIsWindows) {
    const parts = cwd.split(/\/+/u).filter(Boolean);
    return parts.length ? `linux: ${parts.slice(-2).join('/')}` : 'linux: ?';
  }

  if (hostIsWindows) return windowsNativeLabel(cwd, home);
  return posixNativeLabel(cwd, home);
}

// Pure string ops, '/' literals, no path.sep: this function takes `platform`
// as a parameter, so its answer must not secretly depend on the OS the CALLER
// happens to run on (a win32 host asking about a linux-era path must get the
// same label the Linux install produced). On Linux path.sep was '/' anyway, so
// this is the same behaviour it always had.
function posixNativeLabel(cwd, home) {
  const base = (home || '').replace(/\/+$/u, '');
  if (base) {
    if (cwd === base) return '~';
    const dev = `${base}/dev`;
    if (cwd === dev) return 'dev';
    if (cwd.startsWith(`${dev}/`)) return cwd.slice(dev.length + 1);
    if (cwd.startsWith(`${base}/`)) {
      const parts = cwd.slice(base.length + 1).split('/');
      return parts.length > 1 ? parts.slice(-2).join('/') : parts[0];
    }
  }
  return cwd.split('/').filter(Boolean).slice(-2).join('/');
}

// The posix rules, restated on the shapes Windows actually has. Comparisons are
// case-insensitive because NTFS is; labels join with '/' because that is what
// every era label already did and what the icon slug expects. Two dev roots:
// `<home>\dev` mirrors the posix convention, and `<drive>:\dev` is where the
// projects actually live on this machine (C:\dev\harbor labels `harbor`, which
// is also the name its icon file has carried since the Linux install).
function windowsNativeLabel(cwd, home) {
  const strip = (p) => String(p).replace(/^[A-Za-z]:[\\/]?/u, '');
  const segsOf = (p) => strip(p).split(/[\\/]+/u).filter(Boolean);
  const keyOf = (p) => segsOf(p).join('/').toLowerCase();
  const parts = segsOf(cwd);
  // A bare drive root is not a project name, but '?' (what it used to answer,
  // and 'win: ?' before that) is worse than useless on the machine the drives
  // actually belong to: it names nothing, and because the rail GROUPS BY LABEL
  // it also merges every drive into one row, so C:\ and D:\ sessions pile up
  // under a single '?'. Pat had 103 sessions under one of these on 2026-08-12,
  // including the whole Legion migration audit, sitting behind a question mark.
  // The drive is a real, distinct, honest name for a session started at a drive
  // root, so it is the label; only a rootless path with no drive to name (a UNC
  // share, a malformed cwd) still has nothing to say and keeps '?'.
  if (!parts.length) {
    const drive = /^([A-Za-z]):/u.exec(String(cwd));
    return drive ? `${drive[1].toUpperCase()}:` : '?';
  }
  const key = keyOf(cwd);
  if (home) {
    const homeKey = keyOf(home);
    if (homeKey) {
      if (key === homeKey) return '~';
      if (key.startsWith(`${homeKey}/`)) {
        const rel = parts.slice(segsOf(home).length);
        if (rel[0]?.toLowerCase() === 'dev') {
          return rel.length > 1 ? rel.slice(1).join('/') : 'dev';
        }
        return rel.length > 1 ? rel.slice(-2).join('/') : rel[0];
      }
    }
  }
  if (parts[0].toLowerCase() === 'dev') {
    return parts.length > 1 ? parts.slice(1).join('/') : 'dev';
  }
  return parts.slice(-2).join('/');
}

module.exports = { projectLabelForCwd };
