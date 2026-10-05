'use strict';

function available(detail = '') {
  return { available: true, ...(detail ? { detail } : {}) };
}

function unavailable(reason) {
  return { available: false, reason };
}

function commandAvailable(command, which) {
  try {
    return Boolean(which(command));
  } catch {
    return false;
  }
}

module.exports = { available, unavailable, commandAvailable };

