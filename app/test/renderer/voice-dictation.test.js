'use strict';

// Voice dictation: the .compose-mic button records, whisper:transcribe returns
// text, and the text is APPENDED to the draft.
//
// Two rules, both live-caught 2026-09-03 by scripts/drive-voice-dictation-win.js
// (an isolated Harbor, Chromium's fake capture device fed a real speech clip,
// the real IPC and the real Whisper call):
//
//   1. A recording outlives the render that started it. `setText` in CommandBar
//      is NOT a React state setter: it reads `text` out of its closure. Reading
//      the draft that way when the transcription landed wrote the draft AS IT
//      WAS WHEN RECORDING STARTED, destroying anything typed in between. The
//      drive typed a word while the mic was open and watched it disappear.
//   2. A recording must always be stoppable and must never outlive the bar.
//      The composer can go untypeable mid-recording (another client takes
//      terminal control), which disabled the only button that could stop the
//      microphone; and switching the rail to Tasks or Notes unmounts the whole
//      Stage, which used to leave the recorder and the stream running.
//
// This reads the source, so it proves the rules are still written down rather
// than that they execute; the executing proof is the drive script.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/stage/CommandBar.jsx'),
  'utf8',
);

test('the transcription lands on the LIVE draft, not the one captured at record time', () => {
  assert.match(source, /const liveDraftRef = useRef\(\{ text, onDraftChange \}\);\s*\n\s*liveDraftRef\.current = \{ text, onDraftChange \};/);
  assert.match(source, /const \{ text: current, onDraftChange: patchDraft \} = liveDraftRef\.current;\s*\n\s*patchDraft\?\.\(\{ text: appendTranscription\(current, result\.text\) \}\)/);
  // The stale path must be gone: a functional setText inside the async stop
  // handler is exactly the bug.
  assert.doesNotMatch(source, /setText\(\(prev\) => appendTranscription\(prev, result\.text\)\)/);
});

test('a live recording stays stoppable, and starting one still needs a typeable composer', () => {
  assert.match(source, /disabled=\{\(voiceState\.phase !== 'recording' && !canType\)/);
  assert.match(source, /if \(voiceState\.phase === 'recording'\) stopVoiceRecording\(\);\s*\n\s*else if \(canType && !\['requesting', 'transcribing'\]\.includes\(voiceState\.phase\)\) startVoiceRecording\(\);/);
});

test('unmounting the command bar releases the microphone', () => {
  assert.match(source, /useEffect\(\(\) => \(\) => \{[\s\S]*recorderRef\.current\?\.state === 'recording'[\s\S]*recordingStreamRef\.current\?\.getTracks\?\.\(\)[\s\S]*\}, \[\]\)/);
});

test('a start racing an unmount stops the mic instead of leaking it', () => {
  // Each record attempt takes a token; unmount and the two cleanups bump it, so
  // a getUserMedia() that resolves after the bar is gone stops the stream rather
  // than opening a mic nothing tracks (2026-09-03).
  assert.match(source, /const attempt = \(recordAttemptRef\.current \+= 1\)/);
  assert.match(source, /if \(recordAttemptRef\.current !== attempt\) \{\s*\n\s*stream\.getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\);\s*\n\s*return;/);
  // A late callback only clears the shared slots when they still point at ITS
  // own recorder and stream.
  assert.match(source, /if \(recorderRef\.current === recorder\) recorderRef\.current = null;/);
  assert.match(source, /if \(recordingStreamRef\.current === stream\) recordingStreamRef\.current = null;/);
});

test('a transcription lands in the session that was recording, not the one now selected', () => {
  // The recording captures its session id in the recorder closure (never the
  // shared ref, which a newer attempt may overwrite); the transcript is appended
  // to THAT session's latest draft via appendSessionDraft, so a rail switch
  // mid-recording cannot land it in the wrong draft (2026-09-03).
  assert.match(source, /const recordingSessionId = session\?\.id \|\| null;/);
  assert.match(source, /if \(appendSessionDraft && recordingSessionId\) \{\s*\n\s*appendSessionDraft\(recordingSessionId, result\.text\);/);
});

test('a failed or superseded recorder never transcribes or stomps a newer recording', () => {
  // A MediaRecorder error, or a stale recorder whose attempt has been superseded,
  // must do no Whisper call (no spend) and must not change shared UI state
  // belonging to a newer attempt (2026-09-03 round-2 fix).
  assert.match(source, /const mine = \(\) => recordAttemptRef\.current === attempt;/);
  assert.match(source, /recorder\.onerror = \(\) => \{\s*\n\s*recorderFailed = true;/);
  assert.match(source, /if \(recorderFailed \|\| !mine\(\)\) return;/);
});
