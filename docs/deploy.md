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

### Docker Compose + Object Storage (MinIO)

For a local S3-compatible setup (MinIO + FileDock server), use:

```bash
docker compose -f deploy/docker-compose.minio.yml up --build
```

## Option B: Bare Metal (systemd)

- Build `filedock-server` and run it as a systemd service.
- Store data under a dedicated directory (e.g. `/var/lib/filedock`).

Example (manual run):

```bash
export FILEDOCK_STORAGE_DIR=/var/lib/filedock
export FILEDOCK_TOKEN="change-me"   # optional but recommended
export FILEDOCK_PUBLIC_URL="https://files.example.com"   # optional (used for config export)
./target/release/filedock-server --listen 0.0.0.0:8787
```

### Bare Metal + Object Storage (S3-compatible)

Set:

```bash
export FILEDOCK_STORAGE_BACKEND=s3
export FILEDOCK_S3_BUCKET="filedock"
export FILEDOCK_S3_REGION="us-east-1"
export FILEDOCK_S3_ENDPOINT="http://127.0.0.1:9000" # MinIO example
export FILEDOCK_S3_FORCE_PATH_STYLE=true
export AWS_ACCESS_KEY_ID="minioadmin"
export AWS_SECRET_ACCESS_KEY="minioadmin"
```

Then run `filedock-server` as usual.
