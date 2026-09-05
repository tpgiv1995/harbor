import { useCallback, useRef, useState } from 'react';
import { useRpc } from '../rpc/rpc-context.jsx';
import { appendTranscription } from '../../../src/renderer/stage/command-bar-attachments.cjs';

const IDLE = { phase: 'idle', message: '' };

export function useVoiceDraft({ disabled, onTranscribed }) {
  const client = useRpc();
  const [voiceState, setVoiceState] = useState(IDLE);
  const recorderRef = useRef(null);
  const streamRef = useRef(null);

  const stopRecording = useCallback(() => {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  }, []);

  const startRecording = useCallback(async () => {
    if (disabled) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setVoiceState({ phase: 'error', message: 'Microphone recording is unavailable on this device.' });
      return;
    }
    setVoiceState({ phase: 'requesting', message: 'Requesting microphone…' });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
        .find((type) => MediaRecorder.isTypeSupported?.(type));
      const recorder = preferred ? new MediaRecorder(stream, { mimeType: preferred }) : new MediaRecorder(stream);
      const chunks = [];
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
      recorder.onerror = () => {
        stream.getTracks().forEach((track) => track.stop());
        setVoiceState({ phase: 'error', message: 'Microphone recording failed.' });
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        if (!blob.size) {
          setVoiceState({ phase: 'error', message: 'Recording was empty; nothing was transcribed.' });
          return;
        }
        setVoiceState({ phase: 'transcribing', message: 'Transcribing recording…' });
        try {
          const buffer = await blob.arrayBuffer();
          const result = await client.call('whisper:transcribe', {
            buffer: Array.from(new Uint8Array(buffer)),
            mimeType: blob.type,
          });
          if (!result?.ok) throw new Error(result?.reason || 'Whisper transcription failed.');
          onTranscribed?.(appendTranscription, result.text);
          setVoiceState(IDLE);
        } catch (error) {
          setVoiceState({ phase: 'error', message: error?.message || 'Whisper transcription failed.' });
        }
      };
      recorder.start();
      setVoiceState({ phase: 'recording', message: 'Recording… tap the mic to stop.' });
    } catch (error) {
      streamRef.current?.getTracks?.().forEach((track) => track.stop());
      streamRef.current = null;
      const denied = error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError';
      setVoiceState({
        phase: 'error',
        message: denied ? 'Microphone permission was denied.' : `Microphone unavailable: ${error?.message || 'could not start recording'}`,
      });
    }
  }, [client, disabled, onTranscribed]);

  const toggle = useCallback(() => {
    if (voiceState.phase === 'recording') stopRecording();
    else if (!['requesting', 'transcribing'].includes(voiceState.phase)) startRecording();
  }, [voiceState.phase, startRecording, stopRecording]);

  return { voiceState, toggle, stopRecording };
}
