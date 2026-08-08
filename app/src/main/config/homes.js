'use strict';

const fs = require('node:fs');
const path = require('node:path');

// WHERE A PROFILE COMES FROM, and why it is discovered rather than declared.
//
// Until 2026-08-01 the shipped source carried a literal list of three config
// homes and the three profiles built on them, including one labelled with a
// real person's first name and pointing at a `.claude-<name>` directory nobody
// else owns. That list was the author's own setup compiled into the app, and on
// 2026-07-29 it reached somebody else's machine: the macOS tester's first launch inherited
// all three plans plus workflows aimed at the author's Notes vault, because the
// prior-install guard misfired (see hasPriorInstall in migrate.js). The guard
// was the proximate cause; the root cause is that the app had a person's
// account list to hand out at all.
//
// So there is no list any more. A config home is a directory that EXISTS on the
// running user's machine, and both the migration and the setup wizard read the
// same answer from this one function, so they cannot drift.
//
// `.claude` is the personal home by long-standing convention across bin/ and
// the rail, so it sorts first and is named `personal` rather than the literal
// `claude` the folder name would give. Every other `.claude-<suffix>` home
// carries its suffix as its id, whatever that suffix happens to be.
const PRIMARY_HOME = '.claude';
const SUFFIXED_HOME = /^\.claude-(.+)$/;

// Index-ordered badge colours. The first two are --per and --team from
// styles.css, the tokens the rail has always drawn the first two badges in, so
// a discovered profile set lands on the colours the UI already expects. They
// are deliberately NOT --ac (#437FFE): the accent already means "this session
// is live", and a second blue makes two states read as one.
const PROFILE_PALETTE = ['#6FA8D8', '#D68A5A', '#F962BA', '#5FBF9F', '#C9A227', '#B87FD6'];

function homeId(dir) {
  const base = path.basename(dir);
  if (base === PRIMARY_HOME) return 'personal';
  const match = SUFFIXED_HOME.exec(base);
  return match ? match[1] : 'personal';
}

// A directory listing, sorted so the answer is deterministic across platforms
// (readdir order is filesystem-defined, and an unstable profile order would
// reshuffle the rail's badges between launches).
function listHomeDirs(homedir, readdir) {
  let entries;
  try {
    entries = readdir(homedir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    // A symlinked config home is ordinary (the -team and -lab `projects`
    // dirs are symlinks on the author's machine), so isDirectory() alone would miss a
    // home that is itself a link. isFile() is the honest exclusion.
    if (entry.isFile()) continue;
    const name = entry.name;
    if (name !== PRIMARY_HOME && !SUFFIXED_HOME.test(name)) continue;
    found.push(name);
  }
  found.sort((a, b) => {
    if (a === PRIMARY_HOME) return -1;
    if (b === PRIMARY_HOME) return 1;
    return a.localeCompare(b);
  });
  return found.map((name) => path.join(homedir, name));
}

// A badge letter, which must be unique or two plans render as one. The natural
// choice is the id's first character; a collision walks the rest of the id and
// then falls back to a digit, so N profiles always get N distinct letters.
function assignLetter(id, taken) {
  for (const char of `${id}`.toUpperCase()) {
    if (/[A-Z0-9]/.test(char) && !taken.has(char)) return char;
  }
  for (let n = 1; n <= 9; n += 1) {
    if (!taken.has(String(n))) return String(n);
  }
  return '?';
}

function labelFor(id) {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

// The profile list for a machine. Nothing here is a guess about who the user
// is: every entry corresponds to a directory that is actually present. A
// machine with no Claude home at all still gets one `personal` seed, because
// the config schema requires a non-empty profile list and the setup wizard
// needs a row to start editing from.
function discoverProfiles(homedir, overrides = {}) {
  const readdir = overrides.readdir || fs.readdirSync;
  const dirs = listHomeDirs(homedir, readdir);
  const paths = dirs.length ? dirs : [path.join(homedir, PRIMARY_HOME)];
  const taken = new Set();
  const profiles = paths.map((dir, index) => {
    const id = homeId(dir);
    const letter = assignLetter(id, taken);
    taken.add(letter);
    return {
      id,
      label: labelFor(id),
      letter,
      color: PROFILE_PALETTE[index % PROFILE_PALETTE.length],
      provider: 'claude',
      configHome: dir,
      email: null,
      isDefault: false,
    };
  });
  // The primary home is the default when it is present, which is the
  // convention every bin/ script already follows for a bare launch. Otherwise
  // the first discovered home takes it, so exactly one profile is always
  // default and the launcher never has to guess.
  const preferred = profiles.find((profile) => profile.id === 'personal') || profiles[0];
  preferred.isDefault = true;
  return profiles;
}

module.exports = { PRIMARY_HOME, PROFILE_PALETTE, discoverProfiles, homeId, listHomeDirs };
