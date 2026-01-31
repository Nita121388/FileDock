# Storage (Draft)

FileDock supports multiple storage backends.

## Backends

### Disk

- Stores objects/chunks on the server filesystem.
- Useful for small deployments and development.

### S3 (Compatible)

- Stores chunks as objects in an S3 bucket.
- Compatible with MinIO and cloud object storage.

## Object Keys

Draft scheme:

- `chunks/{chunk_hash}`
- `manifests/{snapshot_id}.json` (optional)
