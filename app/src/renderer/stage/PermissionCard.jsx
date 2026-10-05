import React, { useRef, useState } from 'react';
import { PermissionDiff } from './PermissionDiff.jsx';
import './prompt-form.css';

// Both transports supply their own options and actions. This component owns
// only presentation and local feedback; it never invents a persistent choice.
export function PermissionCard({ title, children, options, feedbackIndex, amendIndex, canCancel = true,
  busy = false, error, onChoose, onDecline, device = 'desktop', approval = false }) {
  const [feedbackFor, setFeedbackFor] = useState(null);
  const [message, setMessage] = useState('');
  const [failure, setFailure] = useState(null);
  const field = useRef(null);
  const sending = useRef(false);
  const send = async action => {
    if (busy || sending.current) return;
    sending.current = true;
    setFailure(null);
    try { await action(); } catch (err) { setFailure(String(err.message || err)); }
    finally { sending.current = false; }
  };
  const showFeedback = index => {
    setFeedbackFor(index);
    requestAnimationFrame(() => field.current?.focus());
  };
  const choose = index => index === feedbackIndex ? showFeedback(index) : send(() => onChoose(index));
  const hints = [];
  const ordinary = options.filter(option => option.index !== feedbackIndex).map(option => option.index);
  const digits = ordinary.length > 2 ? `${ordinary.slice(0, -1).join(', ')} or ${ordinary.at(-1)}` : ordinary.join(' or ');
  if (ordinary.length) hints.push(`${digits} to choose`);
  if (feedbackIndex != null) hints.push(`${feedbackIndex} to give feedback`);
  if (canCancel) hints.push('Esc to decline');
  return <section className={`prompt-form permission-prompt${device === 'phone' ? ' permission-phone' : ''}`}
    tabIndex={0} aria-label={title ? `${title} permission` : 'Permission'} onClick={event => event.stopPropagation()}
    onKeyDown={event => {
      const inField = /INPUT|TEXTAREA|SELECT/.test(event.target.tagName);
      if (!inField && options.some(option => String(option.index) === event.key)) {
        event.preventDefault(); event.stopPropagation(); choose(Number(event.key));
      }
      if (event.key === 'Enter') {
        if (event.target.tagName !== 'TEXTAREA') event.preventDefault();
        event.stopPropagation();
      }
      if (event.key === 'Escape' && canCancel) {
        event.preventDefault(); event.stopPropagation(); send(() => onDecline(message));
      }
    }}>
    <header className="prompt-eyebrow">{approval ? 'Plan ready for approval' : title ? `${title} needs permission` : 'Permission requested'}</header>
    <div className="prompt-detail">{children}</div>
    <div className="permission-choices">
      {options.map(option => <React.Fragment key={option.index}>
        <button type="button" className={`prompt-option${feedbackFor === option.index ? ' active' : ''}`} disabled={busy}
          onClick={() => choose(option.index)}><kbd>{option.index}</kbd><span>{option.label.replace(/\s+\((?:esc(?:ape)?|enter|(?:ctrl|shift|alt|cmd)\+[a-z0-9+]+)\)\s*$/i, '')}</span><span aria-hidden="true">›</span></button>
        {feedbackFor === option.index ? <div className="permission-denial">
          <textarea ref={field} rows={1} aria-label="Tell Claude what to do differently" placeholder="Tell Claude what to do differently"
            disabled={busy} value={message} onChange={event => setMessage(event.target.value)} />
          {/* Not "Decline": the footer's Decline sits on the same card and
              declines without a message, so two buttons must not share a name. */}
          <button type="button" className="prompt-secondary" disabled={busy || !message.trim()} onClick={() => send(() => onChoose(option.index, message))}>Send feedback</button>
        </div> : null}
      </React.Fragment>)}
      <footer className="permission-footer">{device !== 'phone' ? <span className="prompt-hints">{hints.join(' · ')}</span> : null}
        {amendIndex != null && amendIndex !== feedbackIndex ? <button type="button" className="permission-footer-action" disabled={busy} onClick={() => showFeedback(amendIndex)}>Amend</button> : null}
        {canCancel ? <button type="button" className="permission-footer-action" disabled={busy} onClick={() => send(() => onDecline(message))}>Decline</button> : null}
      </footer>
    </div>
    {error || failure ? <p className="prompt-error" role="alert">{error || failure}</p> : null}
  </section>;
}

export function ScreenPermissionDetail({ permission }) {
  const mcp = /\(MCP\)$/.test(permission.toolTitle || '');
  const url = permission.toolName === 'WebFetch' && permission.blocks.map(block => block.text).join('\n').match(/https?:\/\/[^\s]+/);
  let host;
  try { host = url ? new URL(url[0]).host : null; } catch { /* Keep the screen's text when a URL is clipped. */ }
  return <>{mcp ? <strong>{permission.toolTitle}</strong> : null}{host ? <strong>{host}</strong> : null}
    {permission.blocks.filter(block => !(block.type === 'text' && /^(?:shift\+tab to approve|ctrl\+g to edit)/i.test(block.text.trim()))).map((block, index) => block.type === 'diff'
    ? <PermissionDiff screen={block.text} key={index} />
    : block.type === 'code' ? <pre key={index}>{block.text}</pre> : <p className={block.type === 'path' ? 'prompt-path' : 'permission-prose'} key={index}>{block.text}</p>)}
    {permission.question ? <p>{permission.question}</p> : null}</>;
}

export function ScrapedPermissionCard({ menu, busy, error, onAction, device }) {
  const permission = menu.permission;
  const feedback = menu.options.find(option => /(?:tell Claude what to (?:do differently|change))/i.test(option.label));
  const feedbackIndex = feedback ? feedback.index : null;
  const negative = menu.options.find(option => /^No\b/i.test(option.label));
  const title = permission.toolName || permission.toolTitle?.replace(/^.+?\s+[-\u2014]\s+/, '').replace(/:?\s*\(MCP\)$/, '');
  return <PermissionCard title={title} options={menu.options} feedbackIndex={feedbackIndex}
    approval={permission.toolTitle === 'Plan'}
    amendIndex={menu.notesKey ? negative?.index : null} canCancel={permission.canCancel} device={device} busy={busy} error={error}
    onChoose={(index, text) => onAction(text === undefined || !text.trim()
      ? { type: 'select', index }
      : { type: menu.options.find(option => option.index === index)?.isText ? 'text' : menu.notesKey ? 'notes' : 'permission-feedback', index, text })}
    onDecline={() => onAction({ type: 'cancel' })}>
    <ScreenPermissionDetail permission={permission} />
  </PermissionCard>;
}

export function PermissionFeedbackFailure({ text, reason, onClose, device = 'desktop' }) {
  return <section className={`prompt-form permission-prompt${device === 'phone' ? ' permission-phone' : ''}`} aria-label="Feedback needs attention">
    <header className="prompt-eyebrow">Feedback needs attention</header>
    <p className="permission-prose" role="alert">{reason}</p>
    <p>Check the conversation and composer before sending again. Your feedback is kept below.</p>
    <textarea rows={3} aria-label="Feedback to keep" readOnly value={text} />
    <button type="button" className="prompt-secondary" onClick={onClose}>Close</button>
  </section>;
}
