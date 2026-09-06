'use strict';

function createAppShim({ userDataDir }) {
  return {
    getPath(name) {
      if (name === 'userData') return userDataDir;
      throw new Error(`harbor-server: app.getPath('${name}') is not available headless`);
    },
  };
}

module.exports = { createAppShim };
