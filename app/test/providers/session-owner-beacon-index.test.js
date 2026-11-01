'use strict';
// The delegation scan lists each home's beacon folder once per pass and stats
// only beacons that exist (2026-11-01: it statted six homes per session, five
// failing, for every session active in the last 48 hours, on every refresh).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { buildBeaconIndex, readSessionBeacon } = require('../../src/main/providers/session-owner.js');

const IDS = ['aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002', 'cccccccc-0000-4000-8000-000000000003'];

function homesFixture() {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'hb-beacon-'));
  const homes = ['.claude', '.claude-team', '.claude-iv'].map((name) => path.join(tmp, name));
  const beacon = (home, id, ageMs) => {
    const dir = path.join(home, 'statusline-state');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.json`);
    fs.writeFileSync(file, '{}');
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(file, when, when);
  };
  beacon(homes[0], IDS[0], 60_000);
  beacon(homes[1], IDS[1], 30_000);
  beacon(homes[2], IDS[1], 10_000); // a session seen in two homes: the newest wins
  fs.mkdirSync(path.join(homes[2], 'statusline-state'), { recursive: true });
  fs.writeFileSync(path.join(homes[2], 'statusline-state', 'notes.txt'), 'not a beacon');
  return homes;
}

test('the per-pass listing answers exactly as the six-path lookup does', async () => {
  const homes = homesFixture();
  const index = await buildBeaconIndex(homes);
  for (const id of IDS) {
    assert.strictEqual(await readSessionBeacon(id, homes, index), await readSessionBeacon(id, homes), id);
  }
  assert.strictEqual(await readSessionBeacon(IDS[2], homes, index), null, 'no beacon anywhere');
});

test('with the listing, only beacons that exist are statted', async (t) => {
  const homes = homesFixture();
  const index = await buildBeaconIndex(homes);
  const stat = t.mock.method(fsp, 'stat');
  for (const id of IDS) await readSessionBeacon(id, homes, index);
  assert.strictEqual(stat.mock.callCount(), 3, 'one stat per existing beacon, none for missing ones');
  stat.mock.resetCalls();
  for (const id of IDS) await readSessionBeacon(id, homes);
  assert.strictEqual(stat.mock.callCount(), IDS.length * homes.length, 'the single lookup still checks every home');
});

test('a home with no beacon folder is skipped, not an error', async () => {
  const homes = [...homesFixture(), path.join(os.tmpdir(), 'hb-beacon-missing-home-xyz')];
  const index = await buildBeaconIndex(homes);
  assert.ok(index.has(IDS[0]));
});
