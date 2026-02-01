export type SplitDir = "row" | "col";

export type PaneKind = "deviceBrowser" | "transferQueue" | "notes";

export type LayoutNode = SplitNode | LeafNode;

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
  pane: PaneKind;
}

export function clampRatio(v: number): number {
  if (!Number.isFinite(v)) return 0.5;
  return Math.max(0.1, Math.min(0.9, v));
}

export function defaultLayout(): LayoutNode {
  return {
    kind: "split",
    id: uid("split"),
    dir: "row",
    ratio: 0.34,
    a: { kind: "leaf", id: uid("pane"), pane: "deviceBrowser" },
    b: { kind: "leaf", id: uid("pane"), pane: "notes" }
  };
}

export function uid(prefix: string): string {
  // Avoid crypto dependency; uniqueness is good enough for persisted UI state.
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
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

export function updateSplitRatio(node: LayoutNode, splitId: string, ratio: number): LayoutNode {
  return mapNode(node, (n) => {
    if (n.kind !== "split") return n;
    if (n.id !== splitId) return n;
    return { ...n, ratio: clampRatio(ratio) };
  });
}

export function splitLeaf(node: LayoutNode, leafId: string, dir: SplitDir): LayoutNode {
  return mapNode(node, (n) => {
    if (n.kind !== "leaf") return n;
    if (n.id !== leafId) return n;
    const left: LeafNode = { ...n };
    const right: LeafNode = { kind: "leaf", id: uid("pane"), pane: "notes" };
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

export function setLeafPane(node: LayoutNode, leafId: string, pane: PaneKind): LayoutNode {
  return mapNode(node, (n) => {
    if (n.kind !== "leaf") return n;
    if (n.id !== leafId) return n;
    return { ...n, pane };
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
  return r.node ?? { kind: "leaf", id: uid("pane"), pane: "notes" };
}
