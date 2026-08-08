'use strict';

const { writeRecord } = require('./ndjson.js');

class ObserverWriter {
  constructor(socket) {
    this.socket = socket;
    this.blocked = false;
    this.droppedFrames = 0;
    socket.on('drain', () => {
      this.blocked = false;
      if (!this.droppedFrames) return;
      const droppedFrames = this.droppedFrames;
      this.droppedFrames = 0;
      this.blocked = writeRecord(this.socket, {
        type: 'event',
        event: { type: 'stream-degraded', dropped_frames: droppedFrames },
      }) === false;
    });
  }

  send(event) {
    if (this.blocked) {
      this.droppedFrames += 1;
      return false;
    }
    this.blocked = writeRecord(this.socket, { type: 'event', event }) === false;
    return true;
  }
}

module.exports = { ObserverWriter };
