'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { registerIpcHandler } = require('./rpc/ipc-transport.js');

const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

function readEnvValue(contents, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(contents || '').match(new RegExp(`^\\s*(?:export\\s+)?${escaped}\\s*=\\s*(.*?)\\s*$`, 'm'));
  if (!match) return null;
  const value = match[1].trim();
  if (!value || value.startsWith('#')) return null;
  if ((value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1).trim() || null;
  return value.replace(/\s+#.*$/, '').trim() || null;
}

async function resolveOpenAiKey({ readFile, keyPaths, env }) {
  if (env.OPENAI_API_KEY?.trim()) return env.OPENAI_API_KEY.trim();
  for (const keyPath of keyPaths) {
    try {
      const key = readEnvValue(await readFile(keyPath, 'utf8'), 'OPENAI_API_KEY');
      if (key) return key;
    } catch { /* absent or unreadable config: try the next known location */ }
  }
  return null;
}

function createWhisperTranscriber({
  readFile = fs.readFile,
  fetchImpl = globalThis.fetch,
  env = process.env,
  // Harbor's own config directory is the ONE place a key is read from. This
  // carried a second path into an unrelated personal tool of the author's
  // until 2026-08-07, which meant Harbor could authenticate to OpenAI with a
  // credential nobody had given it, and told every other user to edit a file
  // belonging to a product they have never installed.
  keyPaths = [path.join(os.homedir(), '.config', 'harbor', '.env')],
} = {}) {
  return async ({ buffer, mimeType = 'audio/webm' } = {}) => {
    // Dictation is a paid OpenAI call, so it answers to the same harness switch
    // live voice does (HARBOR_NO_VOICE, defaulted on under HARBOR_E2E in
    // main/index.js). Until 2026-09-03 only live voice was gated, which left a
    // harness able to click the mic and spend real money against a third party
    // the gate is not allowed to depend on.
    if (env.HARBOR_NO_VOICE === '1') {
      return { ok: false, reason: 'voice is disabled in this Harbor instance' };
    }
    const audio = Buffer.from(buffer || []);
    if (audio.length === 0) return { ok: false, reason: 'Recording was empty; nothing was transcribed.' };
    if (audio.length > MAX_AUDIO_BYTES) {
      return { ok: false, reason: 'Recording is over Whisper’s 25 MB upload limit.' };
    }
    const key = await resolveOpenAiKey({ readFile, keyPaths, env });
    if (!key) {
      return {
        ok: false,
        reason: 'OpenAI key unavailable. Add OPENAI_API_KEY to ~/.config/harbor/.env.',
      };
    }

    const type = String(mimeType || 'audio/webm').split(';')[0];
    const extension = type === 'audio/mp4' ? 'm4a' : type === 'audio/ogg' ? 'ogg' : 'webm';
    const form = new FormData();
    // The API decides how to decode from the FILE NAME, so the extension has to
    // follow the container the recorder actually produced. Confirmed live
    // 2026-09-03: whisper-1 is still listed by GET /v1/models, and a real
    // webm/opus capture and an ogg/opus one both transcribed correctly through
    // this mapping (scripts/drive-voice-dictation-win.js drives the webm case
    // through the whole app).
    form.append('file', new Blob([audio], { type }), `recording.${extension}`);
    form.append('model', 'whisper-1');
    const response = await fetchImpl(WHISPER_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Whisper HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }
    const data = await response.json();
    const text = String(data?.text || '').trim();
    if (!text) return { ok: false, reason: 'Whisper returned an empty transcription.' };
    return { ok: true, text };
  };
}

function createWhisperHandlers({ transcribe }) {
  return {
    'whisper:transcribe': async (_event, payload) => {
      try {
        return await transcribe(payload);
      } catch (error) {
        return { ok: false, reason: error?.message || 'Whisper transcription failed.' };
      }
    },
  };
}

function registerWhisperIpc(ipcMain, dependencies = {}) {
  const handlers = createWhisperHandlers({
    transcribe: dependencies.transcribe || createWhisperTranscriber(dependencies),
  });
  for (const [channel, handler] of Object.entries(handlers)) {
    registerIpcHandler(dependencies.router, ipcMain, channel, handler);
  }
  return handlers;
}

module.exports = {
  MAX_AUDIO_BYTES,
  createWhisperHandlers,
  createWhisperTranscriber,
  readEnvValue,
  registerWhisperIpc,
  resolveOpenAiKey,
};
