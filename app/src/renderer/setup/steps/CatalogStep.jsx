import React, { useEffect, useMemo, useState } from 'react';
import { Field, Segmented, TextInput, errorFor } from './controls.jsx';

// Step 4. The user's REAL skills and slash commands, not a shipped list.
//
// This step runs after the Claude step on purpose: the catalogue is enumerated
// from the config homes picked there, the same way the command bar's capability
// menu enumerates them, so what is offered here is exactly what the CLI would
// accept. Before that step there is no home to read and the list would be an
// empty box dressed up as a catalogue.
//
// What is picked here REPLACES the shipped preset list: config.workflows is
// written from this screen, so a new install gets the user's own quick commands
// instead of Pat's.

const CWD_OPTIONS = [
  { value: 'current', label: 'Current project' },
  { value: 'ask', label: 'Ask each time' },
];

function idFor(command, taken) {
  const base = String(command).replace(/^\//, '').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase() || 'command';
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n += 1) {
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }
  return `${base}-${Date.now()}`;
}

export function CatalogStep({ state, patch, errors, showErrors }) {
  const shown = showErrors ? errors : [];
  const [catalog, setCatalog] = useState(null);
  const [query, setQuery] = useState('');
  const [loadError, setLoadError] = useState(null);

  const homes = useMemo(
    () => (state.claude.profiles || []).map((profile) => profile.configHome).filter(Boolean),
    [state.claude.profiles],
  );

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!homes.length) { setCatalog({ commands: [] }); return; }
      const result = await window.harbor.setup.catalog({ homes });
      if (!alive) return;
      if (!result?.ok) { setLoadError(result?.reason || 'Could not read your commands.'); setCatalog({ commands: [] }); return; }
      setCatalog(result);
    })();
    return () => { alive = false; };
  }, [homes.join('|')]);

  const picked = state.catalog.workflows || [];
  const pickedCommands = new Set(picked.map((entry) => entry.command));

  const matches = useMemo(() => {
    const all = catalog?.commands || [];
    const q = query.trim().toLowerCase();
    const filtered = q
      ? all.filter((command) => command.name.toLowerCase().includes(q)
        || String(command.description || '').toLowerCase().includes(q))
      : all;
    return filtered.slice(0, 60);
  }, [catalog, query]);

  const add = (command) => patch((prev) => {
    const taken = new Set((prev.catalog.workflows || []).map((entry) => entry.id));
    return {
      ...prev,
      catalog: {
        ...prev.catalog,
        workflows: [...(prev.catalog.workflows || []), {
          id: idFor(command.name, taken),
          label: command.name,
          command: command.name,
          cwd: 'current',
          profile: 'current',
          provider: 'current',
          model: 'current',
          effort: 'current',
        }],
      },
    };
  });

  const update = (index, patchObj) => patch((prev) => ({
    ...prev,
    catalog: {
      ...prev.catalog,
      workflows: prev.catalog.workflows.map((entry, i) => (i === index ? { ...entry, ...patchObj } : entry)),
    },
  }));

  const remove = (index) => patch((prev) => ({
    ...prev,
    catalog: { ...prev.catalog, workflows: prev.catalog.workflows.filter((_, i) => i !== index) },
  }));

  return (
    <div className="setup-pane">
      <p className="setup-lede">
        These are the slash commands and skills Harbor found in the config homes you picked. Choose
        the ones you want as quick commands. Picking none is fine.
      </p>

      {loadError ? <div className="setup-note warn">{loadError}</div> : null}

      {!homes.length ? (
        <div className="setup-note">
          No Claude config home was configured, so there is no command catalogue to read. Codex and
          Cursor sessions do not expose one to Harbor.
        </div>
      ) : (
        <div className="setup-card">
          <h2 className="setup-card-title">
            Your commands
            {catalog ? <span className="setup-count">{catalog.commands.length}</span> : null}
          </h2>
          <TextInput
            value={query}
            onChange={setQuery}
            placeholder="Search your commands and skills"
            aria-label="Search commands"
          />
          {catalog === null ? (
            <p className="setup-note-fine">Reading your commands…</p>
          ) : (
            <ul className="setup-catalog">
              {matches.map((command) => (
                <li key={`${command.home}:${command.name}`}>
                  <button
                    type="button"
                    className="setup-cat-row"
                    data-picked={pickedCommands.has(command.name) ? '1' : undefined}
                    disabled={pickedCommands.has(command.name)}
                    onClick={() => add(command)}
                  >
                    <span className="setup-cat-name">{command.name}</span>
                    <span className="setup-cat-src">{command.source}</span>
                    {command.description ? <span className="setup-cat-desc">{command.description}</span> : null}
                  </button>
                </li>
              ))}
              {!matches.length ? <li className="setup-note-fine">Nothing matches that.</li> : null}
            </ul>
          )}
        </div>
      )}

      <div className="setup-card">
        <h2 className="setup-card-title">
          Quick commands
          <span className="setup-count">{picked.length}</span>
        </h2>
        {picked.length === 0 ? (
          <p className="setup-note-fine">
            None picked. Harbor ships with no quick commands of its own, so this list stays empty
            until you add something.
          </p>
        ) : null}
        {picked.map((entry, index) => (
          <div className="setup-subcard" key={entry.id}>
            <div className="setup-grid three">
              <Field label="Label" error={errorFor(shown, `catalog.workflows.${index}.label`)}>
                <TextInput value={entry.label} onChange={(value) => update(index, { label: value })} />
              </Field>
              <Field label="Command" error={errorFor(shown, `catalog.workflows.${index}.command`)}>
                <TextInput value={entry.command} onChange={(value) => update(index, { command: value })} mono />
              </Field>
              <Field label="Runs in">
                <Segmented
                  name="Working folder"
                  options={CWD_OPTIONS}
                  value={CWD_OPTIONS.some((option) => option.value === entry.cwd) ? entry.cwd : 'current'}
                  onChange={(value) => update(index, { cwd: value })}
                />
              </Field>
            </div>
            <button type="button" className="setup-btn ghost setup-remove" onClick={() => remove(index)}>
              Remove
            </button>
          </div>
        ))}
      </div>

      <p className="setup-note-fine">
        Which commands appear in the composer plus-menu is not part of this list. That menu reads
        your live catalogue directly every time it opens, so it is always current and needs nothing
        stored here.
      </p>
    </div>
  );
}
