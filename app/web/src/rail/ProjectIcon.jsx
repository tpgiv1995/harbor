import React, { useState } from 'react';
import { projectColor } from '../../../src/renderer/stage/project-colors.js';

export function ProjectIcon({ label, url, iconClass = 'rail-icon', dotClass = 'rail-dot' }) {
  const [failed, setFailed] = useState(null);
  if (!url || failed === url) {
    return (
      <span
        className={dotClass}
        style={{ background: projectColor(label) }}
        aria-hidden="true"
      />
    );
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

