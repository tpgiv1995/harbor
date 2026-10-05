import React from 'react';
import './model-switch.css';

// Shared with the phone. No initial focus and no Enter-based choice.
export function ModelSwitchCard({ menu, busy, error, onAction }) {
  return <section className="model-switch-card" aria-label={menu.title}
    onClick={event => event.stopPropagation()}
    onKeyDown={event => {
      if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); }
      if (event.key === 'Escape' && menu.canCancel) { event.preventDefault(); event.stopPropagation(); onAction({ type: 'cancel' }); }
    }}>
    <header className="prompt-eyebrow">{menu.title === 'Session paused' ? 'Session paused' : 'Usage limit'}</header>
    <div className="model-switch-detail"><h3>{menu.title}</h3>
      {menu.explanation.split(/\n\s*\n/).map((paragraph, index) => <p key={index} className="model-switch-prose">{paragraph.replace(/\s*\n\s*/g, ' ')}</p>)}
      {menu.waiting ? <p role="status">{menu.waiting}</p> : null}
    </div>
    <div className="model-switch-options">{menu.options.map(option => <button type="button" disabled={busy} key={option.index}
      onClick={() => onAction({ type: 'model-switch', index: option.index, label: option.label, explicitClick: true })}><span className="model-option-label">{option.label}</span><span aria-hidden="true">›</span></button>)}</div>
    <footer className="model-switch-footer"><span>{menu.options.length ? 'Click a choice to continue' : 'Waiting for Claude'}</span>{menu.canCancel ? <button type="button" disabled={busy} className="model-switch-cancel" onClick={() => onAction({ type: 'cancel' })}>Cancel</button> : null}</footer>
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
