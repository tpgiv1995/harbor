import { useCallback, useEffect, useRef, useState } from 'react';
import voiceTools from './voice-tools.cjs';

// The realtime voice set, mirrored from main/voice-realtime.js. Kept here so the
// picker never offers a voice the token minter would reject.
export const REALTIME_VOICES = Object.freeze([
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar',
]);

const { TOOL_DEFS, VOICE_INSTRUCTIONS, dispatchVoiceTool } = voiceTools;

const CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
// How long to wait for a response.create to be acknowledged before assuming it
// failed silently and freeing the speaking lane.
const CREATE_ACK_TIMEOUT_MS = 8000;
export const VOICE_STORE_KEY = 'harbor-voice';

export function readVoicePref() {
  try {
    const raw = JSON.parse(localStorage.getItem(VOICE_STORE_KEY) || 'null');
    return { voice: typeof raw?.voice === 'string' ? raw.voice : 'marin' };
  } catch {
    return { voice: 'marin' };
  }
}

export function writeVoicePref(pref) {
  try { localStorage.setItem(VOICE_STORE_KEY, JSON.stringify(pref)); } catch { /* keep in memory */ }
}

// Harbor's live voice mode: a realtime OpenAI voice agent that can read and drive
// the open Claude sessions through Harbor's own tools (voice-tools.cjs).
//
// The audio runs over WebRTC straight from this page, because the microphone is
// here and pumping PCM through the main process would add latency for nothing.
// Main mints a short-lived client secret so the real OpenAI key never enters the
// renderer.
//
// THE ONE PROTOCOL RULE THAT MATTERS: never ask for a response while one is
// already running. The API rejects it with
// "conversation_already_has_active_response", and a tool call is exactly when it
// is tempting to get wrong, because the arguments arrive BEFORE the response
// that carried them has finished. So tool outputs and relayed session news are
// queued and flushed on response.done, never sent the moment they are ready.
export function useVoiceAgent({ getSessions, readSession, sendToSession, interruptSession, selectSession }) {
  const [phase, setPhase] = useState('idle'); // idle | connecting | live | error
  const [message, setMessage] = useState('');
  const [voice, setVoice] = useState(() => readVoicePref().voice);
  // A short log of what the agent actually DID, so a voice action is never
  // invisible: the user can see the send it made even if they mishear the reply.
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
  // stayed true forever. Every later tool output and relayed update then sat in
  // the queue unsent: the agent kept listening and never spoke again, with no
  // error the user could see. This is what tells the error handler that the
  // stuck lane is ours to free.
  const awaitingCreateRef = useRef(false);
  // The event_id of the response.create we are waiting to see acknowledged. An
  // error frees the lane ONLY when it is the error for THIS create; an error for
  // any other client event must not, or a second response.create goes out while
  // the first is still starting (2026-09-03).
  const pendingCreateIdRef = useRef(null);
  const createSeqRef = useRef(0);
  // A monotonic token for each start() attempt. stop() and unmount bump it, so a
  // start still awaiting the token mint or the microphone knows it was cancelled
  // and bails instead of bringing the connection up after the user turned it off.
  const startGenRef = useRef(0);
  // Aborts the in-flight SDP exchange when stop() races it, so a cancelled start
  // never opens the paid remote session (2026-09-03).
  const startAbortRef = useRef(null);
  const queueRef = useRef([]);
  // Sessions the agent has actually sent something to. Only these get their
  // outcome relayed unprompted: with a dozen windows open, narrating every one
  // that settles would make the voice useless.
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

  // Everything that would start a response goes through here.
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
    // Backstop for a create that is never acknowledged: no response.created and
    // no matching error (an error with no event_id, a dropped frame). Without
    // this the lane wedges forever and the agent goes silent. If response.created
    // or response.done already cleared this id, the guard makes it a no-op.
    setTimeout(() => {
      if (pendingCreateIdRef.current !== id || !awaitingCreateRef.current) return;
      awaitingCreateRef.current = false;
      pendingCreateIdRef.current = null;
      activeResponseRef.current = false;
      flushRef.current();
    }, CREATE_ACK_TIMEOUT_MS);
  }, [rawSend]);
  // Stable pointer to the latest flush, so the ack-timeout closure above (and the
  // stale-event guard below) can call it without a dependency cycle.
  const flushRef = useRef(flush);
  flushRef.current = flush;

  const enqueue = useCallback((...events) => {
    queueRef.current.push(...events);
    flush();
  }, [flush]);

  // Speak an update about a session without the user having to ask. Used when a
  // session they sent to finishes its turn.
  const relay = useCallback((text) => {
    if (!text || channelRef.current?.readyState !== 'open') return;
    enqueue({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    });
  }, [enqueue]);

  // Inject text as if it had been spoken. The e2e drive uses this to exercise the
  // whole tool loop without a microphone.
  const sayAsUser = useCallback((text) => relay(text), [relay]);

  // A session finished a turn. Relayed only if the agent is the one that started
  // it, and only once per settling, so the user hears the outcome of what they asked for
  // without being read a running commentary of the whole grid.
  const sessionSettled = useCallback((sessionId, title, lastText) => {
    if (!watchedRef.current.has(sessionId)) return;
    watchedRef.current.delete(sessionId);
    const body = String(lastText || '').trim().slice(0, 1500);
    relay(`[Harbor] The session "${title}" has finished the turn you started. Its last message was: ${body || '(no text)'}`
      + ' Relay the outcome to the user in one sentence.');
  }, [relay]);

  const handleEvent = useCallback(async (event, gen) => {
    // A message that belongs to a connection we have already stopped (a buffered
    // frame, or a tool result that resolves after stop) must not touch the new
    // connection's lane or enqueue into its channel (2026-09-03).
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
        try { args = JSON.parse(event.arguments || '{}'); } catch { /* the tool reports the bad shape */ }
        const deps = depsRef.current;
        const result = await dispatchVoiceTool(event.name, args, {
          listSessions: deps.getSessions,
          readSession: deps.readSession,
          sendToSession: deps.sendToSession,
          interruptSession: deps.interruptSession,
          selectSession: deps.selectSession,
        });
        // The dispatch awaited IPC; if voice was stopped (and maybe restarted)
        // meanwhile, this result belongs to a dead connection and must not enqueue
        // into the new one.
        if (gen !== startGenRef.current) return;
        if (event.name === 'harbor_send_to_session') {
          if (result?.sent) watchedRef.current.add(result.session.id);
          note(result?.sent ? 'sent' : 'refused',
            result?.sent ? `to ${result.session.title}: ${result.text}` : (result?.reason || result?.error || 'refused'));
        } else if (event.name === 'harbor_interrupt_session' && result?.interrupted) {
          note('sent', `interrupted ${result.session.title}`);
        }
        // Queued, not sent: the response that produced these arguments has not
        // finished yet (see the protocol rule above).
        enqueue({
          type: 'conversation.item.create',
          item: { type: 'function_call_output', call_id: event.call_id, output: JSON.stringify(result ?? {}) },
        });
        break;
      }
      case 'error':
        setMessage(event.error?.message || 'voice error');
        // Free the lane ONLY for the error that belongs to our outstanding
        // response.create, matched by the event_id we tagged it with. A create
        // that fails otherwise leaves no response.created and no response.done,
        // so nothing else would release the lane and the agent would go silent.
        // But an error for any OTHER client event (a conversation item, a
        // session.update) must NOT release a create still on its way, or a second
        // response.create fires while the first starts. The one code we keep even
        // on a match is conversation_already_has_active_response, where the flag
        // is correct and that response's own response.done releases it.
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
    // Invalidate any start() still awaiting the mint or the microphone, so it
    // cannot bring the connection up after this point.
    startGenRef.current += 1;
    try { startAbortRef.current?.abort(); } catch { /* nothing in flight */ }
    startAbortRef.current = null;
    try { channelRef.current?.close(); } catch { /* already gone */ }
    try { pcRef.current?.close(); } catch { /* already gone */ }
    for (const track of streamRef.current?.getTracks() || []) {
      try { track.stop(); } catch { /* already stopped */ }
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
    if (phase === 'connecting' || phase === 'live') return;
    const gen = (startGenRef.current += 1);
    const cancelled = () => startGenRef.current !== gen;
    setPhase('connecting');
    setMessage('');
    try {
      const minted = await window.harbor.voice.token({
        voice, instructions: VOICE_INSTRUCTIONS, tools: TOOL_DEFS,
      });
      if (cancelled()) return;
      if (!minted?.ok) throw new Error(minted?.reason || 'could not start a voice session');

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // A stop() or unmount during the mint or the permission prompt already
      // tore everything down; this stream would otherwise be a mic left on with
      // nothing tracking it. Stop it here and abandon the attempt.
      if (cancelled()) {
        for (const track of stream.getTracks()) { try { track.stop(); } catch { /* already stopped */ } }
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
        audio.play?.().catch(() => { /* autoplay policy; the element stays attached */ });
      };
      for (const track of stream.getTracks()) pc.addTrack(track, stream);
      // Nothing else reports a peer connection that never came up: the data
      // channel that would fire onclose never opened, so an ICE failure left
      // the bar on "connecting voice…" forever with no reason given and the
      // microphone still held. A deliberate stop() closes the connection too,
      // which is why only 'failed' is treated as an error here.
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
        // Ask for input transcription so the activity log can show what Harbor
        // heard, which is the only way to tell a mis-hear from a mis-action.
        rawSend({
          type: 'session.update',
          session: { type: 'realtime', audio: { input: { transcription: { model: 'gpt-4o-mini-transcribe' } } } },
        });
        setPhase('live');
      };
      // A remote close (the server dropping the data channel) leaves the peer
      // connection and the microphone track alive while the UI reads idle, so
      // it must tear the whole session down, not just flip a label. A deliberate
      // stop() closes this channel too, but by then channelRef points elsewhere,
      // so the identity guard makes that path a no-op (2026-09-03).
      channel.onclose = () => { if (channelRef.current === channel) stop(); };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      // A stop() during the SDP exchange must not still POST to the paid Calls
      // endpoint. Check before the request, and give it an abort signal so a stop
      // WHILE it is in flight tears it down too (2026-09-03).
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
      if (!response.ok) {
        throw new Error(`OpenAI refused the voice connection (HTTP ${response.status})`);
      }
      await pc.setRemoteDescription({ type: 'answer', sdp: await response.text() });
    } catch (error) {
      // A cancelled attempt is not an error to show; stop() already cleaned up.
      if (cancelled()) return;
      stop();
      setPhase('error');
      setMessage(error?.message || 'voice failed to start');
    }
  }, [phase, voice, handleEvent, rawSend, stop]);

  const chooseVoice = useCallback((next) => {
    setVoice(next);
    writeVoicePref({ voice: next });
  }, []);

  useEffect(() => stop, [stop]);

  return {
    phase, message, activity, speaking, voice, voices: REALTIME_VOICES,
    start, stop, chooseVoice, relay, sayAsUser, sessionSettled,
    toggle: () => (phase === 'live' || phase === 'connecting' ? stop() : start()),
  };
}
