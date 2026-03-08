import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";

export type WidthState = {
  type: number;
  size: number;
  actions: number;
};

type DragState = {
  index: number;
  pointerId: number;
  startX: number;
  startWidths: [number, number, number, number];
  target: HTMLDivElement;
};

type TableStyle = CSSProperties & {
  "--pane-type-col": string;
  "--pane-size-col": string;
  "--pane-actions-col": string;
};

export const DEFAULT_PANE_TABLE_WIDTHS: WidthState = {
  type: 96,
  size: 120,
  actions: 260
};

export const PANE_TABLE_COLUMN_MINS = [180, 72, 96, 220] as const;

export function clampPaneColumnWidth(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function normalizePaneColumnWidth(value: unknown, fallback: number, min: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.round(Number(value))) : fallback;
}

export function loadPaneTableWidths(storageKey: string): WidthState {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return DEFAULT_PANE_TABLE_WIDTHS;
    const parsed = JSON.parse(raw) as Partial<WidthState>;
    return {
      type: normalizePaneColumnWidth(parsed.type, DEFAULT_PANE_TABLE_WIDTHS.type, PANE_TABLE_COLUMN_MINS[1]),
      size: normalizePaneColumnWidth(parsed.size, DEFAULT_PANE_TABLE_WIDTHS.size, PANE_TABLE_COLUMN_MINS[2]),
      actions: normalizePaneColumnWidth(parsed.actions, DEFAULT_PANE_TABLE_WIDTHS.actions, PANE_TABLE_COLUMN_MINS[3])
    };
  } catch {
    return DEFAULT_PANE_TABLE_WIDTHS;
  }
}

export function savePaneTableWidths(storageKey: string, widths: WidthState) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(widths));
  } catch {
    // ignore
  }
}

export function usePaneTableColumns(storageKey: string) {
  const [widths, setWidths] = useState<WidthState>(() => loadPaneTableWidths(storageKey));
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const headerRefs = useRef<Array<HTMLDivElement | null>>([]);
  const dragRef = useRef<DragState | null>(null);
  const widthsRef = useRef(widths);

  useEffect(() => {
    widthsRef.current = widths;
  }, [widths]);

  useEffect(() => {
    if (draggingIndex !== null) return;
    savePaneTableWidths(storageKey, widths);
  }, [draggingIndex, storageKey, widths]);

  useEffect(() => {
    if (draggingIndex === null) return;
    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
    };
  }, [draggingIndex]);

  useEffect(() => {
    const stopResize = () => {
      const drag = dragRef.current;
      if (drag) {
        try {
          drag.target.releasePointerCapture(drag.pointerId);
        } catch {
          // ignore
        }
      }
      dragRef.current = null;
      setDraggingIndex(null);
    };

    const onMove = (ev: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const leftIndex = drag.index;
      const rightIndex = leftIndex + 1;
      const total = drag.startWidths[leftIndex] + drag.startWidths[rightIndex];
      const minLeft = PANE_TABLE_COLUMN_MINS[leftIndex];
      const minRight = PANE_TABLE_COLUMN_MINS[rightIndex];
      const nextLeft = clampPaneColumnWidth(drag.startWidths[leftIndex] + (ev.clientX - drag.startX), minLeft, total - minRight);
      const nextRight = Math.max(minRight, total - nextLeft);

      setWidths((prev) => {
        if (leftIndex === 0) {
          return { ...prev, type: Math.round(nextRight) };
        }
        if (leftIndex === 1) {
          return { ...prev, type: Math.round(nextLeft), size: Math.round(nextRight) };
        }
        return { ...prev, size: Math.round(nextLeft), actions: Math.round(nextRight) };
      });
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
    window.addEventListener("blur", stopResize);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
      window.removeEventListener("blur", stopResize);
    };
  }, []);

  const setHeaderCellRef = useCallback(
    (index: number) => (node: HTMLDivElement | null) => {
      headerRefs.current[index] = node;
    },
    []
  );

  const resetWidths = useCallback(() => {
    const drag = dragRef.current;
    if (drag) {
      try {
        drag.target.releasePointerCapture(drag.pointerId);
      } catch {
        // ignore
      }
    }
    dragRef.current = null;
    setDraggingIndex(null);
    setWidths(DEFAULT_PANE_TABLE_WIDTHS);
  }, []);

  const startResize = useCallback((index: number, ev: ReactPointerEvent<HTMLDivElement>) => {
    const snapshot = headerRefs.current.map((node) => Math.round(node?.getBoundingClientRect().width ?? 0));
    if (snapshot.length < 4 || snapshot.some((width) => width <= 0)) return;
    dragRef.current = {
      index,
      pointerId: ev.pointerId,
      startX: ev.clientX,
      startWidths: snapshot as [number, number, number, number],
      target: ev.currentTarget
    };
    setDraggingIndex(index);
    ev.preventDefault();
    ev.stopPropagation();
    try {
      ev.currentTarget.setPointerCapture(ev.pointerId);
    } catch {
      // ignore
    }
  }, []);

  const tableStyle = useMemo<TableStyle>(
    () => ({
      "--pane-type-col": `${widths.type}px`,
      "--pane-size-col": `${widths.size}px`,
      "--pane-actions-col": `${widths.actions}px`
    }),
    [widths.actions, widths.size, widths.type]
  );

  return {
    draggingIndex,
    setHeaderCellRef,
    resetWidths,
    startResize,
    tableStyle,
    widths: widthsRef.current
  };
}
