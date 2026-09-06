// ESM view of the wizard model. Deliberately a RE-EXPORT and not a twin.
//
// The three real ESM/CommonJS twin pairs in this repo live in src/shared/ and
// must be edited together, which is a standing drift hazard. Renderer-side pure
// modules (compose-doc, slash-tokens, file-drop, provisional-upgrade) avoid that
// entirely by shipping CommonJS only and being imported straight from JSX, and
// this module follows them: wizard-model.cjs holds every rule, and this file
// exists so an ESM caller that prefers named imports has them without a second
// copy of the logic to drift from. Adding logic here would recreate exactly the
// hazard the .cjs-only convention was adopted to remove.

import model from './wizard-model.cjs';

export const {
  STEPS,
  STEP_IDS,
  PROFILE_SEEDS,
  EFFORT_LEVELS,
  SHARED_ENTRIES,
  NEVER_SHARED,
  stepIndex,
  initialState,
  seedProfile,
  seedCodexAccount,
  stepValidation,
  canAdvance,
  canFinish,
  blockingSteps,
  nextStep,
  previousStep,
  accountCount,
  enabledProviders,
  configFromWizard,
  symlinkPlan,
  addProfile,
  updateProfile,
  removeProfile,
  reconcileDefaults,
  reconcileSymlinks,
} = model;

export default model;
