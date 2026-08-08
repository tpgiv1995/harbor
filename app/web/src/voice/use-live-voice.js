import { useCallback, useEffect, useRef, useState } from 'react';
import voiceTools from '../../../src/renderer/voice/voice-tools.cjs';

export const REALTIME_VOICES = Object.freeze([
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar',
]);

const { TOOL_DEFS, VOICE_INSTRUCTIONS, dispatchVoiceTool } = voiceTools;
const CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
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
    rawSend({ type: 'response.create' });
  }, [rawSend]);

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

  const handleEvent = useCallback(async (event) => {
    switch (event.type) {
      case 'response.created':
        activeResponseRef.current = true;
        setSpeaking(true);
        break;
      case 'response.done':
        activeResponseRef.current = false;
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
        break;
      default:
        break;
    }
  }, [enqueue, flush, note]);

  const stop = useCallback(() => {
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
    queueRef.current = [];
    setSpeaking(false);
    setPhase('idle');
  }, []);

  const start = useCallback(async () => {
    if (!client || phase === 'connecting' || phase === 'live') return;
    setPhase('connecting');
    setMessage('');
    try {
      const minted = await client.call('voice:token', {
        voice, instructions: VOICE_INSTRUCTIONS, tools: TOOL_DEFS,
      });
      if (!minted?.ok) throw new Error(minted?.reason || 'could not start a voice session');

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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

      const channel = pc.createDataChannel('oai-events');
      channelRef.current = channel;
      channel.onmessage = (event) => {
        let parsed = null;
        try { parsed = JSON.parse(event.data); } catch { return; }
        handleEvent(parsed);
      };
      channel.onopen = () => {
        rawSend({
          type: 'session.update',
          session: { type: 'realtime', audio: { input: { transcription: { model: 'gpt-4o-mini-transcribe' } } } },
        });
        setPhase('live');
      };
      channel.onclose = () => setPhase((prev) => (prev === 'live' ? 'idle' : prev));

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const response = await fetch(`${CALLS_URL}?model=${encodeURIComponent(minted.model)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${minted.token}`, 'Content-Type': 'application/sdp' },
        body: offer.sdp,
      });
      if (!response.ok) throw new Error(`OpenAI refused the voice connection (HTTP ${response.status})`);
      await pc.setRemoteDescription({ type: 'answer', sdp: await response.text() });
    } catch (error) {
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
