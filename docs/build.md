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

## CI

GitHub Actions runs `fmt`, `clippy`, and `test` on pushes and PRs.
