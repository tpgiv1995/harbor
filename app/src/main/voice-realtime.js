'use strict';

// Mints the short-lived credential the renderer uses to open a realtime voice
// session with OpenAI.
//
// The API KEY NEVER REACHES THE RENDERER. The renderer needs a credential to
// open its own WebRTC connection (the audio has to flow from the microphone in
// the page, not through the main process), so main exchanges the real key for an
// EPHEMERAL client secret and hands only that over. That token is scoped to one
// session and expires in about a minute, so a renderer compromise cannot walk
// away with Pat's OpenAI account.
//
// Why OpenAI at all: Anthropic has no public voice API of any kind as of
// 2026-07-27 (no speech-to-speech, no TTS endpoint, no audio content block), so
// a live voice mode has to be assembled around the Claude sessions rather than
// spoken by them. Pat chose this shape deliberately: he talks to a fast voice
// agent, and it reads and drives his Claude sessions through Harbor's own tools.

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { resolveOpenAiKey } = require('./whisper-transcription.js');
const { registerIpcHandler } = require('./rpc/ipc-transport.js');

const CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets';
// Confirmed live 2026-09-03: GET /v1/models still lists gpt-realtime-2, and a
// mint against it returns a client secret. OpenAI has since published
// gpt-realtime-2.1 (and a -mini), which also mints; moving to it is a product
// choice with a cost and quality difference, not a repair, so the default stays
// where Pat put it until he says otherwise.
const DEFAULT_MODEL = 'gpt-realtime-2';
const DEFAULT_VOICE = 'marin';

// The voices the realtime API actually accepts, verified against the live API on
// 2026-07-27 by probing every candidate. This is NOT the TTS list: fable, onyx
// and nova exist for text-to-speech and are rejected here.
//
// "sol", the one Pat wanted, is a real voice in this system but is allowlisted
// per organization: it answers "Voice sol is not available for your
// organization" on every realtime model, where an unknown name instead answers
// "Invalid value ... Supported values are ...". So it is not gone, and if OpenAI
// enables it for his org it can simply be added here.
//
// Re-verified against the live API 2026-09-03, on gpt-realtime-2 AND on the
// newer gpt-realtime-2.1: an unknown name still answers "Invalid value:
// 'notavoice'. Supported values are: 'alloy', 'ash', 'ballad', 'coral', 'echo',
// 'sage', 'shimmer', 'verse', 'marin', and 'cedar'." (this list, exactly), and
// sol still answers "Voice sol is not available for your organization." So the
// list is current and sol is still Pat's to ask OpenAI for, not a bug to fix.
const REALTIME_VOICES = Object.freeze([
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar',
]);

// Harbor's own config directory is the ONE place a key is read from. See the
// same note in whisper-transcription.js: a second path into an unrelated
// personal tool of the author's meant Harbor could authenticate to OpenAI with
// a credential nobody had handed it.
const KEY_PATHS = [path.join(os.homedir(), '.config', 'harbor', '.env')];

function createVoiceRealtime({
  readFile = fs.readFile,
  fetchImpl = globalThis.fetch,
  env = process.env,
  keyPaths = KEY_PATHS,
  model = DEFAULT_MODEL,
} = {}) {
  // Ask for a credential for one voice session. `tools` and `instructions` come
  // from the renderer because that is where the tool DISPATCHER lives, and the
  // two must describe the same surface.
  const mintToken = async ({ voice, instructions, tools } = {}) => {
    // Harnesses must never open a real voice call: it costs money, needs the
    // network, and would make the suite depend on a third party. Off by default
    // under E2E, exactly like the usage fetch. The live verification drive turns
    // it back on explicitly (HARBOR_NO_VOICE=0).
    if (env.HARBOR_NO_VOICE === '1') {
      return { ok: false, reason: 'live voice is disabled in this Harbor instance' };
    }
    const chosen = REALTIME_VOICES.includes(voice) ? voice : DEFAULT_VOICE;
    const key = await resolveOpenAiKey({ readFile, keyPaths, env });
    if (!key) {
      return {
        ok: false,
        reason: 'OpenAI key unavailable. Add OPENAI_API_KEY to ~/.config/harbor/.env.',
      };
    }
    const body = {
      session: {
        type: 'realtime',
        model,
        audio: { output: { voice: chosen } },
        ...(instructions ? { instructions } : {}),
        ...(Array.isArray(tools) && tools.length ? { tools, tool_choice: 'auto' } : {}),
      },
    };
    let response;
    try {
      response = await fetchImpl(CLIENT_SECRETS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      return { ok: false, reason: `could not reach OpenAI: ${error?.message || 'network error'}` };
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      // The API's own wording is the useful part here: a gated voice says so
      // specifically, and inventing a friendlier message would hide that.
      let message = `OpenAI HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(detail);
        if (parsed?.error?.message) message = parsed.error.message;
      } catch { if (detail) message = `${message}: ${detail.slice(0, 200)}`; }
      return { ok: false, reason: message };
    }
    const data = await response.json();
    const token = data?.value;
    if (!token) return { ok: false, reason: 'OpenAI returned no client secret' };
    return {
      ok: true,
      token,
      expiresAt: data?.expires_at ?? null,
      model: data?.session?.model || model,
      voice: data?.session?.audio?.output?.voice || chosen,
    };
  };

  return { mintToken, voices: () => [...REALTIME_VOICES] };
}

function registerVoiceIpc(ipcMain, dependencies = {}) {
  const voice = dependencies.voice || createVoiceRealtime(dependencies);
  registerIpcHandler(dependencies.router, ipcMain, 'voice:token', async (_event, payload) => {
    try {
      return await voice.mintToken(payload || {});
    } catch (error) {
      return { ok: false, reason: error?.message || 'could not start a voice session' };
    }
  });
  registerIpcHandler(dependencies.router, ipcMain, 'voice:voices', () => voice.voices());
  return voice;
}

module.exports = {
  CLIENT_SECRETS_URL,
  DEFAULT_MODEL,
  DEFAULT_VOICE,
  REALTIME_VOICES,
  createVoiceRealtime,
  registerVoiceIpc,
};
