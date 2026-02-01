import type { AppState } from "./state";

const KEY = "filedock.desktop.state.v1";

export function loadState(): AppState | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AppState;
    if (!parsed || typeof parsed !== "object") return null;
    if (!Array.isArray(parsed.tabs) || typeof parsed.activeTabId !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveState(state: AppState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Ignore quota / disabled storage; app still works.
  }
}

