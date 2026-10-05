'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveNewSessionDefaults: resolve } = require('../../src/renderer/new-session-defaults.cjs');
const providers = {
  claude: { defaultModel: 'default', efforts: ['default', 'low', 'xhigh'], profiles: [{ id: 'personal' }] },
  codex: { defaultModel: 'default', defaultEffort: 'medium', profiles: [{ id: 'codex' }] },
};
const defaults = { provider: 'codex', model: 'default', effort: 'low' };
const options = { providers, defaults };

test('a fresh renderer uses the completed setup defaults', () => {
  assert.deepEqual(resolve({ options }), { ...defaults, account: 'codex' });
});
test('without config defaults the pin is only used when Claude is enabled', () => {
  assert.deepEqual(resolve({ options: { providers } }), {
    provider: 'claude', model: 'claude-opus-5-5', effort: 'high', account: 'personal',
  });
  assert.deepEqual(resolve({ options: { providers: { codex: providers.codex } } }), {
    provider: 'codex', model: 'default', effort: 'medium', account: 'codex',
  });
});
test('an older stored default is preserved without mutating or reseeding it', () => {
  const stored = Object.freeze({ v: 1, provider: 'claude', model: 'sonnet', effort: 'high', account: 'personal' });
  assert.deepEqual(resolve({ stored, options }), {
    provider: 'claude', model: 'sonnet', effort: 'high', account: 'personal',
  });
  assert.equal(stored.v, 1);
});
test('a disabled stored provider falls back without leaking its model or account', () => {
  const stored = { provider: 'claude', model: 'sonnet', effort: 'xhigh', account: 'personal' };
  assert.deepEqual(resolve({ stored, options: { ...options, providers: { codex: providers.codex } } }), {
    ...defaults, account: 'codex',
  });
});
test('explicit launch fields win and partial requests inherit matching defaults', () => {
  const stored = { provider: 'claude', model: 'sonnet', effort: 'high' };
  assert.deepEqual(resolve({ stored, options, request: { provider: 'codex', model: 'chosen-model', effort: 'high' } }), {
    provider: 'codex', model: 'chosen-model', effort: 'high', account: 'codex',
  });
  assert.deepEqual(resolve({ stored, options, request: { provider: 'codex' } }), { ...defaults, account: 'codex' });
});
test('a disabled requested provider falls back and no providers gives a reason', () => {
  assert.deepEqual(resolve({ options, request: { provider: 'cursor', model: 'foreign', effort: 'foreign' } }), {
    ...defaults, account: 'codex',
  });
  assert.deepEqual(resolve(), { provider: null, unavailable: 'Enable a provider in Setup before starting a session.' });
});
test('switching away from configured defaults uses the enabled registry, not a new pin', () => {
  assert.deepEqual(resolve({ options, request: { provider: 'claude' } }), {
    provider: 'claude', model: 'default', effort: 'default', account: 'personal',
  });
});

test('a Codex account-only launch cannot inherit the saved Claude provider', () => {
  const result = resolve({options, stored:{provider:'claude',model:'opus',effort:'xhigh'}, request:{account:'codex'}});
  assert.equal(result.provider,'codex');
  assert.equal(result.account,'codex');
  assert.equal(result.model,'default');
});

test('a sibling of an unprofiled Codex session carries its provider through launch argv', () => {
  const { siblingSessionRequest } = require('../../src/renderer/new-session-defaults.cjs');
  const { buildNewArgv } = require('../../src/main/actions/launch.js');
  const request=siblingSessionRequest({provider:'codex',id:'session',cwd:'/project'});
  const result=resolve({options,stored:{provider:'claude',model:'opus'},request});
  const argv=buildNewArgv({...result,profiles:[{id:'codex',provider:'codex',configHome:'/codex'}]});
  assert.equal(argv[argv.indexOf('--provider')+1],'codex');
  assert.equal(request.folder,'/project');
});
