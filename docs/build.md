# Build

This repo is a Rust workspace (server + CLI) with TUI and a Tauri desktop app.

## Prerequisites

- Rust (stable)
- `rustfmt` + `clippy` (installed via `rustup component add rustfmt clippy`)

## Server

```bash
cargo run -p filedock-server
```

Override listen addr / storage dir:

```bash
cargo run -p filedock-server -- --listen 127.0.0.1:8787 --storage-dir ./filedock-data
```

Or via env vars:

```bash
export FILEDOCK_LISTEN="127.0.0.1:8787"
export FILEDOCK_STORAGE_DIR="./filedock-data"
cargo run -p filedock-server
```

Optional basic auth (recommended for any non-local use):

```bash
export FILEDOCK_TOKEN="change-me"
cargo run -p filedock-server
```

Health:

```bash
curl -sS http://localhost:8787/health
```

## CLI

```bash
cargo run -p filedock -- health-sample
```

If the server is started with `FILEDOCK_TOKEN`, set the same token for the CLI:

```bash
export FILEDOCK_TOKEN="change-me"
```

Optional device auth headers (if you registered a device and want to avoid sharing the server token):

```bash
export FILEDOCK_DEVICE_ID="<device_id>"
export FILEDOCK_DEVICE_TOKEN="<device_token>"
```

### Push a File (single-chunk MVP)

```bash
cargo run -p filedock -- push-file --server http://127.0.0.1:8787 --file ./path/to/file
```

### Push a Folder (snapshot + manifest MVP)

```bash
cargo run -p filedock -- push-folder --server http://127.0.0.1:8787 --device my-laptop --folder ./some/folder --concurrency 4 --exclude "**/.git/**" --exclude "**/node_modules/**"
```

### Browse a Snapshot (tree)

```bash
cargo run -p filedock -- tree --server http://127.0.0.1:8787 --snapshot <snapshot_id> --path \"\"
```

### Restore a File (download)

```bash
cargo run -p filedock -- pull-file --server http://127.0.0.1:8787 --snapshot <snapshot_id> --path \"relative/file.txt\" --out ./restored/file.txt
```

### Restore a Snapshot (download folder)

```bash
cargo run -p filedock -- pull-folder --server http://127.0.0.1:8787 --snapshot <snapshot_id> --out ./restored_snapshot --concurrency 4
```

### List Snapshots

```bash
cargo run -p filedock -- snapshots --server http://127.0.0.1:8787
```

## TUI (Terminal UI)

Browse snapshots + directories in a split-pane terminal UI:

```bash
cargo run -p filedock-tui -- --server http://127.0.0.1:8787
```

If the server is started with `FILEDOCK_TOKEN`, set the same token for the TUI:

```bash
export FILEDOCK_TOKEN="change-me"
```

You can also use device auth headers:

```bash
export FILEDOCK_DEVICE_ID="<device_id>"
export FILEDOCK_DEVICE_TOKEN="<device_token>"
```

## Desktop UI (Tauri)

The desktop UI lives in `apps/desktop`.

Prereqs (typical):

- Node.js (LTS)
- Rust toolchain (stable)
- Platform-specific Tauri deps (webview toolchain)

Run in dev:

```bash
cd apps/desktop
npm install
npm run tauri dev
```

Build:

```bash
cd apps/desktop
npm run tauri build
```

## CI

GitHub Actions runs `fmt`, `clippy`, and `test` on pushes and PRs.
