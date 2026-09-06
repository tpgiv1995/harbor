'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createVoiceRealtime,
  registerVoiceIpc,
  REALTIME_VOICES,
  DEFAULT_VOICE,
} = require('../../src/main/voice-realtime.js');

const ok = (body) => ({
  ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body),
});
const bad = (status, body) => ({
  ok: false, status, json: async () => body, text: async () => JSON.stringify(body),
});

const minted = (over = {}) => ok({
  value: 'ek_test_secret',
  expires_at: 1785178124,
  session: { model: 'gpt-realtime-2', audio: { output: { voice: 'marin' } } },
  ...over,
});

const harness = (fetchImpl, keyFile = 'OPENAI_API_KEY=sk-test\n') => createVoiceRealtime({
  readFile: async () => keyFile,
  fetchImpl,
  env: {},
  keyPaths: ['/fake/.env'],
});

test('the voice list is the REALTIME set, not the text-to-speech set', () => {
  // Verified against the live API 2026-07-27: fable, onyx and nova are TTS-only
  // and the realtime endpoint rejects them, so offering them here would hand Pat
  // a voice that fails at connect time.
  assert.deepEqual(REALTIME_VOICES,
    ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar']);
  for (const ttsOnly of ['fable', 'onyx', 'nova']) {
    assert.equal(REALTIME_VOICES.includes(ttsOnly), false, `${ttsOnly} is not a realtime voice`);
  }
  // "sol" is a real voice but allowlisted per organization; it is absent until
  // OpenAI enables it, rather than offered and then refused at connect.
  assert.equal(REALTIME_VOICES.includes('sol'), false);
});

test('the pickers offer exactly the voices the minter would accept', () => {
  // The list is written down three times: here (the only copy that can reject a
  // voice), the desktop hook and the phone hook (the two copies that draw the
  // picker). A picker offering a voice the minter sanitises away would hand Pat
  // a control that silently does nothing, so the copies are checked against this
  // one rather than trusted to stay in step.
  const fs = require('node:fs');
  const path = require('node:path');
  const copies = [
    '../../src/renderer/voice/useVoiceAgent.js',
    '../../web/src/voice/use-live-voice.js',
  ];
  for (const relative of copies) {
    const source = fs.readFileSync(path.join(__dirname, relative), 'utf8');
    const literal = source.match(/REALTIME_VOICES = Object\.freeze\(\[([\s\S]*?)\]\)/);
    assert.ok(literal, `${relative} has no REALTIME_VOICES literal`);
    const listed = [...literal[1].matchAll(/'([a-z]+)'/g)].map((hit) => hit[1]);
    assert.deepEqual(listed, [...REALTIME_VOICES], `${relative} drifted from the minter's list`);
  }
});

test('a token request carries the voice, instructions and tools', async () => {
  let seen = null;
  const voice = harness(async (url, init) => { seen = { url, init }; return minted(); });
  const result = await voice.mintToken({
    voice: 'cedar', instructions: 'be terse', tools: [{ type: 'function', name: 'harbor_list_sessions' }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.token, 'ek_test_secret');
  const body = JSON.parse(seen.init.body);
  assert.equal(body.session.audio.output.voice, 'cedar');
  assert.equal(body.session.instructions, 'be terse');
  assert.deepEqual(body.session.tools.map((t) => t.name), ['harbor_list_sessions']);
  assert.equal(body.session.tool_choice, 'auto');
  assert.match(seen.init.headers.Authorization, /^Bearer sk-test$/);
});

test('an unknown or gated voice is sanitised before the request leaves', async () => {
  let sent = null;
  const voice = harness(async (_url, init) => { sent = JSON.parse(init.body); return minted(); });
  await voice.mintToken({ voice: 'sol' });
  assert.equal(sent.session.audio.output.voice, DEFAULT_VOICE, 'a gated voice never reaches the API');
  await voice.mintToken({ voice: undefined });
  assert.equal(sent.session.audio.output.voice, DEFAULT_VOICE);
  await voice.mintToken({ voice: 'ballad' });
  assert.equal(sent.session.audio.output.voice, 'ballad');
});

test('no key is a clear instruction, not a crash', async () => {
  const voice = createVoiceRealtime({
    readFile: async () => { throw new Error('ENOENT'); },
    fetchImpl: async () => minted(),
    env: {},
    keyPaths: ['/fake/.env'],
  });
  const result = await voice.mintToken({});
  assert.equal(result.ok, false);
  assert.match(result.reason, /OPENAI_API_KEY.*harbor\/\.env/);
});

test('the API\'s own error wording survives, because it is the useful part', async () => {
  // A gated voice says exactly why. Replacing that with a friendlier message
  // would hide the one detail worth acting on.
  const voice = harness(async () => bad(400, {
    error: { message: 'Voice sol is not available for your organization.' },
  }));
  const result = await voice.mintToken({ voice: 'marin' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'Voice sol is not available for your organization.');
});

test('a network failure reports as a network failure', async () => {
  const voice = harness(async () => { throw new Error('getaddrinfo ENOTFOUND'); });
  const result = await voice.mintToken({});
  assert.equal(result.ok, false);
  assert.match(result.reason, /could not reach OpenAI/);
});

test('a response with no client secret is refused rather than half-returned', async () => {
  const voice = harness(async () => ok({ session: {} }));
  const result = await voice.mintToken({});
  assert.deepEqual(result, { ok: false, reason: 'OpenAI returned no client secret' });
});

test('the ipc surface hands back only the ephemeral token', async () => {
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
  registerVoiceIpc(ipcMain, { voice: { mintToken: async () => ({ ok: true, token: 'ek_x' }), voices: () => ['marin'] } });
  assert.deepEqual([...handlers.keys()], ['voice:token', 'voice:voices']);
  const result = await handlers.get('voice:token')({}, {});
  // The real API key must never be part of this payload.
  assert.deepEqual(Object.keys(result).sort(), ['ok', 'token']);
  assert.equal(result.token, 'ek_x');
  assert.deepEqual(await handlers.get('voice:voices')({}), ['marin']);
});

test('a throwing minter becomes an honest refusal, not an unhandled rejection', async () => {
  const handlers = new Map();
  registerVoiceIpc({ handle: (c, fn) => handlers.set(c, fn) }, {
    voice: { mintToken: async () => { throw new Error('boom'); }, voices: () => [] },
  });
  assert.deepEqual(await handlers.get('voice:token')({}, {}), { ok: false, reason: 'boom' });
});
