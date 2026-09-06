import React, { useState } from 'react';
import model from '../wizard-model.cjs';
import { Field, PathInput, Segmented, TextInput, errorFor } from './controls.jsx';

const LETTERS = ['P', 'T', 'S', 'A', 'B', 'C', 'D', 'E'];
const COLORS = ['#6fa8d8', '#d68a5a', '#F962BA', '#7bd3a0', '#c9a6ff', '#e8973f', '#79a6ff', '#d98a8a'];

// Step 2. One card per Claude plan. The email under each folder is READ BACK
// from that home's .claude.json oauthAccount, which is the whole point of the
// step: it is how the user confirms they pointed at the right account. It is
// confirmation, not a credential, and nothing else in that file is read.
//
// Zero plans is a supported answer. A codex-only or cursor-only install walks
// straight through this screen, which is why nothing here is required.
function ProfileCard({ profile, index, patch, errors, count }) {
  const [checking, setChecking] = useState(false);
  const [loginNote, setLoginNote] = useState(null);
  const at = `profiles.${index}`;

  const set = (patchObj) => patch((prev) => model.updateProfile(prev, index, patchObj));

  const recheck = async (home) => {
    const target = home || profile.configHome;
    if (!target) return;
    setChecking(true);
    try {
      const result = await window.harbor.setup.readHome({ home: target });
      if (result?.ok) {
        set({ email: result.home.email, authed: result.home.authed, exists: result.home.exists, reason: result.home.reason });
      }
    } finally {
      setChecking(false);
    }
  };

  const signIn = async () => {
    setLoginNote(null);
    const result = await window.harbor.setup.login({ provider: 'claude', configHome: profile.configHome });
    setLoginNote(result?.launched
      ? { kind: 'ok', text: result.note, command: result.manualCommand }
      : { kind: 'warn', text: result?.reason || 'Harbor could not open a terminal.', command: result?.manualCommand });
  };

  return (
    <div className="setup-card setup-profile" data-profile={profile.id}>
      <div className="setup-profile-head">
        <span className="setup-badge" style={{ background: profile.color }}>{profile.letter}</span>
        <strong className="setup-profile-name">{profile.label || 'Unnamed plan'}</strong>
        <label className="setup-default-pick">
          <input
            type="radio"
            name="default-profile"
            checked={Boolean(profile.isDefault)}
            onChange={() => set({ isDefault: true })}
          />
          <span>Default</span>
        </label>
        {count > 0 ? (
          <button
            type="button"
            className="setup-btn ghost setup-remove"
            onClick={() => patch((prev) => model.removeProfile(prev, index))}
          >
            Remove
          </button>
        ) : null}
      </div>

      <Field label="Config home" error={errorFor(errors, `${at}.configHome`)} wide>
        <PathInput
          value={profile.configHome}
          onChange={(value) => { set({ configHome: value, email: null, authed: false }); recheck(value); }}
          placeholder="/home/you/.claude"
          title="Choose this plan's config home"
        />
      </Field>

      <div className="setup-account" data-authed={profile.authed ? '1' : '0'}>
        {profile.authed ? (
          <>
            <span className="setup-account-dot" aria-hidden="true" />
            <span className="setup-account-email">{profile.email}</span>
            <span className="setup-account-note">signed in</span>
          </>
        ) : (
          <>
            <span className="setup-account-dot" aria-hidden="true" />
            <span className="setup-account-note">
              {profile.configHome
                ? (profile.reason || 'No account email recorded in this folder yet.')
                : 'Pick a folder to see which account is signed in there.'}
            </span>
            {profile.configHome ? (
              <>
                <button type="button" className="setup-btn ghost setup-signin" onClick={signIn}>
                  Sign in
                </button>
                <button type="button" className="setup-btn ghost setup-recheck" onClick={() => recheck()} disabled={checking}>
                  {checking ? 'Checking…' : 'Re-check'}
                </button>
              </>
            ) : null}
          </>
        )}
      </div>

      {loginNote ? (
        <div className={`setup-note ${loginNote.kind === 'ok' ? '' : 'warn'}`}>
          <p>{loginNote.text}</p>
          {loginNote.command ? (
            <div className="setup-cmd"><code>{loginNote.command}</code></div>
          ) : null}
        </div>
      ) : null}

      <div className="setup-grid three">
        <Field label="Name" error={errorFor(errors, `${at}.label`)}>
          <TextInput value={profile.label} onChange={(value) => set({ label: value })} placeholder="Personal" />
        </Field>
        <Field label="Id" error={errorFor(errors, `${at}.id`)} hint="Used in config and in launch commands.">
          <TextInput value={profile.id} onChange={(value) => set({ id: value })} mono placeholder="personal" />
        </Field>
        <Field label="Rail badge" error={errorFor(errors, `${at}.letter`)}>
          <Segmented
            name="Rail badge letter"
            options={LETTERS.map((letter) => ({ value: letter, label: letter }))}
            value={profile.letter}
            onChange={(value) => set({ letter: value })}
          />
        </Field>
      </div>

      <Field label="Colour" error={errorFor(errors, `${at}.color`)}>
        <span className="setup-swatches">
          {COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className="setup-swatch"
              style={{ background: color }}
              aria-label={`Use ${color}`}
              data-active={profile.color === color ? '1' : undefined}
              onClick={() => set({ color })}
            />
          ))}
        </span>
      </Field>
    </div>
  );
}

export function ClaudeStep({ state, patch, detected, errors, showErrors }) {
  const shown = showErrors ? errors : [];
  const profiles = state.claude.profiles || [];
  const known = new Set(profiles.map((profile) => profile.configHome));
  const unused = (detected?.claudeHomes || []).filter((home) => !known.has(home.path));

  return (
    <div className="setup-pane">
      <p className="setup-lede">
        A Claude plan is one config home: the folder holding that account&apos;s <code>.claude.json</code>.
        Add one per plan you want to run. Adding none is fine if you only use Codex or Cursor.
      </p>

      {profiles.map((profile, index) => (
        <ProfileCard
          key={`${profile.id}-${index}`}
          profile={profile}
          index={index}
          patch={patch}
          errors={shown}
          count={profiles.length}
        />
      ))}

      {errorFor(shown, 'profiles.default') ? (
        <p className="setup-error">{errorFor(shown, 'profiles.default')}</p>
      ) : null}

      <div className="setup-add-row">
        <button
          type="button"
          className="setup-btn ghost setup-add-profile"
          onClick={() => patch((prev) => model.addProfile(prev, {}))}
        >
          + Add a Claude plan
        </button>
        {unused.map((home) => (
          <button
            key={home.path}
            type="button"
            className="setup-btn ghost setup-add-found"
            onClick={() => patch((prev) => model.addProfile(prev, home))}
          >
            + {home.path}
            {home.email ? <span className="setup-add-email">{home.email}</span> : null}
          </button>
        ))}
      </div>

      {profiles.length === 0 ? (
        <p className="setup-note-fine">
          No Claude plans yet. Harbor still needs at least one account overall, so if you leave this
          empty you will need to enable Codex or Cursor on the next step.
        </p>
      ) : null}
    </div>
  );
}
