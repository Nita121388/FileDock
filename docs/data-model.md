# Data Model (Draft)

This describes the minimal entities needed for the MVP and how they relate.

## Entities

### User

Single-user MVP; later can expand to multi-user.

- `user_id`

### Device

A registered client machine.

- `device_id`
- `user_id`
- `name`
- `os`
- `last_seen_at`

### Backup Job

A configured folder (root) on a device.

- `job_id`
- `device_id`
- `root_path`
- `exclude_rules`
- `enabled`

### Snapshot

An immutable view of a job at a point in time.

- `snapshot_id`
- `job_id`
- `started_at`, `finished_at`
- `status` (running/succeeded/failed)
- `stats` (file count, total bytes)

### File Entry

A file or directory inside a snapshot.

- `file_entry_id`
- `snapshot_id`
- `path` (normalized, POSIX-style)
- `kind` (file/dir/symlink)
- `size`, `mtime`, `mode`
- `link_target` (for symlink)

### Chunk

Content-addressed piece of file data.

- `chunk_hash` (BLAKE3 for MVP)
- `size`
- `ref_count`
- `encryption` metadata (optional; client-side encryption)

### File-Chunk Map

Maps a file entry to an ordered list of chunks.

- `file_entry_id`
- `ordinal`
- `chunk_hash`
- `chunk_size`

### Transfer Task

Represents a cross-device copy/move.

- `transfer_id`
- `user_id`
- `src` (device + snapshot + path)
- `dst` (device + path)
- `status` (queued/running/paused/succeeded/failed)
- `progress` (bytes, chunks)
