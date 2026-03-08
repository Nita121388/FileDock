import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_PANE_TABLE_WIDTHS,
  PANE_TABLE_COLUMN_MINS,
  clampPaneColumnWidth,
  loadPaneTableWidths,
  normalizePaneColumnWidth,
  savePaneTableWidths,
  type WidthState
} from "./usePaneTableColumns";

const STORAGE_KEY = "filedock.test.pane-widths";

describe("pane table width helpers", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("clamps widths within column bounds", () => {
    expect(clampPaneColumnWidth(50, 72, 200)).toBe(72);
    expect(clampPaneColumnWidth(250, 72, 200)).toBe(200);
    expect(clampPaneColumnWidth(160, 72, 200)).toBe(160);
  });

  it("normalizes numeric width values", () => {
    expect(normalizePaneColumnWidth(88.8, 96, 72)).toBe(89);
    expect(normalizePaneColumnWidth("broken", 96, 72)).toBe(96);
    expect(normalizePaneColumnWidth(10, 96, 72)).toBe(72);
  });

  it("loads defaults when storage is empty or invalid", () => {
    expect(loadPaneTableWidths(STORAGE_KEY)).toEqual(DEFAULT_PANE_TABLE_WIDTHS);
    localStorage.setItem(STORAGE_KEY, "not-json");
    expect(loadPaneTableWidths(STORAGE_KEY)).toEqual(DEFAULT_PANE_TABLE_WIDTHS);
  });

  it("loads persisted widths and enforces minimums", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        type: 10,
        size: 128.4,
        actions: 50
      })
    );
    expect(loadPaneTableWidths(STORAGE_KEY)).toEqual({
      type: PANE_TABLE_COLUMN_MINS[1],
      size: 128,
      actions: PANE_TABLE_COLUMN_MINS[3]
    });
  });

  it("persists width state", () => {
    const widths: WidthState = { type: 120, size: 180, actions: 240 };
    savePaneTableWidths(STORAGE_KEY, widths);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) || "null")).toEqual(widths);
  });
});
