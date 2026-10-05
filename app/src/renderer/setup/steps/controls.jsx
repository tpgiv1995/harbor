import React from 'react';

// Shared wizard controls. Deliberately plain: segmented buttons and text
// fields, no native <select> anywhere. Every glass surface in Slate sets
// backdrop-filter, which becomes the containing block for fixed-position
// descendants, and a native option popup inside one simply never appears
// (the recurring Slate bug, live-caught three times). A wizard is not the
// place to relearn it, so nothing here needs to escape its parent.

export function Field({ label, hint, error, children, wide = false }) {
  return (
    <label className={`sf${wide ? ' wide' : ''}`} data-invalid={error ? '1' : undefined}>
      <span className="sf-label">{label}</span>
      {children}
      {error ? <span className="sf-err">{error}</span> : null}
      {!error && hint ? <span className="sf-hint">{hint}</span> : null}
    </label>
  );
}

export function TextInput({ value, onChange, placeholder, mono = false, ...rest }) {
  return (
    <input
      type="text"
      className={`sf-input${mono ? ' mono' : ''}`}
      value={value ?? ''}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      spellCheck={false}
      {...rest}
    />
  );
}

// A path field with its own Browse button. The picker is a native dialog and
// goes through main's dialog guard, so an isolated profile refuses it rather
// than opening a chooser on the real desktop; the text field stays usable
// either way, which is why Browse is an assist and never the only way in.
export function PathInput({ value, onChange, placeholder, title }) {
  const [busy, setBusy] = React.useState(false);
  const [refused, setRefused] = React.useState(null);
  const browse = async () => {
    setBusy(true);
    setRefused(null);
    try {
      const result = await window.harbor.setup.pickFolder({ title });
      if (result?.ok && result.path) onChange(result.path);
    } catch (error) {
      setRefused(String(error?.message || error).replace(/^Error invoking remote method '[^']+':\s*/, ''));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <span className="sf-path">
        <input
          type="text"
          className="sf-input mono"
          value={value ?? ''}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          spellCheck={false}
        />
        <button type="button" className="setup-btn ghost sf-browse" onClick={browse} disabled={busy}>
          Browse
        </button>
      </span>
      {refused ? <span className="sf-err">{refused}</span> : null}
    </>
  );
}

export function Segmented({ options, value, onChange, name }) {
  return (
    <span className="sf-seg" role="radiogroup" aria-label={name}>
      {options.map((option) => {
        const key = option.value ?? option;
        const label = option.label ?? option;
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={value === key}
            className="sf-seg-btn"
            data-active={value === key ? '1' : undefined}
            data-value={key}
            disabled={option.disabled}
            onClick={() => onChange(key)}
          >
            {label}
          </button>
        );
      })}
    </span>
  );
}

export function Toggle({ checked, onChange, label, description, name }) {
  return (
    <div className="sf-toggle">
      <button
        type="button"
        role="switch"
        aria-checked={Boolean(checked)}
        className="sf-switch"
        data-on={checked ? '1' : undefined}
        data-name={name}
        onClick={() => onChange(!checked)}
      >
        <span className="sf-switch-knob" />
      </button>
      <span className="sf-toggle-text">
        <span className="sf-toggle-label">{label}</span>
        {description ? <span className="sf-toggle-desc">{description}</span> : null}
      </span>
    </div>
  );
}

// One detected fact, shown as a fact. `found` false renders the honest "not
// found" state plus whatever the caller offers instead; it never renders a
// plausible value the user would take for a real one.
export function Detected({ label, found, value, missing, children }) {
  return (
    <div className="sf-detect" data-found={found ? '1' : '0'}>
      <span className="sf-detect-dot" aria-hidden="true" />
      <span className="sf-detect-body">
        <span className="sf-detect-label">{label}</span>
        <span className="sf-detect-value">{found ? value : (missing || 'Not found')}</span>
        {children}
      </span>
    </div>
  );
}

export function errorFor(errors, field) {
  return errors.find((error) => error.field === field)?.message || null;
}
