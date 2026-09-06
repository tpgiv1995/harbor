'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  hexToRgb,
  normalizeHome,
  resolveProfile,
  defaultProfileId,
  profileStyle,
  resumeCommandForProfile,
  railWidthForProfileCount,
} = require('../../src/renderer/profiles.cjs');
const { normalizeHome: sidebarNormalizeHome } = require('../../src/shared/sidebar-model.cjs');

const PROFILES = [
  { id: 'personal', label: 'Personal', letter: 'P', color: '#6FA8D8', isDefault: false },
  { id: 'team', label: 'Team', letter: 'T', color: '#D68A5A', isDefault: true },
  { id: 'lab', label: 'Lab', letter: 'S', color: '#F962BA', isDefault: false },
];

test('hexToRgb converts profile colours for CSS custom properties', () => {
  assert.equal(hexToRgb('#6FA8D8'), '111 168 216');
  assert.equal(hexToRgb('#D68A5A'), '214 138 90');
  assert.equal(hexToRgb('#F962BA'), '249 98 186');
});

test('normalizeHome resolves unknown homes to the default profile', () => {
  assert.equal(normalizeHome('team', PROFILES), 'team');
  assert.equal(normalizeHome('bogus', PROFILES), 'team');
  assert.equal(normalizeHome(null, PROFILES), 'team');
  assert.equal(sidebarNormalizeHome('bogus', PROFILES), 'team');
});

test('normalizeHome without profiles returns the home verbatim', () => {
  assert.equal(normalizeHome('alpha'), 'alpha');
  assert.equal(normalizeHome(null), null);
});

test('profileStyle exposes colour tokens for data-driven badges', () => {
  assert.deepEqual(profileStyle(PROFILES[0]), {
    '--profile-color': '#6FA8D8',
    '--profile-rgb': '111 168 216',
  });
});

// The copy-resume-command menu item. It used to compose per-account FLAGS by
// profile index, which emitted the third profile's id as a flag name; on the
// machine this was built for that id was a person's first name, and on anybody
// else's machine the flag does not exist at all. CLAUDE_CONFIG_DIR is what the
// account actually is and what Harbor itself sets.
test('the copied resume command routes by config home, not by an account flag', () => {
  const withHomes = PROFILES.map((p) => ({ ...p, configHome: `/home/testuser/.claude${p.id === 'personal' ? '' : `-${p.id}`}` }));
  // The default profile needs no prefix: a bare launch already lands there.
  assert.equal(
    resumeCommandForProfile(withHomes[1], withHomes, 'abc'),
    'claude --dangerously-skip-permissions --resume abc',
  );
  assert.equal(
    resumeCommandForProfile(withHomes[0], withHomes, 'abc'),
    'claude --dangerously-skip-permissions --resume abc',
  );
  assert.equal(
    resumeCommandForProfile(withHomes[2], withHomes, 'abc'),
    'CLAUDE_CONFIG_DIR=/home/testuser/.claude-lab claude --dangerously-skip-permissions --resume abc',
  );
  // No account name appears anywhere in the composed command.
  for (const profile of withHomes) {
    const command = resumeCommandForProfile(profile, withHomes, 'abc');
    assert.equal(/--(personal|team|lab)\b/.test(command), false, `account flag leaked: ${command}`);
  }
});

test('a config home with a space is quoted so the command can be pasted', () => {
  const odd = [{ id: 'a', isDefault: true, configHome: '/srv/a' }, { id: 'b', isDefault: false, configHome: '/srv/my claude' }];
  assert.equal(
    resumeCommandForProfile(odd[1], odd, 'xyz'),
    "CLAUDE_CONFIG_DIR='/srv/my claude' claude --dangerously-skip-permissions --resume xyz",
  );
});

test('rail width scales with profile count without shrinking the three-profile case', () => {
  assert.equal(railWidthForProfileCount(1), 260);
  assert.equal(railWidthForProfileCount(3), 292);
  assert.equal(railWidthForProfileCount(5), 320);
});

test('renderer sources no longer hardcode the lab account id', () => {
  const files = [
    '../../src/renderer/sidebar/Sidebar.jsx',
    '../../src/renderer/NewSessionConfig.jsx',
    '../../src/renderer/stage/SessionTile.jsx',
    '../../src/renderer/index.jsx',
    '../../src/shared/sidebar-model.js',
    '../../src/shared/sidebar-model.cjs',
  ].map((rel) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8'));
  for (const source of files) {
    assert.equal(source.includes("'lab'"), false, 'literal lab id remains');
    assert.equal(source.includes('"lab"'), false, 'literal lab id remains');
  }
});

test('sidebar launch buttons are profile-driven', () => {
  const sidebarSource = fs.readFileSync(
    path.resolve(__dirname, '../../src/renderer/sidebar/Sidebar.jsx'),
    'utf8',
  );
  assert.match(sidebarSource, /profiles\.map\(\(profile\)/);
  assert.match(sidebarSource, /renderProfileLaunchButtons/);
  assert.doesNotMatch(sidebarSource, /account: 'personal'/);
});

test('default profile id follows isDefault', () => {
  assert.equal(defaultProfileId(PROFILES), 'team');
  assert.equal(resolveProfile(PROFILES, 'personal')?.letter, 'P');
});
