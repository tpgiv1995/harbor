import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import assignModule from './assign-to-claude.cjs';

const { YOLO_CWD, composeTaskPrompt } = assignModule;
const DEFAULT_KEY = 'harbor-new-session-default';

function savedDefaults(options) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(DEFAULT_KEY) || 'null') || {}; } catch { /* use registry */ }
  const claude = options?.providers?.claude || {};
  const profile = options?.profiles?.find((item) => item.id === saved.account)
    || options?.profiles?.find((item) => item.isDefault) || options?.profiles?.[0];
  return {
    account: profile?.id || null,
    model: saved.model || claude.defaultModel || 'default',
    effort: saved.effort || claude.defaultEffort || 'default',
  };
}

function cleanError(error) {
  return String(error?.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

export function AssignToClaudeModal({ doc, taskId, onClose, mutate }) {
  const task = doc.tasks.find((item) => item.id === taskId);
  const listName = doc.lists.find((item) => item.id === task?.listId)?.name || 'Unknown';
  const [options, setOptions] = useState(null);
  const [folder, setFolder] = useState('');
  const [account, setAccount] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [instructions, setInstructions] = useState('');
  const [starting, setStarting] = useState(false);
  const [launchError, setLaunchError] = useState(null);

  useEffect(() => {
    window.harbor.session.newOptions().then((value) => {
      setOptions(value);
      const defaults = savedDefaults(value);
      setAccount(defaults.account || '');
      setModel(defaults.model);
      setEffort(defaults.effort);
    }).catch((error) => setLaunchError(cleanError(error)));
  }, []);

  useEffect(() => {
    const key = (event) => { if (event.key === 'Escape' && !starting) onClose(); };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onClose, starting]);

  const claude = options?.providers?.claude;
  const models = useMemo(() => claude?.models || [], [claude]);
  if (!task) return null;

  const launch = async ({ yolo }) => {
    if (starting) return;
    setStarting(true);
    setLaunchError(null);
    try {
      const defaults = savedDefaults(options);
      const result = await window.harbor.session.newInProject({
        account: yolo ? defaults.account : (account || defaults.account),
        provider: 'claude',
        model: yolo ? defaults.model : (model || defaults.model),
        effort: yolo ? defaults.effort : (effort || defaults.effort),
        folder: yolo ? YOLO_CWD : (folder || YOLO_CWD),
        prompt: composeTaskPrompt({ task, listName, extraInstructions: yolo ? '' : instructions, yolo }),
      });
      if (!result?.sessionId) throw new Error('Claude launched without reporting its session id');
      const annotated = await mutate({ type: 'task.appendAssignment', taskId, sessionId: result.sessionId });
      if (!annotated?.ok) throw new Error(annotated?.reason || 'the assignment launched but its note could not be annotated');
      onClose();
    } catch (error) {
      setLaunchError(cleanError(error));
    } finally {
      setStarting(false);
    }
  };

  return createPortal(
    <div className="assign-claude-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !starting && onClose()}>
      <section className="assign-claude-modal" role="dialog" aria-modal="true" aria-labelledby="assign-claude-title">
        <header><div><span>ASSIGN TASK</span><h2 id="assign-claude-title">Assign to Claude</h2></div><button type="button" onClick={onClose} disabled={starting} aria-label="Close">×</button></header>
        <div className="assign-claude-summary"><strong>{task.title}</strong><span>{listName}{task.dueDate ? ` · due ${task.dueDate}` : ''}</span></div>
        <label><span>Project folder (optional)</span><div className="assign-claude-folder"><input value={folder} onChange={(event) => setFolder(event.target.value)} placeholder={YOLO_CWD} /><button type="button" onClick={async () => { const picked = await window.harbor.session.pickFolder(); if (picked) setFolder(picked); }}>Choose…</button></div></label>
        <div className="assign-claude-grid">
          <label><span>Account / plan (optional)</span><select value={account} onChange={(event) => setAccount(event.target.value)}><option value="">Saved default</option>{(options?.profiles || []).map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}</select></label>
          <label><span>Model (optional)</span><select value={model} onChange={(event) => setModel(event.target.value)}><option value="">Saved default</option>{models.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
          <label><span>Effort (optional)</span><select value={effort} onChange={(event) => setEffort(event.target.value)}><option value="">Saved default</option>{(claude?.efforts || []).map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        </div>
        <label><span>Additional instructions (optional)</span><textarea rows={5} value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="Anything Claude should know beyond the task itself" /></label>
        {launchError ? <div className="config-launch-error" role="alert">{launchError}</div> : null}
        <footer><button type="button" className="assign-claude-yolo" disabled={starting || !options} onClick={() => launch({ yolo: true })}>YOLO, let Claude figure it out</button><button type="button" className="assign-claude-primary" disabled={starting || !options} onClick={() => launch({ yolo: false })}>{starting ? 'Assigning…' : 'Assign'}</button></footer>
      </section>
    </div>,
    document.body,
  );
}
