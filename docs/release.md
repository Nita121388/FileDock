# Release

This doc explains how to produce "release" artifacts (server/CLI/TUI and the desktop app).

## Rust binaries (server + CLI + TUI)

From repo root:

```bash
cargo build --release -p filedock-server -p filedock -p filedock-tui
```

Outputs:
- `target/release/filedock-server`
- `target/release/filedock`
- `target/release/filedock-tui`

Recommended: package these into a tarball/zip per target OS.

## Desktop app (Tauri)

```bash
cd apps/desktop
npm install
npm run tauri build
```

The output location depends on platform and Tauri config, but it is typically under:
- `apps/desktop/src-tauri/target/release/bundle/`

## One-command helpers

If you prefer one-command workflows, see:
- `scripts/build.sh` (build everything)
- `scripts/dev.sh` (run server + desktop dev)
- `scripts/release.sh` (create a local `dist/` folder with artifacts)

