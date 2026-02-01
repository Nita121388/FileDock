# scripts/

Small helper scripts for common developer workflows.

Notes:
- These are conveniences; they assume you have Rust + Node/Tauri installed.
- If a script is not executable, run `chmod +x scripts/*.sh`.

Common:
- `scripts/dev.sh` - run server + desktop UI (dev)
- `scripts/build.sh` - build server + CLI + desktop UI
- `scripts/docker-up.sh` - start server via docker compose
- `scripts/fmt.sh` - rustfmt + prettier (if available)
- `scripts/lint.sh` - clippy (if available)

