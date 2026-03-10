# Snapshot Retention (Prune)

Snapshots grow over time. FileDock provides a retention/prune mechanism that deletes:
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
  --keep-daily 7 \
  --keep-weekly 8 \
  --dry-run
```

Apply:

```bash
filedock prune-snapshots \
  --server http://127.0.0.1:8787 \
  --keep-last 20 \
  --keep-days 30 \
  --keep-daily 7 \
  --keep-weekly 8
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
- All keep rules are combined as a union: a snapshot is kept if it matches any of `keep-last`, `keep-days`, `keep-daily`, or `keep-weekly`.
- `keep-daily` keeps the newest snapshot from each of the newest N UTC calendar days for that device group.
- `keep-weekly` keeps the newest snapshot from each of the newest N ISO weeks (UTC) for that device group.
- Use `--dry-run` first.

