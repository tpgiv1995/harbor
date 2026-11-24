import React from 'react';
import './gemini-setup.css';

// Gemini's first-run pages as a Harbor card (2026-11-24, Pat: "you didn't even bother to build out a harbor screen for
// gemini"). Antigravity asks two things once per profile: a colour scheme for its terminal, then its Terms of Service
// with a data-sharing box Google ticks by default. Both are Pat's to answer; this card shows exactly what agy drew and
// main (gemini-first-run.js) turns a click into keys only after re-reading the screen. Shared with the phone.
export function GeminiSetupCard({ menu, busy, error, onAction }) {
  const stop = (event) => event.stopPropagation();
  if (menu.page === 'scheme') {
    return (
      <section className="gemini-setup-card" aria-label="Gemini setup: colour scheme" onClick={stop}>
        <header className="gemini-setup-eyebrow">Gemini setup · step 1 of 2</header>
        <h3>Choose a colour scheme</h3>
        <p className="gemini-setup-prose">
          Google asks this once, the first time Gemini runs on this computer. It sets the colours of Gemini&apos;s own
          terminal view (the &gt;_ button). This window looks the same whichever you pick.
        </p>
        <div className="gemini-setup-schemes">
          {menu.schemes.map((scheme) => (
            <button
              type="button"
              key={scheme.label}
              disabled={busy}
              className={scheme.selected ? 'is-current' : ''}
              aria-current={scheme.selected ? 'true' : undefined}
              onClick={() => onAction({ type: 'gemini-scheme', label: scheme.label })}
            >
              <span className="gemini-setup-label">{scheme.label}</span>
              {scheme.selected ? <span className="gemini-setup-tag">current</span> : null}
            </button>
          ))}
        </div>
        <footer className="gemini-setup-footer">Click one to use it and go to step 2.</footer>
        {error ? <p className="gemini-setup-error" role="alert">{error}</p> : null}
      </section>
    );
  }
  return (
    <section className="gemini-setup-card" aria-label="Gemini setup: Terms of Service and data use" onClick={stop}>
      <header className="gemini-setup-eyebrow">Gemini setup · step 2 of 2</header>
      <h3>Terms of Service &amp; Data Use</h3>
      {menu.warning ? <p className="gemini-setup-prose gemini-setup-warning">{menu.warning}</p> : null}
      <button
        type="button"
        role="checkbox"
        aria-checked={menu.checked ? 'true' : 'false'}
        disabled={busy}
        className="gemini-setup-consent"
        onClick={() => onAction({ type: 'gemini-terms', op: 'toggle' })}
      >
        <span className={`gemini-setup-box${menu.checked ? ' is-checked' : ''}`} aria-hidden="true">{menu.checked ? '✓' : ''}</span>
        <span>{menu.consent}</span>
      </button>
      <p className="gemini-setup-note">
        Google ticks this box by default. Click it to change it. You can change it later in Antigravity&apos;s settings.
      </p>
      {menu.links?.length ? (
        <p className="gemini-setup-links">
          {menu.links.map((link) => (
            <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer" title={link.url}>{link.label}</a>
          ))}
        </p>
      ) : null}
      <footer className="gemini-setup-actions">
        <button type="button" disabled={busy} className="gemini-setup-back" onClick={() => onAction({ type: 'gemini-terms', op: 'previous' })}>Back</button>
        <button
          type="button"
          disabled={busy}
          className="gemini-setup-done"
          onClick={() => onAction({ type: 'gemini-terms', op: 'done', checked: Boolean(menu.checked) })}
        >
          {menu.checked ? 'Done, sharing data with Google' : 'Done, not sharing data'}
        </button>
      </footer>
      {error ? <p className="gemini-setup-error" role="alert">{error}</p> : null}
    </section>
  );
}
