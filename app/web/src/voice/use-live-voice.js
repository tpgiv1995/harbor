import { useCallback, useEffect, useRef, useState } from 'react';
import voiceTools from '../../../src/renderer/voice/voice-tools.cjs';

export const REALTIME_VOICES = Object.freeze([
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar',
]);

const { TOOL_DEFS, VOICE_INSTRUCTIONS, dispatchVoiceTool } = voiceTools;
const CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
const CREATE_ACK_TIMEOUT_MS = 8000;
const VOICE_STORE_KEY = 'harbor-voice';

function readVoicePref() {
  try {
    const raw = JSON.parse(localStorage.getItem(VOICE_STORE_KEY) || 'null');
    return { voice: typeof raw?.voice === 'string' ? raw.voice : 'marin' };
  } catch {
    return { voice: 'marin' };
  }
}

function writeVoicePref(pref) {
  try { localStorage.setItem(VOICE_STORE_KEY, JSON.stringify(pref)); } catch { /* ignore */ }
}

export function useLiveVoice({
  client,
  getSessions,
  readSession,
  sendToSession,
  interruptSession,
  selectSession,
}) {
  const [phase, setPhase] = useState('idle');
  const [message, setMessage] = useState('');
  const [voice, setVoice] = useState(() => readVoicePref().voice);
  const [activity, setActivity] = useState([]);
  const [speaking, setSpeaking] = useState(false);

  const pcRef = useRef(null);
  const channelRef = useRef(null);
  const streamRef = useRef(null);
  const audioRef = useRef(null);
  const activeResponseRef = useRef(false);
  // A response.create we have SENT but not yet seen acknowledged. The active
  // flag is set optimistically the instant we ask for a response, because the
  // API rejects a second request while one runs; but if that request itself
  // fails, no response.created and no response.done ever arrive, and the flag
  // stayed true forever, leaving every later tool output and relayed update
  // queued and unsent. Kept identical to the desktop hook,
  // src/renderer/voice/useVoiceAgent.js.
  const awaitingCreateRef = useRef(false);
  // The event_id of the response.create we are waiting on; an error frees the
  // lane only when it is the error for THIS create. Kept identical to the desktop
  // hook, src/renderer/voice/useVoiceAgent.js (2026-09-03).
  const pendingCreateIdRef = useRef(null);
  const createSeqRef = useRef(0);
  // A monotonic token per start() attempt; stop() and unmount bump it so a start
  // still awaiting the mint or the mic bails instead of coming up after a stop.
  const startGenRef = useRef(0);
  // Aborts the in-flight SDP exchange when stop() races it (2026-09-03).
  const startAbortRef = useRef(null);
  const queueRef = useRef([]);
  const watchedRef = useRef(new Set());
  const depsRef = useRef({});
  depsRef.current = { getSessions, readSession, sendToSession, interruptSession, selectSession };

  const note = useCallback((kind, text) => {
    setActivity((prev) => [...prev.slice(-19), { kind, text, at: Date.now() }]);
  }, []);

  const rawSend = useCallback((event) => {
    const channel = channelRef.current;
    if (channel?.readyState === 'open') channel.send(JSON.stringify(event));
  }, []);

  const flush = useCallback(() => {
    if (activeResponseRef.current) return;
    const queued = queueRef.current;
    if (queued.length === 0) return;
    queueRef.current = [];
    for (const event of queued) rawSend(event);
    activeResponseRef.current = true;
    awaitingCreateRef.current = true;
    const id = `harbor-resp-${(createSeqRef.current += 1)}`;
    pendingCreateIdRef.current = id;
    rawSend({ type: 'response.create', event_id: id });
    // Backstop for a create that is never acknowledged (no response.created and
    // no matching error); frees the lane so the agent does not go silent. A
    // no-op if response.created/done already cleared this id.
    setTimeout(() => {
      if (pendingCreateIdRef.current !== id || !awaitingCreateRef.current) return;
      awaitingCreateRef.current = false;
      pendingCreateIdRef.current = null;
      activeResponseRef.current = false;
      flushRef.current();
    }, CREATE_ACK_TIMEOUT_MS);
  }, [rawSend]);
  const flushRef = useRef(flush);
  flushRef.current = flush;

  const enqueue = useCallback((...events) => {
    queueRef.current.push(...events);
    flush();
  }, [flush]);

  const relay = useCallback((text) => {
    if (!text || channelRef.current?.readyState !== 'open') return;
    enqueue({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    });
  }, [enqueue]);

  const handleEvent = useCallback(async (event, gen) => {
    // A message from a connection we already stopped must not touch the new
    // connection's lane or channel (2026-09-03; kept identical to the desktop hook).
    if (gen !== startGenRef.current) return;
    switch (event.type) {
      case 'response.created':
        activeResponseRef.current = true;
        awaitingCreateRef.current = false;
        pendingCreateIdRef.current = null;
        setSpeaking(true);
        break;
      case 'response.done':
        activeResponseRef.current = false;
        awaitingCreateRef.current = false;
        pendingCreateIdRef.current = null;
        setSpeaking(false);
        flush();
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript?.trim()) note('you', event.transcript.trim());
        break;
      case 'response.output_audio_transcript.done':
        if (event.transcript?.trim()) note('voice', event.transcript.trim());
        break;
      case 'response.function_call_arguments.done': {
        let args = {};
        try { args = JSON.parse(event.arguments || '{}'); } catch { /* tool reports */ }
        const deps = depsRef.current;
        const result = await dispatchVoiceTool(event.name, args, {
          listSessions: deps.getSessions,
          readSession: deps.readSession,
          sendToSession: deps.sendToSession,
          interruptSession: deps.interruptSession,
          selectSession: deps.selectSession,
        });
        // The dispatch awaited IPC; a stop (and maybe restart) meanwhile makes
        // this a dead connection's result, which must not enqueue into the new one.
        if (gen !== startGenRef.current) return;
        if (event.name === 'harbor_send_to_session') {
          if (result?.sent) watchedRef.current.add(result.session.id);
          note(result?.sent ? 'sent' : 'refused',
            result?.sent ? `to ${result.session.title}: ${result.text}` : (result?.reason || result?.error || 'refused'));
        } else if (event.name === 'harbor_interrupt_session' && result?.interrupted) {
          note('sent', `interrupted ${result.session.title}`);
        }
        enqueue({
          type: 'conversation.item.create',
          item: { type: 'function_call_output', call_id: event.call_id, output: JSON.stringify(result ?? {}) },
        });
        break;
      }
      case 'error':
        setMessage(event.error?.message || 'voice error');
        // Free the lane ONLY for the error that belongs to our outstanding
        // response.create, matched by event_id. An error for any other client
        // event must not release a create still on its way, or a second
        // response.create fires while the first starts. Kept identical to the
        // desktop hook (2026-09-03).
        if (awaitingCreateRef.current && event.error?.event_id
          && event.error.event_id === pendingCreateIdRef.current) {
          awaitingCreateRef.current = false;
          pendingCreateIdRef.current = null;
          if (event.error?.code !== 'conversation_already_has_active_response') {
            activeResponseRef.current = false;
            flush();
          }
        }
        break;
      default:
        break;
    }
  }, [enqueue, flush, note]);

  const stop = useCallback(() => {
    // Invalidate any start() still awaiting the mint or the mic.
    startGenRef.current += 1;
    try { startAbortRef.current?.abort(); } catch { /* nothing in flight */ }
    startAbortRef.current = null;
    try { channelRef.current?.close(); } catch { /* gone */ }
    try { pcRef.current?.close(); } catch { /* gone */ }
    for (const track of streamRef.current?.getTracks() || []) {
      try { track.stop(); } catch { /* gone */ }
    }
    if (audioRef.current) { audioRef.current.srcObject = null; audioRef.current = null; }
    channelRef.current = null;
    pcRef.current = null;
    streamRef.current = null;
    activeResponseRef.current = false;
    awaitingCreateRef.current = false;
    pendingCreateIdRef.current = null;
    queueRef.current = [];
    setSpeaking(false);
    setPhase('idle');
  }, []);

  const start = useCallback(async () => {
    if (!client || phase === 'connecting' || phase === 'live') return;
    const gen = (startGenRef.current += 1);
    const cancelled = () => startGenRef.current !== gen;
    setPhase('connecting');
    setMessage('');
    try {
      const minted = await client.call('voice:token', {
        voice, instructions: VOICE_INSTRUCTIONS, tools: TOOL_DEFS,
      });
      if (cancelled()) return;
      if (!minted?.ok) throw new Error(minted?.reason || 'could not start a voice session');

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // A stop() or unmount during the mint or the permission prompt already
      // tore down; stop this stream and abandon the attempt rather than leave a
      // mic on with nothing tracking it.
      if (cancelled()) {
        for (const track of stream.getTracks()) { try { track.stop(); } catch { /* stopped */ } }
        return;
      }
      streamRef.current = stream;

      const pc = new RTCPeerConnection();
      pcRef.current = pc;
      pc.ontrack = (event) => {
        const audio = audioRef.current || new Audio();
        audio.autoplay = true;
        audio.srcObject = event.streams[0];
        audioRef.current = audio;
        audio.play?.().catch(() => {});
      };
      for (const track of stream.getTracks()) pc.addTrack(track, stream);
      // An ICE failure opens no data channel, so nothing else would ever report
      // it and the bar sat on "connecting" forever. A deliberate stop() closes
      // the connection too, which is why only 'failed' is treated as an error.
      pc.onconnectionstatechange = () => {
        if (pc.connectionState !== 'failed' || pcRef.current !== pc) return;
        stop();
        setPhase('error');
        setMessage('the voice connection failed');
      };

      const channel = pc.createDataChannel('oai-events');
      channelRef.current = channel;
      channel.onmessage = (event) => {
        let parsed = null;
        try { parsed = JSON.parse(event.data); } catch { return; }
        handleEvent(parsed, gen);
      };
      channel.onopen = () => {
        rawSend({
          type: 'session.update',
          session: { type: 'realtime', audio: { input: { transcription: { model: 'gpt-4o-mini-transcribe' } } } },
        });
        setPhase('live');
      };
      // A remote close leaves the peer connection and the mic track alive while
      // the UI reads idle, so tear the whole session down. A deliberate stop()
      // closes this channel too, but channelRef points elsewhere by then, so the
      // identity guard makes that a no-op (2026-09-03).
      channel.onclose = () => { if (channelRef.current === channel) stop(); };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      // A stop() during the SDP exchange must not still POST to the paid Calls
      // endpoint; check before, and abort an in-flight request from stop().
      if (cancelled()) return;
      const controller = new AbortController();
      startAbortRef.current = controller;
      const response = await fetch(`${CALLS_URL}?model=${encodeURIComponent(minted.model)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${minted.token}`, 'Content-Type': 'application/sdp' },
        body: offer.sdp,
        signal: controller.signal,
      });
      if (cancelled()) return;
      if (!response.ok) throw new Error(`OpenAI refused the voice connection (HTTP ${response.status})`);
      await pc.setRemoteDescription({ type: 'answer', sdp: await response.text() });
    } catch (error) {
      if (cancelled()) return;
      stop();
      setPhase('error');
      setMessage(error?.message || 'voice failed to start');
    }
  }, [client, phase, voice, handleEvent, rawSend, stop]);

  const chooseVoice = useCallback((next) => {
    setVoice(next);
    writeVoicePref({ voice: next });
  }, []);

  useEffect(() => stop, [stop]);

  return {
    phase,
    message,
    activity,
    speaking,
    voice,
    voices: REALTIME_VOICES,
    start,
    stop,
    chooseVoice,
    relay,
    toggle: () => (phase === 'live' || phase === 'connecting' ? stop() : start()),
    // Test seam: inject text as if spoken.
    sayAsUser: relay,
    getQueueDepth: () => queueRef.current.length,
    isResponseActive: () => activeResponseRef.current,
  };
}
