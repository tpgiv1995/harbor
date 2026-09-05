'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const api = {
  win: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    getBounds: () => ipcRenderer.invoke('window:get-bounds'),
    setBounds: (bounds) => ipcRenderer.send('window:set-bounds', bounds),
    menuAction: (action) => ipcRenderer.send('window:menu-action', action),
    onMaximizeChange: (listener) => {
      const handler = (_event, maximized) => listener(maximized);
      ipcRenderer.on('window:maximize-changed', handler);
      return () => ipcRenderer.removeListener('window:maximize-changed', handler);
    },
    onUpdateAvailable: (listener) => {
      const handler = () => listener();
      ipcRenderer.on('app:update-available', handler);
      return () => ipcRenderer.removeListener('app:update-available', handler);
    },
  },
  badge: {
    set: (payload) => ipcRenderer.send('taskbar-badge:set', payload),
  },
  sidebar: {
    getState: () => ipcRenderer.invoke('sidebar:get-state'),
    onUpdate: (listener) => {
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on('sidebar:update', handler);
      return () => ipcRenderer.removeListener('sidebar:update', handler);
    },
  },
  pane: {
    focus: (payload) => ipcRenderer.invoke('pane:focus', payload),
  },
  session: {
    resume: (payload) => ipcRenderer.invoke('resume-session', payload),
    takeover: (payload) => ipcRenderer.invoke('session:takeover', payload),
    newInProject: (payload) => ipcRenderer.invoke('new-session', payload),
    newOptions: () => ipcRenderer.invoke('new-session:options'),
    newFolder: (payload) => ipcRenderer.invoke('new-session:folder', payload),
    pickFolder: () => ipcRenderer.invoke('pick-folder'),
    pickFiles: () => ipcRenderer.invoke('pick-files'),
    preview: (payload) => ipcRenderer.invoke('session:preview', payload),
    send: (payload) => ipcRenderer.invoke('session:send', payload),
    menuState: (payload) => ipcRenderer.invoke('session:menu-state', payload),
    answerMenu: (payload) => ipcRenderer.invoke('session:menu-answer', payload),
    getSendQueue: (payload) => ipcRenderer.invoke('session:send-queue', payload),
    cancelSend: (payload) => ipcRenderer.invoke('session:cancel-send', payload),
    interrupt: (payload) => ipcRenderer.invoke('session:interrupt', payload),
    remove: (payload) => ipcRenderer.invoke('session:delete', payload),
    runWorkflow: (payload) => ipcRenderer.invoke('workflow:run', payload),
    workflowRuns: (payload) => ipcRenderer.invoke('session:workflow-runs', payload),
    onLaunched: (listener) => {
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on('session:launched', handler);
      return () => ipcRenderer.removeListener('session:launched', handler);
    },
    onSendStatus: (listener) => {
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on('send:status', handler);
      return () => ipcRenderer.removeListener('send:status', handler);
    },
  },
  clipboard: {
    saveImage: (payload) => ipcRenderer.invoke('clipboard:save-image', payload),
    readImage: () => ipcRenderer.invoke('clipboard:read-image'),
    imageDataUri: (payload) => ipcRenderer.invoke('clipboard:image-data-uri', payload),
    writeFormatted: (payload) => ipcRenderer.invoke('clipboard:write-formatted', payload),
    // The board's Copy as PNG / Copy as image: a rendered data URL onto this
    // machine's clipboard, so a board pastes straight into Teams or Outlook.
    writeImage: (payload) => ipcRenderer.invoke('clipboard:write-image', payload),
  },
  contextMenu: {
    // Spelling suggestions exist ONLY inside Chromium's context-menu params;
    // there is no API to ask for them, so main pushes a finished menu model and
    // the renderer draws it in Slate rather than as a native GTK popup.
    onShow: (listener) => {
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on('context-menu:show', handler);
      return () => ipcRenderer.removeListener('context-menu:show', handler);
    },
    replaceMisspelling: (text) => ipcRenderer.invoke('context-menu:replace-misspelling', { text }),
    addToDictionary: (word) => ipcRenderer.invoke('context-menu:add-to-dictionary', { word }),
    editAction: (action) => ipcRenderer.invoke('context-menu:edit-action', { action }),
    spellStatus: () => ipcRenderer.invoke('context-menu:spell-status'),
  },
  files: {
    // A dropped non-image file is delivered to the session as its absolute
    // path, and a File object has carried no `path` property since Electron 32:
    // webUtils is the only way to recover it, and it lives on this side of the
    // bridge. Returns '' for anything the OS did not hand us (a synthetic File
    // in a harness, a drag from inside the page), which the caller reports
    // honestly instead of inventing a path.
    pathFor: (file) => {
      try { return webUtils.getPathForFile(file) || ''; } catch { return ''; }
    },
  },
  perf: {
    // Fire-and-forget: a renderer that just stalled must not then wait on IPC.
    stall: (payload) => ipcRenderer.send('perf:stall', payload),
  },
  voice: {
    // Returns a short-lived client secret only; the API key stays in main.
    token: (payload) => ipcRenderer.invoke('voice:token', payload),
    voices: () => ipcRenderer.invoke('voice:voices'),
  },
  whisper: {
    transcribe: (payload) => ipcRenderer.invoke('whisper:transcribe', payload),
  },
  transcript: {
    open: (payload) => ipcRenderer.invoke('transcript:open', payload),
    close: (payload) => ipcRenderer.invoke('transcript:close', payload),
    onUpdate: (listener) => {
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on('transcript:update', handler);
      return () => ipcRenderer.removeListener('transcript:update', handler);
    },
  },
  links: {
    get: () => ipcRenderer.invoke('links:get'),
    onUpdate: (listener) => {
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on('links:update', handler);
      return () => ipcRenderer.removeListener('links:update', handler);
    },
  },
  diag: {
    log(events) { ipcRenderer.send('diag:input', events); },
  },
  artifacts: {
    list: () => ipcRenderer.invoke('artifacts:list'),
    thumb: (payload) => ipcRenderer.invoke('artifacts:thumb', payload),
    openExternal: (payload) => ipcRenderer.invoke('artifacts:open-external', payload),
    showInFolder: (payload) => ipcRenderer.invoke('artifacts:show-in-folder', payload),
  },
  tasks: {
    read: () => ipcRenderer.invoke('tasks:read'),
    mutate: (op) => ipcRenderer.invoke('tasks:mutate', op),
    reveal: () => ipcRenderer.invoke('tasks:reveal'),
    onChange: (listener) => {
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on('tasks:changed', handler);
      return () => ipcRenderer.removeListener('tasks:changed', handler);
    },
  },
  notes: {
    read: () => ipcRenderer.invoke('notes:read'),
    mutate: (op) => ipcRenderer.invoke('notes:mutate', op),
    onChange: (listener) => {
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on('notes:changed', handler);
      return () => ipcRenderer.removeListener('notes:changed', handler);
    },
  },
  whiteboard: {
    list: () => ipcRenderer.invoke('whiteboard:list'),
    read: (payload) => ipcRenderer.invoke('whiteboard:read', payload),
    write: (payload) => ipcRenderer.invoke('whiteboard:write', payload),
    create: (payload) => ipcRenderer.invoke('whiteboard:create', payload),
    rename: (payload) => ipcRenderer.invoke('whiteboard:rename', payload),
    delete: (payload) => ipcRenderer.invoke('whiteboard:delete', payload),
    onChange: (listener) => {
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on('whiteboard:changed', handler);
      return () => ipcRenderer.removeListener('whiteboard:changed', handler);
    },
  },
  projectIcons: {
    list: () => ipcRenderer.invoke('project-icons:list'),
    reveal: () => ipcRenderer.invoke('project-icons:reveal'),
    onUpdate: (listener) => {
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on('project-icons:update', handler);
      return () => ipcRenderer.removeListener('project-icons:update', handler);
    },
  },
  workers: {
    close: (payload) => ipcRenderer.invoke('worker:close', payload),
  },
  usage: {
    getAll: () => ipcRenderer.invoke('usage:get-all'),
    onUpdate: (listener) => {
      const handler = () => listener();
      ipcRenderer.on('usage:update', handler);
      return () => ipcRenderer.removeListener('usage:update', handler);
    },
  },
  accounts: {
    readEmails: () => ipcRenderer.invoke('accounts:read-emails'),
  },
  // First-run setup. Note what is NOT here: there is no channel that carries a
  // credential in either direction. The wizard points at config homes and
  // starts the vendors' own login commands; Claude, codex and cursor each keep
  // their own sign-in, and Harbor never sees one.
  setup: {
    state: () => ipcRenderer.invoke('setup:state'),
    detect: () => ipcRenderer.invoke('setup:detect'),
    readHome: (payload) => ipcRenderer.invoke('setup:read-home', payload),
    catalog: (payload) => ipcRenderer.invoke('setup:catalog', payload),
    pickFolder: (payload) => ipcRenderer.invoke('setup:pick-folder', payload),
    login: (payload) => ipcRenderer.invoke('setup:login', payload),
    symlinkPlan: (payload) => ipcRenderer.invoke('setup:symlink-plan', payload),
    symlinkApply: (payload) => ipcRenderer.invoke('setup:symlink-apply', payload),
    preview: (payload) => ipcRenderer.invoke('setup:preview', payload),
    save: (payload) => ipcRenderer.invoke('setup:save', payload),
    onOpen: (listener) => {
      const handler = () => listener();
      ipcRenderer.on('setup:open', handler);
      return () => ipcRenderer.removeListener('setup:open', handler);
    },
  },
  capabilities: {
    get: (payload) => ipcRenderer.invoke('capabilities:get', payload),
    permissionMode: (payload) => ipcRenderer.invoke('capabilities:permission-mode', payload),
    cyclePermissionMode: (payload) => ipcRenderer.invoke('capabilities:cycle-permission-mode', payload),
  },
  terminal: {
    getState: () => ipcRenderer.invoke('terminal:get-state'),
    setVisiblePanes: (panes) => ipcRenderer.invoke('terminal:set-visible-panes', panes),
    focusPane: (payload) => ipcRenderer.invoke('terminal:focus-pane', payload),
    blurPane: (payload) => ipcRenderer.invoke('terminal:blur-pane', payload),
    sendInput: (payload) => ipcRenderer.invoke('terminal:send-input', payload),
    resizePane: (payload) => ipcRenderer.invoke('terminal:resize-pane', payload),
    focusWorkspace: (payload) => ipcRenderer.invoke('terminal:focus-workspace', payload),
    createWorkspace: (payload) => ipcRenderer.invoke('terminal:create-workspace', payload),
    closeWorkspace: (payload) => ipcRenderer.invoke('terminal:close-workspace', payload),
    focusTab: (payload) => ipcRenderer.invoke('terminal:focus-tab', payload),
    createTab: (payload) => ipcRenderer.invoke('terminal:create-tab', payload),
    closeTab: (payload) => ipcRenderer.invoke('terminal:close-tab', payload),
    renameTab: (payload) => ipcRenderer.invoke('terminal:rename-tab', payload),
    onUpdate: (listener) => {
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on('terminal:update', handler);
      return () => ipcRenderer.removeListener('terminal:update', handler);
    },
    onFrame: (listener) => {
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on('terminal:frame', handler);
      return () => ipcRenderer.removeListener('terminal:frame', handler);
    },
    onBackfill: (listener) => {
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on('terminal:backfill', handler);
      return () => ipcRenderer.removeListener('terminal:backfill', handler);
    },
    onReset: (listener) => {
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on('terminal:reset', handler);
      return () => ipcRenderer.removeListener('terminal:reset', handler);
    },
    onControlState: (listener) => {
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on('terminal:control-state', handler);
      return () => ipcRenderer.removeListener('terminal:control-state', handler);
    },
  },
  daemon: {
    getBanner: () => ipcRenderer.invoke('daemon:get-banner'),
    retry: () => ipcRenderer.invoke('daemon:retry'),
    onBanner: (listener) => {
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on('daemon:banner', handler);
      return () => ipcRenderer.removeListener('daemon:banner', handler);
    },
  },
  orchestration: {
    listRuns: () => ipcRenderer.invoke('orchestration:list-runs'),
    getData: (payload) => ipcRenderer.invoke('orchestration:get-data', payload),
    watch: (payload) => ipcRenderer.invoke('orchestration:watch', payload),
    unwatch: () => ipcRenderer.invoke('orchestration:unwatch'),
    watchSummaries: (payload) => ipcRenderer.invoke('orchestration:watch-summaries', payload),
    unwatchSummaries: () => ipcRenderer.invoke('orchestration:unwatch-summaries'),
    kickoffResearch: (payload) => ipcRenderer.invoke('orchestration:kickoff-research', payload),
    kickoffExecute: (payload) => ipcRenderer.invoke('orchestration:kickoff-execute', payload),
    sessionPreview: (payload) => ipcRenderer.invoke('orchestration:session-preview', payload),
    onUpdate: (listener) => {
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on('orchestration:update', handler);
      return () => ipcRenderer.removeListener('orchestration:update', handler);
    },
    onSummaries: (listener) => {
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on('orchestration:summaries', handler);
      return () => ipcRenderer.removeListener('orchestration:summaries', handler);
    },
  },
};

if (process.env.HARBOR_E2E === '1') {
  api.e2e = {
    getLaunchCalls: () => ipcRenderer.invoke('e2e:get-launch-calls'),
    setLink: (payload) => ipcRenderer.invoke('e2e:set-link', payload),
    setAskTranscript: (payload) => ipcRenderer.invoke('e2e:set-ask-transcript', payload),
    emitLaunched: (payload) => ipcRenderer.invoke('e2e:emit-launched', payload),
    getMetrics: () => ipcRenderer.invoke('e2e:get-metrics'),
    sessionOwnerPid: (payload) => ipcRenderer.invoke('e2e:session-owner-pid', payload),
    markInteractive: () => ipcRenderer.invoke('e2e:mark-interactive'),
    quit: () => ipcRenderer.invoke('e2e:quit'),
  };
}

contextBridge.exposeInMainWorld('harbor', Object.freeze(api));
