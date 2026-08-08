'use strict';

// The first-run wizard's whole brain. Every decision the wizard makes lives
// here as a pure function so the UI cannot drift from the rules the tests pin:
// which step comes next, whether Next may be enabled, what the seeded defaults
// are, and the exact config object that gets written at Finish.
//
// Two rules shape all of it.
//
// 1. NEXT IS DISABLED, NEVER SKIPPED-INTO. This repo's doctrine is explicit
//    that a skippable step into a dead end is the failure and that nicer copy
//    is not a guard, so `stepValidation` returns real field-level errors and
//    `canAdvance` is derived from them rather than from a hand-maintained
//    boolean. A step that is genuinely OPTIONAL is modelled as a step whose
//    validation passes when it is turned off, not as a step the user may skip
//    while it is half-filled.
//
// 2. NO CREDENTIAL EVER ENTERS THIS STATE. There is no field here for an API
//    key, a token or a password, and none may be added. Claude, codex and
//    cursor each own their own auth; the wizard points at config homes and
//    launches the vendors' own login flows. The only auth-shaped value we ever
//    hold is an email address READ BACK from a home's .claude.json, which is
//    confirmation of what the user picked, not a secret.

// Seeded profile identity. Pat's install is P/T/S with the rail colors the
// portability inventory recorded, and the batch is explicit that those are
// DEFAULTS and never hardcoded: seeds apply by index, and a fourth profile
// derives its letter from its own label and cycles the palette, so nothing
// about the wizard assumes three plans or those three letters.
// The ids are deliberately GENERIC, and there is ONE generic word for the third
// slot rather than three. `personal` and `team` are ordinary English and
// `personal` is load-bearing (config/homes.js maps the bare `.claude` to it);
// the third seed used to be a real person's first name, which is meaningless on
// any machine but one, and briefly became `third` here while the reference
// oracle and the stylesheet called the same slot `plan3`. A home whose folder
// name carries a better id (detection derives one from the directory) still
// wins over all of these.
const PROFILE_SEEDS = [
  { id: 'personal', label: 'Personal', letter: 'P', color: '#6fa8d8' },
  { id: 'team', label: 'Team', letter: 'T', color: '#d68a5a' },
  { id: 'plan3', label: 'Plan 3', letter: 'S', color: '#F962BA' },
];
const EXTRA_COLORS = ['#7bd3a0', '#c9a6ff', '#e8973f', '#79a6ff'];

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
// A profile id becomes a config key and a rail selector, so it is restricted to
// what is safe in both rather than trusted from a text field.
const PROFILE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

const STEPS = [
  { id: 'platform', title: 'Welcome', subtitle: 'What Harbor found on this machine' },
  { id: 'claude', title: 'Claude plans', subtitle: 'Config homes and the account in each' },
  { id: 'providers', title: 'Codex and Cursor', subtitle: 'Other agent CLIs' },
  { id: 'catalog', title: 'Commands', subtitle: 'Your skills and slash commands' },
  { id: 'symlinks', title: 'Shared config', subtitle: 'Optional: share settings across homes' },
  { id: 'orchestration', title: 'Orchestration', subtitle: 'Optional: the Orch view' },
  { id: 'defaults', title: 'Defaults', subtitle: 'New sessions, then review and finish' },
];

const STEP_IDS = STEPS.map((step) => step.id);

function stepIndex(id) {
  const index = STEP_IDS.indexOf(id);
  return index === -1 ? 0 : index;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function err(field, message) {
  return { field, message };
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

// Turn one detected config home into a profile row. `index` only picks the
// SEED (letter, color, label); everything stays editable afterwards, and a home
// past the seed list derives its own identity instead of reusing a seed.
function seedProfile(home, index, existingIds = []) {
  const seed = PROFILE_SEEDS[index];
  const detectedId = home?.id || null;
  const fallbackLabel = home?.label || `Plan ${index + 1}`;
  const label = seed ? seed.label : fallbackLabel;
  const baseId = detectedId || seed?.id || slugId(label) || `plan-${index + 1}`;
  return {
    id: uniqueId(baseId, existingIds),
    label,
    letter: seed ? seed.letter : firstLetter(label),
    color: seed ? seed.color : EXTRA_COLORS[(index - PROFILE_SEEDS.length) % EXTRA_COLORS.length],
    provider: 'claude',
    configHome: home?.path || '',
    email: home?.email ?? null,
    authed: Boolean(home?.email),
    exists: home?.exists !== false,
    isDefault: index === 0,
  };
}

function slugId(label) {
  return String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function firstLetter(label) {
  const match = String(label || '').match(/[a-zA-Z0-9]/);
  return match ? match[0].toUpperCase() : '?';
}

function uniqueId(base, taken) {
  const clean = slugId(base) || 'plan';
  if (!taken.includes(clean)) return clean;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${clean}-${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${clean}-${Date.now()}`;
}

// A RE-RUN OPENS ON WHAT THE USER ALREADY CHOSE, and until 2026-08-07 it did
// not. Only two of the seven steps read the saved config; every other step
// reseeded from fresh detection, and because Finish REPLACES `profiles`,
// `platform` and `newSessionDefaults` wholesale rather than merging, opening the
// wizard to change one thing silently reverted a custom profile id, label, badge
// letter, colour, a hand-corrected herdr path, and the new-session model and
// effort, then wrote the reversion to disk. "Reopen it to change one thing" is
// the only reason the app menu has that entry.
//
// Saved values win on identity (id, label, letter, colour, default, paths);
// DETECTION still wins on liveness (is the binary there, is that home signed in,
// what is the account email), because those are facts about the machine right
// now and not choices. A home the user has since created is still offered as a
// new row, so re-running the wizard remains the way to add a plan.
function mergeSavedProfiles(saved, homes) {
  const byHome = new Map(homes.filter((home) => home?.path).map((home) => [home.path, home]));
  // CLAIMED, not deleted. Deleting inside the map made a second saved row
  // pointing at the SAME config home (an ordinary shape after a hand-edit) miss
  // its live match and render as "folder does not exist" next to a row saying
  // the folder is signed in. Every row reads the live facts; the claimed set
  // only decides which homes are NEW enough to offer as extra rows below.
  const claimed = new Set();
  const rows = saved.map((profile) => {
    const live = byHome.get(profile.configHome) || null;
    if (live) claimed.add(profile.configHome);
    return {
      id: profile.id,
      label: profile.label,
      letter: profile.letter,
      color: profile.color,
      provider: 'claude',
      configHome: profile.configHome,
      // No live match means detection did not find that directory at all, so
      // nothing about the ACCOUNT is known any more. Carrying the saved email
      // forward would render a deleted config home as a signed-in plan, which
      // is precisely the confident-looking wrong value this wizard exists to
      // refuse. The path stays, because it is what the user chose and what they
      // need to see in order to fix it.
      email: live ? (live.email ?? null) : null,
      authed: live ? Boolean(live.email) : false,
      exists: live ? live.exists !== false : false,
      reason: live ? (live.reason ?? null) : 'folder does not exist',
      isDefault: Boolean(profile.isDefault),
    };
  });
  const ids = rows.map((row) => row.id);
  for (const home of byHome.values()) {
    if (claimed.has(home.path)) continue;
    const row = seedProfile(home, rows.length, ids);
    row.isDefault = false;
    ids.push(row.id);
    rows.push(row);
  }
  if (rows.length && !rows.some((row) => row.isDefault)) rows[0].isDefault = true;
  return rows;
}

// The wizard's opening state, built from what detection actually found. Nothing
// here is a guess: a value detection could not determine arrives null and the
// screen says so rather than showing a confident default.
function initialState(detected = {}, config = null) {
  const homes = Array.isArray(detected.claudeHomes) ? detected.claudeHomes : [];
  const completed = Boolean(config?.setup?.completed);
  const savedProfiles = completed && Array.isArray(config?.profiles) ? config.profiles : [];
  const savedClaude = savedProfiles.filter((profile) => profile?.provider === 'claude');
  const savedCodex = savedProfiles.filter((profile) => profile?.provider === 'codex');
  const savedCursor = savedProfiles.find((profile) => profile?.provider === 'cursor') || null;
  const ids = [];
  const profiles = savedClaude.length
    ? mergeSavedProfiles(savedClaude, homes)
    : homes.map((home, index) => {
      const profile = seedProfile(home, index, ids);
      ids.push(profile.id);
      return profile;
    });
  const codexFound = detected.providers?.codex?.found;
  const cursorFound = detected.providers?.cursor?.found;
  return {
    platform: {
      os: detected.os || null,
      // A saved binary path is a CHOICE (the user may have pointed Harbor at a
      // second install); found/version/socketRequired stay detection, because
      // they describe the machine rather than the decision.
      herdrBin: (completed && config?.platform?.herdrBin) || detected.herdr?.path || '',
      herdrVersion: detected.herdr?.version || null,
      herdrFound: Boolean(detected.herdr?.found),
      herdrSocket: (completed && config?.platform?.herdrSocket) || detected.herdr?.socket || '',
      socketRequired: Boolean(detected.herdr?.socketRequired),
      shell: (completed && config?.platform?.shell) || detected.shell || '',
    },
    claude: {
      // A first run with no ~/.claude at all starts with zero rows, because
      // zero Claude plans is a supported path (codex-only or cursor-only).
      profiles,
      bin: (completed && config?.providers?.claude?.bin) || detected.providers?.claude?.path || '',
    },
    codex: {
      // Enabled only when the binary is actually there. An install that has no
      // codex must not open on a toggle that promises one. On a re-run the
      // user's own answer outranks that, because they may have turned codex off
      // on purpose while the binary is still installed.
      enabled: completed ? Boolean(config?.providers?.codex?.enabled) : Boolean(codexFound),
      bin: (completed && config?.providers?.codex?.bin) || detected.providers?.codex?.path || '',
      accounts: savedCodex.length
        ? savedCodex.map((profile) => ({
          id: profile.id,
          label: profile.label,
          letter: profile.letter || 'C',
          color: profile.color || '#7bd3a0',
          configHome: profile.configHome,
          email: profile.email ?? null,
        }))
        : (codexFound ? [seedCodexAccount(detected, 0)] : []),
    },
    cursor: {
      enabled: completed ? Boolean(config?.providers?.cursor?.enabled) : Boolean(cursorFound),
      bin: (completed && config?.providers?.cursor?.bin) || detected.providers?.cursor?.path || '',
      // Same reasoning as the codex home below: pre-fill the conventional
      // location so an enabled provider does not open on a blocked field.
      configHome: savedCursor?.configHome
        || detected.providers?.cursor?.home
        || (cursorFound && detected.homedir ? `${detected.homedir}/.cursor` : ''),
    },
    // On a RE-RUN, seeded from what is already saved, because Finish REPLACES
    // config.workflows with whatever this list holds and starting empty would
    // silently erase every quick command the user had. On a FIRST run it starts
    // empty, because the config schema ships a default workflow entry and
    // seeding from that would hand a brand-new install a quick command somebody
    // else chose. Same `setup.completed` distinction the orchestration step
    // makes: before it is set, the config holds defaults, not decisions.
    catalog: {
      workflows: config?.setup?.completed
        ? (config.workflows || []).map((entry) => ({ ...entry }))
        : [],
      loaded: false,
    },
    symlinks: {
      // Default OFF, as specified. It rewrites files inside config homes, and
      // an opt-out default is the only safe posture for that.
      enabled: false,
      primary: profiles[0]?.configHome || '',
      targets: profiles.slice(1).map((profile) => profile.configHome).filter(Boolean),
      entries: [],
    },
    orchestration: {
      // A RE-RUN honours what the user chose last time; a FIRST run derives it
      // from whether the launcher is actually on disk. It cannot simply read
      // config.orchestration.enabled, because the config schema defaults that
      // to true, so a fresh machine with no launcher would open with the Orch
      // view enabled and nothing behind it. `setup.completed` is what tells the
      // two cases apart: before it is set, the config holds schema defaults
      // rather than anybody's decision.
      enabled: config?.setup?.completed
        ? Boolean(config.orchestration?.enabled)
        : Boolean(detected.orchestration?.found),
      launcher: config?.orchestration?.launcher || detected.orchestration?.launcher || '',
      researchCommand: config?.orchestration?.researchCommand || '/orchestrate-research',
      executionCommand: config?.orchestration?.executionCommand || '/orchestrate-execution',
    },
    // A re-run opens on the defaults the user actually saved. This used to be
    // hardcoded either way, so somebody who set sonnet/medium saw opus/xhigh on
    // re-open and Finish wrote that back over their choice.
    defaults: {
      provider: (completed && config?.newSessionDefaults?.provider)
        || (profiles.length ? 'claude' : (codexFound ? 'codex' : 'cursor')),
      model: (completed && config?.newSessionDefaults?.model)
        || (profiles.length ? 'opus' : 'default'),
      effort: (completed && config?.newSessionDefaults?.effort)
        || (profiles.length ? 'xhigh' : 'medium'),
    },
  };
}

// A codex home that detection did not find is pre-filled with the conventional
// location rather than left empty. That is not the confident guess this wizard
// refuses to make: the DETECTION still reports honestly that the folder is not
// there, and this is an editable field carrying the path codex itself will
// create on first run. Leaving it blank instead meant a machine with codex
// installed but never run opened step 3 already blocked on a required field,
// which is friction with nothing to learn from it.
function seedCodexAccount(detected, index) {
  const found = detected.providers?.codex?.home;
  const conventional = detected.homedir ? `${detected.homedir}/.codex` : '';
  return {
    id: index === 0 ? 'codex' : `codex-${index + 1}`,
    label: index === 0 ? 'Codex' : `Codex ${index + 1}`,
    letter: 'C',
    color: '#7bd3a0',
    configHome: found || (index === 0 ? conventional : ''),
    email: detected.providers?.codex?.email ?? null,
  };
}

// ---------------------------------------------------------------------------
// Validation. One function per step; canAdvance is DERIVED from it so the
// button state and the error list can never disagree.
// ---------------------------------------------------------------------------

// HERDR IS NOT REQUIRED TO FINISH SETUP, and requiring it was a first screen
// that blocked on a daemon most users will never install. Harbor's own session
// daemon is the default backend; Herdr is the fallback behind
// `HARBOR_SESSION_BACKEND=herdr`. An empty herdr path is now a supported answer,
// so the only thing left to validate is the ONE case where a value is genuinely
// unguessable: the Windows named pipe, and only once a herdr path has been
// supplied, because a user who is not using that backend has no pipe to give.
function validatePlatform(state) {
  const errors = [];
  const { platform } = state;
  if (platform.socketRequired && isNonEmptyString(platform.herdrBin) && !isNonEmptyString(platform.herdrSocket)) {
    errors.push(err('herdrSocket', 'Windows needs the Herdr named pipe explicitly: upstream publishes no stable default to fall back on.'));
  }
  return { ok: errors.length === 0, errors };
}

function validateClaude(state) {
  const errors = [];
  const profiles = state.claude.profiles || [];
  // Zero Claude plans is VALID: a codex-only or cursor-only install is a
  // supported shape, and the total-account floor is enforced on the providers
  // step where the total is actually known.
  const seenIds = new Set();
  const seenHomes = new Set();
  profiles.forEach((profile, index) => {
    const at = `profiles.${index}`;
    if (!isNonEmptyString(profile.configHome)) {
      errors.push(err(`${at}.configHome`, 'Pick the config home folder for this plan.'));
    } else if (seenHomes.has(profile.configHome)) {
      errors.push(err(`${at}.configHome`, 'Two plans cannot share one config home; each plan needs its own .claude.json.'));
    } else {
      seenHomes.add(profile.configHome);
    }
    if (!isNonEmptyString(profile.label)) errors.push(err(`${at}.label`, 'Give this plan a name.'));
    if (!isNonEmptyString(profile.id)) {
      errors.push(err(`${at}.id`, 'Give this plan an id.'));
    } else if (!PROFILE_ID_RE.test(profile.id)) {
      errors.push(err(`${at}.id`, 'Ids may use lowercase letters, numbers and dashes, and must start with a letter or number.'));
    } else if (seenIds.has(profile.id)) {
      errors.push(err(`${at}.id`, 'Plan ids must be unique.'));
    } else {
      seenIds.add(profile.id);
    }
    if (!isNonEmptyString(profile.letter) || [...String(profile.letter)].length !== 1) {
      errors.push(err(`${at}.letter`, 'The rail badge is exactly one character.'));
    }
    if (!HEX_COLOR_RE.test(String(profile.color || ''))) {
      errors.push(err(`${at}.color`, 'Pick a color in #rrggbb form.'));
    }
  });
  if (profiles.length && profiles.filter((profile) => profile.isDefault).length !== 1) {
    errors.push(err('profiles.default', 'Choose exactly one plan as the default.'));
  }
  return { ok: errors.length === 0, errors };
}

function validateProviders(state) {
  const errors = [];
  if (state.codex.enabled) {
    if (!isNonEmptyString(state.codex.bin)) {
      errors.push(err('codex.bin', 'Enter the codex binary path, or turn Codex off.'));
    }
    const seen = new Set();
    (state.codex.accounts || []).forEach((account, index) => {
      if (!isNonEmptyString(account.label)) errors.push(err(`codex.accounts.${index}.label`, 'Name this Codex account.'));
      if (!isNonEmptyString(account.configHome)) {
        errors.push(err(`codex.accounts.${index}.configHome`, 'Point at this account’s codex home folder.'));
      } else if (seen.has(account.configHome)) {
        errors.push(err(`codex.accounts.${index}.configHome`, 'Two Codex accounts cannot share one home folder.'));
      } else {
        seen.add(account.configHome);
      }
    });
  }
  if (state.cursor.enabled && !isNonEmptyString(state.cursor.bin)) {
    errors.push(err('cursor.bin', 'Enter the cursor-agent binary path, or turn Cursor off.'));
  }
  // The floor the whole app rests on: Harbor with no account at all has
  // nothing to show and nothing to drive, so this is the one thing the wizard
  // will not let the user finish without.
  if (accountCount(state) === 0) {
    errors.push(err('accounts', 'Harbor needs at least one account. Add a Claude plan on the previous step, or enable Codex or Cursor here.'));
  }
  return { ok: errors.length === 0, errors };
}

function accountCount(state) {
  return (state.claude.profiles || []).length
    + (state.codex.enabled ? Math.max(1, (state.codex.accounts || []).length) : 0)
    + (state.cursor.enabled ? 1 : 0);
}

function validateCatalog(state) {
  const errors = [];
  const seen = new Set();
  (state.catalog.workflows || []).forEach((entry, index) => {
    if (!isNonEmptyString(entry.command)) {
      errors.push(err(`catalog.workflows.${index}.command`, 'A quick command needs the command to run.'));
    }
    if (!isNonEmptyString(entry.label)) {
      errors.push(err(`catalog.workflows.${index}.label`, 'Give this quick command a label.'));
    }
    if (!isNonEmptyString(entry.id)) {
      errors.push(err(`catalog.workflows.${index}.id`, 'A quick command needs an id.'));
    } else if (seen.has(entry.id)) {
      errors.push(err(`catalog.workflows.${index}.id`, 'Quick command ids must be unique.'));
    } else {
      seen.add(entry.id);
    }
  });
  // Picking nothing is fine. The step is genuinely optional and an empty list
  // simply means no quick commands, which is a working app.
  return { ok: errors.length === 0, errors };
}

function validateSymlinks(state) {
  const errors = [];
  if (!state.symlinks.enabled) return { ok: true, errors };
  if (!isNonEmptyString(state.symlinks.primary)) {
    errors.push(err('symlinks.primary', 'Choose which home holds the real files.'));
  }
  const targets = (state.symlinks.targets || []).filter(isNonEmptyString);
  if (!targets.length) {
    errors.push(err('symlinks.targets', 'Choose at least one home to share into, or turn sharing off.'));
  }
  if (targets.includes(state.symlinks.primary)) {
    errors.push(err('symlinks.targets', 'The home that holds the real files cannot also link to itself.'));
  }
  if (new Set(targets).size !== targets.length) {
    errors.push(err('symlinks.targets', 'Each home can only be linked once.'));
  }
  return { ok: errors.length === 0, errors };
}

function validateOrchestration(state) {
  const errors = [];
  if (!state.orchestration.enabled) return { ok: true, errors };
  if (!isNonEmptyString(state.orchestration.launcher)) {
    errors.push(err('orchestration.launcher', 'Orchestration launches panes through a launcher script; enter its path.'));
  }
  for (const key of ['researchCommand', 'executionCommand']) {
    const value = state.orchestration[key];
    if (!isNonEmptyString(value)) {
      errors.push(err(`orchestration.${key}`, 'Enter the slash command name.'));
    } else if (!String(value).trim().startsWith('/')) {
      errors.push(err(`orchestration.${key}`, 'A slash command starts with /.'));
    }
  }
  return { ok: errors.length === 0, errors };
}

function enabledProviders(state) {
  const out = [];
  if ((state.claude.profiles || []).length) out.push('claude');
  if (state.codex.enabled) out.push('codex');
  if (state.cursor.enabled) out.push('cursor');
  return out;
}

function validateDefaults(state) {
  const errors = [];
  const providers = enabledProviders(state);
  if (!providers.includes(state.defaults.provider)) {
    errors.push(err('defaults.provider', 'Pick a provider you actually enabled.'));
  }
  if (!isNonEmptyString(state.defaults.model)) {
    errors.push(err('defaults.model', 'Pick the model new sessions start on.'));
  }
  // Cursor exposes no effort levels, so demanding one there would be a dead
  // end invented by this screen.
  if (state.defaults.provider !== 'cursor') {
    const allowed = state.defaults.provider === 'codex'
      ? ['low', 'medium', 'high', 'xhigh']
      : ['default', ...EFFORT_LEVELS];
    if (!allowed.includes(state.defaults.effort)) {
      errors.push(err('defaults.effort', 'Pick an effort level this provider supports.'));
    }
  }
  return { ok: errors.length === 0, errors };
}

const VALIDATORS = {
  platform: validatePlatform,
  claude: validateClaude,
  providers: validateProviders,
  catalog: validateCatalog,
  symlinks: validateSymlinks,
  orchestration: validateOrchestration,
  defaults: validateDefaults,
};

function stepValidation(stepId, state) {
  const validator = VALIDATORS[stepId];
  if (!validator) return { ok: true, errors: [] };
  return validator(state);
}

// Next is enabled by this and nothing else, so the button and the error list
// are the same fact rendered twice rather than two facts that can disagree.
function canAdvance(stepId, state) {
  return stepValidation(stepId, state).ok;
}

// Finish requires EVERY step to be valid, not just the last one: a user who
// walks back and breaks step 2 must not be able to write from step 7.
function blockingSteps(state) {
  return STEP_IDS.filter((id) => !stepValidation(id, state).ok);
}

function canFinish(state) {
  return blockingSteps(state).length === 0;
}

function nextStep(stepId) {
  const index = stepIndex(stepId);
  return STEP_IDS[Math.min(index + 1, STEP_IDS.length - 1)];
}

function previousStep(stepId) {
  const index = stepIndex(stepId);
  return STEP_IDS[Math.max(index - 1, 0)];
}

// ---------------------------------------------------------------------------
// Config assembly
// ---------------------------------------------------------------------------

// The exact object the review screen shows and Finish writes. It is built by
// merging onto the config already on disk so a RE-RUN of the wizard edits the
// user's config rather than resetting every field the wizard does not cover.
//
// The one structural decision worth naming: a codex or cursor account is a
// PROFILE with that provider, not a separate list. The batch-7 schema requires
// a non-empty profiles array where every profile carries a `provider`, which is
// exactly this shape, so a zero-Claude install writes a valid config instead of
// needing the schema forked.
function configFromWizard(state, base = {}, meta = {}) {
  const profiles = [];
  for (const profile of state.claude.profiles || []) {
    profiles.push({
      id: profile.id,
      label: profile.label,
      letter: profile.letter,
      color: profile.color,
      provider: 'claude',
      configHome: profile.configHome,
      email: profile.email ?? null,
      isDefault: Boolean(profile.isDefault),
    });
  }
  if (state.codex.enabled) {
    for (const account of state.codex.accounts || []) {
      profiles.push({
        id: account.id,
        label: account.label,
        letter: account.letter || 'C',
        color: account.color || '#7bd3a0',
        provider: 'codex',
        configHome: account.configHome,
        email: account.email ?? null,
        isDefault: false,
      });
    }
  }
  if (state.cursor.enabled) {
    profiles.push({
      id: 'cursor',
      label: 'Cursor',
      letter: 'U',
      color: '#a78bfa',
      provider: 'cursor',
      configHome: state.cursor.configHome,
      email: null,
      isDefault: false,
    });
  }
  // validateConfig requires a non-empty list, and validateProviders already
  // refuses a zero-account finish, so this only ever fires on a caller that
  // skipped validation.
  if (profiles.length && !profiles.some((profile) => profile.isDefault)) {
    profiles[0].isDefault = true;
  }

  return {
    ...base,
    version: base.version ?? 1,
    setup: {
      completed: true,
      completedAt: meta.completedAt ?? null,
      appVersion: meta.appVersion ?? base?.setup?.appVersion ?? null,
    },
    platform: {
      ...(base.platform || {}),
      os: state.platform.os,
      herdrBin: state.platform.herdrBin.trim(),
      herdrSocket: isNonEmptyString(state.platform.herdrSocket)
        ? state.platform.herdrSocket.trim()
        : (base.platform?.herdrSocket ?? null),
      shell: isNonEmptyString(state.platform.shell)
        ? state.platform.shell.trim()
        : (base.platform?.shell ?? null),
    },
    profiles,
    providers: {
      ...(base.providers || {}),
      claude: {
        enabled: (state.claude.profiles || []).length > 0,
        bin: isNonEmptyString(state.claude.bin) ? state.claude.bin.trim() : 'claude',
      },
      codex: {
        enabled: Boolean(state.codex.enabled),
        bin: isNonEmptyString(state.codex.bin) ? state.codex.bin.trim() : 'codex',
      },
      cursor: {
        enabled: Boolean(state.cursor.enabled),
        bin: isNonEmptyString(state.cursor.bin) ? state.cursor.bin.trim() : 'cursor-agent',
      },
    },
    workflows: (state.catalog.workflows || []).map((entry) => ({
      id: entry.id,
      label: entry.label,
      command: entry.command,
      cwd: entry.cwd || 'current',
      profile: entry.profile || 'current',
      provider: entry.provider || 'current',
      model: entry.model || 'current',
      effort: entry.effort || 'current',
    })),
    orchestration: {
      ...(base.orchestration || {}),
      enabled: Boolean(state.orchestration.enabled),
      launcher: state.orchestration.enabled
        ? state.orchestration.launcher.trim()
        : (base.orchestration?.launcher ?? null),
      researchCommand: state.orchestration.researchCommand.trim(),
      executionCommand: state.orchestration.executionCommand.trim(),
    },
    newSessionDefaults: {
      provider: state.defaults.provider,
      model: state.defaults.model,
      effort: state.defaults.provider === 'cursor' ? 'default' : state.defaults.effort,
    },
  };
}

// The symlink plan the apply step sends to main. Kept here so the screen can
// show exactly what will be linked before anything is touched.
const SHARED_ENTRIES = [
  { name: 'CLAUDE.md', kind: 'file' },
  { name: 'settings.json', kind: 'file' },
  { name: 'settings.local.json', kind: 'file' },
  { name: 'commands', kind: 'dir' },
  { name: 'skills', kind: 'dir' },
  { name: 'projects', kind: 'dir' },
];
// The split IS the safety property: these stay real files per home, because
// they are what makes each home a DIFFERENT account. Linking them would point
// every plan at one login.
const NEVER_SHARED = ['.credentials.json', '.claude.json'];

function symlinkPlan(state) {
  if (!state.symlinks.enabled) return { entries: [], primary: null, targets: [] };
  const chosen = (state.symlinks.entries || []).length
    ? state.symlinks.entries
    : SHARED_ENTRIES.map((entry) => entry.name);
  return {
    primary: state.symlinks.primary,
    targets: (state.symlinks.targets || []).filter(isNonEmptyString),
    entries: SHARED_ENTRIES.filter((entry) => chosen.includes(entry.name)),
  };
}

// ---------------------------------------------------------------------------
// State transitions the UI drives. Pure so the tests can walk a whole path.
// ---------------------------------------------------------------------------

function addProfile(state, home = {}) {
  const profiles = state.claude.profiles || [];
  const ids = profiles.map((profile) => profile.id);
  const profile = seedProfile(home, profiles.length, ids);
  if (profiles.length === 0) profile.isDefault = true;
  else profile.isDefault = false;
  return { ...state, claude: { ...state.claude, profiles: [...profiles, profile] } };
}

function updateProfile(state, index, patch) {
  const profiles = (state.claude.profiles || []).map((profile, i) => (
    i === index ? { ...profile, ...patch } : profile
  ));
  // Exactly one default, always: setting one clears the rest in the same move,
  // so the invariant can never be briefly false in the rendered state.
  if (patch.isDefault === true) {
    for (let i = 0; i < profiles.length; i += 1) profiles[i].isDefault = i === index;
  }
  return { ...state, claude: { ...state.claude, profiles } };
}

function removeProfile(state, index) {
  const profiles = (state.claude.profiles || []).filter((_, i) => i !== index);
  if (profiles.length && !profiles.some((profile) => profile.isDefault)) profiles[0].isDefault = true;
  const next = { ...state, claude: { ...state.claude, profiles } };
  // Removing the last Claude plan must not strand a claude default nobody can
  // serve, so the defaults step follows the accounts that remain.
  return reconcileDefaults(next);
}

// After any change to which providers exist, pull newSessionDefaults back onto
// something real. Without this, disabling a provider left the last step in a
// permanently invalid state the user had to discover for themselves.
function reconcileDefaults(state) {
  const providers = enabledProviders(state);
  if (!providers.length || providers.includes(state.defaults.provider)) return state;
  const provider = providers[0];
  const model = provider === 'claude' ? 'opus' : 'default';
  const effort = provider === 'claude' ? 'xhigh' : (provider === 'codex' ? 'medium' : 'default');
  return { ...state, defaults: { provider, model, effort } };
}

// The sharing step's source and targets are SEEDED from the homes that existed
// when the wizard opened, and the user can then edit, remove or re-point those
// homes on step 2. Without this, a target could keep naming a folder that is no
// longer a configured plan, and the apply step would happily link into it: real
// writes into a home the user had already removed from the config. So the
// selection is pruned to the homes that actually exist on every change, which
// is why it runs from the same place reconcileDefaults does.
function reconcileSymlinks(state) {
  const homes = (state.claude.profiles || []).map((profile) => profile.configHome).filter(Boolean);
  const known = new Set(homes);
  const targets = (state.symlinks.targets || []).filter((target) => known.has(target));
  const primary = known.has(state.symlinks.primary) ? state.symlinks.primary : (homes[0] || '');
  if (primary === state.symlinks.primary && targets.length === (state.symlinks.targets || []).length) {
    return state;
  }
  return {
    ...state,
    symlinks: { ...state.symlinks, primary, targets: targets.filter((target) => target !== primary) },
  };
}

module.exports = {
  STEPS,
  STEP_IDS,
  PROFILE_SEEDS,
  EFFORT_LEVELS,
  SHARED_ENTRIES,
  NEVER_SHARED,
  stepIndex,
  initialState,
  seedProfile,
  seedCodexAccount,
  stepValidation,
  canAdvance,
  canFinish,
  blockingSteps,
  nextStep,
  previousStep,
  accountCount,
  enabledProviders,
  configFromWizard,
  symlinkPlan,
  addProfile,
  updateProfile,
  removeProfile,
  reconcileDefaults,
  reconcileSymlinks,
};
