'use strict';

// The permission-mode display contract, in ONE place. Until 2026-08-28 this
// exact logic lived as a character-identical ternary in CommandBar.jsx and
// NewSessionConfig.jsx with MODE_LABEL pasted into both — and the 2026-08-16
// bug this file's `null` handling fixes was PRECISELY those surfaces
// disagreeing (the popover printed "unreadable" over a dead button while the
// bar knew better). Pasted logic recreates that drift on the next edit;
// shared logic cannot.
//
// `null` has two causes and they are different news:
//   - Harbor is DRIVING the session (a live, drivable pane) and the scrape
//     genuinely failed → "unreadable".
//   - Harbor is NOT driving it (no pane, a read-only worker, an
//     externally-controlled or external-live session) → the mode was never
//     readable in the first place, because it is scraped off a pty and typed
//     into with shift+tab → "not controlled".
// Callers pass `driving` accordingly; a component that keys this on pane
// presence alone will lie for the pane-but-not-drivable classes.

// The labels themselves are upstream's single table; this module only adds the
// null-mode split on top of it.
const { MODE_LABEL } = require('./permission-modes.cjs');

function permModeStatus(mode, driving) {
  if (mode === undefined) return 'reading…';
  if (mode === null) return driving ? 'unreadable' : 'not controlled';
  return MODE_LABEL[mode] || mode;
}

module.exports = { MODE_LABEL, permModeStatus };
