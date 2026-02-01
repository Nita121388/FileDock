# scripts/

Small helper scripts for common developer workflows.

Notes:
- These are conveniences; they assume you have Rust + Node/Tauri installed.
- If a script is not executable, run `chmod +x scripts/*.sh`.

Common:
- `scripts/dev.sh` - run server + desktop UI (dev)
- `scripts/build.sh` - build server + CLI + desktop UI
- `scripts/release.sh` - build and collect local release artifacts into `dist/`
- `scripts/smoke.sh` - end-to-end server+CLI smoke test (push-folder + pull-folder + hash compare)
- `scripts/check.sh` - local "CI-like" checks (fmt/clippy/test + desktop build + smoke)
- `scripts/docker-up.sh` - start server via docker compose
- `scripts/fmt.sh` - rustfmt + prettier (if available)
- `scripts/lint.sh` - clippy (if available)
