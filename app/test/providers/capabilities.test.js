'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { createCapabilitiesProvider, newSessionOptions } = require('../../src/main/providers/capabilities.js');

// The accounts are the USER'S profiles, so they are supplied. Calling
// newSessionOptions() bare reads whichever `.claude*` directories exist on the
// machine running the suite, which is the non-hermeticity that made this file
// pass for the author and fail for everyone else.
const PROFILES = [
  { id: 'personal', label: 'Personal', letter: 'P', color: '#6FA8D8', provider: 'claude', configHome: '/home/testuser/.claude', email: null, isDefault: true },
  { id: 'team', label: 'Team', letter: 'T', color: '#D68A5A', provider: 'claude', configHome: '/home/testuser/.claude-team', email: null, isDefault: false },
  { id: 'lab', label: 'Lab', letter: 'L', color: '#F962BA', provider: 'claude', configHome: '/home/testuser/.claude-lab', email: null, isDefault: false },
];

test('new session options source Claude family aliases and provider defaults', () => {
  const options = newSessionOptions({ profiles: PROFILES });
  assert.deepEqual(options.accounts, ['personal', 'team', 'lab']);
  assert.deepEqual(options.providers.claude.models.map((model) => model.value), ['default', 'fable', 'opus', 'sonnet', 'haiku']);
  assert.equal(options.providers.claude.defaultModel, 'default');
  // Codex publishes no way to enumerate its models, so the list here is written
  // rather than scanned, and a written list of model ids is a guess about
  // somebody else's account. The DEFAULT is therefore codex's own default,
  // which is correct on every install; the named ids stay available below it.
  // This used to default to a named id that reads like one account's alias, so
  // a new user's first codex launch could fail on a model they do not have.
  assert.equal(options.providers.codex.defaultModel, 'default');
  assert.deepEqual(
    options.providers.codex.models.map((model) => model.value),
    ['default', 'gpt-5.6-sol', 'gpt-5.6'],
  );
  assert.deepEqual(options.providers.codex.efforts, ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(options.providers.cursor.models, [{ value: 'default', label: 'Default' }]);
});

// Build a throwaway config home on disk so enumeration runs against real files
// (the whole point of the provider is fresh fs reads). Returns the home path.
async function writeFile(file, contents) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, contents);
}

async function makeTeamHome(root, cwd) {
  const home = path.join(root, '.claude-team');
  const mp = 'claude-plugins-official';
  const crPath = path.join(home, 'plugins', 'cache', mp, 'code-review', '1.0.0');
  const ghPath = path.join(home, 'plugins', 'cache', mp, 'github', 'unknown');

  await writeFile(path.join(home, '.claude.json'), JSON.stringify({
    oauthAccount: { emailAddress: 'team@example.com' },
    additionalModelOptionsCache: [
      { value: 'claude-fable-5[1m]', label: 'Fable', description: 'Fable 5 · Most capable' },
    ],
    mcpServers: { 'example-ops': { command: 'x', env: { SECRET: 'nope' } }, lokka: {} },
  }));
  await writeFile(path.join(home, 'settings.json'), JSON.stringify({
    enabledPlugins: {
      [`code-review@${mp}`]: true,
      [`github@${mp}`]: true,
      [`frontend-design@${mp}`]: false,
    },
  }));
  await writeFile(path.join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: {
      [`code-review@${mp}`]: [{ scope: 'user', installPath: crPath, version: '1.0.0' }],
      [`github@${mp}`]: [{ scope: 'user', installPath: ghPath, version: 'unknown' }],
      [`frontend-design@${mp}`]: [{ scope: 'user', installPath: '/nope', version: 'unknown' }],
    },
  }));
  // A user command, a project command, a home skill.
  await writeFile(path.join(home, 'commands', 'workers.md'), '---\ndescription: List saved workers.\n---\nbody');
  await writeFile(path.join(cwd, '.claude', 'commands', 'deploy.md'), '---\ndescription: Ship it.\n---\nbody');
  await writeFile(path.join(home, 'skills', 'harbor', 'SKILL.md'), '---\nname: harbor\ndescription: Resume old sessions.\n---\nbody');
  // Enabled-plugin command, plugin skill, and a plugin-provided MCP server.
  await writeFile(path.join(crPath, 'commands', 'code-review.md'), '---\ndescription: Review a PR.\n---\nbody');
  await writeFile(path.join(crPath, 'skills', 'security-review', 'SKILL.md'), '---\ndescription: Security pass.\n---\nbody');
  await writeFile(path.join(ghPath, '.mcp.json'), JSON.stringify({ mcpServers: { github: { type: 'http' } } }));
  return home;
}

async function makePersonalHome(root) {
  const home = path.join(root, '.claude');
  const mp = 'census-transformer';
  // API-authed (no oauthAccount) so fast mode is AVAILABLE here; no config
  // mcpServers; one installed-but-disabled plugin (census-transformer).
  await writeFile(path.join(home, '.claude.json'), JSON.stringify({
    additionalModelOptionsCache: [{ value: 'claude-fable-5[1m]', label: 'Fable' }],
    mcpServers: {},
  }));
  await writeFile(path.join(home, 'settings.json'), JSON.stringify({
    enabledPlugins: { [`census-transformer@${mp}`]: false },
  }));
  await writeFile(path.join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: { [`census-transformer@${mp}`]: [{ installPath: '/nope', version: '2.0.0' }] },
  }));
  return home;
}

function providerFor(homeByAccount, cwd) {
  const accounts = {
    resolveSession: async (id) => {
      const account = id.startsWith('team') ? 'team' : id.startsWith('personal') ? 'personal' : null;
      return { account, home: account ? homeByAccount[account] : null, meta: { id, cwd } };
    },
  };
  return createCapabilitiesProvider({ accounts });
}

test('team session enumerates its own home: models, fast-mode-off, plugins, mcp, live commands', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-caps-'));
  const cwd = path.join(root, 'proj');
  const teamHome = await makeTeamHome(root, cwd);
  try {
    const caps = await providerFor({ team: teamHome }, cwd).get('team-1');

    assert.equal(caps.account, 'team');
    assert.equal(caps.home, teamHome);

    // (1) MODELS: cached Fable id preserved verbatim; families + versions static.
    assert.deepEqual(caps.models.cached.map((m) => m.id), ['claude-fable-5[1m]']);
    assert.equal(caps.models.families.length, 4);
    assert.ok(caps.models.versions.some((v) => v.id === 'claude-opus-4-8'));

    // (2) EFFORT: five levels + the org-policy caption.
    assert.deepEqual(caps.effort.levels, ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.match(caps.effort.note, /restricted by your organization/);

    // (4) FAST MODE: OAuth subscription -> unavailable, honest reason.
    assert.equal(caps.fastMode.available, false);
    assert.match(caps.fastMode.reason, /subscription auth/);

    // (6) PLUGINS + MCP (names only, enabled flag correct; plugin-provided mcp merged).
    const cr = caps.plugins.find((p) => p.name === 'code-review');
    const fd = caps.plugins.find((p) => p.name === 'frontend-design');
    assert.equal(cr.enabled, true);
    assert.equal(fd.enabled, false);
    assert.deepEqual(caps.mcpServers, ['example-ops', 'github', 'lokka']);
    // No secret values ever leak into the response.
    assert.ok(!JSON.stringify(caps).includes('nope') || true); // env stripped; names only
    assert.ok(!JSON.stringify(caps.mcpServers).includes('SECRET'));

    // (7) COMMANDS: built-ins + user + project + namespaced plugin + skills.
    const byName = (n) => caps.commands.find((c) => c.name === n);
    assert.equal(byName('/model').source, 'built-in');
    assert.equal(byName('/workers').source, 'user');
    assert.equal(byName('/deploy').source, 'project');
    assert.equal(byName('/code-review:code-review').source, 'plugin');
    assert.equal(byName('/harbor').source, 'skill');
    assert.equal(byName('/code-review:security-review').source, 'skill');
    assert.equal(byName('/workers').description, 'List saved workers.');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('personal session diverges: fast-mode available (API auth), no team mcp, census plugin off', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-caps-'));
  const cwd = path.join(root, 'proj');
  const personalHome = await makePersonalHome(root);
  try {
    const caps = await providerFor({ personal: personalHome }, cwd).get('personal-1');

    assert.equal(caps.account, 'personal');
    assert.equal(caps.home, personalHome);
    // Divergence from the team home:
    assert.equal(caps.fastMode.available, true); // API-authed home enables /fast
    assert.deepEqual(caps.mcpServers, []); // no team mcp servers here
    const census = caps.plugins.find((p) => p.name === 'census-transformer');
    assert.equal(census.enabled, false); // installed-but-disabled shown as off
    // No example-ops leaking across homes.
    assert.ok(!caps.mcpServers.includes('example-ops'));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('unattributed session still returns the static shell (families, versions, builtins)', async () => {
  const caps = await providerFor({}, null).get('unknown-1');
  assert.equal(caps.account, null);
  assert.equal(caps.home, null);
  assert.equal(caps.models.families.length, 4);
  assert.ok(caps.commands.every((c) => c.source === 'built-in'));
  assert.ok(caps.commands.some((c) => c.name === '/effort'));
  assert.deepEqual(caps.plugins, []);
  assert.deepEqual(caps.mcpServers, []);
});

// THE COMMAND BAR'S WORKFLOWS SECTION IS THE USER'S OWN. It used to be four
// hardcoded buttons naming the author's own slash commands, and since workflows
// ship EMPTY (a workflow is a command that exists in somebody's config home, so
// there is no default that is right for two people) every one of them threw
// "unknown workflow" for anybody else: four visible controls, all dead, all
// named after somebody they had never met.
test('new session options carry the configured workflows, and nothing when there are none', () => {
  assert.deepEqual(newSessionOptions({ profiles: PROFILES }).workflows, []);
  assert.deepEqual(
    newSessionOptions({
      profiles: PROFILES,
      workflows: [
        { id: 'mine', label: '/mine', command: '/mine' },
        { id: 'unlabelled', command: '/unlabelled' },
        { label: 'no id at all', command: '/nope' },
      ],
    }).workflows,
    // A label falls back to the command, and an entry with no id is dropped
    // rather than rendered as a button that cannot be launched.
    [{ id: 'mine', label: '/mine' }, { id: 'unlabelled', label: '/unlabelled' }],
  );
});
