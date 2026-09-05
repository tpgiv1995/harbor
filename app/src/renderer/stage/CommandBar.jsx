import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ProjectIcon } from './ProjectIcon.jsx';
import { providerIdentity, providerModel, ProfileBadge, useProfiles } from '../providers.js';
import attachmentLifecycle from './command-bar-attachments.cjs';
import slashTokens from './slash-tokens.cjs';
import handoffChainLib from './handoff-chain.cjs';
import { ComposeEditor } from './ComposeEditor.jsx';
import { ImagePreview } from './ImagePreview.jsx';

const {
  appendTranscription, attachmentsAfterSend, attachmentKind, fileAttachmentsFromPaths, imageAttachment,
  removeAttachmentAt, composeOutgoingText, imageAttachmentPaths, classifyPasteItems,
  attachmentPreviewPlan,
} = attachmentLifecycle;
const {
  parseSlashTokens, activeSlashToken, slashMatchesFor, slashChrome,
} = slashTokens;
const { describeChain } = handoffChainLib;

const EFFORT_LABEL = { low: 'low', medium: 'med', high: 'high', xhigh: 'xhigh', max: 'max' };

const PHASE_TEXT = {
  resuming: 'resuming session…',
  waiting: 'waiting for Claude…',
  sending: 'sending…',
  'taking-over': 'taking over…',
};

// How each slash-command source is tagged in the capability menu.
const SOURCE_LABEL = {
  'built-in': 'built-in',
  user: 'you',
  project: 'project',
  plugin: 'plugin',
  skill: 'skill',
};

// Permission-mode display copy, honestly named for what the CLI is doing.
const MODE_LABEL = {
  default: 'default · asks before edits',
  plan: 'plan mode · read-only',
  'accept-edits': 'accept edits',
  bypass: 'bypass permissions',
};

const PlusIcon = ({ children, ...props }) => (
  <svg className="plus-action-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    {children}
  </svg>
);

const IconMic = (props) => (
  <PlusIcon {...props}>
    <rect x="9" y="3" width="6" height="10" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0" />
    <line x1="12" y1="18" x2="12" y2="21" />
    <line x1="8" y1="21" x2="16" y2="21" />
  </PlusIcon>
);

const IconWorkflow = (props) => (
  <PlusIcon {...props}>
    <path d="M6 7h5l2 3h5" />
    <circle cx="6" cy="7" r="2" />
    <circle cx="18" cy="10" r="2" />
    <path d="M6 17h12" />
  </PlusIcon>
);

const IconAttach = (props) => (
  <PlusIcon {...props}>
    <path d="M8 12l7-7a3 3 0 0 1 4 4l-8 8a4 4 0 0 1-6-6l9-9" />
  </PlusIcon>
);

const IconFolder = (props) => (
  <PlusIcon {...props}>
    <path d="M4 7h6l2 2h8v9H4z" />
  </PlusIcon>
);

const IconHandoff = (props) => (
  <PlusIcon {...props}>
    <path d="M4 9a8 8 0 0 1 14-3l2 2" />
    <path d="M20 4v4h-4" />
    <path d="M20 15a8 8 0 0 1-14 3l-2-2" />
    <path d="M4 20v-4h4" />
  </PlusIcon>
);

const stripBeta = (id) => String(id || '').replace(/\[1m\]/g, '');

// The universal prompt bar: always shows WHERE input goes (status row),
// drives exactly the selected session, and never pretends. A session Harbor
// cannot reach says so instead of eating keystrokes. The ▾ button opens a
// per-session capability menu (models, effort, permission mode, fast mode,
// workflow, plugins, live slash commands) built fresh from the session's own
// config home at open time.
export function CommandBar({
  session,
  header,
  pane,
  readOnly,
  externalLive,
  externallyControlled,
  sendState,
  onSend,
  onInterrupt,
  liveVoice,
  onCancelQueued,
  onResume,
  onTakeover,
  onModelSwitch,
  onEffortSwitch,
  onRunWorkflow,
  onOpenConfig,
  handoffChain,
  onHandoffChain,
  draft,
  onDraftChange,
  onDraftClear,
  appendSessionDraft,
}) {
  const { profiles, workflows } = useProfiles();
  const text = draft?.text ?? '';
  const attachments = Array.isArray(draft?.attachments) ? draft.attachments : [];
  const setText = (value) => {
    const next = typeof value === 'function' ? value(text) : value;
    onDraftChange?.({ text: next });
  };
  const setAttachments = (value) => {
    const next = typeof value === 'function' ? value(attachments) : value;
    onDraftChange?.({ attachments: next });
  };
  // `setText` is not a React state setter: it reads `text` out of THIS render's
  // closure. That is harmless for a click handler and wrong for anything that
  // outlives the render, which the mic does; a dictation can run for a minute
  // while the user keeps typing. Appending the transcription through the stale
  // closure wrote the draft AS IT WAS WHEN RECORDING STARTED, silently
  // destroying every keystroke since (reproduced live 2026-09-03 by
  // scripts/drive-voice-dictation-win.js, which types while the mic is open:
  // the word typed mid-recording vanished when the transcript landed). Async
  // work goes through this ref, never the closure, and it carries
  // `onDraftChange` too so the text lands in the draft the user is looking at
  // rather than the one selected when they pressed record.
  const liveDraftRef = useRef({ text, onDraftChange });
  liveDraftRef.current = { text, onDraftChange };
  const [attachmentSendState, setAttachmentSendState] = useState(null);
  const [preview, setPreview] = useState(null);
  const [voiceState, setVoiceState] = useState({ phase: 'idle', message: '' });
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState(null);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const [plusMenuPos, setPlusMenuPos] = useState(null);
  const [plusCmdSearch, setPlusCmdSearch] = useState('');
  const [plusExpanded, setPlusExpanded] = useState({ slash: false, connectors: false, plugins: false });
  const [caps, setCaps] = useState(null);
  const [capsError, setCapsError] = useState(null);
  const [permMode, setPermMode] = useState(undefined); // undefined=unread, null=unreadable
  const [cycling, setCycling] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [cmdSearch, setCmdSearch] = useState('');
  const [slashHighlight, setSlashHighlight] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [slashPos, setSlashPos] = useState(null);
  const inputRef = useRef(null);
  const switchRef = useRef(null);
  const attachRef = useRef(null);
  const recorderRef = useRef(null);
  const recordingStreamRef = useRef(null);
  // A monotonic token per record attempt. Unmount, a stop, or a fast restart
  // bumps it, so a getUserMedia() that resolves LATE knows its attempt was
  // abandoned and stops the stream instead of opening a mic nothing tracks
  // (2026-09-03). The session id is captured with it so a transcription lands in
  // the session that was recording, even after the rail switches away.
  const recordAttemptRef = useRef(0);
  const recordSessionIdRef = useRef(null);
  const submittingRef = useRef(false);
  const pending = Boolean(sendState && (
    ['resuming', 'waiting', 'sending', 'taking-over'].includes(sendState.phase)
    || sendState.queue?.items?.some((item) => item.status === 'sending')
  ));
  const queuedItem = sendState?.queue?.items?.find((item) => item.status === 'queued') || null;
  const showStop = Boolean(pane?.paneId && (pending || header?.working));

  // Retargeting the bar clears menu remnants; each session keeps its own draft.
  useEffect(() => {
    setMenuOpen(false);
    setPlusMenuOpen(false);
    setSlashDismissed(false);
    setPlusExpanded({ slash: false, connectors: false, plugins: false });
  }, [session?.id]);

  useEffect(() => {
    if (!plusMenuOpen) {
      setPlusExpanded({ slash: false, connectors: false, plugins: false });
    }
  }, [plusMenuOpen]);

  useEffect(() => () => {
    recordAttemptRef.current += 1;
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    recordingStreamRef.current?.getTracks?.().forEach((track) => track.stop());
  }, []);

  // No auto-grow effect and no mirror layer any more: a contenteditable sizes
  // itself, and slash tokens are painted with the CSS Custom Highlight API,
  // which colours ranges without touching the DOM. Both mechanisms existed only
  // because a textarea can neither grow nor colour part of its own text.

  // The format toolbar is a toggle next to the mic (Pat, 2026-07-26: "just like
  // MS Teams"), and Teams remembers whether you left it open.
  const [formatOpen, setFormatOpen] = useState(() => {
    try { return window.localStorage.getItem('harbor-compose-format') === '1'; } catch { return false; }
  });
  const toggleFormatBar = () => {
    setFormatOpen((open) => {
      const next = !open;
      try { window.localStorage.setItem('harbor-compose-format', next ? '1' : '0'); } catch { /* private mode */ }
      return next;
    });
    inputRef.current?.focus();
  };

  // Read capabilities for slash autocomplete; refresh when session or a menu opens.
  useEffect(() => {
    if (!session?.id) {
      setCaps(null);
      return undefined;
    }
    let live = true;
    if (menuOpen) {
      setCapsError(null);
      setShowVersions(false);
      setCmdSearch('');
    }
    if (plusMenuOpen) {
      setCapsError(null);
      setPlusCmdSearch('');
    }
    window.harbor.capabilities.get({ sessionId: session.id })
      .then((res) => {
        if (!live) return;
        if (res?.ok) setCaps(res.capabilities);
        else setCapsError(res?.reason || 'could not read capabilities');
      })
      .catch((e) => { if (live) setCapsError(String(e?.message || e)); });
    return () => { live = false; };
  }, [menuOpen, plusMenuOpen, session?.id]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    let live = true;
    setPermMode(undefined);
    if (pane?.paneId) {
      window.harbor.capabilities.permissionMode({ paneId: pane.paneId })
        .then((res) => { if (live) setPermMode(res?.mode ?? null); })
        .catch(() => { if (live) setPermMode(null); });
    } else {
      setPermMode(null);
    }
    return () => { live = false; };
  }, [menuOpen, pane?.paneId]);


  const dead = session && !pane && !externalLive;
  // Dead codex/cursor sessions resume-on-send like claude (bin/ai --resume-id)
  // EXCEPT when the working folder is unknown (a cursor transcript never
  // records its cwd; an unmatched project cannot be resumed anywhere honest).
  const nonClaudeDead = Boolean(
    dead && ['codex', 'cursor'].includes(session?.provider) && !session?.cwd,
  );
  // Settings that TYPE into the pty need a Harbor-controlled pane; lists and
  // current-state reads work for any session.
  const drivable = Boolean(session && pane && !readOnly && !externalLive && !externallyControlled);
  const disabledReason = !session
    ? 'Select a session window first'
    : readOnly
      ? 'Orchestration workers are read-only'
      : externallyControlled
        ? 'Another client controls this terminal'
        : nonClaudeDead
          ? `This ${providerIdentity(session?.provider).label} session's working folder is unknown; its transcript is read-only`
          : null;
  const canType = session && !disabledReason;

  // Selecting a window ARMS the composer: rail click, tile click, Ctrl+digit
  // and Alt+arrows all land ready to type (Pat, 2026-07-25: "i dont want to
  // have to click into the text box every time"). Once per selected session,
  // when it first becomes typeable, so a mid-session capability change never
  // re-steals focus from something else.
  const armedForRef = useRef(null);
  useEffect(() => {
    if (!session?.id || !canType) return;
    if (armedForRef.current === session.id) return;
    armedForRef.current = session.id;
    inputRef.current?.focus();
  }, [session?.id, canType]);

  // Tile clicks ask for focus explicitly (the selection may not have changed:
  // clicking the already-selected window must still arm the composer).
  useEffect(() => {
    const onFocusRequest = () => { if (canType) inputRef.current?.focus(); };
    window.addEventListener('harbor-focus-composer', onFocusRequest);
    return () => window.removeEventListener('harbor-focus-composer', onFocusRequest);
  }, [canType]);

  const placeholder = !session
    ? 'Select a session…'
    : disabledReason
      ? disabledReason
      : externalLive
        ? 'Message this session (Enter ends its outside terminal and continues here)…'
        : dead
          ? 'Message this session (Enter resumes it first)…'
          : 'Message the selected session…';

  const submit = async () => {
    if (window.__harborUiDebug) console.log('[ui] submit', JSON.stringify({ canType, pending, phase: sendState?.phase, text, dead }));
    if (!canType || submittingRef.current) return;
    const submittedAttachments = attachments;
    const outgoingText = composeOutgoingText(text, submittedAttachments);
    const submittedImages = imageAttachmentPaths(submittedAttachments);
    if (!outgoingText && submittedImages.length === 0) {
      if (dead) onResume();
      return;
    }
    submittingRef.current = true;
    setAttachmentSendState(submittedAttachments.length ? 'sending' : null);
    let ok = false;
    try {
      ok = externalLive
        ? Boolean(await onTakeover(outgoingText, submittedImages))
        : Boolean(await onSend(outgoingText, submittedImages));
    } catch {
      ok = false;
    }
    setAttachments((current) => attachmentsAfterSend(current, submittedAttachments, ok));
    if (ok) {
      onDraftClear?.();
      setSlashDismissed(false);
    }
    setAttachmentSendState(ok || submittedAttachments.length === 0 ? null : 'failed');
    submittingRef.current = false;
    inputRef.current?.focus();
  };

  const attach = async () => {
    if (!canType) return;
    setPlusMenuOpen(false);
    const files = await window.harbor.session.pickFiles().catch(() => null);
    if (!files?.length) return;
    const picked = fileAttachmentsFromPaths(files);
    setAttachments((current) => [...current, ...picked]);
    setAttachmentSendState(null);
    inputRef.current?.focus();
  };

  const attachFolder = async () => {
    if (!canType) return;
    setPlusMenuOpen(false);
    const folder = await window.harbor.session.pickFolder().catch(() => null);
    if (!folder) return;
    setText((prev) => `${prev}${prev && !prev.endsWith(' ') ? ' ' : ''}${folder} `);
    inputRef.current?.focus();
  };

  const stopVoiceRecording = () => {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  };

  const startVoiceRecording = async () => {
    setPlusMenuOpen(false);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setVoiceState({ phase: 'error', message: 'Microphone recording is unavailable on this device.' });
      return;
    }
    const attempt = (recordAttemptRef.current += 1);
    const recordingSessionId = session?.id || null;
    setVoiceState({ phase: 'requesting', message: 'Requesting microphone…' });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // The bar unmounted (rail switched) or a stop/restart happened while the
      // permission prompt was open: this attempt is stale, so stop the stream
      // rather than open a mic with nothing left to close it.
      if (recordAttemptRef.current !== attempt) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      recordingStreamRef.current = stream;
      recordSessionIdRef.current = recordingSessionId;
      const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
        .find((type) => MediaRecorder.isTypeSupported?.(type));
      const recorder = preferred ? new MediaRecorder(stream, { mimeType: preferred }) : new MediaRecorder(stream);
      const chunks = [];
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
      // This recorder's own facts, captured so a LATER attempt cannot poison
      // them: its attempt token, the session it is recording, and whether it
      // failed (2026-09-03). `mine()` is true only while THIS attempt is still
      // the current one.
      const mine = () => recordAttemptRef.current === attempt;
      let recorderFailed = false;
      // Only clear the shared refs when they still point at THIS recorder and
      // stream; a late callback from an older recorder must not null the slots a
      // newer one just took.
      const releaseSlots = () => {
        if (recorderRef.current === recorder) recorderRef.current = null;
        if (recordingStreamRef.current === stream) recordingStreamRef.current = null;
      };
      recorder.onerror = () => {
        recorderFailed = true;
        stream.getTracks().forEach((track) => track.stop());
        releaseSlots();
        // A stale recorder's error must not stomp a newer recording's UI.
        if (mine()) setVoiceState({ phase: 'error', message: 'Microphone recording failed.' });
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        releaseSlots();
        // A FAILED or SUPERSEDED recorder does no transcription (so a partial
        // clip never reaches Whisper and never spends) and touches no shared UI:
        // a newer attempt owns the mic, the state, and the draft now (2026-09-03).
        if (recorderFailed || !mine()) return;
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        if (!blob.size) {
          setVoiceState({ phase: 'error', message: 'Recording was empty; nothing was transcribed.' });
          return;
        }
        setVoiceState({ phase: 'transcribing', message: 'Transcribing recording…' });
        try {
          const result = await window.harbor.whisper.transcribe({
            buffer: await blob.arrayBuffer(),
            mimeType: blob.type,
          });
          if (!result?.ok) throw new Error(result?.reason || 'Whisper transcription failed.');
          // The transcript belongs to the session that was recording, captured in
          // THIS closure (never the shared ref, which a newer attempt may have
          // overwritten), appended to that session's LATEST draft even if the rail
          // has since switched away. appendSessionDraft reads the current text for
          // that id; the liveDraftRef path is the fallback when the prop is absent.
          if (appendSessionDraft && recordingSessionId) {
            appendSessionDraft(recordingSessionId, result.text);
          } else {
            const { text: current, onDraftChange: patchDraft } = liveDraftRef.current;
            patchDraft?.({ text: appendTranscription(current, result.text) });
          }
          if (mine()) { setVoiceState({ phase: 'idle', message: '' }); inputRef.current?.focus(); }
        } catch (error) {
          if (mine()) setVoiceState({ phase: 'error', message: error?.message || 'Whisper transcription failed.' });
        }
      };
      recorder.start();
      setVoiceState({ phase: 'recording', message: 'Recording… click the mic to stop.' });
    } catch (error) {
      recordingStreamRef.current?.getTracks?.().forEach((track) => track.stop());
      recordingStreamRef.current = null;
      const denied = error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError';
      setVoiceState({
        phase: 'error',
        message: denied ? 'Microphone permission was denied.' : `Microphone unavailable: ${error?.message || 'could not start recording'}`,
      });
    }
  };

  const toggleVoiceRecording = () => {
    // STOPPING is always allowed, starting is not. The composer can become
    // untypeable mid-recording (another client takes terminal control, the
    // session turns read-only), and when that disabled the button it left the
    // microphone open with nothing able to close it.
    if (voiceState.phase === 'recording') stopVoiceRecording();
    else if (canType && !['requesting', 'transcribing'].includes(voiceState.phase)) startVoiceRecording();
  };

  // A recording must never outlive the bar. Switching the rail to Tasks, Notes,
  // Board or Files unmounts the whole Stage, and without this the MediaRecorder
  // and its microphone stream stayed live with the OS recording indicator on and
  // nothing left in the tree that could stop them. Stopping the recorder rather
  // than only its tracks lets the transcription still land in the draft, which
  // is where the user will look for it when they come back.
  useEffect(() => () => {
    recordAttemptRef.current += 1;
    try { if (recorderRef.current?.state === 'recording') recorderRef.current.stop(); } catch { /* already stopped */ }
    for (const track of recordingStreamRef.current?.getTracks?.() || []) {
      try { track.stop(); } catch { /* already stopped */ }
    }
  }, []);

  const paste = async (event) => {
    if (!canType) return;
    const items = Array.from(event.clipboardData?.items || []);
    const { imageItem, readClipboardImage } = classifyPasteItems(items);
    let savedPath = null;
    let thumbDataUri = null;
    if (imageItem) {
      event.preventDefault();
      const file = imageItem.getAsFile();
      if (!file) return;
      const ext = file.type === 'image/jpeg' ? 'jpg' : 'png';
      const buffer = await file.arrayBuffer();
      thumbDataUri = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
      });
      savedPath = await window.harbor.clipboard.saveImage({ buffer, ext }).catch(() => null);
    } else if (readClipboardImage) {
      event.preventDefault();
      savedPath = await window.harbor.clipboard.readImage().catch(() => null);
    } else {
      return;
    }
    if (!savedPath) return;
    setAttachments((current) => [...current, imageAttachment(savedPath, thumbDataUri)]);
    setAttachmentSendState(null);
    inputRef.current?.focus();
  };

  // Open a pending attachment to look at it. The data URI captured at paste
  // time IS the full image, so a pasted or dropped file previews with no round
  // trip; an attachment that has none (the Electron clipboard path, and any
  // draft restored from localStorage, which persists paths and not bytes) is
  // read back off disk through the allowlisted channel. An image that cannot be
  // read still OPENS, saying so, rather than the click doing nothing.
  const openAttachmentPreview = async (attachment) => {
    const plan = attachmentPreviewPlan(attachment);
    if (!plan) return;
    setPreview(plan);
    if (!plan.needsFetch) return;
    const src = await window.harbor.clipboard.imageDataUri?.({ path: plan.path }).catch(() => null);
    // Guarded on the path: the user can click a different chip (or send) while
    // this read is in flight, and a late answer must not overwrite what is now
    // on screen.
    setPreview((current) => (current && current.path === plan.path ? { ...current, src: src || null } : current));
  };

  // A preview must not outlive the thing it is previewing: sending or removing
  // the attachment closes it, so the overlay can never show an image the draft
  // no longer has.
  useEffect(() => {
    if (!preview) return;
    if (!attachments.some((attachment) => attachment.path === preview.path)) setPreview(null);
  }, [attachments, preview]);

  const toggleMenu = () => {
    if (!menuOpen && switchRef.current) {
      const rect = switchRef.current.getBoundingClientRect();
      setMenuPos({ bottom: window.innerHeight - rect.top + 8, right: window.innerWidth - rect.right });
    }
    setMenuOpen((open) => !open);
  };

  const togglePlusSection = (key) => {
    setPlusExpanded((current) => ({ ...current, [key]: !current[key] }));
  };

  const togglePlusMenu = () => {
    if (!canType) return;
    if (!plusMenuOpen && attachRef.current) {
      const rect = attachRef.current.getBoundingClientRect();
      setPlusMenuPos({ bottom: window.innerHeight - rect.top + 8, left: rect.left });
      setPlusCmdSearch('');
    }
    setPlusMenuOpen((open) => !open);
  };

  // Insert-not-send: slash commands, skills, and the ultracode keyword go into
  // the composer draft for Pat to review; they NEVER auto-send.
  const insertDraft = (snippet) => {
    setText((prev) => `${prev}${prev && !prev.endsWith(' ') ? ' ' : ''}${snippet}`);
    setMenuOpen(false);
    setPlusMenuOpen(false);
    inputRef.current?.focus();
  };

  const launchWorkflow = async (id) => {
    setPlusMenuOpen(false);
    await onRunWorkflow(id);
  };

  // Model/effort switching DOES send (through the error-surfacing send path).
  const runSwitch = (fn, arg) => { setMenuOpen(false); fn(arg); };

  const cycleMode = async () => {
    if (!pane?.paneId || cycling) return;
    setCycling(true);
    try {
      const res = await window.harbor.capabilities.cyclePermissionMode({
        paneId: pane.paneId,
        workspaceId: pane.workspaceId,
      });
      if (res?.ok) setPermMode(res.mode ?? null);
    } catch { /* leave the prior reading */ }
    setCycling(false);
  };

  const displayTitle = session
    ? (session.isChildTask && session.childTitle ? session.childTitle : session.title)
    : null;
  const ctxPct = typeof header?.contextPct === 'number' ? Math.round(header.contextPct) : null;
  const ctxWarn = ctxPct != null && ctxPct >= 70;
  // No percent known: show the real token count, never a guessed fraction.
  const ctxTokens = typeof header?.contextTokens === 'number' && header.contextTokens > 0
    ? (header.contextTokens >= 1_000_000
      ? `${(header.contextTokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
      : `${Math.max(1, Math.round(header.contextTokens / 1000))}k`)
    : null;
  const phaseText = sendState?.phase === 'error'
    ? `failed: ${sendState.detail || 'send error'}`
    : sendState?.phase === 'cancelled'
      ? sendState.detail || 'Queued message cancelled'
    : pending
      ? sendState.detail || PHASE_TEXT[sendState.phase]
      // A finished resume used to clear the line to nothing, so the only
      // feedback for "Resume" was a flicker and then silence, which reads as a
      // dead button (Pat, 2026-07-25). A terminal phase that carries a detail
      // says what happened; index.jsx clears it after 2.5s.
      : sendState?.phase === 'sent' && sendState.detail
        ? sendState.detail
        : null;
  // The handoff chain reports through the same status slot; a live send phase
  // (which the chain's own sends produce) outranks the chain summary.
  const chainText = describeChain(handoffChain);
  const chainActive = handoffChain?.status === 'active';
  const handoffDisabledReason = !session ? 'No session selected'
    : (session.provider || 'claude') !== 'claude' ? 'Handoff is a Claude command'
      : !canType ? disabledReason
        : externalLive ? 'This session is running outside Harbor; send it a message to adopt it first'
          : chainActive ? 'A handoff chain is already running in this session'
            : header?.working ? 'Wait for the current turn to finish'
              : header?.blocked ? 'Answer the question in the window first'
                : null;
  const runHandoffChain = () => {
    if (handoffDisabledReason) return;
    setPlusMenuOpen(false);
    onHandoffChain?.();
  };
  const projectName = session?.project || '~';
  const provider = providerIdentity(session?.provider);
  const displayModel = header?.model || providerModel(session?.model, session?.modelLabel);
  const stateWord = !session ? null
    : readOnly ? 'worker · read-only'
      : externalLive ? 'in an outside terminal · send moves it here'
        : externallyControlled ? 'controlled elsewhere'
          : pane ? 'drivable here'
            : 'resumable';
  const stateTone = !session ? null
    : readOnly || externallyControlled ? 'muted'
      : externalLive || !pane ? 'warn'
        : 'ok';

  // ---- capability-menu derived state ----
  const curModelId = header?.model?.id ? stripBeta(header.model.id) : null;
  const curFamily = header?.model?.tone || null;
  // The session's own effort backs the header up, so a window with no
  // transcript yet still shows what it was launched with (the tile header has
  // always done this; the bar had not).
  const curEffort = header?.effort || session?.effort || null;
  const isCurModelId = (id) => curModelId && stripBeta(id) === curModelId;
  const isCurFamily = (fam) => curFamily && curFamily === fam;

  const allCommands = caps?.commands || [];
  const q = cmdSearch.trim().toLowerCase();
  const filteredCommands = q
    ? allCommands.filter((c) => c.name.toLowerCase().includes(q)
      || (c.description || '').toLowerCase().includes(q))
    : allCommands;
  const plusQ = plusCmdSearch.trim().toLowerCase();
  const plusFilteredCommands = plusQ
    ? allCommands.filter((c) => c.name.toLowerCase().includes(plusQ)
      || (c.description || '').toLowerCase().includes(plusQ))
    : allCommands;

  // Recognition runs over the WHOLE draft (see slash-tokens.cjs): the leading
  // token keeps command-intent semantics, a known command later in the text
  // (Pat's /quality-at-the-end pattern) recolors too, and only the token still
  // being typed at the end of the draft drives the popup.
  const knownCommandNames = useMemo(() => new Set(allCommands.map((c) => c.name)), [allCommands]);
  const draftSlashTokens = useMemo(() => parseSlashTokens(text), [text]);
  const activeSlash = useMemo(
    () => activeSlashToken(text, draftSlashTokens),
    [text, draftSlashTokens],
  );
  const chrome = useMemo(
    () => slashChrome(draftSlashTokens, knownCommandNames),
    [draftSlashTokens, knownCommandNames],
  );
  const slashMatches = useMemo(
    () => slashMatchesFor(activeSlash, allCommands),
    [activeSlash, allCommands],
  );
  const slashExact = Boolean(activeSlash) && knownCommandNames.has(activeSlash.token);
  // The command is "set" once it is fully recognized with no sibling left to
  // disambiguate; the popup closes (terminal / Claude Code behavior), leaving
  // the recolored, committed command in the input. Typing past the name (a
  // space) ends the active token, which closes the popup the same way.
  const slashSet = slashExact && slashMatches.length === 1;
  const slashOpen = Boolean(activeSlash && canType && !slashDismissed && slashMatches.length > 0 && !slashSet);
  const activeSlashKey = activeSlash ? `${activeSlash.start}:${activeSlash.token}` : null;

  useEffect(() => {
    setSlashHighlight(0);
    setSlashDismissed(false);
  }, [activeSlashKey]);

  useEffect(() => {
    // inputRef is the editor's imperative handle, not a DOM node, so the
    // element has to be asked for explicitly (live-caught 2026-07-26: calling
    // getBoundingClientRect straight on the handle threw inside the effect and
    // the slash popup simply never positioned, so it never appeared).
    const element = inputRef.current?.element;
    if (!slashOpen || !element) {
      setSlashPos(null);
      return;
    }
    const rect = element.getBoundingClientRect();
    setSlashPos({
      left: rect.left,
      bottom: window.innerHeight - rect.top + 6,
      width: Math.max(rect.width, 280),
    });
  }, [slashOpen, text]);

  const completeSlash = (commandName) => {
    if (!activeSlash) return;
    const before = text.slice(0, activeSlash.start);
    const rest = text.slice(activeSlash.start + activeSlash.token.length);
    const spacer = rest.startsWith(' ') ? '' : ' ';
    setText(`${before}${commandName}${spacer}${rest.trimStart()}`);
    setSlashDismissed(true);
    setSlashHighlight(0);
    inputRef.current?.focus();
  };

  return (
    <div className="ubar">
      <div className="ubar-row">
        <div className={`field${canType ? '' : ' off'}`}>
          <button
            ref={attachRef}
            type="button"
            className={`attach${plusMenuOpen ? ' open' : ''}`}
            title="Add files, folders, slash commands…"
            onClick={togglePlusMenu}
            disabled={!canType}
            aria-expanded={plusMenuOpen}
            aria-haspopup="menu"
          >
            ＋
          </button>
          <div className="compose-stack">
            {attachments.length ? (
              <div className="compose-attachments" aria-label="Pending attachments">
                {attachments.map((attachment, index) => (attachmentKind(attachment) === 'file' ? (
                  <div className="file-chip" key={`${attachment.path}-${index}`} title={attachment.path}>
                    <span className="file-chip-glyph" aria-hidden="true">▤</span>
                    <span className="file-chip-name">{attachment.basename || attachment.path}</span>
                    <button
                      type="button"
                      className="image-chip-remove file-chip-remove"
                      aria-label={`Remove file attachment ${attachment.basename || index + 1}`}
                      title="Remove file"
                      onClick={() => {
                        setAttachments((current) => removeAttachmentAt(current, index));
                        setAttachmentSendState(null);
                      }}
                    >
                      ×
                    </button>
                  </div>
                ) : (
                  <div className="image-chip" key={`${attachment.path}-${index}`}>
                    {/* The thumbnail is the button: a chip whose only control
                        was its '×' meant the sole thing a click could do was
                        delete the image. Nested buttons are invalid, so the
                        remove control stays a sibling on top rather than a
                        child of this one. */}
                    <button
                      type="button"
                      className="image-chip-open"
                      aria-label={`Preview image attachment ${index + 1}`}
                      title="Click to preview"
                      onClick={() => openAttachmentPreview(attachment)}
                    >
                      {attachment.thumbDataUri
                        ? <img src={attachment.thumbDataUri} alt="Pending attachment preview" />
                        : <span aria-hidden="true">▧</span>}
                    </button>
                    <button
                      type="button"
                      className="image-chip-remove"
                      aria-label={`Remove image attachment ${index + 1}`}
                      title="Remove image"
                      onClick={() => {
                        setAttachments((current) => removeAttachmentAt(current, index));
                        setAttachmentSendState(null);
                      }}
                    >
                      ×
                    </button>
                  </div>
                )))}
                {attachmentSendState ? (
                  <span className={`attachment-send-state ${attachmentSendState}`} role="status">
                    {attachmentSendState === 'sending' ? 'Sending attachments…' : 'Send failed · attachments kept for retry'}
                  </span>
                ) : null}
              </div>
            ) : null}
            <div className="compose-input-wrap">
              <div className={`ubar-input-stack${chrome.active ? (chrome.valid ? ' slash-valid' : ' slash-invalid') : ''}`}>
                <ComposeEditor
                  ref={inputRef}
                  value={text}
                  onChange={setText}
                  onSubmit={submit}
                  onPasteImage={paste}
                  disabled={!canType}
                  placeholder={placeholder}
                  ariaInvalid={chrome.active && !chrome.valid}
                  formatOpen={formatOpen}
                  knownCommandNames={knownCommandNames}
                  onKeyDown={(e) => {
                    // The slash popup gets first refusal on these keys; the
                    // editor checks defaultPrevented before doing anything of
                    // its own, so Enter still submits when no popup is open.
                    if (!slashOpen) return;
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setSlashHighlight((current) => (current + 1) % slashMatches.length);
                      return;
                    }
                    if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setSlashHighlight((current) => (current - 1 + slashMatches.length) % slashMatches.length);
                      return;
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      setSlashDismissed(true);
                      return;
                    }
                    if ((e.key === 'Tab' || e.key === 'Enter') && !e.shiftKey) {
                      e.preventDefault();
                      const pick = slashMatches[slashHighlight] || slashMatches[0];
                      if (pick) completeSlash(pick.name);
                    }
                  }}
                />
              </div>
              {/* The VALID/UNKNOWN pill used to sit here. Removed 2026-07-27 at
                  user request (its alignment was broken, and it was not needed
                  anyway): it was a third copy of a signal already carried by the
                  slash token's own colour (the CSS Custom Highlight, green for
                  known, red for unknown) and by the coloured inset line under
                  the input, and its own box was the misalignment, sitting flush
                  to the bottom of a flex-end row whose other controls all ride
                  9px up. The validity signal itself is untouched. */}
              <button
                type="button"
                className={`compose-format-toggle${formatOpen ? ' on' : ''}`}
                aria-label={formatOpen ? 'Hide formatting options' : 'Show formatting options'}
                aria-pressed={formatOpen}
                title="Format text (bold, lists, quotes, code)"
                onClick={toggleFormatBar}
                disabled={!canType}
              >
                {/* The Teams "Aa with a pen" mark: a formatting affordance
                    reads faster as letterforms than as an abstract glyph. */}
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 16L7 6l4 10" />
                  <path d="M4.2 13h5.6" />
                  <path d="M20 10.5a2.5 2.5 0 0 0-5 0V16" />
                  <path d="M15 13.2h5" />
                  <path d="M20 16v.01" />
                </svg>
              </button>
              <button
                type="button"
                className={`compose-mic ${voiceState.phase}`}
                aria-label={voiceState.phase === 'recording' ? 'Stop voice recording' : 'Record voice message'}
                title={voiceState.message || 'Record voice and insert transcription into the draft'}
                onClick={toggleVoiceRecording}
                /* A live recording stays stoppable even when the composer has
                   gone untypeable; only STARTING one needs canType. */
                disabled={(voiceState.phase !== 'recording' && !canType)
                  || ['requesting', 'transcribing'].includes(voiceState.phase)}
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="9" y="3" width="6" height="10" rx="3" />
                  <path d="M5 11a7 7 0 0 0 14 0" />
                  <line x1="12" y1="18" x2="12" y2="21" />
                  <line x1="8" y1="21" x2="16" y2="21" />
                </svg>
              </button>
              {/* LIVE voice mode, distinct from the mic beside it: the mic dictates
                  into this draft, this opens a spoken conversation with an agent
                  that can read and drive the open sessions. Two different things,
                  so two buttons (Pat asked for it next to the mic, 2026-07-27). */}
              {liveVoice ? (
                <button
                  type="button"
                  className={`compose-live-voice ${liveVoice.phase}${liveVoice.speaking ? ' speaking' : ''}`}
                  aria-label={liveVoice.phase === 'live' ? 'End live voice mode' : 'Start live voice mode'}
                  aria-pressed={liveVoice.phase === 'live'}
                  title={liveVoice.message
                    || (liveVoice.phase === 'live'
                      ? `Live voice on (${liveVoice.voice}). Click to end.`
                      : 'Live voice: talk to Harbor and drive your sessions')}
                  onClick={liveVoice.toggle}
                >
                  {/* Sound waves, so it never reads as a second dictation mic. */}
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
                    <line x1="4" y1="10" x2="4" y2="14" />
                    <line x1="8" y1="7" x2="8" y2="17" />
                    <line x1="12" y1="4" x2="12" y2="20" />
                    <line x1="16" y1="7" x2="16" y2="17" />
                    <line x1="20" y1="10" x2="20" y2="14" />
                  </svg>
                </button>
              ) : null}
            </div>
          </div>
          {dead && !nonClaudeDead && canType ? (
            <button
              type="button"
              className="resume-chip"
              onClick={onResume}
              disabled={pending}
              title={ctxPct != null && ctxPct >= 72
                ? `Context is at ${ctxPct}%: Claude will auto-compact when this resumes (short delay, summarized history)`
                : 'Resume without sending a message'}
            >
              {pending ? PHASE_TEXT[sendState.phase] || '…' : (ctxPct != null && ctxPct >= 72 ? 'Resume · will compact' : 'Resume')}
            </button>
          ) : null}
        </div>
        {session ? (
          <button
            ref={switchRef}
            type="button"
            className={`model model-chip mswitch tone-${displayModel?.tone || 'other'}`}
            onClick={() => onOpenConfig(insertDraft)}
            title="Model, effort, permissions, plugins, and slash commands for this session"
          >
            <img className="logomk" src={provider.logo} alt="" aria-hidden="true" />
            {displayModel?.name || provider.label}
            {curEffort ? <span className="eff">{EFFORT_LABEL[curEffort] || curEffort}</span> : null}
            {session.provider === 'claude' && session.home ? (
              <ProfileBadge profileId={session.home} profiles={profiles} className="model-acct" />
            ) : null}
            <span className="mswitch-caret" aria-hidden="true">▾</span>
          </button>
        ) : null}
        {/* Both buttons draw real icons rather than the bare glyphs they used to
            (↑ and ■). The send glyph inherited a near-black colour on a blue
            gradient, which is the "tacky" Pat flagged 2026-07-27; a white
            stroked mark reads as a button at 40px and matches the mic and format
            controls, which have been SVGs all along. */}
        {showStop ? (
          <button
            type="button"
            className="send stop"
            aria-label="Stop current turn"
            title="Stop current turn (Esc)"
            onClick={onInterrupt}
          >
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
              <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />
            </svg>
          </button>
        ) : (
          <button
            type="button"
            className="send"
            aria-label="Send"
            title="Send to the selected session (Enter)"
            onClick={submit}
            disabled={!canType}
          >
            <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="12" y1="19.5" x2="12" y2="5.5" />
              <polyline points="5.5,12 12,5.5 18.5,12" />
            </svg>
          </button>
        )}
      </div>
      <div className={`ubar-status${sendState?.phase === 'error' || handoffChain?.status === 'failed' ? ' err' : ''}${session ? '' : ' idle'}`}>
        {session ? (
          <>
            <span className="ustat-pj" title={projectName}>
              <ProjectIcon label={session.project} iconClass="pj-icon" dotClass="pjdot" />
              <span className="ustat-pj-name">{projectName}</span>
            </span>
            <span className="ustat-sep" aria-hidden="true">·</span>
            <span
              className={`ustat-ctx${ctxWarn ? ' warn' : ''}`}
              title={ctxPct != null
                ? `${ctxPct}% of context used`
                : ctxTokens != null
                  ? 'Tokens in context; window size not yet reported by Claude'
                  : 'Context usage unavailable'}
            >
              <span className="ustat-lbl">ctx</span>
              <span className="ustat-val">{ctxPct != null ? `${ctxPct}%` : ctxTokens != null ? ctxTokens : '--'}</span>
              {stateTone ? (
                <span
                  className={`ustat-dot ${stateTone}`}
                  title={stateWord}
                  aria-label={stateWord}
                  role="img"
                />
              ) : null}
            </span>
            <span className="ustat-sep" aria-hidden="true">·</span>
            <span className="ustat-title" title={displayTitle}>{displayTitle}</span>
            <span className="ustat-sep" aria-hidden="true">·</span>
            <span className={`ustat-phase${phaseText || chainText ? '' : ' empty'}`} title={phaseText || chainText || undefined}>
              {phaseText || chainText ||' '}
            </span>
            {queuedItem ? (
              <span className="queued-mini" title={queuedItem.textPreview}>
                queued
                <button
                  type="button"
                  aria-label={`Cancel queued message: ${queuedItem.textPreview}`}
                  title="Unsend queued message"
                  onClick={() => onCancelQueued(queuedItem.id)}
                >
                  ×
                </button>
              </span>
            ) : null}
          </>
        ) : (
          <span className="ustat-title">Select a session</span>
        )}
      </div>
      {liveVoice && (liveVoice.phase !== 'idle' || liveVoice.activity.length > 0) ? (
        <div className={`live-voice-bar ${liveVoice.phase}`} role="status">
          <span className="live-voice-dot" aria-hidden="true" />
          <span className="live-voice-label">
            {liveVoice.phase === 'connecting' ? 'connecting voice…'
              : liveVoice.phase === 'error' ? (liveVoice.message || 'voice failed')
                : liveVoice.phase === 'live' ? `live · ${liveVoice.voice}` : 'voice ended'}
          </span>
          {/* What the agent HEARD and DID. A spoken action must never be
              invisible: this is where a mis-hear becomes obvious. */}
          {liveVoice.activity.slice(-3).map((item) => (
            <span key={item.at} className={`live-voice-act ${item.kind}`}>
              <b>{item.kind === 'you' ? 'you' : item.kind === 'voice' ? 'harbor' : item.kind}</b>
              {item.text.slice(0, 120)}
            </span>
          ))}
        </div>
      ) : null}
      {voiceState.message ? (
        <div className={`voice-status ${voiceState.phase}`} role="status" aria-live="polite">
          {voiceState.message}
        </div>
      ) : null}
      {slashOpen && slashPos ? createPortal(
        <div
          className="slash-ac"
          style={{ left: slashPos.left, bottom: slashPos.bottom, width: slashPos.width }}
          role="listbox"
          aria-label="Slash command suggestions"
        >
          {slashMatches.map((command, index) => (
            <button
              key={`${command.source}:${command.name}`}
              type="button"
              role="option"
              aria-selected={index === slashHighlight}
              className={`slash-ac-row${index === slashHighlight ? ' active' : ''}`}
              title={command.description || command.name}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => completeSlash(command.name)}
            >
              <span className="slash-ac-name">{command.name}</span>
              <span className="slash-ac-src">{SOURCE_LABEL[command.source] || command.source}</span>
              {command.description ? <span className="slash-ac-desc">{command.description}</span> : null}
            </button>
          ))}
        </div>,
        document.body,
      ) : null}
      {plusMenuOpen ? createPortal(
        <>
          <button type="button" className="menu-backdrop" aria-label="Close add menu" onClick={() => setPlusMenuOpen(false)} />
          <div
            className="plus-menu cap-menu"
            style={plusMenuPos ? { bottom: plusMenuPos.bottom, left: plusMenuPos.left } : undefined}
            role="menu"
            aria-label="Add to message"
          >
            {capsError ? (
              <div className="cap-empty">could not read capabilities: {capsError}</div>
            ) : !caps ? (
              <div className="cap-empty">reading capabilities…</div>
            ) : (
              <>
                {liveVoice ? (
                  <div className="cap-sec">
                    <div className="cap-sec-h">Live voice</div>
                    {/* The picker exists because the whole point of the feature was
                        that Pat disliked the voices he was offered elsewhere. The
                        list is the REALTIME set; a voice cannot change mid-call
                        once audio has been emitted, so a change made while live
                        says it applies to the next one rather than silently not
                        taking. */}
                    <div className="voice-pick">
                      {(liveVoice.voices || []).map((name) => (
                        <button
                          key={name}
                          type="button"
                          role="menuitemradio"
                          aria-checked={liveVoice.voice === name}
                          className={`voice-chip${liveVoice.voice === name ? ' on' : ''}`}
                          title={liveVoice.phase === 'live'
                            ? `${name}: applies the next time you start live voice`
                            : `Use the ${name} voice`}
                          onClick={() => liveVoice.chooseVoice(name)}
                        >
                          {name}
                        </button>
                      ))}
                    </div>
                    <div className="voice-pick-note">
                      {liveVoice.phase === 'live'
                        ? 'A new voice applies the next time you start live voice.'
                        : 'Talk to Harbor and drive your sessions by voice.'}
                    </div>
                  </div>
                ) : null}
                {workflows.length ? (
                  <div className="cap-sec">
                    <div className="cap-sec-h">Workflows</div>
                    {workflows.map(({ id, label }) => (
                      <button key={id} type="button" className="plus-action" role="menuitem" onClick={() => launchWorkflow(id)}>
                        <IconWorkflow />
                        <span>{label}</span>
                      </button>
                    ))}
                  </div>
                ) : null}

                <div className="cap-sec">
                  <button type="button" className="plus-action" role="menuitem" onClick={toggleVoiceRecording}>
                    <IconMic />
                    <span>{voiceState.phase === 'recording' ? 'Stop voice recording' : 'Record voice to draft'}</span>
                  </button>
                  <button type="button" className="plus-action" role="menuitem" onClick={attach}>
                    <IconAttach />
                    <span>Add files or photos</span>
                  </button>
                  <button type="button" className="plus-action" role="menuitem" onClick={attachFolder}>
                    <IconFolder />
                    <span>Add folder</span>
                  </button>
                  <button
                    type="button"
                    className="plus-action"
                    role="menuitem"
                    disabled={Boolean(handoffDisabledReason)}
                    title={handoffDisabledReason || 'Runs /handoff, then /compact, then /pickup in this session'}
                    onClick={runHandoffChain}
                  >
                    <IconHandoff />
                    <span>{chainActive ? 'Handoff chain running…' : 'Handoff and compact'}</span>
                  </button>
                </div>

                <div className={`plus-sec${plusExpanded.slash ? ' open' : ''}`}>
                  <button
                    type="button"
                    className="plus-sec-toggle"
                    aria-expanded={plusExpanded.slash}
                    onClick={() => togglePlusSection('slash')}
                  >
                    <span className="plus-sec-caret" aria-hidden="true">{plusExpanded.slash ? '▾' : '▸'}</span>
                    <span className="plus-sec-label">Slash commands</span>
                    <span className="cap-sec-count">{plusFilteredCommands.length}/{allCommands.length}</span>
                  </button>
                  {plusExpanded.slash ? (
                    <>
                      <input
                        type="text"
                        className="cap-search"
                        placeholder="Search commands, skills…"
                        value={plusCmdSearch}
                        onChange={(e) => setPlusCmdSearch(e.target.value)}
                        aria-label="Search slash commands"
                      />
                      <div className="cap-cmds">
                        {plusFilteredCommands.map((c) => (
                          <button
                            key={`plus:${c.source}:${c.name}`}
                            type="button"
                            role="menuitem"
                            className="cap-cmd"
                            title={c.description || c.name}
                            onClick={() => insertDraft(`${c.name} `)}
                          >
                            <span className="cap-cmd-name">{c.name}</span>
                            <span className="cap-cmd-src">{SOURCE_LABEL[c.source] || c.source}</span>
                            {c.description ? <span className="cap-cmd-desc">{c.description}</span> : null}
                          </button>
                        ))}
                        {plusFilteredCommands.length === 0 ? <div className="cap-note">no match</div> : null}
                      </div>
                    </>
                  ) : null}
                </div>

                <div className={`plus-sec${plusExpanded.connectors ? ' open' : ''}`}>
                  <button
                    type="button"
                    className="plus-sec-toggle"
                    aria-expanded={plusExpanded.connectors}
                    onClick={() => togglePlusSection('connectors')}
                  >
                    <span className="plus-sec-caret" aria-hidden="true">{plusExpanded.connectors ? '▾' : '▸'}</span>
                    <span className="plus-sec-label">Connectors</span>
                  </button>
                  {plusExpanded.connectors ? (
                    caps.mcpServers.length ? (
                      <div className="cap-mcp">
                        <span className="cap-mcp-lbl">MCP</span>
                        <span className="cap-mcp-names">{caps.mcpServers.join(', ')}</span>
                      </div>
                    ) : <div className="cap-note">no connectors</div>
                  ) : null}
                </div>

                <div className={`plus-sec${plusExpanded.plugins ? ' open' : ''}`}>
                  <button
                    type="button"
                    className="plus-sec-toggle"
                    aria-expanded={plusExpanded.plugins}
                    onClick={() => togglePlusSection('plugins')}
                  >
                    <span className="plus-sec-caret" aria-hidden="true">{plusExpanded.plugins ? '▾' : '▸'}</span>
                    <span className="plus-sec-label">Plugins</span>
                  </button>
                  {plusExpanded.plugins ? (
                    caps.plugins.length ? (
                      <div className="cap-plugins">
                        {caps.plugins.map((p) => (
                          <div key={`plus:${p.name}@${p.marketplace}`} className={`cap-plugin${p.enabled ? '' : ' off'}`} title={`${p.name}@${p.marketplace}${p.version ? ` (${p.version})` : ''}`}>
                            <span className="cap-plugin-dot" aria-hidden="true" />
                            <span className="cap-plugin-name">{p.name}</span>
                            <span className="cap-plugin-state">{p.enabled ? 'on' : 'off'}</span>
                          </div>
                        ))}
                      </div>
                    ) : <div className="cap-note">no plugins installed</div>
                  ) : null}
                </div>
              </>
            )}
          </div>
        </>,
        document.body,
      ) : null}
      {menuOpen ? createPortal(
        <>
          <button type="button" className="menu-backdrop" aria-label="Close capability menu" onClick={() => setMenuOpen(false)} />
          <div className="cap-menu" style={menuPos ? { bottom: menuPos.bottom, right: menuPos.right } : undefined} role="menu" aria-label="Session capabilities">
            {capsError ? (
              <div className="cap-empty">could not read capabilities: {capsError}</div>
            ) : !caps ? (
              <div className="cap-empty">reading capabilities…</div>
            ) : (
              <>
                {!drivable ? (
                  <div className="cap-banner" role="note">
                    <span>
                      {nonClaudeDead ? 'This session is not running; its transcript is read-only.'
                        : dead ? 'Not under Harbor control. Resume to change settings; the lists below are live.'
                          : externalLive ? 'Open in an outside terminal. Sending a message moves it into Harbor first.'
                            : readOnly ? 'Orchestration workers are read-only.'
                              : 'Another client controls this terminal.'}
                    </span>
                    {dead && !nonClaudeDead ? (
                      <button type="button" className="cap-banner-resume" onClick={() => { setMenuOpen(false); onResume(); }}>
                        Resume
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {/* ── (1) MODELS ── */}
                <div className="cap-sec">
                  <div className="cap-sec-h">Model</div>
                  {caps.models.cached.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      role="menuitem"
                      className={`cap-row${isCurModelId(m.id) ? ' current' : ''}`}
                      title={m.description || m.id}
                      onClick={() => runSwitch(onModelSwitch, m.id)}                      disabled={!drivable}
                    >
                      <span className="cap-row-lbl">{m.label}</span>
                      <span className="cap-row-tag">cached</span>
                    </button>
                  ))}
                  {caps.models.families.map((m) => (
                    <button
                      key={m.alias}
                      type="button"
                      role="menuitem"
                      className={`cap-row${isCurFamily(m.family) ? ' current' : ''}`}
                      onClick={() => runSwitch(onModelSwitch, m.alias)}                      disabled={!drivable}
                    >
                      <span className="cap-row-lbl">{m.label}</span>
                      <span className="cap-row-sub">{m.alias}</span>
                    </button>
                  ))}
                  <button type="button" className="cap-more" onClick={() => setShowVersions((v) => !v)}>
                    {showVersions ? 'Hide versions ▴' : 'All versions ▾'}
                  </button>
                  {showVersions ? caps.models.versions.map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      role="menuitem"
                      className={`cap-row sub${isCurModelId(v.id) ? ' current' : ''}`}
                      onClick={() => runSwitch(onModelSwitch, v.id)}                      disabled={!drivable}
                    >
                      <span className="cap-row-lbl">{v.label}</span>
                      <span className="cap-row-sub">{v.id}</span>
                    </button>
                  )) : null}
                </div>

                {/* ── (2) EFFORT ── */}
                <div className="cap-sec">
                  <div className="cap-sec-h">Effort</div>
                  <div className="cap-effort">
                    {caps.effort.levels.map((lvl) => (
                      <button
                        key={lvl}
                        type="button"
                        role="menuitem"
                        className={`cap-eff${curEffort === lvl ? ' current' : ''}`}
                        onClick={() => runSwitch(onEffortSwitch, lvl)}                      disabled={!drivable}
                      >
                        {lvl}
                      </button>
                    ))}
                  </div>
                  <div className="cap-note">{caps.effort.note}</div>
                </div>

                {/* ── (3) PERMISSION MODE ── */}
                <div className="cap-sec">
                  <div className="cap-sec-h">Permission mode</div>
                  <div className="cap-status">
                    <span className="cap-status-lbl">current</span>
                    <span className="cap-status-val">
                      {permMode === undefined ? 'reading…'
                        : permMode === null ? (pane ? 'unreadable' : 'not controlled')
                          : (MODE_LABEL[permMode] || permMode)}
                    </span>
                  </div>
                  <button type="button" className="cap-action" onClick={cycleMode} disabled={!pane?.paneId || cycling}>
                    {cycling ? 'cycling…' : 'Cycle mode (⇧Tab)'}
                  </button>
                </div>

                {/* ── (4) FAST MODE ── */}
                <div className="cap-sec">
                  <div className="cap-sec-h">Fast mode</div>
                  {caps.fastMode.available ? (
                    <button type="button" className="cap-action" onClick={() => insertDraft('/fast ')}>
                      Insert /fast
                    </button>
                  ) : (
                    <div className="cap-row disabled" aria-disabled="true">
                      <span className="cap-row-lbl">Unavailable</span>
                      <span className="cap-row-reason">{caps.fastMode.reason}</span>
                    </div>
                  )}
                </div>

                {/* ── (5) DYNAMIC WORKFLOW ── */}
                <div className="cap-sec">
                  <div className="cap-sec-h">Workflow</div>
                  <button type="button" className="cap-action" onClick={() => insertDraft(`${caps.dynamicWorkflow.keyword} `)}>
                    Insert “{caps.dynamicWorkflow.keyword}” keyword
                  </button>
                  <div className="cap-note">{caps.dynamicWorkflow.note}</div>
                </div>

                {/* ── (6) PLUGINS & CONNECTORS (read-only) ── */}
                <div className="cap-sec">
                  <div className="cap-sec-h">Plugins &amp; connectors</div>
                  {caps.plugins.length ? (
                    <div className="cap-plugins">
                      {caps.plugins.map((p) => (
                        <div key={`${p.name}@${p.marketplace}`} className={`cap-plugin${p.enabled ? '' : ' off'}`} title={`${p.name}@${p.marketplace}${p.version ? ` (${p.version})` : ''}`}>
                          <span className="cap-plugin-dot" aria-hidden="true" />
                          <span className="cap-plugin-name">{p.name}</span>
                          <span className="cap-plugin-state">{p.enabled ? 'on' : 'off'}</span>
                        </div>
                      ))}
                    </div>
                  ) : <div className="cap-note">no plugins installed</div>}
                  {caps.mcpServers.length ? (
                    <div className="cap-mcp">
                      <span className="cap-mcp-lbl">MCP</span>
                      <span className="cap-mcp-names">{caps.mcpServers.join(', ')}</span>
                    </div>
                  ) : null}
                </div>

                {/* ── (7) SLASH COMMANDS (searchable, insert-not-send) ── */}
                <div className="cap-sec">
                  <div className="cap-sec-h">
                    Slash commands
                    <span className="cap-sec-count">{filteredCommands.length}/{allCommands.length}</span>
                  </div>
                  <input
                    type="text"
                    className="cap-search"
                    placeholder="Search commands, skills…"
                    value={cmdSearch}
                    onChange={(e) => setCmdSearch(e.target.value)}
                    aria-label="Search slash commands"
                  />
                  <div className="cap-cmds">
                    {filteredCommands.map((c) => (
                      <button
                        key={`${c.source}:${c.name}`}
                        type="button"
                        role="menuitem"
                        className="cap-cmd"
                        title={c.description || c.name}
                        onClick={() => insertDraft(`${c.name} `)}
                      >
                        <span className="cap-cmd-name">{c.name}</span>
                        <span className="cap-cmd-src">{SOURCE_LABEL[c.source] || c.source}</span>
                        {c.description ? <span className="cap-cmd-desc">{c.description}</span> : null}
                      </button>
                    ))}
                    {filteredCommands.length === 0 ? <div className="cap-note">no match</div> : null}
                  </div>
                </div>
              </>
            )}
          </div>
        </>,
        document.body,
      ) : null}
      {preview ? (
        <ImagePreview src={preview.src} name={preview.name} onClose={() => setPreview(null)} />
      ) : null}
    </div>
  );
}
