'use strict';

// Keys match session-send's permission-mode readback, not the CLI's config keys.
const MODE_LABEL = Object.freeze({
  default: 'default · asks before edits',
  plan: 'plan mode · read-only',
  'accept-edits': 'accept edits',
  bypass: 'bypass permissions',
  auto: 'auto mode · classifier reviews',
  // Codex only: its sandbox, read from the rollout's turn_context.
  'read-only': 'read-only sandbox',
});

module.exports = { MODE_LABEL };
