'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createWhisperTranscriber,
  createWhisperHandlers,
  readEnvValue,
} = require('../../src/main/whisper-transcription.js');

test('readEnvValue reads a quoted OPENAI_API_KEY without exposing other values', () => {
  const env = 'OTHER=value\nOPENAI_API_KEY="sk-test-key"\n';
  assert.equal(readEnvValue(env, 'OPENAI_API_KEY'), 'sk-test-key');
  assert.equal(readEnvValue(env, 'MISSING'), null);
});

test('Whisper transcriber posts renderer audio to OpenAI and returns transcript text', async () => {
  const calls = [];
  const transcribe = createWhisperTranscriber({
    readFile: async (file) => {
      calls.push(['readFile', file]);
      return 'OPENAI_API_KEY=sk-test-key\n';
    },
    keyPaths: ['/config/harbor/.env'],
    env: {},
    fetchImpl: async (url, options) => {
      calls.push(['fetch', url, options]);
      return { ok: true, json: async () => ({ text: 'Draft from speech.' }) };
    },
  });

  const result = await transcribe({
    buffer: Uint8Array.from([1, 2, 3]),
    mimeType: 'audio/webm;codecs=opus',
  });

  assert.deepEqual(result, { ok: true, text: 'Draft from speech.' });
  assert.deepEqual(calls[0], ['readFile', '/config/harbor/.env']);
  const [, url, options] = calls[1];
  assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers.Authorization, 'Bearer sk-test-key');
  assert.equal(options.body.get('model'), 'whisper-1');
  assert.equal(options.body.get('file').name, 'recording.webm');
});

test('Whisper transcriber reports a missing key honestly and does not call the API', async () => {
  let fetches = 0;
  const transcribe = createWhisperTranscriber({
    readFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    keyPaths: ['/missing/.env'],
    env: {},
    fetchImpl: async () => { fetches += 1; },
  });

  assert.deepEqual(await transcribe({ buffer: Uint8Array.from([1]) }), {
    ok: false,
    reason: 'OpenAI key unavailable. Add OPENAI_API_KEY to ~/.config/harbor/.env.',
  });
  assert.equal(fetches, 0);
});

test('Whisper IPC handler converts API failures into an honest renderer result', async () => {
  const handlers = createWhisperHandlers({
    transcribe: async () => { throw new Error('Whisper HTTP 429: rate limited'); },
  });

  assert.deepEqual(
    await handlers['whisper:transcribe']({}, { buffer: Uint8Array.from([4]) }),
    { ok: false, reason: 'Whisper HTTP 429: rate limited' },
  );
});
