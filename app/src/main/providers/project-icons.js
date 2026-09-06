'use strict';

// User project icons: the per-project image Harbor draws in every place it would
// otherwise draw a coloured dot (rail rows, window headers, the command bar
// status, the Artifacts view, the Orch project picker).
//
// The icons live in the USER's data directory, never in the repo. The original
// mechanism resolved them with a build-time `import.meta.glob` over
// app/assets/project-icons/, which made a personal icon set into repo content,
// and that is exactly how the whole feature was lost: the 2026-07-29 share pass
// deleted 53 icons named for household and employer projects (correctly, they
// were personal data in a shared repo) and every icon surface fell back to the
// dot, because an icon had nowhere else it could live. A user directory fixes
// the cause rather than the symptom, and it also means adding an icon no longer
// needs a renderer rebuild or a checkout.
//
// The bundled app/assets/project-icons/ folder still works and still ships
// empty; the user directory takes precedence over it.
//
// Nothing here trusts a name from the renderer. `filePathFor` answers only for a
// file the index actually found in the directory, so a served path can never be
// composed from renderer input (no traversal, no absolute paths, no symlink
// chase out of the folder).

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

// Extension priority, so a slug owning both foo.png and foo.svg resolves the
// same way on every machine instead of by readdir order.
const ICON_EXTENSIONS = ['.png', '.svg', '.webp', '.jpg', '.jpeg', '.gif'];

const MIME_BY_EXTENSION = {
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
};

// A slug is the icon's filename without its extension: lowercase, because the
// renderer slugifies labels to lowercase, and free of path separators so a slug
// can never address a parent directory.
const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;

function resolveIconsDir({ env = process.env, configuredDir = null, app = null } = {}) {
  // Env first, deliberately: a harness must be able to point this at a
  // throwaway directory and outrank whatever the composed config says (the
  // 2026-07-28 lesson, where composition started outranking HARBOR_ARTIFACTS_*
  // and an isolated app read the real store).
  if (env.HARBOR_PROJECT_ICONS_DIR) return path.resolve(env.HARBOR_PROJECT_ICONS_DIR);
  if (configuredDir) return path.resolve(configuredDir);
  const electronApp = app || require('electron').app;
  return path.join(electronApp.getPath('userData'), 'project-icons');
}

function createProjectIconProvider(options = {}) {
  const dir = resolveIconsDir(options);
  const scheme = options.scheme || 'harbor-icon';
  const logger = options.logger || console;
  let index = null;
  let watcher = null;
  let debounce = null;

  const urlFor = (file, mtimeMs) =>
    // The mtime query is a cache buster: replacing an icon in place must repaint
    // it, and without it Chromium keeps serving the bytes it already has.
    `${scheme}://local/${encodeURIComponent(file)}?v=${Math.round(mtimeMs)}`;

  async function buildIndex() {
    const bySlug = new Map();
    const byFile = new Map();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') logger.error(`Harbor project icons: cannot read ${dir}:`, error);
      // Create it so the folder is discoverable rather than a documented
      // absence. A failure here is not fatal: no icons simply means dots.
      await fsp.mkdir(dir, { recursive: true }).catch(() => {});
      return { dir, bySlug, byFile };
    }
    const candidates = [];
    for (const entry of entries) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const extension = path.extname(entry.name).toLowerCase();
      if (!ICON_EXTENSIONS.includes(extension)) continue;
      const slug = entry.name.slice(0, -extension.length).toLowerCase();
      if (!SLUG_RE.test(slug)) continue;
      candidates.push({ slug, file: entry.name, extension });
    }
    // Sort so extension priority decides a slug collision deterministically.
    candidates.sort((a, b) =>
      a.slug.localeCompare(b.slug) ||
      ICON_EXTENSIONS.indexOf(a.extension) - ICON_EXTENSIONS.indexOf(b.extension));
    for (const candidate of candidates) {
      if (bySlug.has(candidate.slug)) continue;
      const filePath = path.join(dir, candidate.file);
      let stat;
      try { stat = await fsp.stat(filePath); } catch { continue; }
      if (!stat.isFile()) continue;
      bySlug.set(candidate.slug, { file: candidate.file, url: urlFor(candidate.file, stat.mtimeMs) });
      byFile.set(candidate.file, filePath);
    }
    return { dir, bySlug, byFile };
  }

  async function ensureIndex() {
    if (!index) index = await buildIndex();
    return index;
  }

  async function list() {
    const current = await ensureIndex();
    const icons = {};
    for (const [slug, entry] of current.bySlug) icons[slug] = entry.url;
    return { dir: current.dir, icons };
  }

  return {
    dir,
    list,
    /** Absolute path for a filename the index found, or null for anything else. */
    async filePathFor(file) {
      if (typeof file !== 'string' || !file || file.includes('/') || file.includes('\\')) return null;
      const current = await ensureIndex();
      return current.byFile.get(file) || null;
    },
    mimeFor(file) {
      return MIME_BY_EXTENSION[path.extname(String(file)).toLowerCase()] || null;
    },
    /** Drop the cached index so the next read re-scans the directory. */
    invalidate() { index = null; },
    /**
     * Watch the directory and call back with a fresh list whenever it changes,
     * so dropping an icon in shows up without restarting the app.
     */
    watch(onChange) {
      if (watcher) return () => {};
      try {
        fs.mkdirSync(dir, { recursive: true });
        watcher = fs.watch(dir, () => {
          clearTimeout(debounce);
          debounce = setTimeout(() => {
            index = null;
            list().then(onChange).catch(() => {});
          }, 200);
        });
        watcher.on('error', () => { try { watcher.close(); } catch { /* already gone */ } watcher = null; });
      } catch (error) {
        // A missing watch is a degraded feature, not a broken one: icons still
        // load at boot and on the next app start.
        logger.error(`Harbor project icons: cannot watch ${dir}:`, error);
        return () => {};
      }
      return () => {
        clearTimeout(debounce);
        try { watcher?.close(); } catch { /* already gone */ }
        watcher = null;
      };
    },
  };
}

module.exports = { createProjectIconProvider, resolveIconsDir, ICON_EXTENSIONS, SLUG_RE };
