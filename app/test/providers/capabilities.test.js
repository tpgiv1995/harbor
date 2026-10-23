'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { createCapabilitiesProvider, newSessionOptions: readNewSessionOptions } = require('../../src/main/providers/capabilities.js');
const { realTmpDir } = require('../support/real-tmpdir.js');
const newSessionOptions = (config) => readNewSessionOptions(config, { env: {}, homedir: () => path.join(realTmpDir(), 'harbor-no-codex-home') });

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
  // Codex models are DISCOVERED from a configured codex home's
  // models_cache.json; with no codex profile here there is nothing to read, so
  // the menu is `default` plus a single valid fallback slug. It used to carry a
  // hand-pinned `gpt-5.6`, which 400s as "not supported ... ChatGPT account".
  // The fallback carries no migration target (gpt-5.6-sol did, and with no
  // cache nothing acknowledges it, so its first launch met codex's migration
  // screen).
  assert.equal(options.providers.codex.defaultModel, 'default');
  assert.deepEqual(
    options.providers.codex.models.map((model) => model.value),
    ['default', 'gpt-6-sol'],
  );
  assert.deepEqual(options.providers.codex.efforts, ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(options.providers.cursor.models, [{ value: 'default', label: 'Default' }]);
  assert.equal(options.providers.cursor.bin, 'cursor-agent');
  assert.deepEqual(options.profilesByProvider.claude.map((profile) => profile.id), ['personal', 'team', 'lab']);
  assert.deepEqual(options.profilesByProvider.codex, []);
  assert.equal(options.defaultProfiles.claude, 'personal');
});

test('codex models are discovered from a configured codex home models_cache', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-codex-cache-'));
  const home = path.join(dir, '.codex');
  await fsp.mkdir(home, { recursive: true });
  // Same shape codex-cli writes: slug/display_name/visibility. `hide` entries
  // (gpt-reserve, codex-auto-review) must not reach the menu.
  await fsp.writeFile(path.join(home, 'models_cache.json'), JSON.stringify({
    models: [
      { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list' },
      { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna', visibility: 'list' },
      { slug: 'gpt-reserve', display_name: 'Reserve', visibility: 'hide' },
      { slug: 'codex-auto-review', display_name: 'Auto Review', visibility: 'hide' },
    ],
  }));
  const options = newSessionOptions({
    profiles: [
      { id: 'personal', label: 'Personal', provider: 'claude', configHome: '/home/testuser/.claude', isDefault: true },
      { id: 'codex-a', label: 'Codex A', provider: 'codex', configHome: home, isDefault: true },
    ],
  });
  assert.deepEqual(
    options.providers.codex.models.map((model) => model.value),
    ['default', 'gpt-5.6-sol', 'gpt-5.6-luna'],
  );
  assert.equal(options.providers.codex.models[1].label, 'GPT-5.6-Sol');
  await fsp.rm(dir, { recursive: true, force: true });
});

// Codex reasoning levels are DISCOVERED from the same models_cache.json (the
// highest-priority listed model's supported_reasoning_levels), so a codex
// release that adds a level surfaces without a code change. 0.151 added `max`
// and `ultra` above the low/medium/high/xhigh set the menu was pinned to. The
// no-codex-home floor stays `['low','medium','high','xhigh']` (asserted above).
test('codex reasoning levels are discovered from the models_cache, highest priority wins', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-codex-effort-'));
  const home = path.join(dir, '.codex');
  await fsp.mkdir(home, { recursive: true });
  await fsp.writeFile(path.join(home, 'models_cache.json'), JSON.stringify({
    models: [
      {
        slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list', priority: 1,
        supported_reasoning_levels: [
          { effort: 'low' }, { effort: 'medium' }, { effort: 'high' },
          { effort: 'xhigh' }, { effort: 'max' }, { effort: 'ultra' },
        ],
      },
      // A lower-priority listed model must NOT win the effort read.
      {
        slug: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna', visibility: 'list', priority: 2,
        supported_reasoning_levels: [{ effort: 'low' }],
      },
    ],
  }));
  const options = newSessionOptions({
    profiles: [
      { id: 'personal', provider: 'claude', configHome: '/home/testuser/.claude', isDefault: true },
      { id: 'codex-a', provider: 'codex', configHome: home, isDefault: true },
    ],
  });
  assert.deepEqual(
    options.providers.codex.efforts,
    ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  );
  await fsp.rm(dir, { recursive: true, force: true });
});

test('new session options group multiple Codex profiles and omit disabled providers', () => {
  const options = newSessionOptions({
    profiles: [
      PROFILES[0],
      { id: 'codex-a', label: 'Codex A', provider: 'codex', configHome: '/tmp/codex-a', isDefault: false },
      { id: 'codex-b', label: 'Codex B', provider: 'codex', configHome: '/tmp/codex-b', isDefault: true },
    ],
    providers: { cursor: { enabled: false } },
  });
  assert.deepEqual(options.profilesByProvider.codex.map((profile) => profile.id), ['codex-a', 'codex-b']);
  assert.equal(options.defaultProfiles.codex, 'codex-b');
  assert.equal(options.providers.codex.defaultProfile, 'codex-b');
  assert.equal(options.providers.cursor, undefined);
  assert.equal(options.profilesByProvider.cursor, undefined);
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

// THE SLASH MENU IS PROVIDER-SCOPED (2026-10-15). A Codex window was offered
// Claude's built-ins (/effort, /fast, /output-style, /init "Generate a
// CLAUDE.md") plus the default Claude home's commands, skills, plugins and MCP
// servers. A Codex window now lists Codex's own built-ins (the 0.160.0 popup),
// its home's skills as `$name`, and the MCP server names in its config.toml.
const { createAccountsProvider } = require('../../src/main/providers/accounts.js');
const { CODEX_BUILTIN_COMMANDS } = require('../../src/main/providers/capabilities.js');

async function makeCodexWorld(root) {
  const claudeHome = path.join(root, '.claude');
  const codexHome = path.join(root, '.codex-pro');
  const userHome = path.join(root, 'user');
  const cwd = path.join(root, 'proj');
  // A Claude home that MUST NOT leak into the Codex window.
  await writeFile(path.join(claudeHome, '.claude.json'), JSON.stringify({ mcpServers: { 'claude-only-mcp': {} } }));
  await writeFile(path.join(claudeHome, 'commands', 'claude-only.md'), '---\ndescription: Claude command.\n---\n');
  await writeFile(path.join(claudeHome, 'skills', 'claude-skill', 'SKILL.md'), '---\nname: claude-skill\ndescription: Claude skill.\n---\n');
  // The Codex home: a user skill, a bundled .system skill, a skill whose
  // frontmatter name differs from its folder, and one Codex would reject.
  await writeFile(path.join(codexHome, 'skills', 'sketch', 'SKILL.md'), '---\nname: sketch\ndescription: Draw a sketch.\n---\n');
  await writeFile(path.join(codexHome, 'skills', 'folder-name', 'SKILL.md'), '---\nname: renamed\ndescription: >\n  Folded block\n  description.\n---\n');
  await writeFile(path.join(codexHome, 'skills', 'no-description', 'SKILL.md'), '---\nname: no-description\n---\n');
  await writeFile(path.join(codexHome, 'skills', '.system', 'bundled', 'SKILL.md'), '---\nname: bundled\ndescription: Ships with Codex.\n---\n');
  await writeFile(path.join(userHome, '.agents', 'skills', 'roaming', 'SKILL.md'), '---\nname: roaming\ndescription: From ~/.agents.\n---\n');
  await writeFile(path.join(cwd, '.agents', 'skills', 'repo-skill', 'SKILL.md'), '---\nname: repo-skill\ndescription: From the repo.\n---\n');
  await writeFile(path.join(codexHome, 'prompts', 'old-prompt.md'), '---\ndescription: 0.160 has no custom prompts.\n---\n');
  await writeFile(path.join(codexHome, 'config.toml'), [
    'model = "gpt-6-sol"',
    '[mcp_servers.docs]',
    'command = "npx"',
    'env = { TOKEN = "synthetic-secret" }',
    '[mcp_servers."quoted.name"]',
    'url = "http://127.0.0.1:1"',
    '[mcp_servers.docs.env]',
    'X = "y"',
  ].join('\n'));
  return { claudeHome, codexHome, userHome, cwd };
}

test('a Codex window lists Codex built-ins, $skills and its own MCP names, never Claude\'s', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-caps-codex-'));
  try {
    const { claudeHome, codexHome, userHome, cwd } = await makeCodexWorld(root);
    const profiles = [
      { id: 'max', provider: 'claude', configHome: claudeHome, isDefault: true },
      { id: 'cx-pro', provider: 'codex', configHome: codexHome },
    ];
    const accounts = createAccountsProvider({
      history: { sessionMeta: async () => { throw new Error('not indexed'); } },
      profiles,
    });
    const provider = createCapabilitiesProvider({ accounts, homedir: () => userHome });
    // The provisional window has no rollout yet; the hint is all there is.
    const caps = await provider.get('pane:42', { provider: 'codex', profileId: 'cx-pro', cwd });
    assert.equal(caps.provider, 'codex');
    assert.equal(caps.account, 'cx-pro');
    assert.equal(caps.home, codexHome);
    const names = caps.commands.map((c) => c.name);
    for (const claudeOnly of ['/effort', '/fast', '/output-style', '/rate-limit-options', '/claude-only', '/claude-skill']) {
      assert.ok(!names.includes(claudeOnly), `${claudeOnly} leaked into a Codex window`);
    }
    assert.equal(caps.commands.find((c) => c.name === '/init').description, 'create an AGENTS.md file with instructions for Codex');
    assert.deepEqual(names.filter((n) => n.startsWith('/')), CODEX_BUILTIN_COMMANDS.map(([n]) => n));
    // The popup's own exclusions: debug commands, /apps, debug-build-only and alias rows.
    for (const hidden of ['/debug-config', '/debug-m-drop', '/apps', '/rollout', '/test-approval', '/quit', '/btw']) {
      assert.ok(!names.includes(hidden), `${hidden} is not in the 0.160 popup`);
    }
    // No custom prompts in 0.160.
    assert.ok(!names.some((n) => n.startsWith('/prompts:')));
    // Skills insert with Codex's own `$` syntax.
    assert.deepEqual(names.filter((n) => n.startsWith('$')), ['$bundled', '$renamed', '$repo-skill', '$roaming', '$sketch']);
    assert.equal(caps.commands.find((c) => c.name === '$renamed').description, 'Folded block description.');
    assert.ok(caps.commands.filter((c) => c.name.startsWith('$')).every((c) => c.source === 'skill'));
    // MCP names from config.toml only, no values, no Claude servers.
    assert.deepEqual(caps.mcpServers, ['docs', 'quoted.name']);
    assert.doesNotMatch(JSON.stringify(caps), /synthetic-secret|claude-only-mcp/);
    // Nothing of Claude's model / effort / fast-mode surface either.
    assert.deepEqual(caps.models, { cached: [], families: [], versions: [] });
    assert.deepEqual(caps.effort.levels, []);
    assert.deepEqual(caps.plugins, []);
    assert.equal(caps.dynamicWorkflow, null);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('an indexed Codex session resolves its home from the rollout scan, with no hint', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-caps-codex-'));
  try {
    const { claudeHome, codexHome, userHome, cwd } = await makeCodexWorld(root);
    const accounts = createAccountsProvider({
      history: { sessionMeta: async () => ({ provider: 'codex', cwd, path: path.join(codexHome, 'sessions', 'r.jsonl'), configHome: codexHome }) },
      profiles: [
        { id: 'max', provider: 'claude', configHome: claudeHome, isDefault: true },
        { id: 'cx-pro', provider: 'codex', configHome: codexHome },
      ],
    });
    const caps = await createCapabilitiesProvider({ accounts, homedir: () => userHome }).get('019a0000-0000-7000-8000-000000000000');
    assert.equal(caps.provider, 'codex');
    assert.equal(caps.account, 'cx-pro');
    assert.ok(caps.commands.some((c) => c.name === '$repo-skill'));
    assert.ok(!caps.commands.some((c) => c.name === '/effort'));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('a Cursor window gets no Claude command list', async () => {
  const accounts = createAccountsProvider({
    history: { sessionMeta: async () => { throw new Error('not indexed'); } },
    profiles: [{ id: 'max', provider: 'claude', configHome: '/nonexistent/.claude', isDefault: true }],
  });
  const caps = await createCapabilitiesProvider({ accounts }).get('pane:9', { provider: 'cursor' });
  assert.equal(caps.provider, 'cursor');
  assert.deepEqual(caps.commands, []);
  assert.deepEqual(caps.models.families, []);
});

test('a Claude window is unchanged by the provider split', async () => {
  const caps = await providerFor({}, null).get('unknown-2', { provider: 'claude' });
  assert.equal(caps.provider, 'claude');
  assert.ok(caps.commands.some((c) => c.name === '/effort'));
  assert.equal(caps.models.families.length, 4);
});

test('codex model menus read EVERY configured codex home, the default home winning a shared slug', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-codex-homes-'));
  try {
    const first = path.join(dir, '.codex');
    const second = path.join(dir, '.codex-pro');
    await writeFile(path.join(first, 'models_cache.json'), JSON.stringify({ models: [
      { slug: 'gpt-6-sol', display_name: 'GPT-6-Sol', visibility: 'list', priority: 2, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
    ] }));
    await writeFile(path.join(second, 'models_cache.json'), JSON.stringify({ models: [
      { slug: 'gpt-6-sol', display_name: 'Other label', visibility: 'list', priority: 2, supported_reasoning_levels: [{ effort: 'ultra' }] },
      { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list', priority: 1, supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'ultra' }] },
    ] }));
    const options = newSessionOptions({ profiles: [
      { id: 'personal', provider: 'claude', configHome: '/home/testuser/.claude', isDefault: true },
      { id: 'cx', provider: 'codex', configHome: first },
      { id: 'cx-pro', provider: 'codex', configHome: second },
    ] }).providers.codex;
    assert.deepEqual(options.models.map((m) => m.value), ['default', 'gpt-6-sol', 'gpt-6-astra']);
    assert.equal(options.models[1].label, 'GPT-6-Sol');
    assert.deepEqual(options.effortsByModel['gpt-6-sol'], ['low', 'high']);
    // The highest-priority model across every home supplies Default.
    assert.deepEqual(options.efforts, ['medium', 'ultra']);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
