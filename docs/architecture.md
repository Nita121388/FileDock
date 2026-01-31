# Architecture

FileDock = Client + Server + Storage.

## High-Level Components

- Client (Windows/macOS/Linux)
  - Scans/monitors local folders
  - Creates snapshots
  - Uploads missing chunks (dedup)
  - Downloads/restores files
  - Provides UI (Tauri desktop)

- Server
  - Auth + device registry
  - Snapshot/file-tree metadata
  - Coordinates chunk presence + uploads
  - Provides browse APIs for UI

- Storage backends
  - Disk backend (server local filesystem)
  - S3-compatible backend (MinIO / cloud object storage)

## Design Constraints

- Cross-platform client.
- Data safety: integrity checks for every chunk.
- Performance: parallel chunk upload; avoid re-upload.
- Optional end-to-end encryption (client-side).

## MVP Scope

- Single user.
- Manual backups (no scheduler).
- Browse snapshot file tree.
- Download single files.
