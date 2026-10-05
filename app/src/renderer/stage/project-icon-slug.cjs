'use strict';

// Rail project label -> icon slug. Pure, so the resolution order is a test
// subject rather than something only the running app knows.
//
// Labels come from projectLabelForCwd() in main/index.js: a folder under ~/dev is
// its path relative to ~/dev ('harbor', 'Team Tools', 'Data-Pipeline', and
// nested ones like 'example-chatbot/example-chatbot'), the ~/dev root is
// 'dev', the home directory is '~', and anything else is its last two segments
// ('Notes/Wiki').
//
// This derivation exists so an icon set needs no name map. The map it replaces
// was the personal-data half of the feature: 26 real household and employer
// project names hardcoded in the renderer. Slugify covers every label that map
// covered except '~', which has no letters to slugify and is handled below.

// The home directory has no name to derive, and 'home' is a generic slug rather
// than anyone's project, so it stays in code.
const BUILT_IN_SLUGS = Object.freeze({ '~': 'home' });

/**
 * Lowercase, hyphenate, and strip a label down to a filename-safe slug.
 * 'Team Tools' -> 'team-tools', 'R&D' -> 'randd', 'Notes/Wiki' ->
 * 'notes-wiki', '_ARCHIVED-Foo-DO-NOT-EDIT' -> 'archived-foo-do-not-edit'.
 */
function slugifyLabel(label) {
  if (typeof label !== 'string') return '';
  return label
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[\s/\\_]+/g, '-')
    .replace(/[^a-z0-9.-]+/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
}

/**
 * Slugs to try for a label, best first. A caller looks each one up and takes the
 * first hit, so a more specific icon always wins over a less specific one.
 */
function iconSlugCandidates(label) {
  if (typeof label !== 'string' || !label) return [];
  const candidates = [];
  const add = (slug) => {
    if (slug && !candidates.includes(slug)) candidates.push(slug);
  };
  add(BUILT_IN_SLUGS[label]);
  // The raw label, so an already-slug-shaped label needs no transformation and
  // an icon set built against the old behaviour keeps working.
  add(label);
  add(slugifyLabel(label));
  // A nested label falls back to its own segments, so a session run in a
  // subfolder still shows the project it belongs to instead of a bare dot. Both
  // are tried only AFTER the full label, so a full-label icon
  // ('notes-wiki.png') always wins.
  //
  // Leaf before parent, because the leaf is the more specific claim and each
  // direction has real cases: 'Documents/Photobook' wants the LEAF (photobook,
  // where 'documents' means nothing), while 'Surveys/Intake' and 'harbor/app'
  // want the PARENT (surveys, harbor, where the leaf is a subfolder nobody drew
  // an icon for).
  const segments = label.split(/[/\\]+/).filter(Boolean);
  if (segments.length > 1) {
    add(slugifyLabel(segments[segments.length - 1]));
    add(slugifyLabel(segments[0]));
  }
  return candidates;
}

/**
 * Resolve a label to an icon URL against the user's icons first and the bundled
 * ones second, or null when neither has one (the caller draws the dot).
 */
function resolveIconUrl(label, { userIcons = null, bundledIcons = null } = {}) {
  for (const slug of iconSlugCandidates(label)) {
    const user = userIcons ? userIcons[slug] : null;
    if (user) return user;
  }
  for (const slug of iconSlugCandidates(label)) {
    const bundled = bundledIcons ? bundledIcons[slug] : null;
    if (bundled) return bundled;
  }
  return null;
}

module.exports = { BUILT_IN_SLUGS, iconSlugCandidates, resolveIconUrl, slugifyLabel };
