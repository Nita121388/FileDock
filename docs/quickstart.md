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

Create a named agent profile in the default config directory:

```bash
cargo run -p filedock -- agent init \
  --profile laptop \
  --server http://127.0.0.1:8787 \
  --folder /home/you/Documents
```

What this does:
- saves `~/.config/filedock/agents/laptop.toml` on Linux (platform-default location on macOS/Windows)
- auto-registers a device when the server allows it
- stores device credentials in the profile so the long-running agent does not need raw env vars
- if you do not pass any `--exclude` / `--ignore-file`, it seeds a small default exclude list to avoid uploading huge trees (e.g. `.git`, `node_modules`).
  - To include everything, edit the generated profile TOML and remove the `exclude = [...]` line.

Preview the generated service wiring, then install it:

```bash
cargo run -p filedock -- agent install --profile laptop --dry-run
cargo run -p filedock -- agent install --profile laptop
```

Check status:

```bash
cargo run -p filedock -- agent status --profile laptop
```

If you want the older/manual flow, you can still run directly from a TOML file:

```bash
cp deploy/agent-config.example.toml ./agent.toml
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

Check whether your local folder is up-to-date with the newest snapshot:

```bash
cargo run -p filedock -- status \
  --server http://127.0.0.1:8787 \
  --latest \
  --folder /home/you/Documents
```

Check a single file (relative path inside `--folder`):

```bash
cargo run -p filedock -- status \
  --server http://127.0.0.1:8787 \
  --latest \
  --folder /home/you/Documents \
  --path "notes/todo.md"
```

For an accurate (slower) content comparison, add `--verify`.

To debug ignore rules, add `--include-ignored` (and optionally pass the same `--exclude` / `--ignore-file` inputs you use for backups).

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

You can also export a server config for copy/paste or QR:

```bash
export FILEDOCK_TOKEN="change-me"
filedock config export --server http://127.0.0.1:8787
filedock config qr --server http://127.0.0.1:8787
```

### Restore a snapshot to a local folder (desktop)

In the Device Browser pane:
- select a snapshot
- set restore concurrency (small number input next to `RST`, default 4)
- choose conflict policy (dropdown next to concurrency): overwrite / skip / rename (default: rename)
- click `RST` and pick a destination folder
- if needed, click `Cancel` (stops scheduling new files; in-flight downloads finish)

### Cross-device copy (desktop)

Open two Device Browser panes (either in tabs or split panes), connect each to a server/device, then:
- drag a file or folder from one pane to the other to enqueue a transfer
- use the Transfer Queue pane to run/pause/cancel and tune concurrency/bandwidth

## Notes

- Rust/Tauri prerequisites vary by platform. See `docs/build.md` for details.
- This repo is developed in small "phase" commits; see `progress/` for a running diary.

## Plugins (optional)

List plugins:

```bash
cargo run -p filedock -- plugin list
```

Run the example plugin shipped in this repo:

```bash
cargo run -p filedock -- plugin run --name notify --json '{"event":"hello","ts":123}'
```
