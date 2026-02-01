# FileDock Desktop (MVP UI Shell)

Goal: a cross-platform desktop UI (Windows/macOS/Linux) with:

- tabs (workspaces)
- dockable/splittable panes
- drag-resizable split gutters
- persisted layouts (per tab)

MVP docking:

- drag a pane titlebar onto another pane to reveal drop zones:
  - left/right/top/bottom: auto-split + dock
  - center: merge into target pane as tabs

This folder contains the frontend UI and a minimal Tauri wrapper skeleton.

Notes:

- The UI intentionally starts “offline-first”: it focuses on layout + navigation scaffolding.
- Server integration (snapshots/tree/transfer queue) is layered on later.
- Snapshot restore (to local folder) is implemented via a Tauri command and appears as `RST` in the Device Browser pane.
