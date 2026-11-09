import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useRpc } from '../rpc/rpc-context.jsx';
import { useSend } from './use-send.js';
import { AttachChips } from '../attach/AttachChips.jsx';
import { useAttachments } from '../attach/use-attachments.js';
import { useCapabilities } from '../capability/use-capabilities.js';
import { FormatToolbar } from './FormatToolbar.jsx';
import { useVoiceDraft } from '../voice/use-voice-draft.js';
import { LiveVoiceBar } from '../voice/LiveVoiceBar.jsx';
import { SlashPalette, useSlashState } from '../slash/SlashPalette.jsx';
import { useComposerLiveVoice } from './use-composer-live-voice.js';
import { composerActions, hasDraft } from './composer-actions.cjs';
import { readPlain, setSelectionOffsets, writePlain } from './plain-text.cjs';
import './composer.css';
import { replyStore, useQuestionReply } from '../../../src/renderer/stage/use-question-reply.js';
import '../slash/slash.css';
import '../voice/voice.css';

// A draft outlives the screen (2026-10-21). iOS ends a backgrounded web app
// whenever it likes, and a reconnect or a session switch remounts this
// component, so a message typed on a bad connection was simply gone. One draft
// per session, cleared when it is sent.
const draftKey = (id) => `harbor-draft:${id}`;
function readDraft(id) {
  if (!id) return '';
  try { return localStorage.getItem(draftKey(id)) || ''; } catch { return ''; }
}
function writeDraft(id, text) {
  if (!id) return;
  try {
    if (text) localStorage.setItem(draftKey(id), text);
    else localStorage.removeItem(draftKey(id));
  } catch { /* storage full or blocked: the draft lives only in memory */ }
}

function insertSlashCommand(text, active, command) {
  if (!active || !command?.name) return text;
  const before = text.slice(0, active.start);
  const after = text.slice(active.start + active.token.length);
  return `${before}${command.name}${after}`;
}

export function Composer({
  sessionId,
  paneId,
  disabled,
  working = false,
  onSent,
  // While the link is down the box stays open for typing (Pat typed a whole
  // message during the 2026-10-21 outage); only the send waits, and says so.
  offline = false,
}) {
  const questionReply = useQuestionReply(sessionId);
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;
  const [text, setText] = useState(() => readDraft(sessionId));
  const draftSession = useRef(sessionId);
  useEffect(() => {
    // A different session in the same mount starts from that session's draft.
    if (draftSession.current !== sessionId) {
      draftSession.current = sessionId;
      setText(readDraft(sessionId));
      return;
    }
    writeDraft(sessionId, text);
  }, [sessionId, text]);
  const [focused, setFocused] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [formatOpen, setFormatOpen] = useState(() => {
    try { return localStorage.getItem('harbor-compose-format') === '1'; } catch { return false; }
  });
  const [slashHighlight, setSlashHighlight] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  // The message box is a plain-text editable element, not a textarea: Safari's
  // AutoFill offers contact details only in input/textarea/select (plain-text.cjs).
  const boxRef = useRef(null);
  // Where the caret goes after code (not typing) changes the draft.
  const pendingCaret = useRef(null);
  useEffect(() => { const focus = () => boxRef.current?.focus(); window.addEventListener('harbor-focus-composer',focus); return () => window.removeEventListener('harbor-focus-composer',focus); }, []);
  const client = useRpc();
  const { capabilities, error: capsError } = useCapabilities(
    client,
    sessionId ? { id: sessionId, paneId } : null,
  );
  const { addFiles, attachments, clearPaths, error: attachmentError, remove, uploading } = useAttachments();
  const { cancel, interrupt, queue, send, sending, status } = useSend({
    sessionId,
    paneId,
    onSent,
  });

  const commands = capabilities?.commands || [];
  const slash = useSlashState(text, commands);
  const slashOpen = slash.open && !slashDismissed;

  const onTranscribed = useCallback((append, transcription) => {
    pendingCaret.current = { start: Infinity };
    setText((prev) => append(prev, transcription));
    boxRef.current?.focus();
  }, []);

  const { voiceState, toggle: toggleVoice } = useVoiceDraft({
    disabled,
    onTranscribed: (append, transcription) => onTranscribed(append, transcription),
  });
  const liveVoice = useComposerLiveVoice();

  // The box shows the draft. Typing flows the other way (onInput reads the box),
  // so this writes only when the draft changed somewhere else: a saved draft, a
  // session switch, a slash pick, a format button, voice, a send clearing it.
  // Writing while the box already matches would move the caret and break iOS
  // text composition (autocorrect, dictation, CJK input) mid-word.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    if (readPlain(box) !== text) writePlain(box, text);
    const caret = pendingCaret.current;
    if (caret) {
      pendingCaret.current = null;
      setSelectionOffsets(box, caret.start, caret.end ?? caret.start);
    }
  }, [text, sessionId]);

  // Budget against the visible viewport, including tools and attachments.
  useLayoutEffect(() => {
    const node = boxRef.current;
    if (!node) return undefined;
    const composer = node.closest('.composer');
    const resize = () => {
      const viewport = window.visualViewport?.height || window.innerHeight;
      const style = getComputedStyle(composer);
      const extras = composer.querySelector('.composer-extras').scrollHeight
        + (composer.querySelector('.composer-tools')?.offsetHeight || 0);
      const chrome = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + 1;
      // The card around the text box (border, attachment chips, the toolbar) is
      // part of the budget too; the box's own height cancels out, so the answer
      // does not depend on what was typed. The box grows with its text up to the
      // cap and scrolls inside itself past it.
      const card = composer.querySelector('.composer-card');
      const cardChrome = Math.max(0, (card?.offsetHeight || 0) - (node.offsetHeight || 0));
      const cap = Math.max(44, Math.min(150, viewport * .4 - extras - chrome - cardChrome));
      node.style.maxHeight = cap + 'px';
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(composer.querySelector('.composer-extras'));
    // The box's own width can change under a draft (a turn starting or ending, a
    // rotation, a different card), and what wraps changes with it: remeasure, so
    // a multi-line draft never clips its last line. Width only, so the height the
    // measure itself sets does not loop back.
    let lastWidth = node.offsetWidth;
    const widthObserver = new ResizeObserver(() => {
      if (node.offsetWidth === lastWidth) return;
      lastWidth = node.offsetWidth;
      resize();
    });
    widthObserver.observe(node);
    window.visualViewport?.addEventListener('resize', resize);
    window.addEventListener('resize', resize);
    return () => { observer.disconnect(); widthObserver.disconnect(); window.visualViewport?.removeEventListener('resize', resize); window.removeEventListener('resize', resize); };
  }, [text, formatOpen, toolsOpen, attachments, sessionId, working]);

  useEffect(() => {
    setSlashDismissed(false);
    setSlashHighlight(0);
  }, [sessionId]);

  // The toolbar's right end (composer-actions.cjs): [Send] while idle, [Stop]
  // [Send] while a turn runs. Send never moves; Send is muted without a draft.
  const actions = composerActions({
    canStop: Boolean(paneId && working),
    hasDraft: hasDraft(text, attachments.length),
  });

  if (!sessionId) return null;

  const submit = async () => {
    if (disabled || offline || sending || uploading || !actions.sendReady) return;
    const images = attachments.map((attachment) => attachment.path);
    const sentSessionId = sessionId;
    const sentText = text;
    const result = await send(text, images);
    if (currentSession.current !== sentSessionId) return;
    if (result.ok) {
      // Clear only what was sent: anything typed while the send was in flight
      // is a new draft, and wiping it (and its saved copy) lost words that
      // were never sent (2026-10-21, second review).
      setText((current) => (current === sentText ? '' : current));
      clearPaths(images);
      setSlashDismissed(false);
    }
  };

  // A tap on the composer's own buttons leaves focus in the text box: moving it
  // to the button ended typing mode mid-tap, the tabs came back, the layout
  // jumped 90px and the first tap on Send was lost (2026-10-21, second review).
  // It also keeps the keyboard up for the next message.
  const keepFocus = (event) => {
    if (document.activeElement === boxRef.current) event.preventDefault();
  };

  const pickSlash = (command) => {
    if (slash.active && command?.name) {
      const at = slash.active.start + command.name.length;
      pendingCaret.current = { start: at };
    }
    setText((prev) => insertSlashCommand(prev, slash.active, command));
    setSlashDismissed(false);
    setSlashHighlight(0);
    boxRef.current?.focus();
  };

  const toggleFormat = () => {
    setFormatOpen((open) => {
      const next = !open;
      try { localStorage.setItem('harbor-compose-format', next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
    boxRef.current?.focus();
  };

  const placeholder = questionReply ? "Reply to Claude's questions" : 'Message this session';

  // Slash validity colours the card's border (it was an inset bar down the text
  // box's left edge, which a rounded card cannot hold cleanly).
  const cardClass = [
    'composer-card',
    slash.chrome.active ? (slash.chrome.valid ? 'slash-valid' : 'slash-invalid') : '',
  ].filter(Boolean).join(' ');

  return (
    <section
      className={`composer${focused ? ' is-focused' : ''}`}
      data-pane={paneId || ''}
    >
      <div className="composer-extras">
      {questionReply ? <div className="question-reply-banner" role="status"><span>Replying to Claude&apos;s questions</span><button type="button" onClick={() => replyStore.cancel(sessionId)}>Cancel reply</button></div> : null}
      {queue.count > 0 ? (
        <div className="composer-queue" aria-live="polite">
          {queue.items.map((item) => (
            <div className="composer-queue-item" key={item.id}>
              <span>{item.status}: {item.textPreview}</span>
              {item.status === 'queued' ? (
                <button type="button" onClick={() => cancel(item.id)}>Cancel queued</button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {status?.detail ? (
        <p className={`composer-status ${status.phase === 'error' ? 'error' : ''}`} role={status.phase === 'error' ? 'alert' : 'status'}>
          {status.detail}
        </p>
      ) : null}
      {offline && (text.trim() || attachments.length) ? (
        <p className="composer-status waiting" role="status">Waiting for the connection. Your message stays here; send it once Harbor is back.</p>
      ) : null}
      {attachmentError ? <p className="composer-status error" role="alert">{attachmentError}</p> : null}
      {capsError && !offline ? <p className="composer-status error" role="alert">{capsError}</p> : null}
      {voiceState.message ? (
        <p className={`voice-status ${voiceState.phase === 'error' ? 'error' : ''}`} role="status">{voiceState.message}</p>
      ) : null}
      <LiveVoiceBar liveVoice={liveVoice} />
      {formatOpen ? (
        <FormatToolbar
          editorRef={boxRef}
          text={text}
          onChange={setText}
          disabled={disabled}
        />
      ) : null}
      </div>
      {/* Secondary tools share the tray so the typing row stays spacious. The
          tray sits OUTSIDE the scrolling extras (2026-10-06): with the keyboard
          up the composer gets 40% of what is visible, an attachment chip plus
          Stop filled that, and the tray scrolled out of sight while the plus
          still read as open, so Pat had no way back to the paperclip. Picking a
          file closes the tray, so the attachment's own x is the only x. */}
      {toolsOpen ? (
        <div className="composer-tools" role="group" aria-label="Composer tools">
        <label className="composer-attach" aria-label="Attach images">
          <input
            type="file"
            accept="image/*"
            multiple
            disabled={disabled || uploading}
            onChange={(event) => {
              addFiles(event.target.files);
              event.target.value = '';
              setToolsOpen(false);
            }}
          />
          <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
            {/* A document with a plus, never a paperclip (Pat's standing rule for every attach button). */}
            <path d="M6 2.6h5.3l4.2 4.2V16a1.4 1.4 0 0 1-1.4 1.4H6A1.4 1.4 0 0 1 4.6 16V4A1.4 1.4 0 0 1 6 2.6Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
            <path d="M11 2.8v4.2h4.2M10 10.4v4.4M7.8 12.6h4.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </label>
        <button
          type="button"
          className={`composer-format-toggle${formatOpen ? ' on' : ''}`}
          aria-label={formatOpen ? 'Hide formatting options' : 'Show formatting options'}
          aria-pressed={formatOpen}
          disabled={disabled}
          onClick={toggleFormat}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M3 16L7 6l4 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M4.2 13h5.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M20 10.5a2.5 2.5 0 0 0-5 0V16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M15 13.2h5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M20 16v.01" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
        <button
          type="button"
          className={`composer-mic ${voiceState.phase}`}
          aria-label={voiceState.phase === 'recording' ? 'Stop voice recording' : 'Record voice message'}
          disabled={disabled || ['requesting', 'transcribing'].includes(voiceState.phase)}
          onClick={toggleVoice}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="9" y="3" width="6" height="10" rx="3" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="M5 11a7 7 0 0 0 14 0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /><line x1="12" y1="18" x2="12" y2="21" stroke="currentColor" strokeWidth="1.8" /></svg>
        </button>
        {liveVoice ? <button type="button" className={`composer-live-voice ${liveVoice.phase}${liveVoice.speaking ? ' speaking' : ''}`} aria-label={liveVoice.phase === 'live' ? 'End live voice mode' : 'Start live voice mode'} aria-pressed={liveVoice.phase === 'live'} onClick={liveVoice.toggle}><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><line x1="4" y1="10" x2="4" y2="14" stroke="currentColor" strokeWidth="1.9" /><line x1="8" y1="7" x2="8" y2="17" stroke="currentColor" strokeWidth="1.9" /><line x1="12" y1="4" x2="12" y2="20" stroke="currentColor" strokeWidth="1.9" /><line x1="16" y1="7" x2="16" y2="17" stroke="currentColor" strokeWidth="1.9" /><line x1="20" y1="10" x2="20" y2="14" stroke="currentColor" strokeWidth="1.9" /></svg></button> : null}
        </div>
      ) : null}
      {/* ONE CARD holds the whole composer (2026-10-31): attachment chips on top,
          the text box at the card's full width, a toolbar along the bottom edge
          with the tools toggle on the left and Stop / Send on the right. */}
      <div className={cardClass}>
        {attachments.length ? (
          <div className="composer-strip">
            <AttachChips attachments={attachments} onRemove={remove} />
          </div>
        ) : null}
        <div className="composer-field">
          {/* A plain-text editable box, not a textarea (2026-11-01): Safari raised
              "AutoFill Contact" and offered home and work addresses on a textarea
              whatever its autoComplete, label or name said, and its AutoFill does
              not look at editable elements at all. plain-text.cjs is its text model. */}
          <div
            ref={boxRef}
            className="composer-input"
            contentEditable={disabled ? 'false' : 'plaintext-only'}
            role="textbox"
            aria-multiline="true"
            aria-label="Message"
            aria-disabled={disabled ? 'true' : undefined}
            aria-placeholder={placeholder}
            data-placeholder={placeholder}
            data-empty={text ? undefined : ''}
            spellCheck
            autoCorrect="on"
            autoCapitalize="sentences"
            inputMode="text"
            onInput={(event) => {
              // Typing owns the caret: a pick that left the draft unchanged must
              // not move it on the next keystroke.
              pendingCaret.current = null;
              setText(readPlain(event.currentTarget));
              setSlashDismissed(false);
            }}
            onFocus={() => setFocused(true)}
            onBlur={(event) => {
              if (!event.currentTarget.closest('.composer')?.contains(event.relatedTarget)) setFocused(false);
            }}
            onKeyDown={(event) => {
              if (!slashOpen) return;
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setSlashHighlight((current) => (current + 1) % slash.matches.length);
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setSlashHighlight((current) => (current - 1 + slash.matches.length) % slash.matches.length);
              } else if (event.key === 'Enter' && !event.shiftKey) {
                const pick = slash.matches[slashHighlight] || slash.matches[0];
                if (pick) {
                  event.preventDefault();
                  pickSlash(pick);
                }
              } else if (event.key === 'Escape') {
                event.preventDefault();
                setSlashDismissed(true);
              }
            }}
          />
        </div>
        <div className="composer-bar">
          <button
            type="button"
            className={`composer-plus${toolsOpen ? ' on' : ''}`}
            onPointerDown={keepFocus}
            aria-label={toolsOpen ? 'Hide composer tools' : 'Show composer tools'}
            aria-expanded={toolsOpen}
            onClick={() => setToolsOpen((v) => !v)}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
              <path d="M10 4.4v11.2M4.4 10h11.2" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
            </svg>
          </button>
          <div className="composer-actions">
            {actions.stop ? (
              <button
                type="button"
                className="composer-stop"
                onPointerDown={keepFocus}
                onClick={interrupt}
                aria-label="Stop"
                title="Stop this turn"
              >
                <span className="composer-stop-glyph" aria-hidden="true" />
              </button>
            ) : null}
            <button
              type="button"
              className="composer-send"
              onPointerDown={keepFocus}
              disabled={disabled || offline || sending || uploading || !actions.sendReady}
              onClick={submit}
              aria-label={sending ? 'Sending' : questionReply ? "Reply to Claude's questions" : 'Send'}
              title={questionReply ? "Reply to Claude's questions" : 'Send to this session'}
            >
              {sending ? (
                <span className="composer-send-spinner" aria-hidden="true" />
              ) : (
                <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                  <path
                    d="M10 16V4.8M10 4.4 5.2 9.2M10 4.4 14.8 9.2"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
      <SlashPalette
        open={slashOpen}
        matches={slash.matches}
        highlight={slashHighlight}
        onHighlight={setSlashHighlight}
        onPick={pickSlash}
        onDismiss={() => setSlashDismissed(true)}
      />
    </section>
  );
}
