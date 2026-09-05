'use strict';
// THE RUNNER FOR EVERY TEST-SPAWNED DAEMON, KEEPER, AND HARNESS CHILD.
//
// Console-subsystem node.exe flashes REAL terminal windows on win32: Windows
// Terminal is the default console host on this machine, so every new console
// any child acquires opens a visible Terminal window for its lifetime. A
// suite that spawns a daemon, three keepers, and stand-in CLIs flashed eight
// of them per run, measured 2026-08-30 with an EnumWindows watcher
// (CASCADIA_HOSTING_WINDOW_CLASS, plus a classic ConsoleWindowClass and
// visible PseudoConsoleWindows), stealing focus from the user each time.
// windowsHide on the direct spawns is necessary but NOT sufficient: consoles
// allocated deeper in the chain still open host windows.
//
// Electron-as-node is the production answer already (script-exec.js runs
// every bin script that way): the Electron binary is GUI-subsystem, a GUI
// process never allocates a console, and with no console there is nothing
// for any host to show. ConPTY panes still work identically (production
// keepers have run this way since the Windows port). POSIX keeps plain node,
// the proven path, exactly as script-exec.js does.
//
// Setting ELECTRON_RUN_AS_NODE here at module load makes every descendant
// (the daemon's own keeper spawns included: cleanDaemonEnv forwards it, and
// the daemon spawns keepers with its own execPath) run as plain Node.
const path = require('node:path');

const IS_WIN32 = process.platform === 'win32';
if (IS_WIN32) process.env.ELECTRON_RUN_AS_NODE = '1';

const execPath = IS_WIN32
  ? path.join(__dirname, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe')
  : process.execPath;

module.exports = { execPath, IS_WIN32 };
