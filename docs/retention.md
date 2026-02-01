# Snapshot Retention (Prune)

Snapshots grow over time. FileDock provides a minimal retention/prune mechanism that deletes:
- snapshot metadata (`snapshots/<id>.json`)
- snapshot manifests (`manifests/<id>.json`)

Important: chunks are not garbage-collected yet. This means pruning snapshots does not immediately free
storage (because chunks may be shared across snapshots and devices).

## CLI

Dry-run (show what would be deleted):

```bash
filedock prune-snapshots \
  --server http://127.0.0.1:8787 \
  --keep-last 20 \
  --keep-days 30 \
  --dry-run
```

Apply:

```bash
filedock prune-snapshots \
  --server http://127.0.0.1:8787 \
  --keep-last 20 \
  --keep-days 30
```

Prune a single device only:

```bash
filedock prune-snapshots \
  --server http://127.0.0.1:8787 \
  --device-id "$FILEDOCK_DEVICE_ID" \
  --keep-last 50
```

Delete one snapshot explicitly:

```bash
filedock delete-snapshot \
  --server http://127.0.0.1:8787 \
  --snapshot <snapshot_id>
```

## API

- `DELETE /v1/snapshots/{snapshot_id}`
- `POST /v1/snapshots/prune`

## Notes / Safety

- Prune is per device-group (prefers `device_id` when present, else uses `device_name`).
- `keep-last` and `keep-days` are combined (union): a snapshot is kept if it matches either rule.
- Use `--dry-run` first.

