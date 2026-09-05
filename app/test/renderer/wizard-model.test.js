'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const model = require('../../src/renderer/setup/wizard-model.cjs');
const { validateConfig } = require('../../src/main/config/schema.js');
const { deriveDefaults } = require('../../src/main/config/defaults.js');

// A synthetic machine. Detection is injected everywhere, so the model can be
// walked end to end without touching the real one.
function detectedLinux(overrides = {}) {
  return {
    os: 'linux',
    osLabel: 'Linux',
    homedir: '/home/tester',
    shell: '/bin/bash',
    symlinkStyle: 'symlink',
    providers: {
      claude: { found: true, path: '/home/tester/.local/bin/claude' },
      codex: { found: false, path: null, home: null },
      cursor: { found: false, path: null, home: null },
    },
    claudeHomes: [
      { id: 'personal', path: '/home/tester/.claude', exists: true, authed: true, email: 'a@example.com' },
    ],
    orchestration: { launcher: '', found: false },
    ...overrides,
  };
}

// The runtime deriveDefaults needs, kept hermetic: no real HOME, no real PATH,
// no real provider paths. A test that reads the real machine is a test that passes or
// fails by whose machine it runs on.
function runtime() {
  return {
    env: { PATH: '', SHELL: '/bin/bash' },
    homedir: '/home/tester',
    platform: 'linux',
    findBinary: (name) => name,
  };
}

test('initialState seeds one profile per detected home and nothing else', () => {
  const state = model.initialState(detectedLinux());
  assert.equal(state.claude.profiles.length, 1);
  assert.equal(state.claude.profiles[0].configHome, '/home/tester/.claude');
  assert.equal(state.claude.profiles[0].email, 'a@example.com');
  assert.equal(state.claude.profiles[0].isDefault, true);
  // Nothing is enabled that was not found: an install with no codex must not
  // open on a toggle promising one.
  assert.equal(state.codex.enabled, false);
  assert.equal(state.cursor.enabled, false);
  // Sharing config rewrites files inside config homes, so it is off unless asked.
  assert.equal(state.symlinks.enabled, false);
});

test('a machine where detection found nothing still produces a usable state', () => {
  const state = model.initialState({});
  assert.equal(state.claude.profiles.length, 0);
  assert.equal(state.platform.os, null);
  // And it advances, because the included session daemon requires no setup, so
  // a machine with nothing detected is an
  // ordinary first run rather than a blocked one. The floor that does exist is
  // one account overall, and it is enforced on the providers step where the
  // total is actually known.
  assert.equal(model.canAdvance('platform', state), true);
  assert.equal(model.canAdvance('providers', state), false, 'zero accounts anywhere is still refused');
});

test('seeded identity is P/T/S by index and derived past the seeds', () => {
  let state = model.initialState({});
  for (const home of ['/h/.claude', '/h/.claude-team', '/h/.claude-plan3', '/h/.claude-fourth']) {
    state = model.addProfile(state, { path: home, label: 'Fourth plan' });
  }
  assert.deepEqual(state.claude.profiles.map((profile) => profile.letter), ['P', 'T', 'S', 'F']);
  // The fourth is not a seed reused; it derives from its own label.
  assert.notEqual(state.claude.profiles[3].color, state.claude.profiles[0].color);
});

// -- step 1 ------------------------------------------------------------------

test('platform: the included session daemon needs no configuration', () => {
  const state = model.initialState(detectedLinux());
  assert.equal(model.canAdvance('platform', state), true);
  assert.deepEqual(model.stepValidation('platform', state).errors, []);
});

// -- step 2 ------------------------------------------------------------------

test('claude: zero plans is valid, but a half-filled plan is not', () => {
  const empty = model.initialState({});
  assert.equal(model.canAdvance('claude', empty), true, 'zero Claude plans is a supported path');

  const added = model.addProfile(empty, {});
  assert.equal(model.canAdvance('claude', added), false, 'a plan with no config home cannot advance');
  assert.match(model.stepValidation('claude', added).errors[0].message, /config home/i);
});

test('claude: duplicate homes, duplicate ids and bad identity each block Next', () => {
  let state = model.initialState({});
  state = model.addProfile(state, { path: '/h/.claude' });
  state = model.addProfile(state, { path: '/h/.claude-team' });
  assert.equal(model.canAdvance('claude', state), true);

  const sameHome = model.updateProfile(state, 1, { configHome: '/h/.claude' });
  assert.equal(model.canAdvance('claude', sameHome), false);
  assert.match(model.stepValidation('claude', sameHome).errors[0].message, /cannot share one config home/);

  const sameId = model.updateProfile(state, 1, { id: state.claude.profiles[0].id });
  assert.equal(model.canAdvance('claude', sameId), false);

  const badLetter = model.updateProfile(state, 0, { letter: 'PT' });
  assert.equal(model.canAdvance('claude', badLetter), false);

  const badColor = model.updateProfile(state, 0, { color: 'blue' });
  assert.equal(model.canAdvance('claude', badColor), false);

  const badId = model.updateProfile(state, 0, { id: 'Not Valid' });
  assert.equal(model.canAdvance('claude', badId), false);
});

test('claude: exactly one default, enforced by the transition not by hope', () => {
  let state = model.initialState({});
  state = model.addProfile(state, { path: '/h/.claude' });
  state = model.addProfile(state, { path: '/h/.claude-team' });
  state = model.updateProfile(state, 1, { isDefault: true });
  assert.deepEqual(state.claude.profiles.map((profile) => profile.isDefault), [false, true]);

  // Removing the default promotes another rather than leaving none.
  const removed = model.removeProfile(state, 1);
  assert.equal(removed.claude.profiles.filter((profile) => profile.isDefault).length, 1);
});

// -- step 3 ------------------------------------------------------------------

test('providers: the zero-account floor is the one thing setup will not allow', () => {
  const state = model.initialState({});
  assert.equal(model.accountCount(state), 0);
  assert.equal(model.canAdvance('providers', state), false);
  assert.match(model.stepValidation('providers', state).errors[0].message, /at least one account/);

  const withCodex = { ...state, codex: { ...state.codex, enabled: true, bin: 'codex', accounts: [model.seedCodexAccount({}, 0)] } };
  // Still blocked: the enabled account has no home yet.
  assert.equal(model.canAdvance('providers', withCodex), false);
  const homed = {
    ...withCodex,
    codex: { ...withCodex.codex, accounts: [{ ...withCodex.codex.accounts[0], configHome: '/h/.codex' }] },
  };
  assert.equal(model.canAdvance('providers', homed), true);
});

test('providers: two codex accounts cannot share one home', () => {
  const base = model.initialState({});
  const state = {
    ...base,
    codex: {
      enabled: true,
      bin: 'codex',
      accounts: [
        { ...model.seedCodexAccount({}, 0), configHome: '/h/.codex' },
        { ...model.seedCodexAccount({}, 1), configHome: '/h/.codex' },
      ],
    },
  };
  assert.equal(model.canAdvance('providers', state), false);
  assert.match(model.stepValidation('providers', state).errors[0].message, /cannot share one home/);
});

// -- step 5 ------------------------------------------------------------------

test('symlinks: off is valid; on demands a source and a distinct target', () => {
  const state = model.initialState(detectedLinux());
  assert.equal(model.canAdvance('symlinks', state), true, 'off is a complete answer');

  const on = { ...state, symlinks: { ...state.symlinks, enabled: true, primary: '/h/.claude', targets: [] } };
  assert.equal(model.canAdvance('symlinks', on), false);

  const selfLink = { ...on, symlinks: { ...on.symlinks, targets: ['/h/.claude'] } };
  assert.equal(model.canAdvance('symlinks', selfLink), false);

  const good = { ...on, symlinks: { ...on.symlinks, targets: ['/h/.claude-team'] } };
  assert.equal(model.canAdvance('symlinks', good), true);
});

test('the sharing selection follows the homes, so it cannot link into a removed one', () => {
  // Caught by the driven wizard: targets are SEEDED from the homes that existed
  // when it opened, and step 2 can then remove or re-point one. Left alone, the
  // apply step would write links into a folder no longer in the config.
  let state = model.initialState({});
  state = model.addProfile(state, { path: '/h/.claude' });
  state = model.addProfile(state, { path: '/h/.claude-team' });
  state = {
    ...state,
    symlinks: { enabled: true, primary: '/h/.claude', targets: ['/h/.claude-team'], entries: [] },
  };
  assert.equal(model.canAdvance('symlinks', state), true);

  const removed = model.reconcileSymlinks(model.removeProfile(state, 1));
  assert.deepEqual(removed.symlinks.targets, [], 'the removed home is no longer a target');
  assert.equal(model.canAdvance('symlinks', removed), false, 'and sharing now honestly has nowhere to go');

  // Re-pointing the PRIMARY home is the same hazard from the other side.
  const repointed = model.reconcileSymlinks(model.updateProfile(state, 0, { configHome: '/h/.claude-moved' }));
  assert.equal(repointed.symlinks.primary, '/h/.claude-moved');
  assert.ok(!repointed.symlinks.targets.includes('/h/.claude'));
});

test('a detected provider binary pre-fills its conventional home, not an empty field', () => {
  // A machine with codex installed but never run has no ~/.codex yet. Opening
  // step 3 already blocked on a required empty field is friction with nothing
  // to learn from it; detection still reports the folder honestly as missing.
  const state = model.initialState({
    homedir: '/home/tester',
    providers: {
      claude: { found: false },
      codex: { found: true, path: '/usr/bin/codex', home: null },
      cursor: { found: true, path: '/usr/bin/cursor-agent', home: null },
    },
  });
  assert.equal(state.codex.enabled, true);
  assert.equal(state.codex.accounts[0].configHome, '/home/tester/.codex');
  assert.equal(state.cursor.configHome, '/home/tester/.cursor');
  assert.equal(model.canAdvance('providers', state), true, 'step 3 opens usable, not blocked');
});

test('symlinkPlan never offers a credential file, whatever the state says', () => {
  const state = model.initialState(detectedLinux());
  const plan = model.symlinkPlan({
    ...state,
    symlinks: {
      enabled: true,
      primary: '/h/.claude',
      targets: ['/h/.claude-team'],
      entries: ['CLAUDE.md', '.credentials.json', '.claude.json'],
    },
  });
  const names = plan.entries.map((entry) => entry.name);
  assert.ok(names.includes('CLAUDE.md'));
  assert.ok(!names.includes('.credentials.json'));
  assert.ok(!names.includes('.claude.json'));
});

// -- step 6 ------------------------------------------------------------------

test('orchestration defaults off on a fresh machine, and honours a re-run', () => {
  // The config SCHEMA defaults orchestration.enabled to true, so reading it
  // straight would open a fresh install with the Orch view on and no launcher
  // behind it. Caught by the driven wizard once Finish started merging onto the
  // config on disk.
  const schemaDefaults = deriveDefaults({}, runtime());
  assert.equal(schemaDefaults.orchestration.enabled, true, 'the schema really does default it on');

  const fresh = model.initialState(detectedLinux(), schemaDefaults);
  assert.equal(fresh.orchestration.enabled, false, 'no launcher on disk, so off');

  const withLauncher = model.initialState(
    detectedLinux({ orchestration: { launcher: '/h/bin/claude-go', found: true } }),
    schemaDefaults,
  );
  assert.equal(withLauncher.orchestration.enabled, true, 'a launcher that exists turns it on');

  // A completed install is the user's own decision and is honoured either way.
  const chosenOff = model.initialState(
    detectedLinux({ orchestration: { launcher: '/h/bin/claude-go', found: true } }),
    { ...schemaDefaults, setup: { completed: true }, orchestration: { ...schemaDefaults.orchestration, enabled: false } },
  );
  assert.equal(chosenOff.orchestration.enabled, false, 're-run honours a deliberate off');
});

test('orchestration: off is valid; on needs a launcher and real slash commands', () => {
  const state = model.initialState(detectedLinux());
  assert.equal(model.canAdvance('orchestration', state), true);

  const on = { ...state, orchestration: { ...state.orchestration, enabled: true, launcher: '' } };
  assert.equal(model.canAdvance('orchestration', on), false);

  const noSlash = {
    ...state,
    orchestration: { enabled: true, launcher: '/h/bin/claude-go', researchCommand: 'research', executionCommand: '/x' },
  };
  assert.equal(model.canAdvance('orchestration', noSlash), false);
  assert.match(model.stepValidation('orchestration', noSlash).errors[0].message, /starts with \//);
});

// -- step 7 ------------------------------------------------------------------

test('defaults: a provider that is not enabled cannot be the default', () => {
  const state = model.initialState(detectedLinux());
  const bad = { ...state, defaults: { ...state.defaults, provider: 'codex' } };
  assert.equal(model.canAdvance('defaults', bad), false);
  assert.match(model.stepValidation('defaults', bad).errors[0].message, /actually enabled/);
});

test('defaults follow the accounts: removing the last Claude plan re-points them', () => {
  // Without this the user had to walk to step 7 to discover it was broken.
  let state = model.initialState(detectedLinux());
  state = { ...state, codex: { ...state.codex, enabled: true, bin: 'codex', accounts: [{ ...model.seedCodexAccount({}, 0), configHome: '/h/.codex' }] } };
  assert.equal(state.defaults.provider, 'claude');
  const gone = model.removeProfile(state, 0);
  assert.equal(gone.defaults.provider, 'codex');
  assert.equal(model.canAdvance('defaults', gone), true);
});

test('cursor takes no effort level, so the step does not invent one', () => {
  const state = model.initialState({});
  const cursorOnly = model.reconcileDefaults({
    ...state,
    cursor: { enabled: true, bin: 'cursor-agent', configHome: '/h/.cursor' },
  });
  assert.equal(cursorOnly.defaults.provider, 'cursor');
  assert.equal(model.canAdvance('defaults', cursorOnly), true);
});

// -- finish ------------------------------------------------------------------

test('canFinish requires EVERY step, not just the last one', () => {
  let state = model.initialState(detectedLinux());
  assert.equal(model.canFinish(state), true);
  // Break an EARLIER step from the last screen: Finish must go away. Step 1 is
  // no longer a candidate for this, because nothing on it is required any more,
  // so the break has to be a value
  // that genuinely cannot be missing: a plan pointing at no config home.
  state = model.updateProfile(state, 0, { configHome: '' });
  assert.equal(model.canFinish(state), false);
  assert.deepEqual(model.blockingSteps(state), ['claude']);
});

test('MINIMUM PATH: one Claude account and nothing else writes a valid config', () => {
  const state = model.initialState(detectedLinux());
  assert.equal(model.canFinish(state), true);

  const config = model.configFromWizard(state, {});
  const derived = deriveDefaults(config, runtime());
  assert.doesNotThrow(() => validateConfig(derived));

  assert.equal(derived.setup.completed, true);
  assert.equal(derived.profiles.length, 1);
  assert.equal(derived.profiles[0].provider, 'claude');
  assert.equal(derived.profiles[0].isDefault, true);
  assert.equal(derived.providers.codex.enabled, false);
  assert.equal(derived.providers.cursor.enabled, false);
  assert.equal(derived.orchestration.enabled, false);
  assert.deepEqual(derived.workflows, [], 'no quick commands were picked, so none are written');
  assert.equal(derived.newSessionDefaults.provider, 'claude');
});

test('ZERO-CLAUDE PATH: a codex-only install writes a valid config too', () => {
  // The schema requires a non-empty profiles list where every profile names a
  // provider, so a codex account IS a profile. That is the existing shape, not
  // a fork of it.
  let state = model.initialState({});
  state = {
    ...state,
    platform: { ...state.platform, os: 'linux' },
    codex: {
      enabled: true,
      bin: '/h/.npm-global/bin/codex',
      accounts: [{ ...model.seedCodexAccount({}, 0), configHome: '/home/tester/.codex' }],
    },
  };
  state = model.reconcileDefaults(state);
  assert.equal(model.canFinish(state), true, model.blockingSteps(state).join(','));

  const derived = deriveDefaults(model.configFromWizard(state, {}), runtime());
  assert.doesNotThrow(() => validateConfig(derived));
  assert.equal(derived.profiles.length, 1);
  assert.equal(derived.profiles[0].provider, 'codex');
  assert.equal(derived.profiles[0].isDefault, true);
  assert.equal(derived.providers.claude.enabled, false);
  assert.equal(derived.newSessionDefaults.provider, 'codex');
});

test('FULL PATH: three plans, codex, cursor, orchestration and quick commands', () => {
  let state = model.initialState({});
  state = { ...state, platform: { ...state.platform, os: 'linux' } };
  for (const home of ['/home/tester/.claude', '/home/tester/.claude-team', '/home/tester/.claude-plan3']) {
    state = model.addProfile(state, { path: home });
  }
  state = model.updateProfile(state, 1, { isDefault: true });
  state = {
    ...state,
    codex: { enabled: true, bin: 'codex', accounts: [{ ...model.seedCodexAccount({}, 0), configHome: '/home/tester/.codex' }] },
    cursor: { enabled: true, bin: 'cursor-agent', configHome: '/home/tester/.cursor' },
    catalog: { loaded: true, workflows: [{ id: 'acclimate', label: '/acclimate', command: '/acclimate', cwd: 'current' }] },
    symlinks: { enabled: true, primary: '/home/tester/.claude', targets: ['/home/tester/.claude-team', '/home/tester/.claude-plan3'], entries: [] },
    orchestration: { enabled: true, launcher: '/home/tester/.local/bin/claude-go', researchCommand: '/orchestrate-research', executionCommand: '/orchestrate-execution' },
  };
  assert.equal(model.canFinish(state), true, model.blockingSteps(state).join(','));

  const derived = deriveDefaults(model.configFromWizard(state, {}), runtime());
  assert.doesNotThrow(() => validateConfig(derived));
  assert.equal(derived.profiles.length, 5, '3 claude + 1 codex + 1 cursor');
  assert.deepEqual(
    derived.profiles.map((profile) => profile.provider),
    ['claude', 'claude', 'claude', 'codex', 'cursor'],
  );
  assert.equal(derived.profiles.filter((profile) => profile.isDefault).length, 1);
  assert.equal(derived.profiles[1].isDefault, true, 'the team plan was chosen');
  assert.equal(derived.orchestration.enabled, true);
  assert.equal(derived.workflows.length, 1);
  assert.equal(derived.workflows[0].command, '/acclimate');
});

test('re-running the wizard EDITS the existing config rather than resetting it', () => {
  // Fields the wizard does not cover must survive a second run, or re-opening
  // it from the app menu to change one thing would quietly wipe the rest.
  const base = deriveDefaults({}, runtime());
  const state = model.initialState(detectedLinux(), base);
  const next = model.configFromWizard(state, base);
  assert.equal(next.paths.cacheDir, base.paths.cacheDir);
  assert.equal(next.paths.delegateStateDir, base.paths.delegateStateDir);
  assert.equal(next.platform.shell, base.platform.shell);
});

test('a re-run does not wipe the quick commands the user already saved', () => {
  // Finish REPLACES config.workflows with whatever step 4 holds, so starting
  // that list empty meant re-opening the wizard to change a launcher silently
  // erased every quick command.
  const base = deriveDefaults({
    setup: { completed: true, completedAt: null, appVersion: null },
    workflows: [
      { id: 'acclimate', label: '/acclimate', command: '/acclimate', cwd: 'current', profile: 'current', provider: 'current', model: 'current', effort: 'current' },
    ],
  }, runtime());

  const state = model.initialState(detectedLinux(), base);
  assert.equal(state.catalog.workflows.length, 1, 'step 4 opens holding what is saved');

  // But a FIRST run starts empty even though the schema ships a default entry:
  // handing a brand-new install a quick command somebody else chose is not a
  // default, it is a leftover.
  const firstRun = model.initialState(detectedLinux(), { ...base, setup: { completed: false } });
  assert.deepEqual(firstRun.catalog.workflows, []);
  const next = model.configFromWizard(state, base);
  assert.equal(next.workflows.length, 1);
  assert.equal(next.workflows[0].command, '/acclimate');

  // Removing one on purpose still removes it: seeding is not the same as
  // making the list unwritable.
  const cleared = { ...state, catalog: { ...state.catalog, workflows: [] } };
  assert.deepEqual(model.configFromWizard(cleared, base).workflows, []);
});

test('no field anywhere in a produced config is credential-shaped', () => {
  // A structural check, not a spot check: walk the whole object.
  const state = model.initialState(detectedLinux());
  const config = deriveDefaults(model.configFromWizard(state, {}), runtime());
  const forbidden = /(api[-_]?key|secret|token|password|passwd|credential|bearer|oauth)/i;
  const walk = (value, at) => {
    if (value === null || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.ok(!forbidden.test(key), `config carries a credential-shaped key at ${at}.${key}`);
      if (typeof child === 'string') {
        assert.ok(!/^sk-|^sk_ant/.test(child), `config carries a key-shaped value at ${at}.${key}`);
      }
      walk(child, `${at}.${key}`);
    }
  };
  walk(config, 'config');
});

test('the ESM view is the same object, never a second copy of the rules', () => {
  // The three real twin pairs in src/shared/ must be edited together, and that
  // is a standing drift hazard. This one cannot drift because there is nothing
  // to drift: wizard-model.js re-exports the .cjs.
  const source = require('node:fs').readFileSync(
    path.join(__dirname, '../../src/renderer/setup/wizard-model.js'),
    'utf8',
  );
  assert.match(source, /import model from '\.\/wizard-model\.cjs'/);
  assert.ok(!/function\s+\w+\s*\(/.test(source), 'the ESM view must contain no logic of its own');
});

// REOPENING THE WIZARD MUST NOT UNDO WHAT THE USER ALREADY CHOSE, which it did
// until 2026-08-07. Only two of the seven steps read the saved config; the rest
// reseeded from fresh detection, and because Finish REPLACES `profiles`,
// `platform` and `newSessionDefaults` wholesale rather than merging, opening the
// wizard to change one thing silently reverted a renamed profile, a re-coloured
// badge and the new-session model and effort, then
// wrote the reversion to disk on the next Finish. "Reopen it to change one
// thing" is the only reason the app menu has that entry.
//
// The split that makes this correct: IDENTITY is the user's (id, label, letter,
// colour, which one is default, which paths), LIVENESS is the machine's (is the
// binary there, is that home signed in, which account email). Asserting both
// halves matters, because seeding everything from the config would freeze a
// stale email in place and look just as "preserved".
function savedConfig(overrides = {}) {
  return {
    setup: { completed: true, completedAt: '2026-08-01T00:00:00.000Z', appVersion: '1.0.0' },
    platform: { os: 'linux', shell: '/bin/zsh' },
    profiles: [
      { id: 'work', label: 'Work laptop', letter: 'W', color: '#123456', provider: 'claude', configHome: '/home/tester/.claude', email: 'stale@example.com', isDefault: true },
    ],
    providers: { claude: { enabled: true, bin: '/opt/claude' }, codex: { enabled: false, bin: 'codex' }, cursor: { enabled: false, bin: 'cursor-agent' } },
    newSessionDefaults: { provider: 'claude', model: 'sonnet', effort: 'medium' },
    workflows: [],
    orchestration: { enabled: false, launcher: '', researchCommand: '/orchestrate-research', executionCommand: '/orchestrate-execution' },
    ...overrides,
  };
}

test('a re-run opens on the saved profile identity, not on freshly detected seeds', () => {
  const state = model.initialState(detectedLinux(), savedConfig());
  const profile = state.claude.profiles[0];

  assert.equal(profile.id, 'work', 'a renamed profile id survives');
  assert.equal(profile.label, 'Work laptop');
  assert.equal(profile.letter, 'W');
  assert.equal(profile.color, '#123456');
  assert.equal(profile.isDefault, true);

  // ...while the account email is re-read from the machine, because that is a
  // fact rather than a decision. Detection says a@example.com; the stale saved
  // value must lose.
  assert.equal(profile.email, 'a@example.com');
  assert.equal(profile.authed, true);
});

test('a re-run keeps saved platform settings and new-session defaults', () => {
  const state = model.initialState(detectedLinux(), savedConfig());
  assert.equal(state.platform.shell, '/bin/zsh');
  assert.equal(state.claude.bin, '/opt/claude');
  assert.deepEqual(state.defaults, { provider: 'claude', model: 'sonnet', effort: 'medium' });
});

test('a re-run offers a config home created since last time, without disturbing the saved ones', () => {
  const detected = detectedLinux({
    claudeHomes: [
      { id: 'personal', path: '/home/tester/.claude', exists: true, authed: true, email: 'a@example.com' },
      { id: 'lab', path: '/home/tester/.claude-lab', exists: true, authed: true, email: 'b@example.com' },
    ],
  });
  const state = model.initialState(detected, savedConfig());
  assert.deepEqual(state.claude.profiles.map((p) => p.id), ['work', 'lab']);
  assert.equal(state.claude.profiles[0].isDefault, true, 'the new row must not steal the default');
  assert.equal(state.claude.profiles[1].isDefault, false);
  assert.equal(state.claude.profiles[1].email, 'b@example.com');
});

test('a first run is unaffected: nothing is seeded from a config that has not been completed', () => {
  // Two-sided. If the merge above ran on a first launch it would hand a brand
  // new user the schema's own placeholder values as though they were choices.
  const first = model.initialState(detectedLinux(), savedConfig({ setup: { completed: false, completedAt: null, appVersion: null } }));
  assert.equal(first.claude.profiles[0].id, 'personal', 'detection seeds a first run');
  assert.equal(first.platform.shell, '/bin/bash');
  assert.deepEqual(first.defaults, { provider: 'claude', model: 'opus', effort: 'xhigh' });
});

test('a saved profile whose folder has since been deleted is shown as missing, not as signed in', () => {
  const detected = detectedLinux({ claudeHomes: [] });
  const state = model.initialState(detected, savedConfig());
  const profile = state.claude.profiles[0];
  assert.equal(profile.exists, false);
  assert.equal(profile.authed, false);
  assert.match(profile.reason || '', /does not exist/);
});
