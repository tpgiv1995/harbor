import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import './composer.css';
import '../slash/slash.css';
import '../voice/voice.css';

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
}) {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [formatOpen, setFormatOpen] = useState(() => {
    try { return localStorage.getItem('harbor-compose-format') === '1'; } catch { return false; }
  });
  const [slashHighlight, setSlashHighlight] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const textareaRef = useRef(null);
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
    setText((prev) => append(prev, transcription));
    textareaRef.current?.focus();
  }, []);

  const { voiceState, toggle: toggleVoice } = useVoiceDraft({
    disabled,
    onTranscribed: (append, transcription) => onTranscribed(append, transcription),
  });
  const liveVoice = useComposerLiveVoice();

  // THE FIELD HAS TO GROW WITH WHAT IS TYPED (live-caught by Pat, 2026-08-08:
  // "tiny as hell and can barely see anything").
  //
  // composer.css has said "One row. The field starts at a single line and grows
  // with what is typed" since it was written, and nothing ever implemented the
  // growing half. `rows={1}` with a fixed min-height meant a long message showed
  // ONE line and scrolled inside itself, on a phone, which is the worst place to
  // compose blind. CSS `field-sizing: content` would do this natively but is not
  // in Safari, which is most of the phones this client exists for, so it is
  // measured here instead: reset to auto first, or scrollHeight only ever grows.
  // The cap matches the stylesheet's max-height so the conversation above is
  // never pushed off screen.
  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    const cap = Math.round(window.innerHeight * 0.4);
    node.style.height = `${Math.min(node.scrollHeight, cap)}px`;
    node.style.overflowY = node.scrollHeight > cap ? 'auto' : 'hidden';
  }, [text]);

  useEffect(() => {
    setSlashDismissed(false);
    setSlashHighlight(0);
  }, [sessionId]);

  if (!sessionId) return null;

  const submit = async () => {
    if (disabled || sending || uploading || (!text.trim() && attachments.length === 0)) return;
    const images = attachments.map((attachment) => attachment.path);
    const result = await send(text, images);
    if (result.ok) {
      setText('');
      clearPaths(images);
      setSlashDismissed(false);
    }
  };

  const pickSlash = (command) => {
    setText((prev) => insertSlashCommand(prev, slash.active, command));
    setSlashDismissed(false);
    setSlashHighlight(0);
    textareaRef.current?.focus();
  };

  const toggleFormat = () => {
    setFormatOpen((open) => {
      const next = !open;
      try { localStorage.setItem('harbor-compose-format', next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
    textareaRef.current?.focus();
  };

  const fieldClass = [
    'composer-field',
    slash.chrome.active ? (slash.chrome.valid ? 'slash-valid' : 'slash-invalid') : '',
    text ? 'has-text' : '',
  ].filter(Boolean).join(' ');

  return (
    <section
      className={`composer${focused ? ' is-focused' : ''}`}
      data-pane={paneId || ''}
    >
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
      {attachmentError ? <p className="composer-status error" role="alert">{attachmentError}</p> : null}
      {capsError ? <p className="composer-status error" role="alert">{capsError}</p> : null}
      {voiceState.message ? (
        <p className={`voice-status ${voiceState.phase === 'error' ? 'error' : ''}`} role="status">{voiceState.message}</p>
      ) : null}
      <LiveVoiceBar liveVoice={liveVoice} />
      <AttachChips attachments={attachments} onRemove={remove} />
      {paneId && working ? (
        <button type="button" className="composer-interrupt" onClick={interrupt}>
          <span className="composer-interrupt-glyph" aria-hidden="true" />
          Stop
        </button>
      ) : null}
      {formatOpen ? (
        <FormatToolbar
          textareaRef={textareaRef}
          text={text}
          onChange={setText}
          disabled={disabled}
        />
      ) : null}
      {/* Secondary tools share the tray so the typing row stays spacious. */}
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
            }}
          />
          <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
            <path d="M6.8 10.8 11.9 5.7a3 3 0 1 1 4.2 4.2l-6.2 6.2a4.5 4.5 0 0 1-6.4-6.4l6-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
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
      <div className="composer-row">
        <button
          type="button"
          className={`composer-plus${toolsOpen ? ' on' : ''}`}
          aria-label={toolsOpen ? 'Hide composer tools' : 'Show composer tools'}
          aria-expanded={toolsOpen}
          onClick={() => setToolsOpen((v) => !v)}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
            <path d="M10 4.4v11.2M4.4 10h11.2" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
          </svg>
        </button>
        <div className={fieldClass}>
          <textarea
            ref={textareaRef}
            aria-label="Message"
            placeholder="Message this session"
            rows={1}
            value={text}
            disabled={disabled}
            onChange={(event) => {
              setText(event.target.value);
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
        <button
          type="button"
          className="composer-send"
          disabled={disabled || sending || uploading || (!text.trim() && attachments.length === 0)}
          onClick={submit}
          aria-label={sending ? 'Sending' : 'Send'}
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
