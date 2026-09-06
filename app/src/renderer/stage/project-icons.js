// Per-project rail icons: the image Harbor draws wherever it would otherwise
// draw a coloured dot (rail rows, window headers, the command bar status, the
// Artifacts view, the Orch project picker). Two sources, in order:
//
//   1. The USER's icon directory (<userData>/project-icons/), listed over IPC and
//      served over the harbor-icon:// scheme. This is where an icon set belongs,
//      because an icon set is named for someone's real projects. Icons added
//      there appear without a rebuild or a restart.
//   2. app/assets/project-icons/, bundled at build time by Vite. Ships EMPTY and
//      stays empty in the repo; still supported so a fork can bundle its own set.
//
// Neither having one is a supported look rather than a missing state: the caller
// draws the stable coloured dot (see ProjectIcon.jsx).
//
// A label needs no name map. `iconSlugCandidates` derives the slug from the label
// ('Team Tools' -> team-tools.png), which is what replaced the map of 26
// hardcoded real project names the 2026-07-29 share pass had to delete. If a
// label will not derive to the name you want, rename the file.
//
// Labels come from projectLabelForCwd() in main/index.js: for a folder under
// ~/dev the label is its path relative to ~/dev (e.g. "harbor", "example-app",
// "Team Tools"); the ~/dev root itself is "dev"; the home directory is "~".

import { resolveIconUrl } from './project-icon-slug.cjs';

const iconModules = import.meta.glob('../../../assets/project-icons/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
});

const BUNDLED_BY_SLUG = {};
for (const [path, url] of Object.entries(iconModules)) {
  const slug = path.slice(path.lastIndexOf('/') + 1, -4).toLowerCase(); // strip dir + ".png"
  BUNDLED_BY_SLUG[slug] = url;
}

// The user index arrives asynchronously (one IPC round trip at first use) and
// changes while the app runs when a file lands in the folder, so it is a tiny
// store rather than a constant. `version` is what subscribers watch: a number is
// a valid useSyncExternalStore snapshot, where the icon map itself would be a
// fresh object identity on every read and loop forever.
let userIcons = {};
let iconsDir = null;
let version = 0;
let loading = null;
let unwatch = null;
const listeners = new Set();

function publish(next) {
  userIcons = next?.icons || {};
  iconsDir = next?.dir || null;
  version += 1;
  for (const listener of listeners) listener();
}

function loadUserIcons() {
  const bridge = globalThis.window?.harbor?.projectIcons;
  if (!bridge || loading) return;
  loading = bridge.list()
    .then((result) => publish(result))
    .catch(() => { /* no icons is a supported state, never an error surface */ });
  // Dropping a PNG into the folder repaints without a restart, which is half the
  // point of the folder living outside the build.
  if (!unwatch && bridge.onUpdate) unwatch = bridge.onUpdate((payload) => publish(payload));
}

/** Subscribe to icon-set changes. The first subscriber triggers the load. */
export function subscribeProjectIcons(listener) {
  listeners.add(listener);
  loadUserIcons();
  return () => { listeners.delete(listener); };
}

/** Snapshot for useSyncExternalStore: bumps whenever the icon set changes. */
export function projectIconsVersion() {
  return version;
}

/** The directory icons are read from, for the help overlay and diagnostics. */
export function projectIconsDir() {
  return iconsDir;
}

/** Resolve a rail project label to an icon URL, or null for the dot. */
export function projectIconUrl(label) {
  return resolveIconUrl(label, { userIcons, bundledIcons: BUNDLED_BY_SLUG });
}
