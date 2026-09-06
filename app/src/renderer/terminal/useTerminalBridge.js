import { useCallback, useEffect, useRef, useState } from 'react';

const EMPTY_STATE = {
  workspaces: [],
  tabs: [],
  layouts: {},
  focusedWorkspaceId: null,
  controlledPaneId: null,
  controlledPaneTabId: null,
  externalControl: {},
};

export function useTerminalBridge() {
  const [state, setState] = useState(EMPTY_STATE);
  const frameListeners = useRef(new Set());
  const backfillListeners = useRef(new Set());
  const resetListeners = useRef(new Set());
  const controlListeners = useRef(new Set());

  useEffect(() => {
    let cancelled = false;
    window.harbor.terminal.getState().then((payload) => {
      if (!cancelled && payload) setState(payload);
    });

    const unsubs = [
      window.harbor.terminal.onUpdate((payload) => setState(payload || EMPTY_STATE)),
      window.harbor.terminal.onFrame((payload) => {
        for (const listener of frameListeners.current) listener(payload);
      }),
      window.harbor.terminal.onBackfill((payload) => {
        for (const listener of backfillListeners.current) listener(payload);
      }),
      window.harbor.terminal.onReset((payload) => {
        for (const listener of resetListeners.current) listener(payload);
      }),
      window.harbor.terminal.onControlState((payload) => {
        for (const listener of controlListeners.current) listener(payload);
      }),
    ];

    return () => {
      cancelled = true;
      for (const unsub of unsubs) unsub();
    };
  }, []);

  const onFrame = useCallback((listener) => {
    frameListeners.current.add(listener);
    return () => frameListeners.current.delete(listener);
  }, []);

  const onBackfill = useCallback((listener) => {
    backfillListeners.current.add(listener);
    return () => backfillListeners.current.delete(listener);
  }, []);

  const onReset = useCallback((listener) => {
    resetListeners.current.add(listener);
    return () => resetListeners.current.delete(listener);
  }, []);

  const onControlState = useCallback((listener) => {
    controlListeners.current.add(listener);
    return () => controlListeners.current.delete(listener);
  }, []);

  return {
    state,
    onFrame,
    onBackfill,
    onReset,
    onControlState,
    setVisiblePanes: window.harbor.terminal.setVisiblePanes,
    focusPane: window.harbor.terminal.focusPane,
    blurPane: window.harbor.terminal.blurPane,
    sendInput: window.harbor.terminal.sendInput,
    resizePane: window.harbor.terminal.resizePane,
    focusWorkspace: window.harbor.terminal.focusWorkspace,
    createWorkspace: window.harbor.terminal.createWorkspace,
    closeWorkspace: window.harbor.terminal.closeWorkspace,
    focusTab: window.harbor.terminal.focusTab,
    createTab: window.harbor.terminal.createTab,
    closeTab: window.harbor.terminal.closeTab,
    renameTab: window.harbor.terminal.renameTab,
  };
}
