'use strict';

const path = require('node:path');

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
// This is that one rule. It mirrors providers/history-index.js `projectLabel`,
// which is the canonical producer: the history rows define the groups, so the
// live side has to agree with THAT, not with a reasonable-looking variant.
function projectLabelForCwd(cwd, home) {
  if (!cwd) return null;
  const base = home || '';
  if (cwd.includes('\\') || /^[A-Za-z]:/u.test(cwd)) {
    const withoutDrive = cwd.replace(/^[A-Za-z]:[\\/]?/u, '');
    const parts = withoutDrive.split(/[\\/]+/u).filter(Boolean);
    return parts.length ? `win: ${parts.slice(-2).join('/')}` : 'win: ?';
  }
  if (base) {
    if (cwd === base) return '~';
    const dev = path.join(base, 'dev');
    if (cwd === dev) return 'dev';
    if (cwd.startsWith(`${dev}${path.sep}`)) return path.relative(dev, cwd);
    if (cwd.startsWith(`${base}${path.sep}`)) {
      const parts = path.relative(base, cwd).split(path.sep);
      return parts.length > 1 ? parts.slice(-2).join(path.sep) : parts[0];
    }
  }
  return cwd.split(path.sep).filter(Boolean).slice(-2).join(path.sep);
}

module.exports = { projectLabelForCwd };
