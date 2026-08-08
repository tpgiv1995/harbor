#!/bin/sh
':' //; exec node "$0" "$@"
'use strict';

// The single daemon-health contract for every bin organ: make a timed,
// main-thread request. `herdr status` is intentionally absent because a zombie
// listener can serve it while session.snapshot is permanently wedged.
const { healthy } = require('./harbor-bin.cjs');
process.exitCode = healthy() ? 0 : 1;
