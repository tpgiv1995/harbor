'use strict';

class LaneError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
function fail(code, message, details) { throw new LaneError(code, message, details); }
function insist(value, code, message, details) { if (!value) fail(code, message, details); }
module.exports = { LaneError, fail, insist };
