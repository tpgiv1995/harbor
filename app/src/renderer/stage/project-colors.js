// Stable project color assignment. The design fixes three exemplars; the rest
// of the palette stays in the same saturation/lightness family so any project
// reads as "a project color", never as a status. Hash, not registry: the same
// label gets the same hue on every machine and restart.
const PALETTE = [
  '#8b9bff', // periwinkle
  '#4ec9b6', // teal
  '#d884c8', // orchid
  '#e0b45c', // amber
  '#6fb0e0', // sky
  '#9ccc8a', // sage
  '#e09a8a', // coral
  '#74b6c6', // slate cyan
];

// Pin a label here to keep one project on a fixed hue across machines. The
// hash below already gives every project a stable colour, so this is taste.
const PINNED = {
  harbor: '#8b9bff',
};

export function projectColor(label) {
  const key = String(label || '~');
  if (PINNED[key]) return PINNED[key];
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

/** Faint project-accent tint for rail header row backgrounds. */
export function projectRowFill(label, alpha = 0.08) {
  const hex = projectColor(label);
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function homeLabel(label) {
  const key = String(label || '').trim();
  return !key || key === '~' ? 'home' : key;
}
