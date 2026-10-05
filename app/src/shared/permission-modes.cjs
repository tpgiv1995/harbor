'use strict';

// Keys match session-send's permission-mode readback, not the CLI's config keys.
const MODE_LABEL = Object.freeze({
  default: 'default · asks before edits',
  plan: 'plan mode · read-only',
  'accept-edits': 'accept edits',
  bypass: 'bypass permissions',
  auto: 'auto mode · classifier reviews',
});

module.exports = { MODE_LABEL };
