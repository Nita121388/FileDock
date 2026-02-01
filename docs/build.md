# Build

This repo is a Rust workspace (server + CLI) with a planned Tauri desktop app.

## Prerequisites

- Rust (stable)
- `rustfmt` + `clippy` (installed via `rustup component add rustfmt clippy`)

## Server

```bash
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

### Push a File (single-chunk MVP)

```bash
cargo run -p filedock -- push-file --server http://127.0.0.1:8787 --file ./path/to/file
```

### Push a Folder (snapshot + manifest MVP)

```bash
cargo run -p filedock -- push-folder --server http://127.0.0.1:8787 --device my-laptop --folder ./some/folder --concurrency 4
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

## CI

GitHub Actions runs `fmt`, `clippy`, and `test` on pushes and PRs.
