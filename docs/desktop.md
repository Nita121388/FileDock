# Desktop App

The desktop app (Tauri) provides a multi-pane UI for browsing snapshots and (via plugins) remote filesystems like SFTP.

## Server config import

You can paste a server config JSON into Preferences → Import JSON. Supported fields:

- `server_base_url`
- `token` (optional; required if server auth is enabled)
- `device_id` / `device_token` (optional)

This config can be exported from the server (see `GET /v1/admin/config/export`) or via the CLI:

```bash
filedock config export --server http://127.0.0.1:8787
```

## Drag-and-drop transfers (MVP)

- Snapshot file → SFTP pane: uploads a snapshot file to a remote SFTP path (queues `snapshot_to_sftp`).
- SFTP file → Device Browser pane: imports a remote SFTP file into a new snapshot on the server (queues `sftp_to_snapshot`).

## Bundling `filedock` + plugins inside the app

The desktop UI can invoke `filedock plugin run ...` via a Tauri backend command.

In development, this typically uses `filedock` on your `PATH`.

For packaged builds, the recommended approach is to bundle:
- `filedock` (CLI) as a Tauri external binary
- plugin executables (e.g. `filedock-sftp`) as external binaries too

This repo includes:
- Tauri config: `apps/desktop/src-tauri/tauri.conf.json` (`bundle.externalBin`)
- Sidecar output folder: `apps/desktop/src-tauri/binaries/`
- Builder script: `scripts/build-desktop-sidecars.sh`

On a build machine:

```bash
./scripts/build-desktop-sidecars.sh
cd apps/desktop
npm run tauri build
```

Notes:
- Tauri expects binaries named with the host target triple (see `apps/desktop/src-tauri/binaries/README.md`).
- The app will default `FILEDOCK_PLUGIN_DIRS` to the directory of the bundled `filedock` binary, so plugins can live alongside it.
