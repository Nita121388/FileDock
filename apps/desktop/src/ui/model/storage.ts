import type { AppState } from "./state";
import { normalizeLayoutNode } from "./layout";

const KEY = "filedock.desktop.state.v1";
const ACTIVE_LEAF_KEY = "filedock.desktop.activeLeafByTab.v1";

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

export function loadActiveLeafByTab(): Record<string, string> {
  try {
    const raw = localStorage.getItem(ACTIVE_LEAF_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as any;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof k === "string" && typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveActiveLeafByTab(map: Record<string, string>): void {
  try {
    localStorage.setItem(ACTIVE_LEAF_KEY, JSON.stringify(map));
  } catch {
    // Ignore quota / disabled storage; app still works.
  }
}
