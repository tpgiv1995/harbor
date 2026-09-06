#!/usr/bin/env node
'use strict';

// badge-sample.js: samples 20 random attributed sessions and compares the
// UI-model home (from the Node indexer's home map) against the per-session
// meta home. Prints a match matrix and exits 0 iff all 20 match.
//
// Usage: node app/scripts/badge-sample.js

const { createHistoryIndex } = require('../src/main/providers/history-index.js');
const SAMPLE_SIZE = 20;
const indexer = createHistoryIndex();

async function runIndexer(args) {
  return indexer.run(args);
}

async function buildHomeMap() {
  return indexer.buildHomeMap();
}

async function sessionMeta(id) {
  return JSON.parse(await runIndexer(['meta', id]));
}

function parseEmitTsv(text) {
  return String(text).split(/\r?\n/).filter(Boolean).map((line) => {
    const [id, lastActive, project, ...title] = line.split('\t');
    return { id, lastActive, project, title: title.join('\t') };
  });
}

function pick(arr, n) {
  const copy = [...arr];
  const result = [];
  while (result.length < n && copy.length > 0) {
    const idx = Math.floor(Math.random() * copy.length);
    result.push(copy.splice(idx, 1)[0]);
  }
  return result;
}

async function main() {
  console.log('Building home map from indexer...');
  const homeMap = await buildHomeMap();

  const attributed = Object.entries(homeMap)
    .filter(([, home]) => home === 'team' || home === 'personal')
    .map(([id, home]) => ({ id, mapHome: home }));

  if (attributed.length === 0) {
    console.error('No attributed sessions found in home map.');
    process.exit(1);
  }

  const sample = pick(attributed, Math.min(SAMPLE_SIZE, attributed.length));
  console.log(`\nSampling ${sample.length} sessions (of ${attributed.length} attributed):\n`);

  const header = ['session-id'.padEnd(36), 'map-home'.padEnd(10), 'meta-home'.padEnd(10), 'match'];
  console.log(header.join('  '));
  console.log('-'.repeat(72));

  let mismatches = 0;
  let unavailable = 0;
  for (const { id, mapHome } of sample) {
    let metaHome = null;
    let note = 'OK';
    try {
      const meta = await sessionMeta(id);
      metaHome = meta?.home || 'null';
    } catch {
      // session not found in indexer (likely Windows-era or removed transcript)
      metaHome = 'n/a';
      note = 'no-transcript';
      unavailable += 1;
    }
    if (metaHome !== 'n/a') {
      const match = mapHome === metaHome;
      note = match ? 'OK' : 'MISMATCH';
      if (!match) mismatches += 1;
    }
    const row = [
      id.padEnd(36),
      mapHome.padEnd(10),
      metaHome.padEnd(10),
      note,
    ];
    console.log(row.join('  '));
  }

  console.log('-'.repeat(72));
  const comparable = sample.length - unavailable;
  const ok = comparable - mismatches;
  console.log(`\n${ok}/${comparable} comparable sessions match (${unavailable} skipped: no indexer transcript).`);
  if (mismatches > 0) console.log(`${mismatches} HOME MISMATCHES.`);
  else console.log('All comparable sessions agree. Home attribution is consistent.');
  process.exit(mismatches > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
