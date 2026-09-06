import React from 'react';
import { Field, PathInput, TextInput, Toggle, errorFor } from './controls.jsx';

// Step 6. Optional, and off means OFF: the config carries
// orchestration.enabled false, and the Orch view is hidden rather than left
// standing with nothing behind it. A visible view that dead-ends on a launcher
// that does not exist is the failure this toggle prevents.
//
// The command names are configurable because they are OURS, not the product's:
// /orchestrate-research and /orchestrate-execution ship in this repo's
// .claude/commands/. A different install may name them differently.
//
// AND THE STEP SAYS WHAT IS MISSING. This view needs a delegate queue CLI that
// Harbor does not ship, and the only place that was written down was a doc no
// link reached. A screen that offers a toggle without naming its one hard
// dependency is the same dead end the toggle exists to prevent.
export function OrchestrationStep({ state, patch, detected, errors, showErrors }) {
  const shown = showErrors ? errors : [];
  const { orchestration } = state;
  const set = (patchObj) => patch((prev) => ({ ...prev, orchestration: { ...prev.orchestration, ...patchObj } }));
  const delegateCli = detected?.orchestration?.delegateCli || 'claude-delegate';
  const delegateFound = Boolean(detected?.orchestration?.delegateFound);

  return (
    <div className="setup-pane">
      <p className="setup-lede">
        Orchestration runs a research pane and an execution pane against a project, driven by two
        slash commands that hand a batch queue to a delegation CLI. Harbor does not ship that CLI.
        If you do not have one, leave this off.
      </p>

      <div className={`setup-note${delegateFound ? '' : ' warn'}`}>
        {delegateFound ? (
          <p>
            {`Found a delegation CLI on your PATH (${detected.orchestration.delegatePath}).`}
          </p>
        ) : (
          <p>
            {`No delegation CLI called ${delegateCli} was found on your PATH. You can still turn this `}
            on, but Research and Execute will open a session whose first command fails. See
            <code> docs/COMMANDS.md </code>
            for what the commands expect.
          </p>
        )}
      </div>

      <div className="setup-card">
        <Toggle
          name="orchestration"
          checked={orchestration.enabled}
          onChange={(value) => set({ enabled: value })}
          label="Enable the Orch view"
          description={orchestration.enabled
            ? 'The Orch view appears in the rail switcher.'
            : 'Off: the Orch view is hidden entirely, not shown broken.'}
        />

        {orchestration.enabled ? (
          <>
            <Field
              label="Launcher script"
              error={errorFor(shown, 'orchestration.launcher')}
              // Honest about what is in the box: the field is pre-filled with
              // the conventional location so the step does not open blocked,
              // but the hint says plainly that nothing is there yet rather than
              // letting a filled field read as a found one.
              hint={detected?.orchestration?.launcherFound
                ? `Harbor's own launcher, at ${detected.orchestration.launcher}. Change it only if you use a different wrapper.`
                : 'No launcher found. The path below is where Harbor will look; change it if yours is elsewhere.'}
              wide
            >
              <PathInput
                value={orchestration.launcher}
                onChange={(value) => set({ launcher: value })}
                placeholder="bin/ai"
                title="Choose the launcher script"
              />
            </Field>
            <div className="setup-grid">
              <Field
                label="Research command"
                error={errorFor(shown, 'orchestration.researchCommand')}
                hint="Sent into the research pane."
              >
                <TextInput
                  value={orchestration.researchCommand}
                  onChange={(value) => set({ researchCommand: value })}
                  mono
                  placeholder="/orchestrate-research"
                />
              </Field>
              <Field
                label="Execution command"
                error={errorFor(shown, 'orchestration.executionCommand')}
                hint="Sent into the execution pane."
              >
                <TextInput
                  value={orchestration.executionCommand}
                  onChange={(value) => set({ executionCommand: value })}
                  mono
                  placeholder="/orchestrate-execution"
                />
              </Field>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
