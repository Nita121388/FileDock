import { defaultLayout, uid, type LayoutNode } from "./layout";

export interface TabState {
  id: string;
  name: string;
  root: LayoutNode;
}

export interface AppState {
  activeTabId: string;
  tabs: TabState[];
}

export const DEFAULT_APP_STATE: AppState = (() => {
  const t = newTab("Workspace");
  return { activeTabId: t.id, tabs: [t] };
})();

export function newTab(name: string): TabState {
  return {
    id: uid("tab"),
    name,
    root: defaultLayout()
  };
}

export function removeTab(state: AppState, tabId: string): AppState {
  if (state.tabs.length <= 1) return state;
  const tabs = state.tabs.filter((t) => t.id !== tabId);
  let activeTabId = state.activeTabId;
  if (activeTabId === tabId) activeTabId = tabs[0]?.id ?? activeTabId;
  return { ...state, tabs, activeTabId };
}

