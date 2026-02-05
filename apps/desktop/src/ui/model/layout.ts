import { i18next } from "../i18n";

export type SplitDir = "row" | "col";

export type PaneKind = "deviceBrowser" | "sftpBrowser" | "localBrowser" | "transferQueue" | "notes";

export type DropZone = "center" | "left" | "right" | "top" | "bottom";

export type LayoutNode = SplitNode | LeafNode;

export type DeviceBrowserTabState = {
  // Per-tab connection override. Empty strings mean "use global settings".
  serverBaseUrl: string;
  token: string;
  deviceId: string;
  deviceToken: string;
  deviceName: string;
  snapshotId: string;
  path: string;
};

export type SftpBrowserTabState = {
  host: string;
  port: number;
  user: string;

  // auth
  password: string;
  keyPath: string;
  useAgent: boolean;

  // host key checking
  knownHostsPolicy: "strict" | "accept-new" | "insecure";
  knownHostsPath: string;

  // navigation
  basePath: string;
  path: string;

  // optional: filedock plugin runner configuration
  filedockPath: string; // empty => default "filedock"
  pluginDirs: string; // ":"-separated
};

export type LocalBrowserTabState = {
  basePath: string;
  path: string;
};

export type PaneTab =
  | { id: string; pane: "deviceBrowser"; title?: string; state: DeviceBrowserTabState }
  | { id: string; pane: "sftpBrowser"; title?: string; state: SftpBrowserTabState }
  | { id: string; pane: "localBrowser"; title?: string; state: LocalBrowserTabState }
  | { id: string; pane: "transferQueue"; title?: string }
  | { id: string; pane: "notes"; title?: string };

export interface SplitNode {
  kind: "split";
  id: string;
  dir: SplitDir;
  ratio: number; // 0..1 (a size proportion)
  a: LayoutNode;
  b: LayoutNode;
}

export interface LeafNode {
  kind: "leaf";
  id: string;
  tabs: PaneTab[];
  activeTabId: string;
}

export function clampRatio(v: number): number {
  if (!Number.isFinite(v)) return 0.5;
  return Math.max(0.1, Math.min(0.9, v));
}

export function defaultLayout(): LayoutNode {
  return leafFromPane("deviceBrowser");
}

export function uid(prefix: string): string {
  // Avoid crypto dependency; uniqueness is good enough for persisted UI state.
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function makeTab(pane: PaneKind, title?: string): PaneTab {
  const id = uid("tab");
  if (pane === "deviceBrowser") {
    return {
      id,
      pane,
      title,
      state: {
        serverBaseUrl: "",
        token: "",
        deviceId: "",
        deviceToken: "",
        deviceName: "",
        snapshotId: "",
        path: ""
      }
    };
  }
  if (pane === "sftpBrowser") {
    return {
      id,
      pane,
      title,
      state: {
        host: "",
        port: 22,
        user: "",
        password: "",
        keyPath: "",
        useAgent: false,
        knownHostsPolicy: "strict",
        knownHostsPath: "",
        basePath: "",
        path: "/",
        filedockPath: "",
        pluginDirs: ""
      }
    };
  }
  if (pane === "localBrowser") {
    return {
      id,
      pane,
      title,
      state: {
        basePath: "",
        path: ""
      }
    };
  }
  return { id, pane: pane as any, title } as PaneTab;
}

export function leafFromPane(pane: PaneKind): LeafNode {
  const t = makeTab(pane);
  return { kind: "leaf", id: uid("pane"), tabs: [t], activeTabId: t.id };
}

export function activeTab(leaf: LeafNode): PaneTab {
  return leaf.tabs.find((t) => t.id === leaf.activeTabId) ?? leaf.tabs[0]!;
}

export function displayTabTitle(tab: PaneTab): string {
  if (tab.title && tab.title.trim()) return tab.title.trim();
  const t = i18next.t.bind(i18next);

  if (tab.pane === "deviceBrowser") {
    const dev = tab.state.deviceName || t("tab.device");
    const snap = tab.state.snapshotId ? ` ${tab.state.snapshotId}` : "";
    const p = tab.state.path ? ` /${tab.state.path}` : " /";
    return `${dev}${snap}${p}`;
  }

  if (tab.pane === "sftpBrowser") {
    const host = tab.state.host || t("tab.vps");
    const user = tab.state.user ? `${tab.state.user}@` : "";
    const p = tab.state.path ? ` ${tab.state.path}` : " /";
    return `${user}${host}${p}`;
  }

  if (tab.pane === "localBrowser") {
    const base = tab.state.basePath || t("tab.local");
    const p = tab.state.path ? ` /${tab.state.path}` : "";
    return `${base}${p}`;
  }

  if (tab.pane === "transferQueue") return t("tab.transfers");
  return t("tab.notes");
}

export function mapNode(node: LayoutNode, f: (n: LayoutNode) => LayoutNode): LayoutNode {
  const mapped = node.kind === "split"
    ? {
        ...node,
        a: mapNode(node.a, f),
        b: mapNode(node.b, f)
      }
    : node;
  return f(mapped);
}

export function findLeaf(node: LayoutNode, id: string): LeafNode | null {
  if (node.kind === "leaf") return node.id === id ? node : null;
  return findLeaf(node.a, id) ?? findLeaf(node.b, id);
}

export function normalizeLayoutNode(node: LayoutNode): LayoutNode {
  const firstLeaf = (n: LayoutNode): LeafNode | null => {
    if (n.kind === "leaf") return n;
    return firstLeaf(n.a) ?? firstLeaf(n.b);
  };

  const toSingleLeaf = (leaf: LeafNode): LeafNode => {
    const a = activeTab(leaf);
    return { kind: "leaf", id: leaf.id, tabs: [a], activeTabId: a.id };
  };

  if (node.kind === "split") {
    return {
      ...node,
      ratio: clampRatio(node.ratio),
      a: normalizeLayoutNode(node.a),
      b: normalizeLayoutNode(node.b)
    };
  }

  // Migration: legacy leaf schema had {pane}.
  const anyLeaf = node as unknown as {
    pane?: PaneKind;
    tabs?: any[];
    activeTabId?: string;
  };

  if (anyLeaf.tabs && Array.isArray(anyLeaf.tabs) && anyLeaf.tabs.length > 0) {
    const tabs: PaneTab[] = anyLeaf.tabs
      .map((t) => {
        if (!t || typeof t !== "object") return null;
        if (typeof t.id !== "string" || typeof t.pane !== "string") return null;
        const pane = t.pane as PaneKind;
        const title = typeof t.title === "string" ? t.title : undefined;
        if (pane === "deviceBrowser") {
          const st = t.state as Partial<DeviceBrowserTabState> | undefined;
          return {
            id: t.id,
            pane,
            title,
            state: {
              serverBaseUrl: typeof st?.serverBaseUrl === "string" ? st.serverBaseUrl : "",
              token: typeof st?.token === "string" ? st.token : "",
              deviceId: typeof st?.deviceId === "string" ? st.deviceId : "",
              deviceToken: typeof st?.deviceToken === "string" ? st.deviceToken : "",
              deviceName: typeof st?.deviceName === "string" ? st.deviceName : "",
              snapshotId: typeof st?.snapshotId === "string" ? st.snapshotId : "",
              path: typeof st?.path === "string" ? st.path : ""
            }
          };
        }
        if (pane === "sftpBrowser") {
          const st = t.state as Partial<SftpBrowserTabState> | undefined;
          const khPolicy = (st?.knownHostsPolicy as any) ?? "strict";
          const policy: "strict" | "accept-new" | "insecure" =
            khPolicy === "accept-new" || khPolicy === "insecure" ? khPolicy : "strict";
          return {
            id: t.id,
            pane,
            title,
            state: {
              host: typeof st?.host === "string" ? st.host : "",
              port: typeof st?.port === "number" && Number.isFinite(st.port) ? st.port : 22,
              user: typeof st?.user === "string" ? st.user : "",
              password: typeof st?.password === "string" ? st.password : "",
              keyPath: typeof st?.keyPath === "string" ? st.keyPath : "",
              useAgent: typeof st?.useAgent === "boolean" ? st.useAgent : false,
              knownHostsPolicy: policy,
              knownHostsPath: typeof st?.knownHostsPath === "string" ? st.knownHostsPath : "",
              basePath: typeof st?.basePath === "string" ? st.basePath : "",
              path: typeof st?.path === "string" ? st.path : "/",
              filedockPath: typeof st?.filedockPath === "string" ? st.filedockPath : "",
              pluginDirs: typeof st?.pluginDirs === "string" ? st.pluginDirs : ""
            }
          };
        }
        if (pane === "localBrowser") {
          const st = t.state as Partial<LocalBrowserTabState> | undefined;
          return {
            id: t.id,
            pane,
            title,
            state: {
              basePath: typeof st?.basePath === "string" ? st.basePath : "",
              path: typeof st?.path === "string" ? st.path : ""
            }
          };
        }
        if (pane === "transferQueue" || pane === "notes") {
          return { id: t.id, pane, title } as PaneTab;
        }
        return null;
      })
      .filter((x): x is PaneTab => x !== null);

    if (tabs.length > 0) {
      const activeTabId = typeof anyLeaf.activeTabId === "string" ? anyLeaf.activeTabId : tabs[0]!.id;
      const activeExists = tabs.some((t) => t.id === activeTabId);
      const leaf: LeafNode = {
        kind: "leaf",
        id: node.id,
        tabs,
        activeTabId: activeExists ? activeTabId : tabs[0]!.id
      };
      return toSingleLeaf(leaf);
    }
  }

  const pane: PaneKind = anyLeaf.pane ?? "deviceBrowser";
  const t = makeTab(pane);
  return toSingleLeaf({ kind: "leaf", id: node.id, tabs: [t], activeTabId: t.id });
}

export function updateSplitRatio(node: LayoutNode, splitId: string, ratio: number): LayoutNode {
  return mapNode(node, (n) => {
    if (n.kind !== "split") return n;
    if (n.id !== splitId) return n;
    return { ...n, ratio: clampRatio(ratio) };
  });
}

export function splitLeaf(
  node: LayoutNode,
  leafId: string,
  dir: SplitDir,
  newPane: PaneKind = "notes"
): LayoutNode {
  return mapNode(node, (n) => {
    if (n.kind !== "leaf") return n;
    if (n.id !== leafId) return n;
    const left: LeafNode = { ...n };
    const right: LeafNode = leafFromPane(newPane);
    return {
      kind: "split",
      id: uid("split"),
      dir,
      ratio: 0.5,
      a: left,
      b: right
    };
  });
}

export function splitRoot(node: LayoutNode, dir: SplitDir, newPane: PaneKind = "notes"): LayoutNode {
  const left = node;
  const right: LeafNode = leafFromPane(newPane);
  return {
    kind: "split",
    id: uid("split"),
    dir,
    ratio: 0.5,
    a: left,
    b: right
  };
}

export function splitRootWithLeaf(
  node: LayoutNode,
  dir: SplitDir,
  right: LeafNode,
  ratio: number = 0.5
): LayoutNode {
  const left = node;
  return {
    kind: "split",
    id: uid("split"),
    dir,
    ratio: clampRatio(ratio),
    a: left,
    b: right
  };
}

export function setLeafPane(node: LayoutNode, leafId: string, pane: PaneKind): LayoutNode {
  return mapNode(node, (n) => {
    if (n.kind !== "leaf") return n;
    if (n.id !== leafId) return n;
    const a = activeTab(n);
    return {
      ...n,
      tabs: n.tabs.map((t) => {
        if (t.id !== a.id) return t;
        const title = (t as any).title as string | undefined;
        if (pane === "deviceBrowser") {
          const prev: DeviceBrowserTabState = t.pane === "deviceBrowser" ? t.state : {
            serverBaseUrl: "",
            token: "",
            deviceId: "",
            deviceToken: "",
            deviceName: "",
            snapshotId: "",
            path: ""
          };
          return { id: t.id, pane, title, state: { ...prev } };
        }
        if (pane === "sftpBrowser") {
          const prev: SftpBrowserTabState = t.pane === "sftpBrowser" ? t.state : {
            host: "",
            port: 22,
            user: "",
            password: "",
            keyPath: "",
            useAgent: false,
            knownHostsPolicy: "strict",
            knownHostsPath: "",
            basePath: "",
            path: "/",
            filedockPath: "",
            pluginDirs: ""
          };
          return { id: t.id, pane, title, state: { ...prev } };
        }
        if (pane === "localBrowser") {
          const prev: LocalBrowserTabState = t.pane === "localBrowser" ? t.state : {
            basePath: "",
            path: ""
          };
          return { id: t.id, pane, title, state: { ...prev } };
        }
        if (pane === "transferQueue") return { id: t.id, pane, title };
        return { id: t.id, pane: "notes", title };
      })
    };
  });
}

export function addLeafTab(node: LayoutNode, leafId: string, pane: PaneKind): LayoutNode {
  return mapNode(node, (n) => {
    if (n.kind !== "leaf") return n;
    if (n.id !== leafId) return n;
    const t = makeTab(pane);
    return { ...n, tabs: [...n.tabs, t], activeTabId: t.id };
  });
}

export function updateLeafTabState(
  node: LayoutNode,
  leafId: string,
  tabId: string,
  updater: (tab: PaneTab) => PaneTab
): LayoutNode {
  return mapNode(node, (n) => {
    if (n.kind !== "leaf") return n;
    if (n.id !== leafId) return n;
    return {
      ...n,
      tabs: n.tabs.map((t) => (t.id === tabId ? updater(t) : t))
    };
  });
}

export function setLeafActiveTab(node: LayoutNode, leafId: string, tabId: string): LayoutNode {
  return mapNode(node, (n) => {
    if (n.kind !== "leaf") return n;
    if (n.id !== leafId) return n;
    const ok = n.tabs.some((t) => t.id === tabId);
    return ok ? { ...n, activeTabId: tabId } : n;
  });
}

export function closeLeafTab(node: LayoutNode, leafId: string, tabId: string): LayoutNode {
  return mapNode(node, (n) => {
    if (n.kind !== "leaf") return n;
    if (n.id !== leafId) return n;
    const tabs = n.tabs.filter((t) => t.id !== tabId);
    if (tabs.length === 0) {
      const t = makeTab("notes");
      return { ...n, tabs: [t], activeTabId: t.id };
    }
    const activeTabId = tabs.some((t) => t.id === n.activeTabId) ? n.activeTabId : tabs[0]!.id;
    return { ...n, tabs, activeTabId };
  });
}

export function closeLeaf(node: LayoutNode, leafId: string): LayoutNode {
  function remove(n: LayoutNode): { node: LayoutNode | null; removed: boolean } {
    if (n.kind === "leaf") {
      if (n.id === leafId) return { node: null, removed: true };
      return { node: n, removed: false };
    }

    const ra = remove(n.a);
    if (ra.node === null) return { node: n.b, removed: true };

    const rb = remove(n.b);
    if (rb.node === null) return { node: n.a, removed: true };

    if (ra.removed || rb.removed) {
      return { node: { ...n, a: ra.node, b: rb.node }, removed: true };
    }
    return { node: n, removed: false };
  }

  const r = remove(node);
  // Keep at least one pane alive.
  return r.node ?? leafFromPane("notes");
}

export function moveLeaf(root: LayoutNode, sourceLeafId: string, targetLeafId: string, zone: DropZone): LayoutNode {
  if (sourceLeafId === targetLeafId) return root;
  if (zone === "center") return mergeLeafTabs(root, sourceLeafId, targetLeafId);

  const extracted = extractLeaf(root, sourceLeafId);
  if (!extracted.leaf) return root;
  return insertLeaf(extracted.root, targetLeafId, zone, extracted.leaf);
}

function mergeLeafTabs(root: LayoutNode, sourceLeafId: string, targetLeafId: string): LayoutNode {
  const extracted = extractLeaf(root, sourceLeafId);
  if (!extracted.leaf) return root;

  const sourceTabs = extracted.leaf.tabs;
  if (sourceTabs.length === 0) return extracted.root;

  let merged = false;
  const next = mapNode(extracted.root, (n) => {
    if (n.kind !== "leaf") return n;
    if (n.id !== targetLeafId) return n;
    merged = true;
    return {
      ...n,
      tabs: [...n.tabs, ...sourceTabs],
      activeTabId: sourceTabs[sourceTabs.length - 1]!.id
    };
  });

  // If target not found (shouldn't happen), fall back to re-inserting source by splitting.
  if (!merged) return insertLeaf(extracted.root, targetLeafId, "right", extracted.leaf);
  return next;
}

function extractLeaf(root: LayoutNode, leafId: string): { root: LayoutNode; leaf: LeafNode | null } {
  function remove(n: LayoutNode): { node: LayoutNode | null; extracted: LeafNode | null } {
    if (n.kind === "leaf") {
      if (n.id === leafId) return { node: null, extracted: n };
      return { node: n, extracted: null };
    }

    const ra = remove(n.a);
    if (ra.extracted) {
      if (ra.node === null) return { node: n.b, extracted: ra.extracted };
      return { node: { ...n, a: ra.node }, extracted: ra.extracted };
    }

    const rb = remove(n.b);
    if (rb.extracted) {
      if (rb.node === null) return { node: n.a, extracted: rb.extracted };
      return { node: { ...n, b: rb.node }, extracted: rb.extracted };
    }

    return { node: n, extracted: null };
  }

  const r = remove(root);
  const nextRoot = r.node ?? leafFromPane("notes");
  return { root: nextRoot, leaf: r.extracted };
}

function insertLeaf(root: LayoutNode, targetLeafId: string, zone: DropZone, leaf: LeafNode): LayoutNode {
  function go(n: LayoutNode): { node: LayoutNode; inserted: boolean } {
    if (n.kind === "leaf") {
      if (n.id !== targetLeafId) return { node: n, inserted: false };

      if (zone === "center") return { node: leaf, inserted: true };

      const dir: SplitDir = zone === "left" || zone === "right" ? "row" : "col";
      const before = zone === "left" || zone === "top";
      const a = before ? leaf : n;
      const b = before ? n : leaf;
      return {
        node: {
          kind: "split",
          id: uid("split"),
          dir,
          ratio: 0.5,
          a,
          b
        },
        inserted: true
      };
    }

    const ra = go(n.a);
    if (ra.inserted) return { node: { ...n, a: ra.node }, inserted: true };
    const rb = go(n.b);
    if (rb.inserted) return { node: { ...n, b: rb.node }, inserted: true };
    return { node: n, inserted: false };
  }

  const r = go(root);
  return r.node;
}
