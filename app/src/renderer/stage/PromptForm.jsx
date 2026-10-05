import React, { useState } from 'react';
import { PermissionCard } from './PermissionCard.jsx';
import { PermissionDiff } from './PermissionDiff.jsx';
import { fieldType, choicesFor, defaultsFor, validateContent, safeExternalUrl } from '../../shared/elicitation.cjs';
import './prompt-form.css';

function Field({ name, field, value, change, required, error }) {
  const type = fieldType(field);
  const choices = choicesFor(field);
  const id = `prompt-field-${name}`;
  let control;
  if (type === 'array') {
    control = <div className="prompt-checks">{choices.map(choice => <label key={choice.value}>
      <input type="checkbox" checked={(value || []).includes(choice.value)} onChange={event => change(event.target.checked
        ? [...(value || []), choice.value] : value.filter(item => item !== choice.value))} />{choice.label}
    </label>)}</div>;
  } else if (type === 'boolean') {
    control = <select id={id} value={value === undefined ? '' : String(value)} onChange={event => change(event.target.value === '' ? undefined : event.target.value === 'true')}>
      <option value="">Choose</option><option value="true">Yes</option><option value="false">No</option>
    </select>;
  } else if (choices.length) {
    control = <select id={id} value={value === undefined ? '' : String(choices.findIndex(choice => choice.value === value))}
      onChange={event => change(event.target.value === '' ? undefined : choices[Number(event.target.value)].value)}>
      <option value="">Choose</option>{choices.map((choice, index) => <option key={index} value={index}>{choice.label}</option>)}
    </select>;
  } else {
    const numeric = ['number', 'integer'].includes(type);
    control = <input id={id} type={numeric ? 'number' : 'text'} step={type === 'integer' ? 1 : 'any'}
      value={value ?? ''} min={field.minimum} max={field.maximum}
      onChange={event => change(event.target.value === '' ? undefined : numeric ? Number(event.target.value) : event.target.value)} />;
  }
  return <div className="prompt-field">
    <label htmlFor={id}>{field.title || name}{required ? ' *' : ''}</label>
    {field.description ? <p>{field.description}</p> : null}
    {control}
    {error ? <span role="alert">{error}</span> : null}
  </div>;
}

function RequestDetail({ prompt }) {
  const tool = prompt.toolName;
  const data = prompt.toolInput;
  if (tool === 'Edit') return <>
    <p className="prompt-path">{data.file_path}</p>
    <PermissionDiff before={data.old_string} after={data.new_string} />
    {data.replace_all ? <p>Replace every occurrence</p> : null}
  </>;
  if (tool === 'Write') {
    return <><p className="prompt-path">{data.file_path}</p><pre>{data.content}</pre></>;
  }
  if (tool === 'WebFetch') {
    const url = safeExternalUrl(data.url);
    return <><strong>{url ? new URL(url).host : 'URL'}</strong><p>Claude wants to fetch content from {url ? new URL(url).host : data.url}</p>
      <pre>{`url: ${data.url}\nprompt: ${data.prompt || ''}`}</pre></>;
  }
  if (tool === 'Bash') return <><p>{data.description}</p><pre>{data.command}</pre></>;
  return <><strong>{`${prompt.serverName || 'MCP server'} \u2014 ${prompt.displayTool || tool} (MCP)`}</strong>
    <pre>{Object.entries(data).map(([name, value]) => `${name}: ${JSON.stringify(value)}`).join('\n')}</pre></>;
}

// Only the request details scroll. Choices stay visible, including in a grid.
export function PromptForm({ ask, onAnswer, device = 'desktop' }) {
  const prompt = ask.prompt;
  const permission = ask.kind === 'permission';
  const [content, setContent] = useState(() => defaultsFor(prompt.schema || {}));
  const [errors, setErrors] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const send = async payload => {
    if (busy) return;
    if (payload.action === 'accept' && prompt.mode === 'form') {
      const validation = validateContent(prompt.schema, content);
      setErrors(validation.errors);
      if (!validation.ok) return;
      payload.content = content;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await onAnswer(ask.id, payload);
      if (!result?.ok) {
        setError(result?.reason || 'The response could not be delivered');
        setErrors(result?.errors || {});
      }
    } catch (failure) {
      setError(String(failure.message || failure));
    } finally {
      setBusy(false);
    }
  };
  if (permission) return <PermissionCard title={prompt.displayTool || prompt.toolName} device={device}
    options={[{ index: 1, label: 'Yes' }, { index: 2, label: prompt.persistent.label },
      { index: 3, label: 'No, and tell Claude what to do differently' }]}
    feedbackIndex={3} busy={busy} error={error}
    onChoose={(index, message) => send(index === 3 ? { choice: 'deny', message } : { choice: index === 1 ? 'once' : 'always' })}
    onDecline={message => send({ choice: 'deny', message })}>
    <RequestDetail prompt={prompt} />
    <p>{prompt.toolName === 'WebFetch' ? 'Do you want to allow Claude to fetch this content?' : 'Do you want to proceed?'}</p>
  </PermissionCard>;
  const url = safeExternalUrl(prompt.url);
  const keyDown = event => {
    if (event.key === 'Enter') {
      if (event.target.tagName !== 'TEXTAREA') event.preventDefault();
      event.stopPropagation();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      send({ action: 'cancel' });
    }
  };
  return <section className="prompt-form" tabIndex={0}
    onClick={event => event.stopPropagation()} onKeyDown={keyDown}
    aria-label="MCP input request">
    <header className="prompt-eyebrow">{`MCP server ${prompt.serverName || ''} asks`}</header>
    <div className="prompt-detail">
      <>
        <p>{prompt.message}</p>
        {prompt.mode === 'url' ? <div className="prompt-url">
          <strong>{url ? new URL(url).host : 'Invalid URL'}</strong><p>{prompt.url}</p>
          {device === 'phone' && url ? <a href={url} target="_blank" rel="noopener noreferrer">Open in browser</a>
            : <button type="button" disabled={busy || !url} onClick={() => send({ action: 'open-url' })}>Open in browser</button>}
        </div> : Object.entries(prompt.schema.properties).map(([name, field]) => <Field key={name}
          name={`${ask.id}-${name}`} field={{ ...field, title: field.title || name }} value={content[name]}
          required={prompt.schema.required?.includes(name)} error={errors[name]}
          change={value => setContent(current => {
            const next = { ...current };
            if (value === undefined) delete next[name];
            else next[name] = value;
            return next;
          })} />)}
      </>
    </div>
    <footer className="prompt-actions">
      <button className="prompt-primary" type="button" disabled={busy} onClick={() => send({ action: 'accept' })}>{prompt.mode === 'url' ? "I'm done, continue" : 'Accept'}</button>
      <button className="prompt-secondary" type="button" disabled={busy} onClick={() => send({ action: 'decline' })}>Decline</button>
      <button className="prompt-secondary" type="button" disabled={busy} onClick={() => send({ action: 'cancel' })}>Cancel</button>
    </footer>
    {error || errors._form ? <p className="prompt-error" role="alert">{error || errors._form}</p> : null}
  </section>;
}
