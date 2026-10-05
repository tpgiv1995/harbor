'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { realTmpDir } = require('../support/real-tmpdir.js');
const { newSessionOptions } = require('../../src/main/providers/capabilities.js');
const { createCodexModelDiscovery } = require('../../src/main/providers/codex-model-catalog.js');

test('Codex explicit empty catalogs never invent a bundled model, missing caches retain the floor', async (t) => {
  const home = await fs.mkdtemp(path.join(realTmpDir(), 'codex-empty-catalog-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const file = path.join(home, 'models_cache.json');
  const options = () => newSessionOptions({ profiles: [] }, { env: { CODEX_HOME: home } }).providers.codex;
  assert.deepEqual(options().models.map(m => m.value), ['default', 'gpt-6-sol']);
  for (const models of [[], [{ slug: 'internal-model', visibility: 'hide' }]]) {
    await fs.writeFile(file, JSON.stringify({ client_version: '0.160.0', fetched_at: '-262143-01-01T00:00:00Z', models }));
    assert.deepEqual(options().models.map(m => m.value), ['default']);
  }
  await fs.writeFile(file, '{invalid');
  assert.deepEqual(options().models.map(m => m.value), ['default', 'gpt-6-sol']);
});

test('Codex invalidated same-version cache retries discovery and reports an empty refresh honestly', async (t) => {
  const home = await fs.mkdtemp(path.join(realTmpDir(), 'codex-retry-catalog-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const file = path.join(home, 'models_cache.json');
  const save = models => fs.writeFile(file, JSON.stringify({ client_version: '0.160.0', models }));
  await save([]);
  let calls = 0;
  let recover = false;
  const discovery = createCodexModelDiscovery({ env: { CODEX_HOME: home }, execFile: async () => {
    calls++;
    if (recover) await save([{ slug: 'provider-model', visibility: 'list' }]);
    return { stdout: '' };
  } });
  assert.equal((await discovery.refresh({ version: '0.160.0' })).ok, false);
  assert.equal(calls, 1);
  recover = true;
  assert.equal((await discovery.refresh({ version: '0.160.0' })).ok, true);
  assert.equal(calls, 2);
  assert.equal((await discovery.refresh({ version: '0.160.0' })).ok, true);
  assert.equal(calls, 2, 'a populated same-version cache still skips');
});
