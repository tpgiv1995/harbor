'use strict';

// The opt-in preferences as the renderer sees them: read once at boot from
// setup:state (they change only through the wizard, whose Finish restarts
// Harbor), applied to the document, and readable by any component that needs
// one (the copy-paste resume command carries the same permission flags a
// launch does). CommonJS only, imported straight from JSX like the other
// renderer-side pure modules.

const { normalizePreferences } = require('../shared/preferences.cjs');

let current = normalizePreferences(null);

function appPreferences() {
  return current;
}

// The theme is a root attribute, so its stylesheet (reading-theme.css) is
// inert until it is set and the Slate palette is untouched by default.
function applyPreferences(raw, root = globalThis.document?.documentElement) {
  current = normalizePreferences(raw);
  if (root?.dataset) {
    if (current.theme === 'default') delete root.dataset.harborTheme;
    else root.dataset.harborTheme = current.theme;
  }
  return current;
}

module.exports = { appPreferences, applyPreferences };
