# Protocol (Draft)

We will use a versioned HTTP API for MVP.

## Core Concepts

- Device registration + device token
- Backup jobs + snapshots
- File entries (tree) per snapshot
- Chunks (content-addressed) for dedup

## Draft Endpoints (subject to change)

- `POST /v1/auth/device/register`
- `GET /v1/devices`
- `POST /v1/jobs/{id}/snapshots`
- `GET /v1/snapshots/{id}/tree?path=/...`
- `POST /v1/chunks/presence`
- `PUT /v1/chunks/{hash}`
