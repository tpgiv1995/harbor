'use strict';

// 2026-09-20: discovery and the update installer share the Windows launcher
// rule. Node cannot exec a .cmd shim directly; never enable shell:true.
function cliCommand(bin, args, platform = process.platform) {
  return platform === 'win32' && !/\.exe$/i.test(bin)
    ? { file: 'cmd.exe', args: ['/d', '/c', bin, ...args] }
    : { file: bin, args };
}

module.exports = { cliCommand };
