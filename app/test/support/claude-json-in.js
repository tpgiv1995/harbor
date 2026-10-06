'use strict';

// One shared stand-in for the config layer's `exists` override, used by both
// config-migrate suites. It exists because two ad-hoc copies of this helper
// shipped on 2026-08-28 and immediately diverged — one regex-anchored, one
// endsWith-based — and both hardcoded POSIX '/' separators while production
// `listHomeDirs` probes with the HOST `path.join`. On the windows-latest CI
// gate (the repo's only unit gate) every probe arrived with backslashes, missed
// both helpers, fell through to the real `fs.existsSync` of a fake path, and
// every suffixed home silently vanished from discovery. This is the same
// correction `project-label.cjs` got on 2026-08-12: when a rule is
// platform-shaped, parameterise the platform instead of assuming the author's.
//
// Contract: discovery treats a suffixed `.claude-*` directory as a real config
// home when it holds an account's `.claude.json` OR a `projects/` transcript
// store (see homes.js). This stand-in answers BOTH probes, split by path
// segments so the host separator never matters:
//   - `names`        homes that are fully real (have `.claude.json`)
//   - `bare`         homes that only LOOK like homes (answer false to both)
//   - `projectsOnly` homes mid-reauth: no `.claude.json`, but `projects/` exists
// Anything that is not one of those two probes defers to the real filesystem,
// because `exists` is the config layer's ONE fs stand-in and hasPriorInstall
// asks it about genuinely-on-disk paths.

const fs = require('node:fs');

function segments(p) {
  return String(p).split(/[\\/]+/).filter(Boolean);
}

function claudeJsonIn(names, { bare = [], projectsOnly = [], fallback = fs.existsSync } = {}) {
  const real = new Set(names.filter((n) => !bare.includes(n) && !projectsOnly.includes(n)));
  const withProjects = new Set(projectsOnly);
  return (p) => {
    const parts = segments(p);
    const leaf = parts[parts.length - 1];
    const home = parts[parts.length - 2];
    if (leaf === '.claude.json') return real.has(home);
    if (leaf === 'projects') return withProjects.has(home) || real.has(home);
    return fallback(p);
  };
}

module.exports = { claudeJsonIn };
