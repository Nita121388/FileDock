# API (Draft)

MVP: versioned HTTP JSON API.

## Conventions

- Base path: `/v1`
- Auth: device token (MVP)
- Responses: JSON

## Endpoints (Draft)

### Health

- `GET /health`

### Auth

- `POST /v1/auth/device/register`
  - Request: device name, os
  - Response: device_id, device_token

### Devices

- `GET /v1/devices`
- `POST /v1/devices/{device_id}/heartbeat`

### Jobs & Snapshots

- `POST /v1/jobs`
- `GET /v1/jobs`
- `POST /v1/jobs/{job_id}/snapshots` (start snapshot)
- `GET /v1/snapshots/{snapshot_id}`

MVP (current implementation):

- `POST /v1/snapshots` (create snapshot id)
- `PUT /v1/snapshots/{snapshot_id}/manifest`
- `GET /v1/snapshots/{snapshot_id}/manifest`

### Browse

- `GET /v1/snapshots/{snapshot_id}/tree?path=/...`
- `GET /v1/snapshots/{snapshot_id}/file?path=/...`

### Chunks

- `POST /v1/chunks/presence` (hash list -> missing list)
- `PUT /v1/chunks/{hash}`
- `GET /v1/chunks/{hash}`

### Transfer

- `POST /v1/transfers`
- `GET /v1/transfers`
- `GET /v1/transfers/{transfer_id}`
- `POST /v1/transfers/{transfer_id}/pause`
- `POST /v1/transfers/{transfer_id}/resume`
- `POST /v1/transfers/{transfer_id}/cancel`
