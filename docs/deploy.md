# Deployment (Draft)

This project can run with or without containers.

## Option A: Docker Compose (convenient for dev)

- Pros: repeatable setup, one command bring-up.
- Cons: requires Docker.

Planned components:
- `filedock-server`
- Postgres
- Optional: MinIO (S3-compatible)

## Option B: Bare Metal (systemd)

- Install Postgres normally.
- Run `filedock-server` as a systemd service.
- Configure storage backend (disk or S3).
