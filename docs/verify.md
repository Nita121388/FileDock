# Verify / Smoke Test

This is a quick way to sanity-check that server + CLI can:
- push a folder snapshot
- browse a tree
- pull a folder restore

## One-command smoke test

From repo root:

```bash
./scripts/smoke.sh
```

To test auth mode, set a token:

```bash
export FILEDOCK_TOKEN="change-me"
./scripts/smoke.sh
```

This script:
- starts a local server on an ephemeral port
- creates a small sample folder
- pushes it as a snapshot
- restores it to a new folder
- compares file hashes

If it exits with code 0, the basic end-to-end flow works.
