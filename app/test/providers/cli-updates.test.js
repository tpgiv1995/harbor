'use strict';

// CLI update checker. Everything is injected: no network, no npm, no real home.
// The suite proves the four things the feature exists for:
//   1. it can tell that a newer version exists, for all three CLI shapes;
//   2. it slices the release notes to exactly the versions being crossed;
//   3. it flags the lines that touch a Harbor contract, the Revert rule first;
//   4. it snapshots config before an install and can diff and restore it after.

const test = require('node:test');
const assert = require('node:assert');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { realTmpDir } = require('../support/real-tmpdir.js');

const {
  createCliUpdateChecker,
  compareVersions,
  isNewer,
  parseClaudeChangelog,
  parseCodexReleases,
  sectionsBetween,
  tagLine,
  diffJson,
  diffText,
  pendingUpdates,
  configTargets,
} = require('../../src/main/providers/cli-updates.js');

// Three sections of the real CHANGELOG.md shape (## <version>, "- " bullets,
// newest first), trimmed to the lines this suite reasons about.
const CLAUDE_CHANGELOG = `# Changelog

## 2.1.260

- Added a diff panel that opens beside the conversation in fullscreen mode
- Fixed flags, joined emoji and accented letters splitting across wrapped lines
- Reverted the 2.1.258 change to how \`--session-id\` is validated

## 2.1.259

- Fixed \`/model\` picker not showing Fable 5.1 for organizations that can use it
- Changed nothing anybody will notice

## 2.1.258

- Added the statusline field nobody should see in this slice
`;

const CODEX_RELEASES = [
  { tag_name: 'rust-v0.154.0-alpha.3', prerelease: true, draft: false, body: '- alpha noise' },
  {
    tag_name: 'rust-v0.153.2',
    prerelease: false,
    draft: false,
    body: '## Bug Fixes\n\n- Corrected the Fast tier description (#42632)\n\n## Changelog\n\nFull Changelog: https://github.com/openai/codex/compare/rust-v0.153.1...rust-v0.153.2\n\n- #42632 Fix tier description @anp-oai\n',
  },
  {
    tag_name: 'rust-v0.153.1',
    prerelease: false,
    draft: false,
    body: '- Changed the rollout item_completed payload shape\n',
  },
  { tag_name: 'rust-v0.153.0', prerelease: false, draft: true, body: '- draft, never shown' },
  { tag_name: 'rust-v0.152.1', prerelease: false, draft: false, body: '- the installed version, excluded\n' },
];

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok, status, json: async () => body, text: async () => JSON.stringify(body),
  };
}

function textResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => JSON.parse(body), text: async () => body };
}

// One fake network for the whole checker: npm registry, the claude changelog,
// the codex releases API and the cursor download endpoint.
function fakeFetch(overrides = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (overrides[String(url)]) return overrides[String(url)];
    if (String(url).endsWith('@anthropic-ai/claude-code/latest')) return jsonResponse({ version: '2.1.260' });
    if (String(url).endsWith('@openai/codex/latest')) return jsonResponse({ version: '0.153.2' });
    if (String(url).includes('CHANGELOG.md')) return textResponse(CLAUDE_CHANGELOG);
    if (String(url).includes('api.github.com')) return jsonResponse(CODEX_RELEASES);
    if (String(url).includes('GetCliDownloadUrl')) {
      return jsonResponse({ version: '2026.09.02-c22c1a3', url: 'https://downloads.example/x/' });
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  impl.calls = calls;
  return impl;
}

async function makeHome() {
  const root = await fsp.mkdtemp(path.join(realTmpDir(), 'harbor-cli-updates-'));
  const home = path.join(root, 'home');
  const prefix = path.join(root, 'npm');
  await fsp.mkdir(path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code'), { recursive: true });
  await fsp.writeFile(
    path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code', 'package.json'),
    JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.258' }),
  );
  await fsp.mkdir(path.join(prefix, 'node_modules', '@openai', 'codex'), { recursive: true });
  await fsp.writeFile(
    path.join(prefix, 'node_modules', '@openai', 'codex', 'package.json'),
    JSON.stringify({ name: '@openai/codex', version: '0.152.1' }),
  );
  const cursorDir = path.join(root, 'local', 'cursor-agent', 'versions');
  await fsp.mkdir(path.join(cursorDir, '2026.08.31-4057e58'), { recursive: true });
  await fsp.mkdir(path.join(cursorDir, '2026.08.11-e8db854'), { recursive: true });
  // Config files the snapshot has to find, and one it must not invent.
  await fsp.mkdir(path.join(home, '.claude'), { recursive: true });
  await fsp.mkdir(path.join(home, '.codex'), { recursive: true });
  await fsp.writeFile(
    path.join(home, '.claude.json'),
    JSON.stringify({ autoUpdates: false, installMethod: 'global', oauthAccount: { emailAddress: 'x@y.z' } }, null, 2),
  );
  await fsp.writeFile(
    path.join(home, '.claude', 'settings.json'),
    JSON.stringify({ model: 'opus', hooks: { PreToolUse: [] } }, null, 2),
  );
  await fsp.writeFile(path.join(home, '.codex', 'config.toml'), 'model = "gpt-6"\napproval_policy = "never"\n');
  return { root, home, prefix, local: path.join(root, 'local') };
}

function checkerFor(fixture, extra = {}) {
  const readFile = extra.readFile || fsp.readFile;
  const execFile = extra.execFile || (async () => { throw new Error('updater must not run in this test'); });
  return createCliUpdateChecker({
    fetchImpl: fakeFetch(),
    homedir: () => fixture.home,
    env: { HARBOR_NPM_PREFIX: fixture.prefix, LOCALAPPDATA: fixture.local },
    now: () => new Date('2026-09-03T12:00:00.000Z'),
    stateFile: path.join(fixture.root, 'state', 'cli-updates.json'),
    execFile: async () => { throw new Error('execFile must not run in this test'); },
    ...extra,
    readFile: async (file, ...args) => {
      const content = await readFile(file, ...args);
      if (String(file).startsWith(fixture.prefix) && String(file).endsWith('package.json')) {
        const manifest = JSON.parse(content);
        const id = String(file).includes('claude-code') ? 'claude' : 'codex';
        return JSON.stringify({ ...manifest, bin: { [id]: id === 'claude' ? 'bin/claude.exe' : 'bin/codex.js' } });
      }
      return content;
    },
    execFile: async (file, args, options) => {
      if (args.at(-1) !== '--version') return execFile(file, args, options);
      const id = [file, ...args].some(a => String(a).includes('claude-code')) ? 'claude' : 'codex';
      const pkg = id === 'claude' ? '@anthropic-ai/claude-code' : '@openai/codex';
      const manifest = JSON.parse(await readFile(path.join(fixture.prefix, 'node_modules', pkg, 'package.json'), 'utf8'));
      return { stdout: id === 'claude' ? `${manifest.version} (Claude Code)` : `codex-cli ${manifest.version}` };
    },
  });
}

test('first state reconciles stale disk truth before any reply or push, without network', async (t) => {
  const fixture = await makeHome();
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }));
  const checker = checkerFor(fixture, { fetchImpl: () => assert.fail('reconcile used network') });
  await fsp.mkdir(path.dirname(checker.stateFile), { recursive: true });
  await fsp.writeFile(checker.stateFile, JSON.stringify({ providers: {
    claude: { installed: '2.1.250', latest: '2.1.258', notes: { sections: [] }, flags: ['config'] },
    codex: { installed: '0.151.0', latest: '0.153.2' },
  } }));
  const pushes = [];
  const changes = [];
  checker.subscribe((state) => pushes.push(JSON.parse(JSON.stringify(state))));
  checker.onInstalledChanged((change) => changes.push(change));
  const states = await Promise.all([checker.state(), checker.state()]);
  for (const state of [...states, ...pushes]) {
    assert.equal(state.providers.claude.installed, '2.1.258');
    assert.equal(state.providers.claude.notes, null);
    assert.deepEqual(state.providers.claude.flags, []);
    assert.deepEqual(pendingUpdates(state).map((p) => p.id), ['codex']);
  }
  assert.equal(states[0].providers.claude.history[0].source, 'external');
  assert.equal(states[0].providers.claude.history.length, 1);
  assert.equal(changes.filter((c) => c.provider === 'claude').length, 1);
  assert.equal(JSON.parse(await fsp.readFile(checker.stateFile)).providers.claude.installed, '2.1.258');
});

test('install reads click-time disk truth and verified target never runs the updater or snapshots', async (t) => {
  const fixture = await makeHome();
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }));
  const checker = checkerFor(fixture);
  await checker.check();
  await fsp.writeFile(path.join(fixture.prefix, 'node_modules/@anthropic-ai/claude-code/package.json'), JSON.stringify({ version: '2.1.260' }));
  const result = await checker.install('claude', '2.1.260');
  assert.equal(result.ok, true);
  assert.equal(result.alreadyInstalled, true);
  assert.deepEqual(await checker.listSnapshots('claude'), []);
  const state = await checker.state();
  assert.equal(state.providers.claude.history[0].source, 'external');
  assert.equal(state.providers.claude.history[0].from, '2.1.258');
  assert.equal(state.providers.claude.installed, '2.1.260');
});

test('local reconcile throttles repeated reads but discovers an external install after the throttle', async (t) => {
  const fixture = await makeHome();
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }));
  let clock = Date.parse('2026-09-20T12:00:00Z');
  const checker = checkerFor(fixture, { now: () => new Date(clock) });
  await checker.state();
  await fsp.writeFile(path.join(fixture.prefix, 'node_modules/@anthropic-ai/claude-code/package.json'), JSON.stringify({ version: '2.1.278' }));
  assert.equal((await checker.state()).providers.claude.installed, '2.1.258');
  clock += 31000;
  assert.equal((await checker.state()).providers.claude.installed, '2.1.278');
});

for (const provider of ['claude', 'codex', 'cursor']) {
  for (const outcome of ['upgrade', 'uninstall']) {
    test(`${provider}: a missing install read is provisional until a later reconcile (${outcome})`, async (t) => {
      const fixture = await makeHome();
      t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }));
      const oldVersion = provider === 'cursor' ? '2026.09.18-aaaaaaa' : '1.0.0';
      const newVersion = provider === 'cursor' ? '2026.09.20-bbbbbbb' : '2.0.0';
      let diskVersion = oldVersion;
      const pkg = provider === 'claude' ? '@anthropic-ai/claude-code' : '@openai/codex';
      const packageFile = path.join(fixture.prefix, 'node_modules', pkg, 'package.json');
      const checker = checkerFor(fixture, {
        fetchImpl: () => assert.fail('local reconcile used the network'),
        readFile: async (file, ...args) => provider !== 'cursor' && file === packageFile
          ? JSON.stringify({ version: diskVersion }) : fsp.readFile(file, ...args),
        readdir: async (dir) => provider === 'cursor' && dir.endsWith('versions')
          ? (diskVersion ? [diskVersion] : []) : fsp.readdir(dir),
      });
      await checker.state();
      const pushed = [];
      const changed = [];
      checker.subscribe((state) => pushed.push(state.providers[provider].installed));
      checker.onInstalledChanged((change) => { if (change.provider === provider) changed.push(change); });
      diskVersion = null;
      assert.equal((await checker.reconcile({ force: true })).providers[provider].installed, oldVersion);
      assert.deepEqual(changed, [], 'one null never fires discovery');
      assert.equal(pushed.includes(null), false);
      diskVersion = outcome === 'upgrade' ? newVersion : null;
      const state = await checker.reconcile({ force: true });
      assert.equal(state.providers[provider].installed, diskVersion);
      assert.equal(changed.length, 1);
      assert.equal(changed[0].from, oldVersion);
      if (outcome === 'upgrade') {
        assert.equal(pushed.includes(null), false);
        assert.deepEqual(state.providers[provider].history.map(({ from, to, source }) => ({ from, to, source })),
          [{ from: oldVersion, to: newVersion, source: 'external' }]);
      } else {
        assert.equal(pushed.at(-1), null, 'two nulls still report a real uninstall');
      }
    });
  }
}

test('a successful same-version read clears the provisional missing mark', async (t) => {
  const fixture = await makeHome();
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }));
  const packageFile = path.join(fixture.prefix, 'node_modules/@anthropic-ai/claude-code/package.json');
  let diskVersion = '2.1.258';
  const checker = checkerFor(fixture, { readFile: async (file, ...args) => file === packageFile
    ? JSON.stringify({ version: diskVersion }) : fsp.readFile(file, ...args) });
  await checker.state();
  for (const version of [null, '2.1.258', null]) {
    diskVersion = version;
    assert.equal((await checker.reconcile({ force: true })).providers.claude.installed, '2.1.258');
  }
  assert.equal((await checker.reconcile({ force: true })).providers.claude.installed, null);
});

test('a null click-time read keeps the history baseline but never returns already installed', async (t) => {
  const fixture = await makeHome();
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }));
  const packageFile = path.join(fixture.prefix, 'node_modules/@anthropic-ai/claude-code/package.json');
  let diskVersion = '2.1.258';
  let spawned = 0;
  const checker = checkerFor(fixture, {
    readFile: async (file, ...args) => file === packageFile
      ? JSON.stringify({ version: diskVersion }) : fsp.readFile(file, ...args),
    execFile: async () => { spawned += 1; diskVersion = '2.1.258'; return { stdout: 'installed' }; },
  });
  await checker.state();
  const pushed = [];
  checker.subscribe((state) => pushed.push(state.providers.claude.installed));
  diskVersion = null;
  const result = await checker.install('claude', '2.1.258');
  assert.equal(result.ok, true);
  assert.equal(result.alreadyInstalled, undefined);
  assert.equal(spawned, 1);
  assert.equal(pushed.includes(null), false);
  const state = await checker.state();
  assert.equal(state.providers.claude.history[0].from, '2.1.258');
  assert.equal(state.providers.claude.history[0].source, 'harbor');
});

test('a slow local reconcile cannot overwrite an install or fabricate external history', async (t) => {
  const fixture = await makeHome();
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }));
  let releaseExec;
  let execStarted;
  const started = new Promise((resolve) => { execStarted = resolve; });
  let gateCursor = false;
  let releaseCursor;
  let cursorStarted;
  const cursorBlocked = new Promise((resolve) => { cursorStarted = resolve; });
  const checker = checkerFor(fixture, {
    execFile: async () => {
      execStarted();
      await new Promise((resolve) => { releaseExec = resolve; });
      await fsp.writeFile(path.join(fixture.prefix, 'node_modules/@anthropic-ai/claude-code/package.json'), JSON.stringify({ version: '2.1.260' }));
      return { stdout: 'installed' };
    },
    readdir: async (dir) => {
      if (gateCursor && dir.endsWith('versions')) {
        cursorStarted();
        await new Promise((resolve) => { releaseCursor = resolve; });
      }
      return fsp.readdir(dir);
    },
  });
  await checker.state();
  const installing = checker.install('claude', '2.1.260');
  await started;
  gateCursor = true;
  const reconcile = checker.reconcile({ force: true });
  await cursorBlocked;
  releaseExec();
  assert.equal((await installing).installed, '2.1.260');
  releaseCursor();
  await reconcile;
  const state = await checker.state();
  assert.equal(state.providers.claude.installed, '2.1.260');
  assert.deepEqual(state.providers.claude.history.map((entry) => entry.source), ['harbor']);
});

test('reconcile never attributes an in-flight Harbor install to an external installer', async (t) => {
  const fixture = await makeHome();
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }));
  let releaseExec;
  let wrote;
  const written = new Promise((resolve) => { wrote = resolve; });
  const checker = checkerFor(fixture, { execFile: async () => {
    await fsp.writeFile(path.join(fixture.prefix, 'node_modules/@anthropic-ai/claude-code/package.json'), JSON.stringify({ version: '2.1.260' }));
    wrote();
    await new Promise((resolve) => { releaseExec = resolve; });
    return { stdout: 'installed' };
  } });
  await checker.state();
  const installing = checker.install('claude', '2.1.260');
  await written;
  await checker.reconcile({ force: true });
  releaseExec();
  await installing;
  assert.deepEqual((await checker.state()).providers.claude.history.map((entry) => entry.source), ['harbor']);
});

test('partial external installs trim release notes and impact flags to versions still pending', async (t) => {
  const fixture = await makeHome();
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }));
  const checker = checkerFor(fixture);
  await checker.check();
  await fsp.writeFile(path.join(fixture.prefix, 'node_modules/@anthropic-ai/claude-code/package.json'), JSON.stringify({ version: '2.1.259' }));
  await checker.reconcile({ force: true });
  assert.deepEqual((await checker.releaseNotes('claude')).sections.map((section) => section.version), ['2.1.260']);
  assert.equal(pendingUpdates(await checker.state()).some((p) => p.id === 'claude'), true);
});

test('version compare handles npm semver, prereleases and cursor date builds', () => {
  assert.equal(compareVersions('2.1.260', '2.1.258') > 0, true);
  assert.equal(compareVersions('2.1.9', '2.1.10') < 0, true, 'segments compare numerically, not as text');
  assert.equal(compareVersions('0.153.2', '0.153.2'), 0);
  assert.equal(compareVersions('0.154.0', '0.154.0-alpha.3') > 0, true, 'a release outranks its prerelease');
  assert.equal(compareVersions('2026.09.02-c22c1a3', '2026.08.31-4057e58') > 0, true);
  // Two builds of the same day are not an upgrade; nagging on a rebuilt hash
  // would make the chip permanent.
  assert.equal(compareVersions('2026.08.31-aaaaaaa', '2026.08.31-4057e58'), 0);
  assert.equal(isNewer('2.1.260', '2.1.258'), true);
  assert.equal(isNewer('2.1.258', '2.1.260'), false);
  assert.equal(isNewer(null, '2.1.258'), false, 'an unknown latest is never an update');
});

test('claude changelog parses into version sections and slices between installed and latest', () => {
  const sections = parseClaudeChangelog(CLAUDE_CHANGELOG);
  assert.deepEqual(sections.map((s) => s.version), ['2.1.260', '2.1.259', '2.1.258']);
  assert.equal(sections[1].lines.length, 2);
  const crossed = sectionsBetween(sections, '2.1.258', '2.1.260');
  assert.deepEqual(crossed.map((s) => s.version), ['2.1.260', '2.1.259']);
  assert.equal(
    crossed.some((s) => s.version === '2.1.258'), false,
    'the installed version is exclusive: those changes are already here',
  );
});

test('codex releases skip prereleases and drafts, map rust-v tags, and drop the commit roll-up', () => {
  const sections = parseCodexReleases(CODEX_RELEASES);
  assert.deepEqual(sections.map((s) => s.version), ['0.153.2', '0.153.1', '0.152.1']);
  assert.equal(sections.some((s) => s.version.includes('alpha')), false);
  assert.deepEqual(sections[0].lines, ['Corrected the Fast tier description (#42632)']);
  const crossed = sectionsBetween(sections, '0.152.1', '0.153.2');
  assert.deepEqual(crossed.map((s) => s.version), ['0.153.2', '0.153.1']);
});

test('impact flags tag the Harbor contracts a note line touches, Revert included', () => {
  const reverted = tagLine('claude', 'Reverted the 2.1.258 change to how --session-id is validated');
  assert.deepEqual(reverted.flags.map((f) => f.id).sort(), ['reverted', 'transcript']);
  assert.match(reverted.flags.find((f) => f.id === 'reverted').why, /UNDOES an earlier change/);

  const dialog = tagLine('claude', 'Fixed the AskUserQuestion permission prompt not repainting');
  assert.equal(dialog.flags.some((f) => f.id === 'ask-dialog'), true);
  assert.equal(
    dialog.flags.find((f) => f.id === 'ask-dialog').verify,
    'node scripts/drive-ask-sheet-win.js',
  );

  const codex = tagLine('codex', 'Changed the rollout item_completed payload shape');
  assert.equal(codex.flags.some((f) => f.id === 'rollout'), true);

  const cursor = tagLine('cursor', 'Removed --force in favour of --yolo');
  assert.equal(cursor.flags.some((f) => f.id === 'resume'), true);

  const boring = tagLine('claude', 'Improved the colour of a spinner');
  assert.deepEqual(boring.flags, [], 'an unrelated line carries no scare text');
});

// The 2026-09-25 review found the lines that mattered most in codex 0.157.0 and
// claude 2.1.281 carrying NO flag. Each is pinned verbatim from its changelog.
test('the release lines that changed a Harbor pane carry a flag', () => {
  const ids = (provider, line) => tagLine(provider, line).flags.map((f) => f.id);
  assert.ok(ids('codex', 'Enabled automatic background-server startup for eligible interactive sessions, with recovery choices when server settings are incompatible. (#47179, #47318)').includes('daemon'));
  assert.ok(ids('codex', 'Enabled automatic background-server startup for eligible interactive sessions, with recovery choices when server settings are incompatible. (#47179, #47318)').includes('startup-screen'));
  assert.ok(ids('codex', 'Enabled fullscreen transcripts by default and added Shift-click to extend text selections. (#47178, #47414)').includes('visibility'));
  const migration = ids('codex', 'Added GPT-6 Sol and Luna, including Amazon Bedrock support and migration prompts for older models. (#47332, #47347)');
  assert.ok(migration.includes('startup-screen') && migration.includes('models'), migration.join(','));
  assert.ok(ids('claude', 'Changed the dangerous `rm` prompt in `--dangerously-skip-permissions` and auto mode to wait 2 minutes for an answer, then deny the command with a rewrite hint so unattended sessions keep going').includes('bypass-mode'));
  assert.ok(ids('claude', 'Changed queued messages to show in the conversation above the spinner instead of under it').includes('composer'));
  assert.ok(ids('claude', 'Fixed pasted multi-line text being submitted line by line after the terminal\'s bracketed paste mode was reset mid-session').includes('composer'));
  assert.ok(ids('claude', 'Windows: Fixed a race in which Claude Code sessions updating at the same moment could delete each other\'s `claude.exe` backup, which could leave no `claude.exe` behind').includes('auto-update'));
  assert.deepEqual(ids('codex', 'Added retries for transient file-upload failures and increased the upload timeout to five minutes. (#47122, #47393)'), []);
});

// The 2026-10-07 review (claude 2.1.291 to 2.1.293) found three more: a new
// model, the paste-classification fixes every Harbor send rides on, and the
// usage-limit wording model-switch.js reads, all with no flag.
test('a new model, paste classification and usage-limit lines carry a flag', () => {
  const ids = (provider, line) => tagLine(provider, line).flags.map((f) => f.id);
  assert.ok(ids('claude', 'Added Claude Haiku 5.5 (`claude-haiku-5-5`), now the default Haiku model on the Anthropic API').includes('model'));
  assert.ok(ids('claude', 'Added Claude Sonnet 5.5, the new default Sonnet').includes('model'));
  assert.ok(ids('claude', 'Fixed pasted text that begins and ends with the same words sometimes being sent to Claude as if it had been typed').includes('composer'));
  assert.ok(ids('claude', 'Fixed some pasted text reaching Claude as typed text when several pastes overlapped in one prompt').includes('composer'));
  assert.ok(ids('claude', 'Changed usage limit messages to write claude.ai settings links with https:// so terminals and apps can make them clickable').includes('usage-limit'));
  assert.ok(ids('claude', 'Fixed the usage limit alert repeating once per background agent when agents failed on a limit that had already stopped the main conversation').includes('usage-limit'));
  assert.equal(tagLine('claude', 'Changed usage limit messages to write claude.ai settings links with https://').flags.find((f) => f.id === 'usage-limit').verify, 'npm test -- model-switch');
  assert.deepEqual(ids('claude', 'Fixed `/add-dir` path box letting Shift+Enter or a paste add a line break'), []);
});

test('check reads installed versions off disk and latest off the network, per provider', async () => {
  const fixture = await makeHome();
  const checker = checkerFor(fixture);
  const state = await checker.check();

  assert.equal(state.providers.claude.installed, '2.1.258');
  assert.equal(state.providers.claude.latest, '2.1.260');
  assert.equal(state.providers.codex.installed, '0.152.1');
  assert.equal(state.providers.codex.latest, '0.153.2');
  assert.equal(state.providers.cursor.installed, '2026.08.31-4057e58');
  assert.equal(state.providers.cursor.latest, '2026.09.02-c22c1a3');
  assert.equal(state.checkedAt, '2026-09-03T12:00:00.000Z');

  // The notes are sliced to the crossed versions and the flags summarise them.
  assert.deepEqual(
    state.providers.claude.notes.sections.map((s) => s.version), ['2.1.260', '2.1.259'],
  );
  assert.equal(state.providers.claude.flags.includes('reverted'), true);
  assert.equal(state.providers.claude.flags.includes('model'), true);
  // Cursor has no machine-readable notes and says so instead of pretending.
  assert.match(state.providers.cursor.notes.unavailable, /no machine-readable release notes/);

  assert.deepEqual(pendingUpdates(state).map((p) => p.id), ['claude', 'codex', 'cursor']);

  // State survives a restart through ~/.harbor/cli-updates.json.
  const reopened = checkerFor(fixture);
  assert.equal((await reopened.state()).providers.claude.latest, '2.1.260');
});

test('a rate-limited notes fetch hides nothing: the update still stands', async () => {
  const fixture = await makeHome();
  const limited = fakeFetch({});
  const wrapped = async (url, init) => {
    if (String(url).includes('api.github.com')) {
      return { ok: false, status: 403, json: async () => ({}), text: async () => '' };
    }
    return limited(url, init);
  };
  const checker = checkerFor(fixture, { fetchImpl: wrapped });
  const state = await checker.check();
  assert.equal(state.providers.codex.latest, '0.153.2');
  assert.equal(state.providers.codex.error, null);
  assert.match(state.providers.codex.notes.unavailable, /rate limited/);
});

test('an unreachable registry leaves that provider honest and the others intact', async () => {
  const fixture = await makeHome();
  const base = fakeFetch({});
  const wrapped = async (url, init) => {
    if (String(url).includes('@openai/codex')) throw new Error('getaddrinfo ENOTFOUND');
    return base(url, init);
  };
  const state = await checkerFor(fixture, { fetchImpl: wrapped }).check();
  assert.equal(state.providers.codex.latest, null);
  assert.match(state.providers.codex.error, /latest version unknown/);
  assert.equal(state.providers.claude.latest, '2.1.260', 'one provider failing never sinks the rest');
});

test('dismiss removes a version from the pending list and persists', async () => {
  const fixture = await makeHome();
  const checker = checkerFor(fixture);
  await checker.check();
  const result = await checker.dismiss('claude', '2.1.260');
  assert.deepEqual(result, { ok: true, dismissed: ['2.1.260'] });
  assert.deepEqual(pendingUpdates(await checker.state()).map((p) => p.id), ['codex', 'cursor']);
  assert.deepEqual(await checker.dismiss('nope', '1.0.0'), { ok: false, reason: 'unknown provider: nope' });

  const reopened = checkerFor(fixture);
  assert.deepEqual((await reopened.state()).providers.claude.dismissed, ['2.1.260']);
});

test('releaseNotes returns the crossed lines tagged, with a de-duplicated verify list', async () => {
  const fixture = await makeHome();
  const checker = checkerFor(fixture);
  await checker.check();
  const notes = await checker.releaseNotes('claude');
  assert.equal(notes.ok, true);
  assert.equal(notes.installed, '2.1.258');
  assert.equal(notes.latest, '2.1.260');
  const flagged = notes.sections.flatMap((s) => s.lines).filter((line) => line.flags.length);
  assert.ok(flagged.length >= 2);
  assert.equal(flagged.some((line) => line.flags.some((f) => f.id === 'reverted')), true);
  assert.equal(new Set(notes.verify.map((f) => f.id)).size, notes.verify.length, 'verify list is deduplicated');
});

test('install records a successful history entry and re-reads the installed version', async () => {
  const fixture = await makeHome();
  const calls = [];
  const checker = checkerFor(fixture, {
    execFile: async (file, args) => {
      calls.push({ file, args });
      // The install is what moves the version on disk; simulate that.
      await fsp.writeFile(
        path.join(fixture.prefix, 'node_modules', '@anthropic-ai', 'claude-code', 'package.json'),
        JSON.stringify({ version: '2.1.260' }),
      );
      return { stdout: 'added 1 package\n', stderr: '' };
    },
  });
  await checker.check();
  const result = await checker.install('claude', '2.1.260');
  assert.equal(result.ok, true);
  assert.equal(result.installed, '2.1.260');
  assert.match(result.output, /added 1 package/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.join(' ').includes('@anthropic-ai/claude-code@2.1.260'), true);

  const state = await checker.state();
  assert.equal(state.providers.claude.history.length, 1);
  assert.deepEqual(
    { from: state.providers.claude.history[0].from, to: state.providers.claude.history[0].to, ok: state.providers.claude.history[0].ok },
    { from: '2.1.258', to: '2.1.260', ok: true },
  );
  assert.ok(state.providers.claude.history[0].snapshot, 'the pre-install config snapshot id is recorded');
});

test('a same-day cursor rebuild installs as success but history names the build on disk', async (t) => {
  const fixture = await makeHome();
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }));
  const checker = checkerFor(fixture, {
    execFile: async () => {
      // cursor-agent update ignores the reviewed build and takes the newest one.
      await fsp.mkdir(path.join(fixture.root, 'local', 'cursor-agent', 'versions', '2026.09.02-aaaaaaa'), { recursive: true });
      return { stdout: 'Latest version available: 2026.09.02-aaaaaaa\nDone\n', stderr: '' };
    },
  });
  await checker.check();
  const result = await checker.install('cursor', '2026.09.02-c22c1a3');
  assert.equal(result.ok, true, 'two builds of one day are one version, not a failed install');
  assert.equal(result.installed, '2026.09.02-aaaaaaa');
  const entry = (await checker.state()).providers.cursor.history[0];
  assert.equal(entry.to, '2026.09.02-aaaaaaa', 'history records what is on disk');
  assert.equal(entry.requested, '2026.09.02-c22c1a3', 'and keeps the reviewed build that was asked for');
});

test('a failed install records the failure and never claims the new version', async () => {
  const fixture = await makeHome();
  const checker = checkerFor(fixture, {
    execFile: async () => {
      const error = new Error('EACCES: permission denied');
      error.stdout = '';
      error.stderr = 'npm ERR! code EACCES\n';
      throw error;
    },
  });
  await checker.check();
  const result = await checker.install('claude', '2.1.260');
  assert.equal(result.ok, false);
  assert.match(result.error, /EACCES/);
  assert.equal(result.installed, '2.1.258', 'the version on disk is the honest answer');
  const state = await checker.state();
  assert.equal(state.providers.claude.history[0].ok, false);
  assert.match(state.providers.claude.history[0].error, /EACCES/);
});

test('npm exiting cleanly without moving the version on disk is a FAILED install', async () => {
  const fixture = await makeHome();
  const checker = checkerFor(fixture, {
    execFile: async () => ({ stdout: 'up to date\n', stderr: '' }),
  });
  await checker.check();
  const result = await checker.install('claude', '2.1.260');
  assert.equal(result.ok, false);
  assert.match(result.error, /2\.1\.258 is installed, not 2\.1\.260/);
});

test('install refuses to run when the config snapshot fails, and never spawns the updater', async () => {
  // No rollback point, no install: this is exactly the safety Pat asked for.
  const fixture = await makeHome();
  let installRan = false;
  const checker = checkerFor(fixture, {
    mkdir: async () => { throw new Error('snapshot dir denied'); },
    execFile: async () => { installRan = true; return { stdout: '', stderr: '' }; },
  });
  await checker.check();
  const result = await checker.install('claude', '2.1.260');
  assert.equal(result.ok, false);
  assert.match(result.reason, /snapshot failed/);
  assert.equal(installRan, false, 'the updater must never spawn without a rollback point');
});

test('an offline latest-check keeps an update it already knew about', async () => {
  const fixture = await makeHome();
  await checkerFor(fixture).check();
  // A later check that cannot reach the network must not erase the known update
  // and make the chip vanish; it marks it stale instead (2026-09-03).
  const offline = checkerFor(fixture, { fetchImpl: () => { throw new Error('offline'); } });
  const state = await offline.check();
  assert.equal(state.providers.claude.latest, '2.1.260', 'the known update survived the offline check');
  assert.equal(state.providers.claude.latestStale, true);
});

test('install refuses a version string that has no business on a command line', async () => {
  const fixture = await makeHome();
  const checker = checkerFor(fixture);
  const result = await checker.install('claude', '2.1.260 && calc.exe');
  assert.equal(result.ok, false);
  assert.match(result.reason, /refusing an unsafe version string/);
});

test('snapshot then diff sees a changed key, a removed key, and an untouched toml', async () => {
  const fixture = await makeHome();
  const checker = checkerFor(fixture);
  const snapshot = await checker.snapshotConfig('claude', { from: '2.1.258', to: '2.1.260' });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.files.some((file) => file.endsWith('.claude.json')), true);
  assert.equal(
    snapshot.files.some((file) => file.includes('.claude-team')), false,
    'a config home that does not exist is never invented',
  );

  // What an update's first run does: flip a setting, drop a key, add one.
  await fsp.writeFile(
    path.join(fixture.home, '.claude.json'),
    JSON.stringify({ autoUpdates: true, oauthAccount: { emailAddress: 'x@y.z' }, newKey: 'hello' }, null, 2),
  );

  const diff = await checker.configDiff('claude');
  assert.equal(diff.ok, true);
  assert.equal(diff.changedCount, 1);
  const claudeJson = diff.files.find((file) => file.source.endsWith('.claude.json'));
  assert.deepEqual(claudeJson.diff.changed, [{ key: 'autoUpdates', from: 'false', to: 'true' }]);
  assert.deepEqual(claudeJson.diff.removed, [{ key: 'installMethod', value: 'global' }]);
  assert.deepEqual(claudeJson.diff.added, [{ key: 'newKey', value: 'hello' }]);

  const settings = diff.files.find((file) => file.source.endsWith(path.join('.claude', 'settings.json')));
  assert.deepEqual(settings.diff, { kind: 'json', added: [], removed: [], changed: [] });
});

test('a codex toml diff reports changed and unchanged as line counts', async () => {
  const fixture = await makeHome();
  const checker = checkerFor(fixture);
  await checker.snapshotConfig('codex', { from: '0.152.1', to: '0.153.2' });
  let diff = await checker.configDiff('codex');
  assert.deepEqual(
    diff.files.find((f) => f.source.endsWith('config.toml')).diff,
    { kind: 'text', changed: false, lineDelta: 0 },
  );
  await fsp.writeFile(
    path.join(fixture.home, '.codex', 'config.toml'),
    'model = "gpt-6"\napproval_policy = "on-request"\nsandbox_mode = "read-only"\n',
  );
  diff = await checker.configDiff('codex');
  assert.deepEqual(
    diff.files.find((f) => f.source.endsWith('config.toml')).diff,
    { kind: 'text', changed: true, lineDelta: 1 },
  );
  assert.equal(diff.changedCount, 1);
});

test('restoreConfig writes the snapshot back, and only when it is asked to', async () => {
  const fixture = await makeHome();
  const checker = checkerFor(fixture);
  await checker.snapshotConfig('codex', { from: '0.152.1', to: '0.153.2' });
  await fsp.writeFile(path.join(fixture.home, '.codex', 'config.toml'), 'model = "wrecked"\n');
  // A diff on its own changes nothing.
  await checker.configDiff('codex');
  assert.equal(await fsp.readFile(path.join(fixture.home, '.codex', 'config.toml'), 'utf8'), 'model = "wrecked"\n');

  const restored = await checker.restoreConfig('codex');
  assert.equal(restored.ok, true);
  assert.equal(restored.restored.length, 1);
  assert.equal(
    await fsp.readFile(path.join(fixture.home, '.codex', 'config.toml'), 'utf8'),
    'model = "gpt-6"\napproval_policy = "never"\n',
  );
});

test('a diff with no snapshot says so instead of throwing', async () => {
  const fixture = await makeHome();
  const checker = checkerFor(fixture);
  assert.deepEqual(
    await checker.configDiff('cursor'),
    { ok: false, reason: 'no config snapshot has been taken for this CLI yet' },
  );
});

test('config diffs redact credential-shaped keys but not every key named *Key', () => {
  const before = JSON.stringify({
    apiKey: 'sk-old-value', oauthToken: 'a', plain: 1, sortKey: 'name',
  });
  const after = JSON.stringify({
    apiKey: 'sk-new-value', oauthToken: 'b', plain: 2, sortKey: 'date',
  });
  const diff = diffJson(before, after);
  assert.deepEqual(diff.changed, [
    { key: 'apiKey', from: '(redacted)', to: '(redacted)' },
    { key: 'oauthToken', from: '(redacted)', to: '(redacted)' },
    { key: 'plain', from: '1', to: '2' },
    { key: 'sortKey', from: 'name', to: 'date' },
  ]);
  assert.deepEqual(diffText('a\nb\n', 'a\nb\n'), { kind: 'text', changed: false, lineDelta: 0 });
});

test('the fixture path loads a prepared state instead of the network', async () => {
  const fixture = await makeHome();
  const fixtureFile = path.join(fixture.root, 'fixture.json');
  await fsp.writeFile(fixtureFile, JSON.stringify({
    providers: { claude: { installed: '1.0.0', latest: '2.0.0', label: 'Claude Code' } },
  }));
  const checker = createCliUpdateChecker({
    fetchImpl: () => { throw new Error('the fixture path must not touch the network'); },
    homedir: () => fixture.home,
    env: {},
    now: () => new Date('2026-09-03T12:00:00.000Z'),
    stateFile: path.join(fixture.root, 'state', 'cli-updates.json'),
    fixtureFile,
  });
  const state = await checker.check();
  assert.equal(state.providers.claude.latest, '2.0.0');
  assert.deepEqual(pendingUpdates(state).map((p) => p.id), ['claude']);
});

test('config targets are DISCOVERED on disk, never hardcoded, and name nothing else', async () => {
  const root = await fsp.mkdtemp(path.join(realTmpDir(), 'harbor-cfgtargets-'));
  const home = path.join(root, 'home');
  for (const dir of ['.claude', '.claude-team', '.codex', '.codex-work', '.cursor']) {
    await fsp.mkdir(path.join(home, dir), { recursive: true });
  }
  await fsp.writeFile(path.join(home, '.claude.json'), '{}');
  const env = { LOCALAPPDATA: path.join(root, 'local') };

  const claude = await configTargets('claude', home, env, fsp.readdir);
  assert.equal(claude.some((file) => file.endsWith('.claude.json')), true);
  // Every `.claude*` home on disk is found; no profile name is written in source.
  assert.equal(claude.some((file) => file.includes(path.join('.claude-team', 'settings.json'))), true);
  assert.equal(claude.some((file) => file.includes('projects')), false, 'transcripts are not settings');

  const codex = await configTargets('codex', home, env, fsp.readdir);
  assert.equal(codex.length, 2, 'both .codex and .codex-work were discovered');
  assert.equal(codex.every((file) => file.endsWith('config.toml')), true);

  const cursor = await configTargets('cursor', home, env, fsp.readdir);
  assert.equal(cursor.some((file) => file.includes('cursor-agent')), true);

  assert.equal((await configTargets('nope', home, env, fsp.readdir)).length, 0);
});

test('a config diff redacts credentials NESTED inside an innocuous-named object', () => {
  // The 2026-09-03 fix: only the top-level key used to be checked, so an
  // oauthAccount or env object whose own name was not credential-shaped had its
  // nested token JSON-dumped into the UI payload.
  const before = JSON.stringify({ oauthAccount: { accessToken: 'old-secret', emailAddress: 'a@b.c' } });
  const after = JSON.stringify({ oauthAccount: { accessToken: 'NEW-SECRET', emailAddress: 'a@b.c' } });
  assert.deepEqual(diffJson(before, after).changed, [{ key: 'oauthAccount', from: '(redacted)', to: '(redacted)' }]);
  // A token buried under an ordinary object key never reaches the diff either.
  const envBefore = JSON.stringify({ mcp: { server: { env: { OPENAI_API_KEY: 'sk-old' } } } });
  const envAfter = JSON.stringify({ mcp: { server: { env: { OPENAI_API_KEY: 'sk-NEW' } } } });
  const changed = diffJson(envBefore, envAfter).changed.find((c) => c.key === 'mcp');
  assert.equal(/sk-old|sk-NEW/.test(JSON.stringify(changed || {})), false, 'no nested secret leaks into the diff');
  // Round-2: auth / bearer names inside arrays of objects are redacted too, and
  // sortKey (an ordinary *Key) is still shown.
  const authBefore = JSON.stringify({ items: [{ auth: { bearer: 'old' } }], sortKey: 'name' });
  const authAfter = JSON.stringify({ items: [{ auth: { bearer: 'new' } }], sortKey: 'date' });
  const authDiff = diffJson(authBefore, authAfter);
  assert.equal(/old|new/.test(JSON.stringify(authDiff.changed.find((c) => c.key === 'items') || {})), false, 'no bearer token leaks');
  assert.deepEqual(authDiff.changed.find((c) => c.key === 'sortKey'), { key: 'sortKey', from: 'name', to: 'date' });
});

test('an unreadable (not absent) config aborts the install so there is a rollback point', async () => {
  const fixture = await makeHome();
  let installRan = false;
  const realRead = fsp.readFile;
  const checker = checkerFor(fixture, {
    readFile: async (p, enc) => {
      if (String(p).endsWith('.claude.json') || String(p).endsWith(path.join('.claude', 'settings.json'))) {
        const err = new Error('permission denied'); err.code = 'EACCES'; throw err;
      }
      return realRead(p, enc);
    },
    execFile: async () => { installRan = true; return { stdout: '', stderr: '' }; },
  });
  await checker.check();
  const result = await checker.install('claude', '2.1.260');
  assert.equal(result.ok, false);
  assert.equal(installRan, false, 'a config that exists but cannot be read must not pass as "no config yet"');
});

test('an updater that exits 0 but leaves an unreadable on-disk version is a failure', async () => {
  const fixture = await makeHome();
  const realRead = fsp.readFile;
  let installed = false;
  const checker = checkerFor(fixture, {
    execFile: async () => { installed = true; return { stdout: 'ok', stderr: '' }; },
    readFile: async (p, enc) => {
      if (installed && String(p).includes(path.join('@anthropic-ai', 'claude-code')) && String(p).endsWith('package.json')) {
        const err = new Error('gone'); err.code = 'ENOENT'; throw err;
      }
      return realRead(p, enc);
    },
  });
  await checker.check();
  const result = await checker.install('claude', '2.1.260');
  assert.equal(result.ok, false);
  assert.match(result.error, /could not be read/);
});

test('a 200 response with no version is a failed check that keeps the known update', async () => {
  const fixture = await makeHome();
  await checkerFor(fixture).check();
  const base = fakeFetch();
  const badFetch = (url, init) => {
    if (String(url).endsWith('@anthropic-ai/claude-code/latest')) {
      return Promise.resolve({ ok: true, json: async () => ({}), text: async () => '' });
    }
    return base(url, init);
  };
  const state = await checkerFor(fixture, { fetchImpl: badFetch }).check();
  assert.equal(state.providers.claude.latest, '2.1.260', 'the known update survived a malformed 200');
  assert.equal(state.providers.claude.latestStale, true);
});

test('subscribers see every state change so the chip repaints without polling', async () => {
  const fixture = await makeHome();
  const checker = checkerFor(fixture);
  const seen = [];
  const off = checker.subscribe((state) => seen.push(state.checkedAt));
  await checker.check();
  await checker.dismiss('claude', '2.1.260');
  off();
  await checker.dismiss('codex', '0.153.2');
  assert.equal(seen.length, 3, 'initial local reconcile, check and dismiss push; unsubscribing stops pushes');
});
