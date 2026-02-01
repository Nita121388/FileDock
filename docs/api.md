# API (Draft)

MVP: versioned HTTP JSON API.

## Conventions

- Base path: `/v1`
- Auth (current MVP): optional static token
  - If the server is started with `FILEDOCK_TOKEN`, all endpoints except `/health` require:
    - Header: `X-FileDock-Token: <token>`
- Auth (next step): optional device token
  - Headers:
    - `X-FileDock-Device-Id: <device_id>`
    - `X-FileDock-Device-Token: <device_token>`
- Responses: JSON

## Endpoints (Draft)

### Health

- `GET /health`

### Auth

- `POST /v1/auth/device/register`
  - Request: device name, os
  - Response: device_id, device_token

MVP (current implementation):

- `POST /v1/auth/device/register` (create a device id + token)

### Devices

- `GET /v1/devices`
- `POST /v1/devices/{device_id}/heartbeat`

MVP (current implementation):

- `GET /v1/devices` (list registered devices)

### Jobs & Snapshots

- `POST /v1/jobs`
- `GET /v1/jobs`
- `POST /v1/jobs/{job_id}/snapshots` (start snapshot)
- `GET /v1/snapshots/{snapshot_id}`

MVP (current implementation):

- `POST /v1/snapshots` (create snapshot id)
  - Optional: include `device_id` to link snapshot to a registered device
- `GET /v1/snapshots` (list snapshots)
- `PUT /v1/snapshots/{snapshot_id}/manifest`
- `GET /v1/snapshots/{snapshot_id}/manifest`

### Browse

- `GET /v1/snapshots/{snapshot_id}/tree?path=/...`
- `GET /v1/snapshots/{snapshot_id}/file?path=/...`

MVP (current implementation):

- `GET /v1/snapshots/{snapshot_id}/tree?path=` (empty path = root)
- `GET /v1/snapshots/{snapshot_id}/file?path=relative/file`

Notes:

- `GET /file` reconstructs data from one or more stored chunks.
- `GET /file` is streamed (does not buffer the whole file in memory).

### Chunks

- `POST /v1/chunks/presence` (hash list -> missing list)
- `PUT /v1/chunks/{hash}`
- `GET /v1/chunks/{hash}`

Notes:

- `PUT /chunks/{hash}` validates that the request body hashes to `{hash}` (integrity check).

### Transfer

- `POST /v1/transfers`
- `GET /v1/transfers`
- `GET /v1/transfers/{transfer_id}`
- `POST /v1/transfers/{transfer_id}/pause`
- `POST /v1/transfers/{transfer_id}/resume`
- `POST /v1/transfers/{transfer_id}/cancel`
