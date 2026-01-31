# FileDock

Cross-platform backup + multi-device file browser/transfer app.

Goals:
- Back up folders from multiple devices to a server (cloud/self-host).
- Browse backups per-device and per-snapshot.
- Wave-terminal-like multi-pane UI for fast cross-device file move/copy.

Status: pre-MVP (scaffolding).

## Repository Layout

- `crates/` Rust crates (server, client core/cli, shared protocol)
- `apps/` UI apps (Tauri desktop)
- `docs/` architecture, protocol, data model, development notes
- `progress/` dated progress logs (committed)

## Quick Links

- Architecture: `docs/architecture.md`
- Roadmap: `docs/roadmap.md`
- Development: `docs/development.md`
