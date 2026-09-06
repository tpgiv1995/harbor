import { SCROLLBACK_CAP } from '../../shared/terminal-layout.js';

export { SCROLLBACK_CAP };

export function xtermScrollbackOptions() {
  return { scrollback: SCROLLBACK_CAP };
}
