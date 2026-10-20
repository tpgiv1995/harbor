import React, { useEffect, useRef, useState } from 'react';
import model from '../wizard-model.cjs';
import homeCheck from '../codex-home-check.cjs';
import { Field, PathInput, TextInput, Toggle, errorFor } from './controls.jsx';

// Step 3. Codex (any number of accounts) and Cursor, same shape as the Claude
// step: detect the binary, confirm the account where it can be read, allow zero.
//
// A Codex account IS readable (2026-10-15): its home's auth.json carries the
// ChatGPT login's id_token, and main reads back only that token's email claim,
// the same confirmation the Claude step shows from .claude.json. An API-key
// login has no email and says so. Cursor still records no account email Harbor
// can read, so it shows no confirmation line rather than a guessed one.
function CodexAccounts({ state, patch, errors }) {
  const accounts = state.codex.accounts || [];
  const [note, setNote] = useState(null);
  // Rows being read back, by account id (never by index: a removed row shifts
  // every index after it).
  const [checking, setChecking] = useState({});
  const patchRef = useRef(patch);
  patchRef.current = patch;
  const checkerRef = useRef(null);
  // Debounced, tagged by account id and path; an answer for a row that is gone
  // or whose home changed since is dropped.
  // Built lazily and dropped on unmount, so a remount (StrictMode) gets a live one.
  const checker = () => {
    if (!checkerRef.current) {
      checkerRef.current = homeCheck.createCodexHomeChecker({
        readHome: (payload) => window.harbor.setup.readHome(payload),
        apply: (accountId, home, fields) => patchRef.current((prev) => homeCheck.applyCodexHomeResult(prev, accountId, home, fields)),
        onChecking: (accountId, busy) => setChecking((prev) => {
          if (Boolean(prev[accountId]) === busy) return prev;
          const next = { ...prev };
          if (busy) next[accountId] = true;
          else delete next[accountId];
          return next;
        }),
      });
    }
    return checkerRef.current;
  };
  useEffect(() => () => {
    checkerRef.current?.dispose();
    checkerRef.current = null;
  }, []);

  const setAccount = (accountId, patchObj) => patch((prev) => ({
    ...prev,
    codex: {
      ...prev.codex,
      accounts: prev.codex.accounts.map((account) => (account.id === accountId ? { ...account, ...patchObj } : account)),
    },
  }));

  const recheck = (accountId, home, options) => checker().check(accountId, home, options);

  const signIn = async (account) => {
    const result = await window.harbor.setup.login({
      provider: 'codex',
      bin: state.codex.bin,
      configHome: account.configHome,
    });
    setNote(result?.launched
      ? { kind: 'ok', text: result.note, command: result.manualCommand, label: result.manualCommandLabel }
      : { kind: 'warn', text: result?.reason || 'Harbor could not open a terminal.', command: result?.manualCommand, label: result?.manualCommandLabel });
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
                onClick={() => {
                  checker().cancel(account.id);
                  patch((prev) => ({
                    ...prev,
                    codex: { ...prev.codex, accounts: prev.codex.accounts.filter((row) => row.id !== account.id) },
                  }));
                }}
              >
                Remove
              </button>
            ) : null}
          </div>
          <div className="setup-grid">
            <Field label="Name" error={errorFor(errors, `codex.accounts.${index}.label`)}>
              <TextInput value={account.label} onChange={(value) => setAccount(account.id, { label: value })} />
            </Field>
            <Field
              label="Codex home"
              error={errorFor(errors, `codex.accounts.${index}.configHome`)}
              hint="The folder holding this account's codex sessions."
            >
              <PathInput
                value={account.configHome}
                onChange={(value) => { setAccount(account.id, { configHome: value, email: null, emailReason: null }); recheck(account.id, value); }}
                placeholder="/home/you/.codex"
                title="Choose the codex home"
              />
            </Field>
          </div>
          <div className="setup-account" data-authed={account.email ? '1' : '0'}>
            <span className="setup-account-dot" aria-hidden="true" />
            <span className="setup-account-note">
              {checking[account.id] ? 'Checking…'
                : account.email ? <>Signed in as <strong>{account.email}</strong></>
                  : (account.emailReason || 'No account email read from this home yet. Sign in, then check again.')}
            </span>
            {!account.email ? (
              <button type="button" className="setup-btn ghost setup-recheck" onClick={() => recheck(account.id, account.configHome, { immediate: true })}>
                Check again
              </button>
            ) : null}
            <button type="button" className="setup-btn ghost setup-signin" onClick={() => signIn(account)}>
              Sign in
            </button>
          </div>
        </div>
      ))}
      {note ? (
        <div className={`setup-note ${note.kind === 'ok' ? '' : 'warn'}`}>
          <p>{note.text}</p>
          {note.command ? <><div className="setup-note-fine">{note.label || 'Shell command'}</div>
            <div className="setup-cmd"><code>{note.command}</code></div></> : null}
        </div>
      ) : null}
      <button
        type="button"
        className="setup-btn ghost setup-add-codex"
        onClick={() => patch((prev) => ({
          ...prev,
          codex: {
            ...prev.codex,
            accounts: [...prev.codex.accounts, model.seedCodexAccount({}, prev.codex.accounts.length, prev.codex.accounts)],
          },
        }))}
      >
        {accounts.length ? '+ Add another Codex account' : '+ Add a Codex account'}
      </button>
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
