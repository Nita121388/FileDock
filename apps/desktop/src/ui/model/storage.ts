import type { AppState } from "./state";
import { normalizeLayoutNode } from "./layout";

const KEY = "filedock.desktop.state.v1";

export function loadState(): AppState | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AppState;
    if (!parsed || typeof parsed !== "object") return null;
    if (!Array.isArray(parsed.tabs) || typeof parsed.activeTabId !== "string") return null;

    // Best-effort migration/normalization for evolving layout schemas.
    parsed.tabs = parsed.tabs.map((t) => ({
      ...t,
      root: normalizeLayoutNode(t.root as any)
    })) as any;
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
