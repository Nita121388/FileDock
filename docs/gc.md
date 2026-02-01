# Chunk Garbage Collection (GC)

Pruning snapshots deletes snapshot metadata/manifests, but it may not free disk space because chunks are shared and
stored separately.

This GC deletes chunks that are no longer referenced by any stored manifest.

Safety:
- GC is an admin operation and requires the server token (`FILEDOCK_TOKEN`).
- Always run a dry-run first.

## CLI

Dry-run:

```bash
export FILEDOCK_TOKEN="change-me"
filedock gc-chunks --server http://127.0.0.1:8787 --dry-run
```

Apply (cap deletions per run):

```bash
export FILEDOCK_TOKEN="change-me"
filedock gc-chunks --server http://127.0.0.1:8787 --max-delete 5000
```

## API

- `POST /v1/admin/chunks/gc`

