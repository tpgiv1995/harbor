import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import model from './wizard-model.cjs';
import { PlatformStep } from './steps/PlatformStep.jsx';
import { ClaudeStep } from './steps/ClaudeStep.jsx';
import { ProvidersStep } from './steps/ProvidersStep.jsx';
import { CatalogStep } from './steps/CatalogStep.jsx';
import { SymlinkStep } from './steps/SymlinkStep.jsx';
import { OrchestrationStep } from './steps/OrchestrationStep.jsx';
import { DefaultsStep } from './steps/DefaultsStep.jsx';
import './setup.css';

const STEP_COMPONENTS = {
  platform: PlatformStep,
  claude: ClaudeStep,
  providers: ProvidersStep,
  catalog: CatalogStep,
  symlinks: SymlinkStep,
  orchestration: OrchestrationStep,
  defaults: DefaultsStep,
};

// The wizard shell: the step rail, the body, and the one footer that owns
// whether the user may move on. Every rule it renders comes from
// wizard-model.cjs, so the disabled Next button and the error list under it are
// the same fact drawn twice rather than two facts that can disagree.
export function SetupWizard({ onClose, dismissible = false }) {
  const [stepId, setStepId] = useState('platform');
  const [state, setState] = useState(null);
  const [detected, setDetected] = useState(null);
  // The config already on disk. Finish MERGES onto this, so re-opening the
  // wizard to change one thing cannot wipe the fields it never asks about.
  const [baseConfig, setBaseConfig] = useState({});
  const [detectError, setDetectError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [showErrors, setShowErrors] = useState(false);
  const bodyRef = useRef(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const result = await window.harbor.setup.detect();
      if (!alive) return;
      if (result?.config) setBaseConfig(result.config);
      if (!result?.ok) {
        // Detection failing is not a dead end: the wizard opens on an empty
        // state where every field is manual, which is the honest-detection
        // rule taken to its end.
        setDetectError(result?.reason || 'Harbor could not inspect this machine.');
        setState(model.initialState({}, result?.config));
        return;
      }
      setDetected(result.detected);
      setState(model.initialState(result.detected, result.config));
    })();
    return () => { alive = false; };
  }, []);

  const validation = useMemo(
    () => (state ? model.stepValidation(stepId, state) : { ok: false, errors: [] }),
    [stepId, state],
  );
  const blocking = useMemo(() => (state ? model.blockingSteps(state) : []), [state]);
  const isLast = stepId === model.STEP_IDS[model.STEP_IDS.length - 1];

  const patch = useCallback((updater) => {
    setState((prev) => {
      if (!prev) return prev;
      const next = typeof updater === 'function' ? updater(prev) : { ...prev, ...updater };
      // Two reconciliations run on every change, both for the same reason: a
      // choice made on an early step must never leave a later step pointing at
      // something that no longer exists. Defaults follow the providers that are
      // still enabled, and the sharing selection follows the homes that are
      // still configured.
      return model.reconcileSymlinks(model.reconcileDefaults(next));
    });
    setShowErrors(false);
  }, []);

  const goNext = useCallback(() => {
    if (!state) return;
    if (!model.canAdvance(stepId, state)) { setShowErrors(true); return; }
    setStepId(model.nextStep(stepId));
    setShowErrors(false);
    bodyRef.current?.scrollTo?.(0, 0);
  }, [state, stepId]);

  const goBack = useCallback(() => {
    setStepId(model.previousStep(stepId));
    setShowErrors(false);
    bodyRef.current?.scrollTo?.(0, 0);
  }, [stepId]);

  // Jumping backwards in the rail is allowed; jumping FORWARD past an invalid
  // step is not, because that is exactly the skip-into-a-dead-end the guard
  // exists to prevent.
  const jumpTo = useCallback((target) => {
    if (!state) return;
    const from = model.stepIndex(stepId);
    const to = model.stepIndex(target);
    if (to <= from) { setStepId(target); setShowErrors(false); return; }
    for (const id of model.STEP_IDS.slice(from, to)) {
      if (!model.canAdvance(id, state)) { setStepId(id); setShowErrors(true); return; }
    }
    setStepId(target);
    setShowErrors(false);
  }, [state, stepId]);

  const finish = useCallback(async () => {
    if (!state || !model.canFinish(state)) { setShowErrors(true); return; }
    setSaving(true);
    setSaveError(null);
    try {
      const config = model.configFromWizard(state, baseConfig);
      const result = await window.harbor.setup.save({ config });
      if (!result?.ok) {
        setSaveError(result?.reason || 'Harbor could not write the config.');
        return;
      }
      onClose?.({ completed: true, config: result.config });
    } finally {
      setSaving(false);
    }
  }, [state, baseConfig, onClose]);

  if (!state) {
    return (
      <div className="setup-root" data-loading="1">
        <div className="setup-shell">
          <div className="setup-loading">Looking at this machine…</div>
        </div>
      </div>
    );
  }

  const StepBody = STEP_COMPONENTS[stepId];
  const stepMeta = model.STEPS[model.stepIndex(stepId)];
  // The footer shows the reason WHENEVER Next is dead, not only after the user
  // tries to press it, because a disabled button cannot be pressed and a dead
  // control with no stated reason is its own dead end. Field-level highlighting
  // stays gated on an attempt, so a row the user just added is explained rather
  // than immediately shouted at.
  const errors = validation.ok ? [] : validation.errors;

  return (
    <div className="setup-root" role="dialog" aria-modal="true" aria-label="Set up Harbor">
      <div className="setup-shell" data-step={stepId}>
        <aside className="setup-rail">
          <div className="setup-brand">
            <span className="setup-brand-mark" aria-hidden="true" />
            <span className="setup-brand-name">Harbor</span>
          </div>
          <ol className="setup-steps">
            {model.STEPS.map((step, index) => {
              const current = step.id === stepId;
              const passed = model.stepIndex(step.id) < model.stepIndex(stepId);
              const invalid = blocking.includes(step.id);
              const stepState = current ? 'current' : (invalid && passed ? 'invalid' : (passed ? 'done' : 'upcoming'));
              return (
                <li key={step.id}>
                  <button
                    type="button"
                    className="setup-step"
                    data-step={step.id}
                    data-state={stepState}
                    aria-current={current ? 'step' : undefined}
                    onClick={() => jumpTo(step.id)}
                  >
                    <span className="setup-step-num">{stepState === 'done' ? '✓' : index + 1}</span>
                    <span className="setup-step-text">
                      <span className="setup-step-title">{step.title}</span>
                      <span className="setup-step-sub">{step.subtitle}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          {dismissible ? (
            <button type="button" className="setup-dismiss" onClick={() => onClose?.({ completed: false })}>
              Close without saving
            </button>
          ) : null}
        </aside>

        <section className="setup-main">
          <header className="setup-head">
            <h1 className="setup-title">{stepMeta.title}</h1>
            <p className="setup-sub">{stepMeta.subtitle}</p>
          </header>

          {detectError ? (
            <div className="setup-note warn" role="status">
              {detectError} Every field below is yours to fill in by hand.
            </div>
          ) : null}

          <div className="setup-body" ref={bodyRef}>
            <StepBody
              state={state}
              patch={patch}
              detected={detected}
              baseConfig={baseConfig}
              errors={validation.errors}
              showErrors={showErrors}
            />
          </div>

          <footer className="setup-foot">
            <div className="setup-foot-msg" role="status" aria-live="polite">
              {errors.length ? (
                <ul className="setup-errors">
                  {errors.map((error) => (
                    <li key={`${error.field}:${error.message}`} className="setup-error">{error.message}</li>
                  ))}
                </ul>
              ) : null}
              {saveError ? <p className="setup-error">{saveError}</p> : null}
            </div>
            <div className="setup-foot-actions">
              <button
                type="button"
                className="setup-btn ghost setup-back"
                onClick={goBack}
                disabled={stepId === model.STEP_IDS[0]}
              >
                Back
              </button>
              {isLast ? (
                <button
                  type="button"
                  className="setup-btn primary setup-finish"
                  onClick={finish}
                  disabled={!model.canFinish(state) || saving}
                  title={model.canFinish(state) ? undefined : `Fix: ${blocking.join(', ')}`}
                >
                  {saving ? 'Writing…' : 'Finish setup'}
                </button>
              ) : (
                <button
                  type="button"
                  className="setup-btn primary setup-next"
                  onClick={goNext}
                  disabled={!validation.ok}
                >
                  Next
                </button>
              )}
            </div>
          </footer>
        </section>
      </div>
    </div>
  );
}

// Boot gate. Asks main whether setup has run, opens the wizard when it has not,
// and re-opens on the app menu's Setup item. Rendered as a SIBLING of the app
// so nothing about first run is entangled with the rail or the stage.
export function SetupGate() {
  const [open, setOpen] = useState(false);
  const [completed, setCompleted] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      let state = null;
      try {
        state = await window.harbor.setup?.state?.();
      } catch { state = null; }
      if (!alive) return;
      // A MISSING answer is not "setup has not run". If the preload surface is
      // absent or the call failed, opening the wizard would throw a full-screen
      // overlay over a working app on nothing more than a stale preload after a
      // dev reload. Only a definite `completed: false` opens it.
      if (!state || typeof state.completed !== 'boolean') return;
      setCompleted(state.completed);
      if (!state.completed) setOpen(true);
    })();
    const off = window.harbor.setup?.onOpen?.(() => { setCompleted((prev) => prev ?? true); setOpen(true); });
    return () => { alive = false; off?.(); };
  }, []);

  if (!open || completed === null) return null;
  return (
    <SetupWizard
      dismissible={completed === true}
      onClose={(result) => {
        setOpen(false);
        // A finished first run has to reach the rest of the app, and every
        // provider, path and profile it just wrote is read at boot. Reloading
        // is the honest way to apply it: a partial in-place adoption would
        // leave half the app on the old config.
        if (result?.completed) window.location.reload();
      }}
    />
  );
}
