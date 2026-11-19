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

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

// A plan's badge normally draws its LETTER in the plan colour over a faint
// tint of that colour, which only reads when the colour is light enough to
// read on Slate's near-black. A profile that also names a `textColor` asks for
// the other look (2026-11-03, the X plan: "black color theme with white
// font"): the chip is filled solid with the plan colour and every foreground
// (letter, launch label, meter donut) takes the text colour, with a faint
// outline in the text colour so a dark chip still has an edge. The extra
// properties are set ONLY then, so every CSS rule reads them with the plain
// look as its fallback and an ordinary profile renders exactly as before.
function profileStyle(profile) {
  if (!profile?.color) return {};
  const style = {
    '--profile-color': profile.color,
    '--profile-rgb': hexToRgb(profile.color),
  };
  if (HEX_COLOR.test(String(profile.textColor || '').trim())) {
    const ink = profile.textColor.trim();
    style['--profile-fg'] = ink;
    style['--profile-fill'] = profile.color;
    style['--profile-edge'] = `rgb(${hexToRgb(ink)} / 30%)`;
  }
  return style;
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

// The plans the rail can launch. Pat, 2026-10-29, with six Claude plans and
// three codex plans: "remove all the buttons in the side panel except for the
// claude plan buttons ... keep one 'o' button for other and have that be my way
// of opening a session for another plan (one of the codex/cursor ones) via the
// modal". So the rail launches every Claude plan directly and folds every other
// plan into one "Other" entry that opens the Session configuration window,
// preselected on the first other provider in the list, whose Plan picker reaches
// every remaining home.
//
// One button per Claude plan stopped fitting at eleven buttons (2026-11-19, the
// last squeeze: the "Sessions" label and the buttons share one line, Pat
// 2026-09-05). Adding the eleventh and twelfth Claude plans the same day, Pat
// asked to "start to think the 'one button per claude plan' ui and do like a
// 'picker' or little hover window". The rail now draws ONE split button however
// many plans exist (the Windows Terminal new-tab pattern): "+<letter>" starts the
// plan picked last (railPrimaryPlan), and the chevron opens the plan picker, one
// row per Claude plan with its usage, then the "Other" row.
function railLaunchPlan(profiles) {
  const list = Array.isArray(profiles) ? profiles : [];
  const isClaude = (profile) => (profile.provider || 'claude') === 'claude';
  const direct = list.filter(isClaude);
  const firstOther = list.find((profile) => !isClaude(profile)) || null;
  return { direct, otherProvider: firstOther ? firstOther.provider : null };
}

// The plan the split button's "+" starts: the plan picked last in the picker
// while it is still a Claude plan, else the default plan, else the first Claude
// plan. Null only when no Claude plan is configured.
function railPrimaryPlan(direct, rememberedId) {
  const list = Array.isArray(direct) ? direct : [];
  if (!list.length) return null;
  return list.find((profile) => profile.id === rememberedId)
    || list.find((profile) => profile.isDefault)
    || list[0];
}

// A key pressed in the open plan picker: a Claude plan's letter starts that plan,
// and "O" starts Other unless a Claude plan owns the letter O. Case-insensitive.
// Returns { profile }, { other: true }, or null for any other key.
function planForKey(direct, key, hasOther) {
  if (typeof key !== 'string' || [...key].length !== 1) return null;
  const letter = key.toUpperCase();
  const profile = (Array.isArray(direct) ? direct : [])
    .find((item) => String(item.letter || '').toUpperCase() === letter);
  if (profile) return { profile };
  if (hasOther && letter === 'O') return { other: true };
  return null;
}

// The rail's default width. It followed the number of launch buttons until
// 2026-11-19; the head now holds one split button whatever the plan count, so it
// is one number: 292px, the measured width at which the worst-case usage meter
// row ("100% ↻11:45pm  100% ↻12/31 12:30pm") renders in full.
const RAIL_DEFAULT_WIDTH = 292;

module.exports = {
  hexToRgb,
  resolveProfile,
  defaultProfile,
  defaultProfileId,
  normalizeHome,
  profileStyle,
  resumeCommandForProfile,
  launchDefaults,
  railLaunchPlan,
  railPrimaryPlan,
  planForKey,
  RAIL_DEFAULT_WIDTH,
};
