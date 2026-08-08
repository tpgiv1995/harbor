import React, { useState, useSyncExternalStore } from 'react';
import { projectColor } from './project-colors.js';
import { projectIconsVersion, projectIconUrl, subscribeProjectIcons } from './project-icons.js';

// A project's real app icon (the same one the file manager shows), used anywhere
// Harbor previously drew a per-project colored dot: the rail rows, the session
// window headers, and the command bar status. Falls back to the stable colored
// dot when the project has no icon or the image fails to load, so a missing icon
// never leaves a gap.
//
// The icon set lives in the user's own directory and is read asynchronously, so
// this subscribes: the app's first render happens before that list has arrived,
// and without a subscription every surface would keep the dot it drew on that
// first pass until something unrelated re-rendered it.
//
// `label` is the project label (folder name relative to ~/dev, or 'dev'/'~').
// `iconClass` sizes the <img> per surface; `dotClass` is the fallback dot's class.
export function ProjectIcon({ label, iconClass = 'pg-icon', dotClass = 'pg-dot' }) {
  useSyncExternalStore(subscribeProjectIcons, projectIconsVersion, projectIconsVersion);
  const url = projectIconUrl(label);
  // Keyed by URL, not a boolean: the icon set can be replaced while the app runs
  // (the folder is watched), and a new file must not inherit the old one's
  // verdict, which a sticky `true` would have handed it.
  const [failed, setFailed] = useState(null);
  if (!url || failed === url) {
    return <span className={dotClass} style={{ background: projectColor(label) }} aria-hidden="true" />;
  }
  return (
    <img
      className={iconClass}
      src={url}
      alt=""
      aria-hidden="true"
      onError={() => setFailed(url)}
    />
  );
}
