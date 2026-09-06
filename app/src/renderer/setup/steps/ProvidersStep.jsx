import React, { useState } from 'react';
import model from '../wizard-model.cjs';
import { Field, PathInput, TextInput, Toggle, errorFor } from './controls.jsx';

// Step 3. Codex (up to two accounts) and Cursor, same shape as the Claude step:
// detect the binary, confirm the account where it can be read, allow zero.
//
// The honest part of this screen is what it does NOT show. Neither codex nor
// cursor records an account email anywhere Harbor can read, so there is no
// confirmation line to render for them. Inventing one, or quietly showing the
// Claude email next to a Codex account, would be exactly the confident guess
// this wizard refuses to make; instead each says where to confirm it.
function CodexAccounts({ state, patch, errors }) {
  const accounts = state.codex.accounts || [];
  const [note, setNote] = useState(null);

  const setAccount = (index, patchObj) => patch((prev) => ({
    ...prev,
    codex: {
      ...prev.codex,
      accounts: prev.codex.accounts.map((account, i) => (i === index ? { ...account, ...patchObj } : account)),
    },
  }));

  const signIn = async (account) => {
    const result = await window.harbor.setup.login({
      provider: 'codex',
      bin: state.codex.bin,
      configHome: account.configHome,
    });
    setNote(result?.launched
      ? { kind: 'ok', text: result.note, command: result.manualCommand }
      : { kind: 'warn', text: result?.reason || 'Harbor could not open a terminal.', command: result?.manualCommand });
  };

  return (
    <>
      {accounts.map((account, index) => (
        <div className="setup-subcard" key={account.id}>
          <div className="setup-profile-head">
            <span className="setup-badge" style={{ background: account.color }}>{account.letter}</span>
            <strong className="setup-profile-name">{account.label}</strong>
            {accounts.length > 1 ? (
              <button
                type="button"
                className="setup-btn ghost setup-remove"
                onClick={() => patch((prev) => ({
                  ...prev,
                  codex: { ...prev.codex, accounts: prev.codex.accounts.filter((_, i) => i !== index) },
                }))}
              >
                Remove
              </button>
            ) : null}
          </div>
          <div className="setup-grid">
            <Field label="Name" error={errorFor(errors, `codex.accounts.${index}.label`)}>
              <TextInput value={account.label} onChange={(value) => setAccount(index, { label: value })} />
            </Field>
            <Field
              label="Codex home"
              error={errorFor(errors, `codex.accounts.${index}.configHome`)}
              hint="The folder holding this account's codex sessions."
            >
              <PathInput
                value={account.configHome}
                onChange={(value) => setAccount(index, { configHome: value })}
                placeholder="/home/you/.codex"
                title="Choose the codex home"
              />
            </Field>
          </div>
          <div className="setup-account" data-authed="0">
            <span className="setup-account-dot" aria-hidden="true" />
            <span className="setup-account-note">
              Codex does not record an account email Harbor can read. Confirm the account in the codex CLI.
            </span>
            <button type="button" className="setup-btn ghost setup-signin" onClick={() => signIn(account)}>
              Sign in
            </button>
          </div>
        </div>
      ))}
      {note ? (
        <div className={`setup-note ${note.kind === 'ok' ? '' : 'warn'}`}>
          <p>{note.text}</p>
          {note.command ? <div className="setup-cmd"><code>{note.command}</code></div> : null}
        </div>
      ) : null}
      {accounts.length < 2 ? (
        <button
          type="button"
          className="setup-btn ghost setup-add-codex"
          onClick={() => patch((prev) => ({
            ...prev,
            codex: {
              ...prev.codex,
              accounts: [...prev.codex.accounts, model.seedCodexAccount({}, prev.codex.accounts.length)],
            },
          }))}
        >
          + Add a second Codex account
        </button>
      ) : null}
    </>
  );
}

export function ProvidersStep({ state, patch, detected, errors, showErrors }) {
  const shown = showErrors ? errors : [];
  const providers = detected?.providers || {};
  const total = model.accountCount(state);

  return (
    <div className="setup-pane">
      <p className="setup-lede">
        Harbor drives Codex and Cursor sessions the same way it drives Claude ones. Turn on the ones
        you use. Both are optional, and you can leave both off.
      </p>

      <div className="setup-card" data-provider="codex">
        <Toggle
          name="codex"
          checked={state.codex.enabled}
          onChange={(value) => patch((prev) => ({ ...prev, codex: { ...prev.codex, enabled: value, accounts: value && !prev.codex.accounts.length ? [model.seedCodexAccount(detected || {}, 0)] : prev.codex.accounts } }))}
          label="Codex"
          description={providers.codex?.found
            ? `Found at ${providers.codex.path}`
            : 'Not found on PATH. You can still enable it and enter the path yourself.'}
        />
        {state.codex.enabled ? (
          <>
            <Field label="codex binary" error={errorFor(shown, 'codex.bin')}>
              <TextInput
                value={state.codex.bin}
                onChange={(value) => patch((prev) => ({ ...prev, codex: { ...prev.codex, bin: value } }))}
                mono
                placeholder="codex"
              />
            </Field>
            <CodexAccounts state={state} patch={patch} errors={shown} />
          </>
        ) : null}
      </div>

      <div className="setup-card" data-provider="cursor">
        <Toggle
          name="cursor"
          checked={state.cursor.enabled}
          onChange={(value) => patch((prev) => ({ ...prev, cursor: { ...prev.cursor, enabled: value } }))}
          label="Cursor"
          description={providers.cursor?.found
            ? `Found at ${providers.cursor.path}`
            : 'Not found on PATH. You can still enable it and enter the path yourself.'}
        />
        {state.cursor.enabled ? (
          <>
            <div className="setup-grid">
              <Field label="cursor-agent binary" error={errorFor(shown, 'cursor.bin')}>
                <TextInput
                  value={state.cursor.bin}
                  onChange={(value) => patch((prev) => ({ ...prev, cursor: { ...prev.cursor, bin: value } }))}
                  mono
                  placeholder="cursor-agent"
                />
              </Field>
              <Field label="Cursor config folder" hint="Optional; used to find agent transcripts.">
                <PathInput
                  value={state.cursor.configHome}
                  onChange={(value) => patch((prev) => ({ ...prev, cursor: { ...prev.cursor, configHome: value } }))}
                  placeholder="/home/you/.cursor"
                  title="Choose the cursor config folder"
                />
              </Field>
            </div>
            <p className="setup-note-fine">
              Cursor transcripts do not record the folder a session ran in. Harbor recovers it when it
              can and says so honestly when it cannot, rather than guessing a project.
            </p>
          </>
        ) : null}
      </div>

      <div className="setup-summary" data-accounts={total}>
        <span className="setup-summary-count">{total}</span>
        <span className="setup-summary-text">
          {total === 0
            ? 'accounts configured. Harbor needs at least one to be useful.'
            : `account${total === 1 ? '' : 's'} configured. That is enough to finish.`}
        </span>
      </div>
      {errorFor(shown, 'accounts') ? <p className="setup-error">{errorFor(shown, 'accounts')}</p> : null}
    </div>
  );
}
