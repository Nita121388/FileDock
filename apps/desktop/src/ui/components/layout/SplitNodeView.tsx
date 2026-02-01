import { useEffect, useMemo, useRef } from "react";
import type { LayoutNode, SplitNode } from "../../model/layout";

export default function SplitNodeView(props: {
  node: SplitNode;
  render: (n: LayoutNode) => JSX.Element;
  onResize: (ratio: number) => void;
}) {
  const { node, render, onResize } = props;
  const ref = useRef<HTMLDivElement | null>(null);

  const isRow = node.dir === "row";

  const style = useMemo(() => {
    return {
      flexDirection: isRow ? ("row" as const) : ("column" as const)
    };
  }, [isRow]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const gutter = el.querySelector<HTMLDivElement>(`[data-split-gutter="${node.id}"]`);
    if (!gutter) return;

    let dragging = false;
    let start = 0;
    let startRatio = node.ratio;
    let pointerId: number | null = null;

    const onMove = (ev: PointerEvent) => {
      if (!dragging) return;
      const rect = el.getBoundingClientRect();
      const size = isRow ? rect.width : rect.height;
      if (size <= 0) return;
      const delta = (isRow ? ev.clientX : ev.clientY) - start;
      const next = startRatio + delta / size;
      onResize(next);
    };

    const onUp = () => {
      dragging = false;
      if (pointerId !== null) {
        try {
          gutter.releasePointerCapture(pointerId);
        } catch {
          // ignore
        }
      }
      pointerId = null;
    };

    const onDown = (ev: PointerEvent) => {
      dragging = true;
      pointerId = ev.pointerId;
      start = isRow ? ev.clientX : ev.clientY;
      startRatio = node.ratio;
      gutter.setPointerCapture(ev.pointerId);
    };

    gutter.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      gutter.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [isRow, node.id, node.ratio, onResize]);

  return (
    <div ref={ref} className="split" style={style}>
      <div className="split-child" style={{ flexBasis: `${node.ratio * 100}%` }}>
        {render(node.a)}
      </div>
      <div
        className={isRow ? "gutter gutter-row" : "gutter gutter-col"}
        data-split-gutter={node.id}
        role="separator"
        aria-orientation={isRow ? "vertical" : "horizontal"}
        tabIndex={-1}
      />
      <div className="split-child" style={{ flexBasis: `${(1 - node.ratio) * 100}%` }}>
        {render(node.b)}
      </div>
    </div>
  );
}
