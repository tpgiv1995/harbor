import { isChildTask } from './sidebar-model.js';

export const SCROLLBACK_CAP = 10000;

export function layoutPaneStyles(layout) {
  if (!layout?.area?.width || !layout?.panes?.length) return [];
  const { area } = layout;
  return layout.panes.map((pane) => ({
    paneId: pane.pane_id,
    focused: !!pane.focused,
    style: {
      left: `${((pane.rect.x - area.x) / area.width) * 100}%`,
      top: `${((pane.rect.y - area.y) / area.height) * 100}%`,
      width: `${(pane.rect.width / area.width) * 100}%`,
      height: `${(pane.rect.height / area.height) * 100}%`,
    },
    cols: pane.rect.width,
    rows: pane.rect.height,
  }));
}

export function tabsForWorkspace(tabs, workspaceId) {
  return (tabs || [])
    .filter((tab) => tab.workspace_id === workspaceId)
    .sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
}

export function focusedTabForWorkspace(tabs, workspaceId) {
  const workspaceTabs = tabsForWorkspace(tabs, workspaceId);
  return workspaceTabs.find((tab) => tab.focused) || workspaceTabs[0] || null;
}

// Split a workspace's tabs into the ones Pat actually opened (primary) and the
// orchestration worker tabs (BATCH TITLE: ...) that otherwise flood the strip.
// Same predicate the sidebar uses to collapse "Child tasks"; one source of truth.
export function partitionTabs(tabs, workspaceId) {
  const ordered = tabsForWorkspace(tabs, workspaceId);
  const primary = [];
  const workers = [];
  for (const tab of ordered) {
    if (isChildTask(tab.label)) workers.push(tab);
    else primary.push(tab);
  }
  return { primary, workers };
}

export function layoutForTab(layouts, tabId) {
  if (!tabId) return null;
  if (layouts instanceof Map) return layouts.get(tabId) || null;
  return layouts?.[tabId] || null;
}
