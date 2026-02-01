import { useEffect, useMemo, useState } from "react";
import { WorkspaceView } from "./components/WorkspaceView";
import {
  DEFAULT_APP_STATE,
  type AppState,
  type TabState,
  newTab,
  removeTab
} from "./model/state";
import { loadState, saveState } from "./model/storage";

export default function App() {
  const [state, setState] = useState<AppState>(() => loadState() ?? DEFAULT_APP_STATE);

  useEffect(() => {
    saveState(state);
  }, [state]);

  const activeTab: TabState = useMemo(() => {
    const t = state.tabs.find((x) => x.id === state.activeTabId);
    return t ?? state.tabs[0];
  }, [state]);

  const setActiveTab = (tabId: string) => {
    setState((s) => ({ ...s, activeTabId: tabId }));
  };

  const onNewTab = () => {
    setState((s) => {
      const t = newTab("Workspace");
      return {
        ...s,
        tabs: [...s.tabs, t],
        activeTabId: t.id
      };
    });
  };

  const onCloseTab = (tabId: string) => {
    setState((s) => {
      const next = removeTab(s, tabId);
      return next;
    });
  };

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <h1>FileDock</h1>
          <div className="meta">desktop UI shell</div>
        </div>

        <div className="tabs" role="tablist" aria-label="Workspaces">
          {state.tabs.map((t) => (
            <div
              key={t.id}
              className={t.id === activeTab.id ? "tab active" : "tab"}
              role="tab"
              aria-selected={t.id === activeTab.id}
              tabIndex={0}
              onClick={() => setActiveTab(t.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") setActiveTab(t.id);
              }}
            >
              <span className="dot" />
              <span>{t.name}</span>
              {state.tabs.length > 1 ? (
                <button
                  className="tab-close"
                  title="Close tab"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(t.id);
                  }}
                >
                  x
                </button>
              ) : null}
            </div>
          ))}
        </div>

        <button className="btn primary" onClick={onNewTab} title="New tab">
          + Tab
        </button>
      </div>

      <div className="workspace" role="main">
        <WorkspaceView
          tab={activeTab}
          onTabChange={(tab) => {
            setState((s) => ({
              ...s,
              tabs: s.tabs.map((x) => (x.id === tab.id ? tab : x))
            }));
          }}
        />
      </div>

      <div className="statusbar">
        <span className="kbd">Split</span> via pane toolbar
        <span className="kbd">Drag</span> gutters to resize
        <span className="kbd">Persist</span> layouts saved locally per tab
      </div>
    </div>
  );
}

