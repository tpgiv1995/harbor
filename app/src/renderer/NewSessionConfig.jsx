import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { providerIdentity, useProfiles, profileStyle } from './providers.js';
import {
  currentEffort, currentModel, isReconfigure, pendingSwitch,
} from './session-config-mode.cjs';

const PROVIDER_KEYS = ['claude', 'codex', 'cursor'];
const DEFAULT_KEY = 'harbor-new-session-default';
// Must match NEW_SESSION_DEFAULT_VERSION in index.jsx, which owns the re-seed.
const DEFAULT_VERSION = 2;
const MODE_LABEL = {
  default: 'default · asks before edits',
  plan: 'plan mode · read-only',
  'accept-edits': 'accept edits',
  bypass: 'bypass permissions',
};

// The model list is Harbor's OWN dropdown, portaled to document.body, not a
// native <select>: this modal sits on a backdrop-filter layer, which traps
// fixed-position descendants (the recurring Slate bug, now three times over),
// and the native option popup simply never appeared, so every model but the
// current one was unreachable (Pat, live-caught 2026-07-25: "there's still not
// a way to see other models besides the default one").
function ModelSelect({ options, value, onChange, disabled }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const buttonRef = useRef(null);
  const current = options.find((item) => item.value === value);

  const place = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const dropDown = below >= 200 || below >= above;
    setPos({
      left: rect.left,
      width: rect.width,
      ...(dropDown
        ? { top: rect.bottom + 6, maxHeight: Math.max(140, below) }
        : { bottom: window.innerHeight - rect.top + 6, maxHeight: Math.max(140, above) }),
    });
  };

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); } };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`model-select${open ? ' open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Model"
        disabled={disabled}
        onClick={() => { if (!open) place(); setOpen((value_) => !value_); }}
      >
        <span className="model-select-val">{current?.label || value || 'select a model'}</span>
        <span className="model-select-caret" aria-hidden="true">▾</span>
      </button>
      {open && pos ? createPortal(
        <>
          <button
            type="button"
            className="menu-backdrop"
            aria-label="Close model list"
            onClick={() => setOpen(false)}
          />
          <div
            className="model-select-list"
            role="listbox"
            aria-label="Models"
            style={{
              left: pos.left,
              width: pos.width,
              maxHeight: pos.maxHeight,
              ...(pos.top != null ? { top: pos.top } : { bottom: pos.bottom }),
            }}
          >
            {options.map((item) => (
              <button
                key={item.value}
                type="button"
                role="option"
                aria-selected={item.value === value}
                className={`model-select-row${item.value === value ? ' on' : ''}`}
                onClick={() => { onChange(item.value); setOpen(false); }}
              >
                <span className="model-select-row-label">{item.label}</span>
                {item.hint ? <span className="model-select-row-hint">{item.hint}</span> : null}
              </button>
            ))}
          </div>
        </>,
        document.body,
      ) : null}
    </>
  );
}

export function NewSessionConfig({ request, onClose, onStart, onReconfigure }) {
  const { profiles, defaultProfileId, defaults } = useProfiles();
  const runningProvider = request.session?.provider || request.provider || 'claude';
  const [options, setOptions] = useState(null);
  const [caps, setCaps] = useState(null);
  const [provider, setProvider] = useState(runningProvider);
  const [account, setAccount] = useState(request.account || defaultProfileId);
  const [model, setModel] = useState(
    request.model || currentModel(request.header, request.session?.model),
  );
  const [effort, setEffort] = useState(
    request.effort || currentEffort(request.header, request.session?.effort) || 'xhigh',
  );
  const [permMode, setPermMode] = useState(undefined);
  const [showVersions, setShowVersions] = useState(false);
  const [cmdSearch, setCmdSearch] = useState('');
  const [starting, setStarting] = useState(false);
  const [makeDefault, setMakeDefault] = useState(false);

  useEffect(() => {
    window.harbor.session.newOptions().then(setOptions).catch(() => {});
    if (request.session?.id) {
      window.harbor.capabilities.get({ sessionId: request.session.id })
        .then((res) => { if (res?.ok) setCaps(res.capabilities); })
        .catch(() => {});
    }
    if (request.pane?.paneId) {
      window.harbor.capabilities.permissionMode({ paneId: request.pane.paneId })
        .then((res) => setPermMode(res?.mode ?? null)).catch(() => setPermMode(null));
    } else setPermMode(null);
  }, [request.session?.id, request.pane?.paneId]);

  useEffect(() => {
    if (request.account || !defaultProfileId) return;
    setAccount(defaultProfileId);
  }, [defaultProfileId, request.account]);

  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const next = options?.providers?.[provider];
    if (!next || provider === runningProvider) return;
    setModel(next.defaultModel);
    setEffort(next.defaultEffort || next.efforts[0] || 'default');
  }, [provider, options, runningProvider]);

  const providerOptions = options?.providers?.[provider];
  // Family aliases always; the pinned dated ids only when asked for. The alias
  // is what a launch should carry (it resolves to the current flagship), so it
  // leads the list.
  const modelOptions = useMemo(() => {
    const rows = [...(providerOptions?.models || [])];
    if (provider === 'claude' && showVersions) {
      for (const item of caps?.models?.versions || []) {
        rows.push({ value: item.id, label: item.label, hint: item.id });
      }
    }
    // A model the session is already on that the catalog does not list (a
    // pinned id, an unreleased alias) still has to be visible, never dropped.
    if (model && !rows.some((row) => row.value === model)) {
      rows.unshift({ value: model, label: model, hint: 'current' });
    }
    return rows;
  }, [providerOptions, provider, showVersions, caps, model]);
  const effortLevels = providerOptions?.efforts?.filter((value) => value !== 'default') || [];
  const effortIndex = Math.max(0, effortLevels.indexOf(effort));
  // Reconfiguring THIS session (switch its model/effort) vs launching a new
  // one. True for ANY existing same-provider Claude session, including one
  // running in an outside terminal or a dead one; the switch routes through
  // adopt/resume in the parent. Gating this on a live drivable pane was the bug
  // that turned "change this session's model" into "launch a new session"
  // (live-caught 2026-07-20, Pat: "the only route is to create a new session").
  // A FRESH session counts too; the whole rule (and both incidents behind it)
  // lives in session-config-mode.cjs.
  const reconfiguring = isReconfigure({
    provider,
    runningProvider,
    sessionId: request.session?.id,
    paneId: request.pane?.paneId,
  });
  // Cycling the permission mode still needs a live pane Harbor already controls.
  const canCyclePermission = reconfiguring
    && request.drivable !== false
    && Boolean(request.pane?.paneId);
  const folder = request.folder || request.session?.cwd || null;
  const folderLabel = folder || request.session?.project || 'session folder';
  const actionLabel = reconfiguring ? 'Apply' : `Start ${providerIdentity(provider).label} session`;
  const commands = caps?.commands || [];
  const filteredCommands = useMemo(() => {
    const q = cmdSearch.trim().toLowerCase();
    return q ? commands.filter((c) => c.name.toLowerCase().includes(q)
      || String(c.description || '').toLowerCase().includes(q)) : commands;
  }, [commands, cmdSearch]);

  const saveDefault = () => {
    // The version stamp marks this as a deliberate save, so the one-time
    // re-seed in index.jsx leaves it alone from here on.
    localStorage.setItem(DEFAULT_KEY, JSON.stringify({
      account, provider, model, effort, v: DEFAULT_VERSION,
    }));
  };

  const submit = async (event) => {
    event.preventDefault();
    if (!providerOptions || starting) return;
    setStarting(true);
    try {
      if (makeDefault) saveDefault();
      if (reconfiguring) {
        // Switch only what the user actually changed. The parent adopts an
        // outside session (or resumes a dead one) as part of the switch, once.
        const next = pendingSwitch({
          header: request.header,
          launchedModel: request.session?.model,
          launchedEffort: request.session?.effort,
          model,
          effort,
        });
        if (next.model || next.effort) await onReconfigure(next);
      } else {
        await onStart({ account, provider, model, effort, folder, sessionId: request.session?.id });
      }
      onClose();
    } finally {
      setStarting(false);
    }
  };

  const cycleMode = async () => {
    if (!request.pane?.paneId || !canCyclePermission) return;
    const res = await window.harbor.capabilities.cyclePermissionMode({
      paneId: request.pane.paneId,
      workspaceId: request.pane.workspaceId,
    });
    if (res?.ok) setPermMode(res.mode ?? null);
  };

  const insert = (value) => {
    request.insertDraft?.(value);
    onClose();
  };

  return createPortal(
    <div className="new-session-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="new-session-popover config-modal" onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="new-session-title">
        <div className="new-session-heading">
          <div><span>SESSION CONFIGURATION</span><h2 id="new-session-title">Session configuration</h2></div>
          <button type="button" className="new-session-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <fieldset className="new-session-field"><legend>PROVIDER</legend><div className="new-session-providers">
          {PROVIDER_KEYS.map((key) => { const ident = providerIdentity(key); return <button type="button" key={key} className={provider === key ? 'active' : ''} style={{ '--provider-color': ident.color }} onClick={() => setProvider(key)}><img src={ident.logo} alt="" />{ident.label}</button>; })}
        </div></fieldset>

        <div className="config-modal-scroll">
          {provider === 'claude' && !reconfiguring && profiles.length > 0 ? <section className="cap-sec">
            <div className="cap-sec-h">Account</div>
            <div className="config-account" role="group" aria-label="Account">
              {profiles.map((profile) => (
                <button
                  type="button"
                  key={profile.id}
                  className={account === profile.id ? 'active' : ''}
                  aria-pressed={account === profile.id}
                  style={profileStyle(profile)}
                  onClick={() => setAccount(profile.id)}
                >
                  {profile.label}
                </button>
              ))}
            </div>
          </section> : null}

          <section className="cap-sec">
            <div className="cap-sec-h">Model</div>
            <ModelSelect options={modelOptions} value={model} onChange={setModel} disabled={!providerOptions} />
            {provider === 'claude' && caps?.models?.versions?.length ? <button type="button" className="cap-more" onClick={() => setShowVersions((value) => !value)}>{showVersions ? 'Hide pinned versions ▴' : 'Show pinned versions ▾'}</button> : null}
          </section>

          {effortLevels.length ? <section className="cap-sec">
            <div className="cap-sec-h">Effort</div>
            <div className="cap-effort-slider-wrap">
              <div className="cap-effort-value" aria-hidden="true">{effortLevels[effortIndex]}</div>
              <input className="cap-effort-slider" type="range" min="0" max={effortLevels.length - 1} step="1" value={effortIndex} aria-label="Effort" aria-valuetext={effortLevels[effortIndex]} onChange={(event) => setEffort(effortLevels[Number(event.target.value)])} />
              <div className="cap-effort-ticks" aria-hidden="true">{effortLevels.map((value) => <span key={value}>{value}</span>)}</div>
            </div>
            {provider === 'claude' && caps?.effort?.note ? <div className="cap-note">{caps.effort.note}</div> : null}
          </section> : null}

          {/* EVERYTHING BELOW DESCRIBES A RUNNING SESSION, so none of it belongs
              on the launch form. Permission mode is read off a pane and changed
              by typing into it; fast mode, plugins and slash commands all come
              from that session's capability read; the workflow button inserts a
              keyword into that session's composer. With no session yet, they
              rendered as "current unreadable" above a disabled button, a status
              about nothing, and "0/0" slash commands over an empty search box:
              four controls that cannot act, on the one form whose entire job is
              a decision. Launch keeps provider, account, model and effort, which
              are the four things a launch actually sets. */}
          {provider === 'claude' && reconfiguring ? <>
            <section className="cap-sec"><div className="cap-sec-h">Permission mode</div><div className="cap-status"><span className="cap-status-lbl">current</span><span className="cap-status-val">{permMode === undefined ? 'reading…' : permMode === null ? 'unreadable' : (MODE_LABEL[permMode] || permMode)}</span></div><button type="button" className="cap-action" onClick={cycleMode} disabled={!canCyclePermission}>Cycle mode (⇧Tab)</button></section>
            <section className="cap-sec"><div className="cap-sec-h">Fast mode</div><div className="cap-row disabled"><span className="cap-row-lbl">Unavailable</span><span className="cap-row-reason">{caps?.fastMode?.reason || 'Fast mode: unavailable on subscription auth'}</span></div></section>
            <section className="cap-sec"><div className="cap-sec-h">Workflow</div><button type="button" className="cap-action" onClick={() => insert(`${caps?.dynamicWorkflow?.keyword || 'ultracode'} `)}>Insert “{caps?.dynamicWorkflow?.keyword || 'ultracode'}” keyword</button></section>
            <section className="cap-sec"><div className="cap-sec-h">Plugins &amp; connectors</div>{caps?.plugins?.length ? <div className="cap-plugins">{caps.plugins.map((plugin) => <div key={`${plugin.name}@${plugin.marketplace}`} className={`cap-plugin${plugin.enabled ? '' : ' off'}`}><span className="cap-plugin-dot" /><span className="cap-plugin-name">{plugin.name}</span><span className="cap-plugin-state">{plugin.enabled ? 'on' : 'off'}</span></div>)}</div> : <div className="cap-note">no plugins installed</div>}{caps?.mcpServers?.length ? <div className="cap-mcp"><span className="cap-mcp-lbl">MCP</span><span className="cap-mcp-names">{caps.mcpServers.join(', ')}</span></div> : null}</section>
            <section className="cap-sec"><div className="cap-sec-h">Slash commands <span className="cap-sec-count">{filteredCommands.length}/{commands.length}</span></div><input className="cap-search" aria-label="Search slash commands" placeholder="Search commands, skills…" value={cmdSearch} onChange={(event) => setCmdSearch(event.target.value)} /><div className="cap-cmds">{filteredCommands.map((command) => <button key={`${command.source}:${command.name}`} type="button" className="cap-cmd" onClick={() => insert(`${command.name} `)}><span className="cap-cmd-name">{command.name}</span><span className="cap-cmd-src">{command.source}</span></button>)}</div></section>
          </> : null}
        </div>

        <label className="config-default"><input type="checkbox" checked={makeDefault} onChange={(event) => setMakeDefault(event.target.checked)} /> Set as default for new sessions</label>
        {/* A running codex/cursor session cannot be re-modelled from here (their
            model switch is an interactive picker inside their own TUI), so this
            button starts a NEW session. Say that outright: the same button
            silently launching a second session was a footgun. */}
        <div className="config-folder">{reconfiguring
          ? 'Changes apply to this session'
          : request.session?.id && provider === runningProvider && provider !== 'claude'
            ? `${providerIdentity(provider).label} switches model inside its own TUI; this starts a NEW session in ${folderLabel}`
            : `Start in ${folderLabel}`}</div>
        <button className="new-session-start" type="submit" disabled={!providerOptions || starting}>{starting ? 'Working…' : actionLabel}</button>
      </form>
    </div>, document.body,
  );
}
