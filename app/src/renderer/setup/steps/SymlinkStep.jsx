import React, { useEffect, useState } from 'react';
import model from '../wizard-model.cjs';
import { Toggle, errorFor } from './controls.jsx';

// Step 5. Optional, explained, and default OFF.
//
// The split is the whole point and it is stated on screen rather than assumed:
// CLAUDE.md, settings, commands, skills and the transcript store are SHARED so
// every plan behaves the same; .credentials.json and .claude.json stay REAL per
// home, because those are exactly what makes each home a different account.
// Sharing them would point every plan at one login, so the backend refuses them
// by name at plan time and again at apply time rather than trusting this screen.

const ACTION_LABEL = {
  create: 'will be linked',
  relink: 'will be re-pointed here',
  replace: 'exists here; will be renamed to a backup, then linked',
  'already-linked': 'already linked',
  skip: 'nothing to share',
  refuse: 'never shared',
};

export function SymlinkStep({ state, patch, detected, errors, showErrors }) {
  const shown = showErrors ? errors : [];
  const [plan, setPlan] = useState(null);
  const [applied, setApplied] = useState(null);
  const [busy, setBusy] = useState(false);
  const homes = (state.claude.profiles || []).map((profile) => profile.configHome).filter(Boolean);
  const { symlinks } = state;

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!symlinks.enabled || !symlinks.primary || !(symlinks.targets || []).length) { setPlan(null); return; }
      const result = await window.harbor.setup.symlinkPlan(model.symlinkPlan(state));
      if (alive) setPlan(result?.ok ? result.plan : null);
    })();
    return () => { alive = false; };
  }, [symlinks.enabled, symlinks.primary, (symlinks.targets || []).join('|')]);

  const set = (patchObj) => patch((prev) => ({ ...prev, symlinks: { ...prev.symlinks, ...patchObj } }));

  const toggleTarget = (home) => set({
    targets: symlinks.targets.includes(home)
      ? symlinks.targets.filter((target) => target !== home)
      : [...symlinks.targets, home],
  });

  const apply = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      setApplied(await window.harbor.setup.symlinkApply({ plan }));
    } finally {
      setBusy(false);
    }
  };

  if (homes.length < 2) {
    return (
      <div className="setup-pane">
        <p className="setup-lede">
          Sharing config across homes needs at least two Claude plans. You have {homes.length}, so
          there is nothing to share and this step has nothing to do.
        </p>
        <p className="setup-note-fine">
          If you add a second plan later, re-open this wizard from the app menu and this step will
          have something to offer.
        </p>
      </div>
    );
  }

  return (
    <div className="setup-pane">
      <p className="setup-lede">
        With more than one Claude plan you usually want the same instructions, settings, commands and
        skills in all of them, and one shared transcript store so the rail shows every session
        whichever account ran it. This is optional and off by default.
      </p>

      <div className="setup-card">
        <Toggle
          name="symlinks"
          checked={symlinks.enabled}
          onChange={(value) => set({ enabled: value })}
          label="Share config between homes"
          description={detected?.symlinkStyle === 'junction'
            ? 'Windows: folders are linked with junctions, which need no special privileges.'
            : 'Links the shared items from one home into the others.'}
        />

        <div className="setup-split">
          <div className="setup-split-col">
            <h3 className="setup-split-title">Shared</h3>
            <ul className="setup-list">
              {model.SHARED_ENTRIES.map((entry) => (
                <li key={entry.name}><code>{entry.name}</code></li>
              ))}
            </ul>
          </div>
          <div className="setup-split-col">
            <h3 className="setup-split-title">Never shared</h3>
            <ul className="setup-list never">
              {model.NEVER_SHARED.map((name) => (
                <li key={name}><code>{name}</code></li>
              ))}
            </ul>
            <p className="setup-note-fine">
              These are what make each home a separate account. Harbor refuses to link them.
            </p>
          </div>
        </div>
      </div>

      {symlinks.enabled ? (
        <div className="setup-card">
          <h2 className="setup-card-title">Which home holds the real files</h2>
          <div className="setup-radio-list">
            {homes.map((home) => (
              <label key={home} className="setup-radio">
                <input
                  type="radio"
                  name="symlink-primary"
                  checked={symlinks.primary === home}
                  onChange={() => set({ primary: home, targets: symlinks.targets.filter((target) => target !== home) })}
                />
                <code>{home}</code>
              </label>
            ))}
          </div>
          {errorFor(shown, 'symlinks.primary') ? <p className="setup-error">{errorFor(shown, 'symlinks.primary')}</p> : null}

          <h2 className="setup-card-title">Link into</h2>
          <div className="setup-radio-list">
            {homes.filter((home) => home !== symlinks.primary).map((home) => (
              <label key={home} className="setup-radio">
                <input
                  type="checkbox"
                  checked={symlinks.targets.includes(home)}
                  onChange={() => toggleTarget(home)}
                />
                <code>{home}</code>
              </label>
            ))}
          </div>
          {errorFor(shown, 'symlinks.targets') ? <p className="setup-error">{errorFor(shown, 'symlinks.targets')}</p> : null}
        </div>
      ) : null}

      {plan ? (
        <div className="setup-card">
          <h2 className="setup-card-title">Exactly what will happen</h2>
          {plan.note ? <p className="setup-note warn">{plan.note}</p> : null}
          {plan.homes.map((home) => (
            <div key={home.home} className="setup-plan-home">
              <code className="setup-plan-title">{home.home}</code>
              <ul className="setup-plan-list">
                {home.entries.map((entry) => (
                  <li key={entry.name} data-action={entry.action}>
                    <code>{entry.name}</code>
                    <span>{ACTION_LABEL[entry.action] || entry.action}</span>
                    {entry.reason ? <span className="setup-plan-reason">{entry.reason}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <button type="button" className="setup-btn primary setup-apply-links" onClick={apply} disabled={busy}>
            {busy ? 'Linking…' : 'Apply now'}
          </button>
          <p className="setup-note-fine">
            Nothing is deleted. An existing real file is renamed beside itself and the backup path is
            reported. You can also skip this and apply it later.
          </p>
        </div>
      ) : null}

      {applied ? (
        <div className={`setup-note ${applied.ok ? '' : 'warn'}`} role="status">
          {applied.ok
            ? `Linked ${applied.applied} item${applied.applied === 1 ? '' : 's'}.`
            : `${applied.failed} item${applied.failed === 1 ? '' : 's'} could not be linked.`}
          <ul className="setup-plan-list">
            {(applied.results || []).filter((entry) => entry.error || entry.warning || entry.backup).map((entry) => (
              <li key={`${entry.target}`}>
                <code>{entry.target}</code>
                <span>{entry.error || entry.warning || `backup at ${entry.backup}`}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
