'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sidebarSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/renderer/sidebar/Sidebar.jsx'),
  'utf8',
);

test('rail defaults to a rolling 48-hour filter', () => {
  assert.match(sidebarSource, /useState\(\{ kind: 'rolling', days: 2 \}\)/);
});

test('rail renders an active 48h filter chip while retaining the existing filters', () => {
  assert.match(sidebarSource, /FilterChip label="48h"[\s\S]*?filter\.kind === 'rolling' && filter\.days === 2/);
  for (const label of ['Today', '7d', '30d', 'All']) {
    assert.match(sidebarSource, new RegExp(`FilterChip label="${label}"`));
  }
  assert.match(sidebarSource, /type="date"/);
});
