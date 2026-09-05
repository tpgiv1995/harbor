'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_AUDIO_BYTES,
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

test('the desktop mic sends an ArrayBuffer, and that is the shape this accepts', async () => {
  // CommandBar posts `await blob.arrayBuffer()` straight over IPC, so an
  // ArrayBuffer (not a typed array) is the payload this actually receives. The
  // rest of the suite passes Uint8Array, which would keep passing if the
  // ArrayBuffer path ever regressed.
  let sentBytes = null;
  const transcribe = createWhisperTranscriber({
    readFile: async () => 'OPENAI_API_KEY=sk-test-key\n',
    keyPaths: ['/config/harbor/.env'],
    env: {},
    fetchImpl: async (_url, options) => {
      sentBytes = (await options.body.get('file').arrayBuffer()).byteLength;
      return { ok: true, json: async () => ({ text: 'Spoken draft.' }) };
    },
  });
  const source = Uint8Array.from([9, 8, 7, 6]);
  assert.deepEqual(await transcribe({ buffer: source.buffer, mimeType: 'audio/webm;codecs=opus' }),
    { ok: true, text: 'Spoken draft.' });
  assert.equal(sentBytes, 4);
});

test('the filename extension follows the recorded container, because Whisper reads it', async () => {
  // The API decides how to decode from the FILE NAME, so a webm payload named
  // .ogg is rejected. Verified end to end against the live API 2026-09-03:
  // webm/opus and ogg/opus both transcribed correctly through this mapping.
  const names = [];
  const transcribe = createWhisperTranscriber({
    readFile: async () => 'OPENAI_API_KEY=sk-test-key\n',
    keyPaths: ['/config/harbor/.env'],
    env: {},
    fetchImpl: async (_url, options) => {
      names.push(options.body.get('file').name);
      return { ok: true, json: async () => ({ text: 'ok' }) };
    },
  });
  for (const mimeType of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', undefined]) {
    await transcribe({ buffer: Uint8Array.from([1]), mimeType });
  }
  assert.deepEqual(names,
    ['recording.webm', 'recording.ogg', 'recording.m4a', 'recording.webm']);
});

test('an oversize recording is refused locally rather than uploaded and rejected', async () => {
  let fetches = 0;
  const transcribe = createWhisperTranscriber({
    readFile: async () => 'OPENAI_API_KEY=sk-test-key\n',
    keyPaths: ['/config/harbor/.env'],
    env: {},
    fetchImpl: async () => { fetches += 1; },
  });
  const result = await transcribe({ buffer: Buffer.alloc(MAX_AUDIO_BYTES + 1) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /25 MB/);
  assert.equal(fetches, 0);
});

test('a harness with voice disabled spends nothing on dictation either', async () => {
  // Dictation is the other paid OpenAI call in this app, and it was reachable
  // from a harness with nothing able to turn it off until 2026-09-03. Same
  // switch as live voice now, and it refuses before it can read a key or reach
  // the network.
  let fetches = 0;
  let reads = 0;
  const transcribe = createWhisperTranscriber({
    readFile: async () => { reads += 1; return 'OPENAI_API_KEY=sk-test-key\n'; },
    keyPaths: ['/config/harbor/.env'],
    env: { HARBOR_NO_VOICE: '1' },
    fetchImpl: async () => { fetches += 1; },
  });
  assert.deepEqual(await transcribe({ buffer: Uint8Array.from([1, 2, 3]) }), {
    ok: false, reason: 'voice is disabled in this Harbor instance',
  });
  assert.equal(fetches, 0);
  assert.equal(reads, 0);
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
