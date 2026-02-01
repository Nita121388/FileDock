# Quickstart

This is a practical "get it running" guide for FileDock.

## 1) Build + run the server

From the repo root:

```bash
cargo build -p filedock-server
./target/debug/filedock-server --listen 127.0.0.1:8787 --data ./data
```

Optional (recommended): enable server token auth:

```bash
export FILEDOCK_TOKEN="change-me"
./target/debug/filedock-server --listen 127.0.0.1:8787 --data ./data
```

## 2) Push a folder snapshot (CLI)

```bash
cargo run -p filedock -- push-folder \
  --server http://127.0.0.1:8787 \
  --device "laptop" \
  --root /home/you/Documents
```

List snapshots:

```bash
cargo run -p filedock -- snapshots --server http://127.0.0.1:8787
```

If you enabled `FILEDOCK_TOKEN` on the server:

```bash
export FILEDOCK_TOKEN="change-me"
```

## 3) Browse snapshots (TUI)

```bash
cargo run -p filedock-tui -- --server http://127.0.0.1:8787
```

## 4) Desktop UI (Tauri)

The desktop UI lives in `apps/desktop`.

```bash
cd apps/desktop
npm install
npm run tauri dev
```

In the UI, set:
- server URL: `http://127.0.0.1:8787`
- token: `FILEDOCK_TOKEN` (if configured)

### Cross-device copy (desktop)

Open two Device Browser panes (either in tabs or split panes), connect each to a server/device, then:
- drag a file or folder from one pane to the other to enqueue a transfer
- use the Transfer Queue pane to run/pause/cancel and tune concurrency/bandwidth

## Notes

- Rust/Tauri prerequisites vary by platform. See `docs/build.md` for details.
- This repo is developed in small "phase" commits; see `progress/` for a running diary.

