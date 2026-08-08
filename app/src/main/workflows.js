'use strict';
const { legacyConfig } = require('./config/migrate.js');

// Small, editable launcher catalog. `current` values are inherited from the
// selected session; literal values make a workflow's execution context fixed.
// Vera and log-backfill intentionally stop at launch + command delivery. Their
// pipeline internals, rate limits, and browser/email export are out of scope.
function inherit(value, currentValue) {
  return value === 'current' ? currentValue : value;
}

function cleanModel(model) {
  return model ? String(model).replace(/\[1m\]/g, '') : model;
}

function workflowPresets(config = {}) {
  return Object.fromEntries((config.workflows || []).map((workflow) => [workflow.id, {
    ...workflow,
    account: workflow.profile,
  }]));
}

const WORKFLOW_PRESETS = Object.freeze(workflowPresets(legacyConfig()));

function resolveWorkflowLaunch(id, current = {}, config = legacyConfig()) {
  const preset = workflowPresets(config)[id];
  if (!preset) throw new Error(`unknown workflow: ${id}`);
  return {
    account: inherit(preset.account, current.account),
    cwd: inherit(preset.cwd, current.cwd),
    provider: inherit(preset.provider, current.provider) || 'claude',
    model: cleanModel(inherit(preset.model, current.model)),
    effort: inherit(preset.effort, current.effort) || 'default',
    command: preset.command,
  };
}

module.exports = {
  WORKFLOW_PRESETS,
  workflowPresets,
  resolveWorkflowLaunch,
};
