# Storage

FileDock stores everything as *objects* addressed by a string key, for example:

- `chunks/<chunk_hash>`
- `snapshots/<snapshot_id>.json`
- `manifests/<snapshot_id>.json`
- `devices/<device_id>.json`

The server supports multiple storage backends.

## Backend: Disk (default)

Stores objects on the server filesystem under `FILEDOCK_STORAGE_DIR`.

Pros:
- simplest deployment
- fastest local I/O

Cons:
- limited by a single server's disk

## Backend: S3 (compatible object storage)

Stores objects in an S3 bucket (works with S3-compatible services like MinIO and Cloudflare R2).

Enable it by setting:

- `FILEDOCK_STORAGE_BACKEND=s3`
- `FILEDOCK_S3_BUCKET=<bucket>`
- `FILEDOCK_S3_REGION=<region>` (for S3-compatible services, `us-east-1` is usually fine)

Optional:
- `FILEDOCK_S3_ENDPOINT=<url>` (needed for MinIO/R2; can be omitted for AWS S3)
- `FILEDOCK_S3_FORCE_PATH_STYLE=true` (often needed for MinIO)
- `FILEDOCK_S3_PREFIX=filedock/` (store everything under a prefix inside the bucket)

Credentials:
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- (optional) `AWS_SESSION_TOKEN`

Notes:
- Listing (`list_prefix`) is used by snapshot retention and chunk GC. On large buckets, listing can be slow and may incur costs.
- This backend is currently byte-buffered for reads/writes (chunks are read into memory as `bytes::Bytes`).

