'use strict';

// Profile list helpers for the renderer. The authoritative profile objects
// arrive from main via `new-session:options`; these utilities keep every
// badge, meter row, and launch button derived from that list instead of the
// old hardcoded three-account triple, whose third entry was a real person's
// first name.

function hexToRgb(hex) {
  const raw = String(hex || '').trim().replace(/^#/, '');
  if (raw.length !== 6 || !/^[0-9a-f]{6}$/i.test(raw)) return '128 128 128';
  const value = Number.parseInt(raw, 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `${r} ${g} ${b}`;
}

function resolveProfile(profiles, id) {
  if (!Array.isArray(profiles) || profiles.length === 0) return null;
  return profiles.find((profile) => profile.id === id)
    || profiles.find((profile) => profile.isDefault)
    || profiles[0]
    || null;
}

function defaultProfile(profiles) {
  return resolveProfile(profiles, null);
}

function defaultProfileId(profiles) {
  return defaultProfile(profiles)?.id || null;
}

function normalizeHome(home, profiles = null) {
  if (Array.isArray(profiles) && profiles.length > 0) {
    if (home && profiles.some((profile) => profile.id === home)) return home;
    return defaultProfileId(profiles);
  }
  return home || null;
}

function profileStyle(profile) {
  if (!profile?.color) return {};
  return {
    '--profile-color': profile.color,
    '--profile-rgb': hexToRgb(profile.color),
  };
}

// The shell command that reproduces a resume by hand. It used to compose
// per-account FLAGS by profile index (` --team`, then ` --<id>`), which was
// wrong in two ways once accounts became the user's own: the flag only exists
// if their launcher happens to define it, and for the third profile it emitted
// the profile id, which on the machine this was built for was a person's name.
//
// CLAUDE_CONFIG_DIR is what the account actually is, it is what Harbor itself
// sets, and it works for any launcher. The default profile needs no prefix
// because a bare launch already lands there.
//
// The binary is the CLAUDE CLI, not a wrapper. This line is copied and pasted
// into a terminal by a human, so naming a wrapper that ships with nothing was a
// command that could not run on any machine but one.
function resumeCommandForProfile(profile, profiles = [], sessionId = '') {
  const resume = `claude --dangerously-skip-permissions --resume ${sessionId}`;
  if (!profile?.configHome) return resume;
  const isDefault = profile.isDefault || profiles.findIndex((item) => item.id === profile.id) <= 0;
  if (isDefault) return resume;
  // Quote only when it would otherwise break: a path with a space is ordinary.
  const home = /^[A-Za-z0-9_./:=+-]+$/.test(profile.configHome)
    ? profile.configHome
    : `'${profile.configHome.replaceAll("'", "'\\''")}'`;
  return `CLAUDE_CONFIG_DIR=${home} ${resume}`;
}

function launchDefaults(options) {
  const defaults = options?.defaults || {};
  return {
    provider: defaults.provider || 'claude',
    model: defaults.model || 'opus',
    effort: defaults.effort || 'xhigh',
  };
}

function railWidthForProfileCount(count) {
  if (count <= 1) return 260;
  if (count <= 3) return 292;
  return 320;
}

module.exports = {
  hexToRgb,
  resolveProfile,
  defaultProfile,
  defaultProfileId,
  normalizeHome,
  profileStyle,
  resumeCommandForProfile,
  launchDefaults,
  railWidthForProfileCount,
};
