# Roadmap

This is a living document.

## Phase 1: Repo Scaffolding (done)
- Repo layout, docs skeleton, progress logging, contribution conventions.

## Phase 2: MVP Core (planned)
- Rust workspace with:
  - server stub (auth, device list, snapshot metadata)
  - client CLI stub (scan + upload skeleton)
  - protocol crate (request/response types)
  - storage abstraction (disk + s3 backends)

## Phase 3: MVP UI (planned)
- Tauri desktop shell
- Multi-pane file browser (read-only first)
- Transfer queue UI (download first)

## Phase 4: Backup Engine (planned)
- Chunking + hashing + dedup
- Resumable upload
- Snapshot retention

## Phase 5: Cross-device Transfer (planned)
- Copy/move across device panes
- Concurrency control + bandwidth limits
