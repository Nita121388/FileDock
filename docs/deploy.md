# Deployment

This project can run with or without containers.

## Option A: Docker Compose (convenient for dev)

- Pros: repeatable setup, one command bring-up.
- Cons: requires Docker.

Current components:
- `filedock-server` (disk storage in a mounted volume)

Example (builds the server image locally):

```bash
docker compose -f deploy/docker-compose.yml up --build
```

Then open:
- server: `http://127.0.0.1:8787/health`

## Option B: Bare Metal (systemd)

- Build `filedock-server` and run it as a systemd service.
- Store data under a dedicated directory (e.g. `/var/lib/filedock`).

Example (manual run):

```bash
export FILEDOCK_STORAGE_DIR=/var/lib/filedock
export FILEDOCK_TOKEN="change-me"   # optional but recommended
./target/release/filedock-server --listen 0.0.0.0:8787
```
