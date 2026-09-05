import React, { useMemo, useState } from 'react';
import { useCapabilities } from './use-capabilities.js';
import './capability.css';

const MODE_LABEL = { default: 'Default', acceptEdits: 'Accept edits', plan: 'Plan · read-only', bypassPermissions: 'Bypass permissions' };

export function CapabilitySheet({ open, onClose, client, session, header, onApplied }) {
  const { capabilities: caps, options, permissionMode, setPermissionMode, error } = useCapabilities(open ? client : null, session);
  const [applying, setApplying] = useState('');
  const [notice, setNotice] = useState('');
  const provider = session?.provider || 'claude';
  const providerOptions = options?.providers?.[provider];
  // Aliases and pinned versions are DIFFERENT things and were being poured
  // into one flat list, so the sheet showed "Fable 5" and "Opus 5" twice with
  // nothing to say why: it read as a rendering bug. They are two groups now,
  // aliases first, because the alias is what this repo wants chosen (it tracks
  // the current flagship, so a new Opus needs no Harbor change) and a pinned id
  // is the deliberate exception.
  const normalize = (row) => ({
    value: row.value || row.alias || row.id,
    label: row.label || row.value || row.alias || row.id,
    hint: row.id && row.id !== row.label ? row.id : row.hint,
  });
  const modelGroups = useMemo(() => {
    if (provider !== 'claude') {
      return [{ key: 'models', title: null, rows: (providerOptions?.models || []).map(normalize).filter((r) => r.value) }];
    }
    const families = (caps?.models?.families || []).map(normalize).filter((r) => r.value);
    const versions = (caps?.models?.versions || []).map(normalize).filter((r) => r.value);
    return [
      { key: 'families', title: 'Latest', note: 'Tracks the current release', rows: families },
      { key: 'versions', title: 'Pinned versions', note: 'Stays on exactly this build', rows: versions },
    ].filter((group) => group.rows.length);
  }, [caps, provider, providerOptions]);
  const models = useMemo(() => modelGroups.flatMap((group) => group.rows), [modelGroups]);
  const efforts = caps?.effort?.levels || providerOptions?.efforts || [];

  if (!open) return null;
  const sendSetting = async (kind, value) => {
    setApplying(`${kind}:${value}`);
    setNotice('');
    const result = await client.call('session:send', {
      sessionId: session.id,
      text: `/${kind} ${value}`,
      pane: session.paneId ? { paneId: session.paneId, workspaceId: session.workspaceId } : null,
      detectedHome: session.home,
      provider,
    }).catch((cause) => ({ ok: false, reason: String(cause?.message || cause) }));
    if (result?.ok) onApplied?.({ [kind]: value });
    setNotice(result?.ok ? `${kind === 'model' ? 'Model' : 'Effort'} change sent to this session.` : (result?.reason || 'Change failed'));
    setApplying('');
  };
  const cyclePermission = async () => {
    if (!session?.paneId) return;
    setApplying('permission');
    const result = await client.call('capabilities:cycle-permission-mode', {
      paneId: session.paneId, workspaceId: session.workspaceId,
    }).catch((cause) => ({ ok: false, reason: String(cause?.message || cause) }));
    if (result?.ok) setPermissionMode(result.mode ?? null);
    else setNotice(result?.reason || 'Permission mode change failed');
    setApplying('');
  };

  return <div className="mobile-sheet-backdrop" onClick={(event) => event.target === event.currentTarget && onClose()}>
    <section className="mobile-sheet capability-sheet" role="dialog" aria-modal="true" aria-labelledby="capability-title">
      <header className="mobile-sheet-head"><div><span>SESSION</span><h2 id="capability-title">Capabilities</h2></div><button type="button" onClick={onClose} aria-label="Close">×</button></header>
      <div className="mobile-sheet-scroll">
        <div className="cap-current"><span>{provider}</span><strong>{header?.model?.label || header?.model?.id || session?.modelLabel || session?.model || 'Model not reported'}</strong><small>{header?.effort || session?.effort || 'Effort not reported'}</small></div>
        {error ? <p className="sheet-error" role="alert">{error}</p> : null}
        {modelGroups.map((group) => (
          <section key={group.key}>
            <h3>{group.title ? `Model · ${group.title}` : 'Model'}</h3>
            {group.note ? <p className="cap-note">{group.note}</p> : null}
            <div className="cap-choice-list">
              {group.rows.map((model) => (
                <button type="button" key={`${group.key}:${model.value}`} onClick={() => sendSetting('model', model.value)} disabled={Boolean(applying)}>
                  <span>{model.label}</span>
                  {model.hint ? <small>{model.hint}</small> : null}
                </button>
              ))}
            </div>
          </section>
        ))}
        <section><h3>Effort</h3><div className="cap-efforts">{efforts.filter((value) => value !== 'default').map((value) => <button type="button" key={value} onClick={() => sendSetting('effort', value)} disabled={Boolean(applying)}>{value}</button>)}</div>{caps?.effort?.note ? <p className="cap-note">{caps.effort.note}</p> : null}</section>
        <section><h3>Permission mode</h3><button type="button" className="cap-permission" onClick={cyclePermission} disabled={!session?.paneId || Boolean(applying)}><span>{permissionMode === undefined ? 'Reading…' : permissionMode === null ? 'Unavailable' : (MODE_LABEL[permissionMode] || permissionMode)}</span><small>Tap to cycle</small></button></section>
        <section><h3>Plugins</h3><div className="cap-plugin-list">{caps?.plugins?.length ? caps.plugins.map((plugin) => <div key={`${plugin.name}:${plugin.marketplace}`}><span>{plugin.name}</span><small>{plugin.enabled ? 'on' : 'off'}</small></div>) : <p className="cap-note">No plugins reported</p>}</div></section>
        <section><h3>Slash commands</h3><div className="cap-command-list">{(caps?.commands || []).map((command) => <div key={`${command.source}:${command.name}`}><code>{command.name}</code><small>{command.source}</small></div>)}</div></section>
      </div>
      {notice ? <div className="sheet-notice" role="status">{notice}</div> : null}
    </section>
  </div>;
}
