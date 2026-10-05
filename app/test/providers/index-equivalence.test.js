'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const PYTHON = process.platform === 'win32' ? 'python' : 'python3';
const PYTHON_INDEXER = path.resolve(__dirname, '../../../reference/python-oracles/harbor-index.py');
const REAL_PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const UUID_JSONL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

function captureCorpus(destination) {
  let count = 0;
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(REAL_PROJECTS, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sourceDirectory = path.join(REAL_PROJECTS, entry.name);
    const targetDirectory = path.join(destination, entry.name);
    fs.mkdirSync(targetDirectory);
    for (const name of fs.readdirSync(sourceDirectory)) {
      if (!UUID_JSONL.test(name)) continue;
      const source = path.join(sourceDirectory, name);
      const target = path.join(targetDirectory, name);
      const stat = fs.statSync(source);
      fs.copyFileSync(source, target, fs.constants.COPYFILE_FICLONE);
      fs.utimesSync(target, stat.atime, stat.mtime);
      count += 1;
    }
  }
  return count;
}

function pythonAdapter(configFile, command, args, env = {}) {
  const started = performance.now();
  const stdout = execFileSync(PYTHON, [PYTHON_INDEXER, command, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', HARBOR_CONFIG_FILE: configFile, HARBOR_TITLES_FILE: path.join(path.dirname(configFile), 'titles.json'), ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { stdout, ms: performance.now() - started };
}

// Node adapters are the product now (CLAUDE.md: "Product code never spawns
// Python"); this spec is a byte-equivalence oracle against
// reference/python-oracles, which needs a python3 interpreter AND the
// author's own ~/.claude/projects transcript corpus to compare against.
// Neither exists on a fresh clone or in CI, so a missing prerequisite is a
// named skip, not a failure: the suite has nothing to compare on a machine
// that has never run Claude Code.
function python3Missing() {
  const probe = require('node:child_process').spawnSync(PYTHON, ['--version'], { encoding: 'utf8' });
  return Boolean(probe.error) || probe.status !== 0;
}

test('Node adapters are byte-identical to Python on the real transcript corpus', {
  timeout: 600_000,
  skip: process.platform === 'win32' && 'the retired Python oracle classifies Windows paths with POSIX-only label semantics',
}, async (t) => {
  if (python3Missing()) {
    return t.skip('python3 is not on PATH; this spec only checks Node against the retired Python oracle (reference/python-oracles), never a product path');
  }
  if (!fs.existsSync(REAL_PROJECTS)) {
    return t.skip(`no transcript corpus at ${REAL_PROJECTS}; this spec compares against a real ~/.claude/projects history, which a fresh machine does not have`);
  }
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-index-equivalence-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const capturedProjects = path.join(tempRoot, 'captured-real-projects');
  const corpusFiles = captureCorpus(capturedProjects);
  assert.ok(corpusFiles > 0, 'real corpus must contain UUID transcript files');
  const pythonCache = path.join(tempRoot, 'python-cache');
  const nodeCache = path.join(tempRoot, 'node-cache');
  const pythonConfig = path.join(tempRoot, 'python-config.json');
  const nodeConfig = path.join(tempRoot, 'node-config.json');
  // BOTH SIDES ARE GIVEN THE SAME CONFIG HOMES, IN THE SAME ORDER, and that is
  // the point of this file rather than an incidental detail.
  //
  // Home order decides ties when a session scores equally in two homes, so an
  // implementation that discovers its homes and one that carries a written list
  // can attribute the same session to different accounts while their parsers
  // agree byte for byte. Both did carry a written list once; the Node side no
  // longer does, because a shipped account list is somebody's own setup compiled
  // into the app, and removing it made this comparison start failing on the tie
  // rule while proving nothing about the parsing it exists to check.
  //
  // Supplying the list explicitly keeps the oracle honest about the one thing it
  // can still testify to.
  const profiles = [
    { id: 'personal', configHome: path.join(os.homedir(), '.claude') },
    { id: 'team', configHome: path.join(os.homedir(), '.claude-team') },
    { id: 'plan3', configHome: path.join(os.homedir(), '.claude-plan3') },
  ];
  fs.writeFileSync(pythonConfig, JSON.stringify({ profiles, paths: { projectsDir: capturedProjects, cacheDir: pythonCache } }));
  fs.writeFileSync(nodeConfig, JSON.stringify({ profiles, paths: { projectsDir: capturedProjects, cacheDir: nodeCache } }));

  const samples = [
    { name: 'emit', args: ['--all', '--with-first-prompt', '--with-cwd'] },
    { name: 'tree', args: ['--all'], env: { HIST_EXPANDED: '' } },
    { name: 'hydrate', args: [], env: {} },
  ];

  const python = new Map();
  for (const sample of samples) {
    python.set(sample.name, pythonAdapter(pythonConfig, sample.name, sample.args, sample.env));
  }

  const { createHistoryIndexWorker } = require('../../src/main/providers/history-index.js');
  const index = createHistoryIndexWorker({
    projectsDir: capturedProjects,
    cacheDir: nodeCache,
    titlesFile: path.join(tempRoot, 'titles.json'),
    // The same list handed to the oracle above. Without it the Node side
    // DISCOVERS the config homes on the machine running the suite, so the two
    // implementations would be scoring against different sets of directories
    // and the byte comparison would be measuring the developer's home folder.
    profiles,
  });
  t.after(() => index.close());

  for (const sample of samples) {
    let parentTicks = 0;
    const ticker = sample.name === 'emit' ? setInterval(() => { parentTicks += 1; }, 10) : null;
    const started = performance.now();
    const stdout = await index.run([sample.name, ...sample.args], sample.env);
    const nodeMs = performance.now() - started;
    if (ticker) clearInterval(ticker);
    const oracle = python.get(sample.name);
    assert.equal(stdout, oracle.stdout, `${sample.name} output differs from the Python oracle`);
    if (sample.name === 'emit') {
      assert.ok(nodeMs <= oracle.ms * 2, `cold Node emit took ${nodeMs.toFixed(1)}ms versus Python ${oracle.ms.toFixed(1)}ms`);
      assert.ok(parentTicks >= 5, `parent event loop ticked only ${parentTicks} times during cold indexing`);
    }
    t.diagnostic(JSON.stringify({ adapter: sample.name, corpusFiles, bytes: Buffer.byteLength(stdout), pythonMs: Number(oracle.ms.toFixed(1)), nodeMs: Number(nodeMs.toFixed(1)), byteDiff: 0, parentTicks: sample.name === 'emit' ? parentTicks : undefined }));
  }

  const nodeCacheFile = path.join(nodeCache, 'index.json');
  const nodeCacheBytes = fs.readFileSync(nodeCacheFile, 'utf8');
  const nodeCacheDocument = JSON.parse(nodeCacheBytes);
  assert.equal(nodeCacheDocument.v, 2, 'Node must retain the rollback-compatible cache version');
  const rollback = pythonAdapter(nodeConfig, 'emit', samples[0].args);
  assert.equal(rollback.stdout, python.get('emit').stdout, 'Python must be able to consume the Node-written cache without rebuilding');
  assert.equal(fs.readFileSync(nodeCacheFile, 'utf8'), nodeCacheBytes, 'Python must accept the Node cache metadata without rewriting it');
});
