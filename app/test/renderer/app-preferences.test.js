'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { appPreferences, applyPreferences } = require('../../src/renderer/app-preferences.cjs');
const { resumeCommandForProfile } = require('../../src/renderer/profiles.cjs');

test('the theme is a root attribute set only for a non-default theme', () => {
  const root = { dataset: {} };
  applyPreferences({ theme: 'reading' }, root);
  assert.equal(root.dataset.harborTheme, 'reading');
  assert.equal(appPreferences().theme, 'reading');
  applyPreferences({ theme: 'unknown' }, root);
  assert.equal(root.dataset.harborTheme, undefined);
  applyPreferences(undefined, root);
  assert.equal(appPreferences().claudeAutoMode, false);
});

test('the copy-paste resume command carries the same Claude permission flags a launch does', () => {
  const profiles = [{ id: 'personal', isDefault: true, configHome: '/h/.claude' }];
  assert.equal(resumeCommandForProfile(profiles[0], profiles, 'abc'), 'claude --dangerously-skip-permissions --resume abc');
  assert.equal(
    resumeCommandForProfile(profiles[0], profiles, 'abc', { claudeAutoMode: true }),
    'claude --permission-mode auto --allow-dangerously-skip-permissions --resume abc',
  );
});
