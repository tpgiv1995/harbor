#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { railWidthForProfileCount } = require('../src/renderer/profiles.cjs');

const OUT = path.resolve(__dirname, '../verify/profile-rail');

const PROFILE_SETS = {
  0: [],
  1: [{ id: 'solo', label: 'Solo', letter: 'S', color: '#6FA8D8' }],
  3: [
    { id: 'personal', label: 'Personal', letter: 'P', color: '#6FA8D8' },
    { id: 'team', label: 'Team', letter: 'T', color: '#D68A5A', isDefault: true },
    { id: 'plan3', label: 'Plan 3', letter: 'S', color: '#F962BA' },
  ],
  5: [
    { id: 'a', label: 'Alpha', letter: 'A', color: '#6FA8D8' },
    { id: 'b', label: 'Bravo', letter: 'B', color: '#D68A5A', isDefault: true },
    { id: 'c', label: 'Charlie', letter: 'C', color: '#F962BA' },
    { id: 'd', label: 'Delta', letter: 'D', color: '#7BD88F' },
    { id: 'e', label: 'Echo', letter: 'E', color: '#C9A0FF' },
  ],
};

function hexToRgb(hex) {
  const raw = String(hex).replace(/^#/, '');
  const value = Number.parseInt(raw, 16);
  return `${(value >> 16) & 255} ${(value >> 8) & 255} ${value & 255}`;
}

function chromeBin() {
  for (const candidate of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const probe = spawnSync('which', [candidate], { encoding: 'utf8' });
    if (probe.status === 0) return probe.stdout.trim();
  }
  throw new Error('no headless chrome binary found');
}

function renderRail(profiles) {
  const width = railWidthForProfileCount(profiles.length || 1);
  const rows = profiles.map((profile) => {
    const rgb = hexToRgb(profile.color);
    return `
      <div class="rm-row" style="--profile-color:${profile.color};--profile-rgb:${rgb}">
        <span class="profile-badge rm-b">${profile.letter}</span>
        <span class="rm-g rm-g-5h"><span class="rm-donut"><span></span></span><b>12%</b><em>↻8pm</em></span>
        <span class="rm-g"><span class="rm-donut"><span></span></span><b>66%</b><em>↻7/31 8pm</em></span>
      </div>`;
  }).join('');
  const launch = profiles.map((profile) => {
    const rgb = hexToRgb(profile.color);
    return `<button class="sidebar-global-new" style="--profile-color:${profile.color};--profile-rgb:${rgb}">+ ${profile.letter}</button>`;
  }).join('');
  const setup = profiles.length === 0
    ? '<div class="rail-setup-banner">No plans configured yet. Open Settings to add a profile.</div>'
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="../../src/renderer/styles.css"><style>
    body { margin: 0; background: #0e0f13; }
    .rail { width: ${width}px; }
  </style></head><body>
    <aside class="rail" data-profile-count="${profiles.length}" style="--rail-width:${width}px">
      <div class="rail-head"><span class="rail-eyebrow">Sessions</span><span class="rail-count">12</span>
        <div class="rail-new-split" data-profile-count="${profiles.length}">${launch}</div>
      </div>
      ${setup}
      <div class="rail-meters" data-profile-count="${profiles.length}">${rows}</div>
    </aside>
  </body></html>`;
}

function meterColumnPositions(profileCount) {
  const padding = 12;
  const badgeW = 16;
  const badgeGap = 8;
  const group5hW = 106;
  const groupGap = 8;
  const weeklyDonut = 18;
  const pctGap = 4;
  const firstDonutX = padding + badgeW + badgeGap;
  const weeklyDonutX = firstDonutX + group5hW + groupGap;
  const weeklyPctX = weeklyDonutX + weeklyDonut + pctGap;
  return {
    railWidth: railWidthForProfileCount(profileCount || 1),
    badgeX: padding,
    fiveHourDonutX: firstDonutX,
    weeklyDonutX,
    weeklyPctX,
  };
}

function screenshot(htmlPath, shotPath) {
  const chrome = chromeBin();
  const result = spawnSync(
    'env',
    ['-u', 'DISPLAY', '-u', 'WAYLAND_DISPLAY', 'xvfb-run', '-a', chrome,
      '--headless=new', '--disable-gpu', '--hide-scrollbars',
      `--screenshot=${shotPath}`, '--window-size=2560,1600',
      `file://${htmlPath}`],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`screenshot failed for ${htmlPath}: ${result.stderr || result.stdout}`);
  }
}

function renderRailBefore() {
  const width = 292;
  const { spawnSync } = require('node:child_process');
  const oldCss = spawnSync('git', ['show', '36dff73:app/src/renderer/styles.css'], {
    cwd: path.resolve(__dirname, '../..'),
    encoding: 'utf8',
  }).stdout;
  const accounts = [
    { key: 'personal', letter: 'P', badge: 'bp' },
    { key: 'team', letter: 'T', badge: 'bt' },
    { key: 'plan3', letter: 'S', badge: 'bs' },
  ];
  const rows = accounts.map((account) => `
      <div class="rm-row">
        <span class="rm-b ${account.badge}">${account.letter}</span>
        <span class="rm-g rm-g-5h"><span class="rm-donut"><span></span></span><b>12%</b><em>↻8pm</em></span>
        <span class="rm-g"><span class="rm-donut"><span></span></span><b>66%</b><em>↻7/31 8pm</em></span>
      </div>`).join('');
  const launch = accounts.map((account) =>
    `<button class="sidebar-global-new ${account.key}">+ ${account.letter}</button>`,
  ).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    ${oldCss.replace(/@import[^;]+;/g, '')}
    body { margin: 0; background: #0e0f13; }
    .rail { width: ${width}px; }
  </style></head><body>
    <aside class="rail" style="--rail-width:${width}px">
      <div class="rail-head"><span class="rail-eyebrow">Sessions</span><span class="rail-count">12</span>
        <div class="rail-new-split">${launch}</div>
      </div>
      <div class="rail-meters">${rows}</div>
    </aside>
  </body></html>`;
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const beforeHtml = path.join(OUT, 'profiles-3-before.html');
  const beforeShot = path.join(OUT, 'profiles-3-before.png');
  fs.writeFileSync(beforeHtml, renderRailBefore());
  screenshot(beforeHtml, beforeShot);
  const report = { 'profiles-3-before': { screenshot: beforeShot, profileCount: 3 } };
  for (const [count, profiles] of Object.entries(PROFILE_SETS)) {
    const key = `profiles-${count}`;
    const htmlPath = path.join(OUT, `${key}.html`);
    const shotPath = path.join(OUT, `${key}.png`);
    fs.writeFileSync(htmlPath, renderRail(profiles));
    screenshot(htmlPath, shotPath);
    report[key] = {
      screenshot: shotPath,
      profileCount: profiles.length,
      columns: Number(count) === 0 ? null : meterColumnPositions(Number(count)),
      setupBanner: profiles.length === 0,
    };
  }
  const reportPath = path.join(OUT, 'measurements.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main();
