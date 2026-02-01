# Quickstart

This is a practical "get it running" guide for FileDock.

## 1) Build + run the server

From the repo root:

```bash
cargo build -p filedock-server
./target/debug/filedock-server --listen 127.0.0.1:8787 --storage-dir ./data
```

Optional (recommended): enable server token auth:

```bash
export FILEDOCK_TOKEN="change-me"
./target/debug/filedock-server --listen 127.0.0.1:8787 --storage-dir ./data
```

## 2) Push a folder snapshot (CLI)

```bash
cargo run -p filedock -- push-folder \
  --server http://127.0.0.1:8787 \
  --device "laptop" \
  --folder /home/you/Documents
```

### 2b) Run as an agent (recommended)

Copy the example config:

```bash
cp deploy/agent-config.example.toml ./agent.toml
```

Edit `agent.toml` (folder path, device name, auth), then run:

```bash
cargo run -p filedock -- agent --config ./agent.toml
```

Optional: add a `.filedockignore` file in the root folder (one glob per line, `#` comments):

```text
# common ignores
**/.git/**
**/node_modules/**
```

Optional: run a simple periodic backup loop (runs `push-folder`, sleeps, repeats):

```bash
cargo run -p filedock -- push-folder-loop \
  --server http://127.0.0.1:8787 \
  --device "laptop" \
  --folder /home/you/Documents \
  --interval-secs 900
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

### Restore a snapshot to a local folder (desktop)

In the Device Browser pane:
- select a snapshot
- set restore concurrency (small number input next to `RST`, default 4)
- click `RST` and pick a destination folder
- if needed, click `Cancel` (stops scheduling new files; in-flight downloads finish)

### Cross-device copy (desktop)

Open two Device Browser panes (either in tabs or split panes), connect each to a server/device, then:
- drag a file or folder from one pane to the other to enqueue a transfer
- use the Transfer Queue pane to run/pause/cancel and tune concurrency/bandwidth

## Notes

- Rust/Tauri prerequisites vary by platform. See `docs/build.md` for details.
- This repo is developed in small "phase" commits; see `progress/` for a running diary.
