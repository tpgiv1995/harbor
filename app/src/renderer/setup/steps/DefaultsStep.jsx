import React, { useEffect, useMemo, useState } from 'react';
import model from '../wizard-model.cjs';
import { Field, Segmented, errorFor } from './controls.jsx';

// Step 7. New-session defaults, then the review.
//
// The model list is NOT hardcoded here. It comes from the same
// new-session:options IPC the rest of the app uses, which reads the model
// catalog, which learns its ids by scanning the installed Claude CLI. Hand
// pinning a list here would recreate exactly the failure that catalog was built
// to end: a model shipping and Harbor's menu missing it.
//
// The review below is not a summary. It is the config object itself, run
// through the same derive-and-validate the save runs, so what the user reads is
// what gets written, and a config the schema would reject is reported here
// rather than after the button.
const PROVIDER_LABEL = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor' };

export function DefaultsStep({ state, patch, baseConfig, errors, showErrors }) {
  const shown = showErrors ? errors : [];
  const [options, setOptions] = useState(null);
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const enabled = model.enabledProviders(state);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const result = await window.harbor.session.newOptions();
        if (alive) setOptions(result);
      } catch { if (alive) setOptions({ providers: {} }); }
    })();
    return () => { alive = false; };
  }, []);

  // The SAME base Finish merges onto. Previewing against an empty base would
  // render a different config than the one that gets written, which is exactly
  // the way a review screen lies.
  const config = useMemo(
    () => model.configFromWizard(state, baseConfig || {}),
    [state, baseConfig],
  );

  useEffect(() => {
    let alive = true;
    (async () => {
      const result = await window.harbor.setup.preview({ config });
      if (!alive) return;
      if (result?.ok) { setPreview(result.config); setPreviewError(null); } else {
        setPreview(null);
        setPreviewError(result?.reason || 'Harbor could not build a valid config from these answers.');
      }
    })();
    return () => { alive = false; };
  }, [JSON.stringify(config)]);

  const registry = options?.providers || {};
  const models = registry[state.defaults.provider]?.models || [];
  const efforts = state.defaults.provider === 'codex'
    ? ['low', 'medium', 'high', 'xhigh']
    : (state.defaults.provider === 'cursor' ? [] : ['default', ...model.EFFORT_LEVELS]);

  const set = (patchObj) => patch((prev) => ({ ...prev, defaults: { ...prev.defaults, ...patchObj } }));

  return (
    <div className="setup-pane">
      <p className="setup-lede">
        What a new session starts as. You can change any of it per session from the command bar.
      </p>

      <div className="setup-card">
        <h2 className="setup-card-title">New sessions</h2>
        <Field label="Provider" error={errorFor(shown, 'defaults.provider')}>
          <Segmented
            name="Default provider"
            options={enabled.map((provider) => ({ value: provider, label: PROVIDER_LABEL[provider] || provider }))}
            value={state.defaults.provider}
            onChange={(provider) => {
              const next = registry[provider]?.models?.[0]?.value
                || (provider === 'claude' ? 'opus' : 'default');
              set({
                provider,
                model: next,
                effort: provider === 'codex' ? 'medium' : (provider === 'cursor' ? 'default' : 'xhigh'),
              });
            }}
          />
        </Field>

        <Field
          label="Model"
          error={errorFor(shown, 'defaults.model')}
          hint={state.defaults.provider === 'claude'
            ? 'Family aliases resolve to whatever the current flagship is, so a new release needs no change here.'
            : undefined}
        >
          {models.length ? (
            <Segmented
              name="Default model"
              options={models}
              value={state.defaults.model}
              onChange={(value) => set({ model: value })}
            />
          ) : (
            <span className="setup-note-fine">
              Harbor could not read the model list for this provider. The saved default stays
              <code> {state.defaults.model}</code>.
            </span>
          )}
        </Field>

        {efforts.length ? (
          <Field label="Effort" error={errorFor(shown, 'defaults.effort')}>
            <Segmented
              name="Default effort"
              options={efforts}
              value={state.defaults.effort}
              onChange={(value) => set({ effort: value })}
            />
          </Field>
        ) : (
          <p className="setup-note-fine">Cursor does not expose effort levels, so there is nothing to set.</p>
        )}
      </div>

      <div className="setup-card setup-review">
        <h2 className="setup-card-title">This is exactly what will be written</h2>
        {previewError ? (
          <p className="setup-error">{previewError}</p>
        ) : (
          <>
            <p className="setup-note-fine">
              {preview
                ? 'Validated against Harbor’s config schema. Nothing is written until you press Finish.'
                : 'Building…'}
            </p>
            <pre className="setup-json" aria-label="Config preview">
              {preview ? JSON.stringify(preview, null, 2) : ''}
            </pre>
          </>
        )}
        <p className="setup-note-fine">
          No credential appears anywhere in this file, and none ever will. Claude, Codex and Cursor
          each keep their own sign-in; Harbor only records which folder holds each one.
        </p>
      </div>
    </div>
  );
}
