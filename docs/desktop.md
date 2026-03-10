# Desktop App

The desktop app (Tauri) provides a multi-pane UI for browsing snapshots and (via plugins) remote filesystems like SFTP.

## Guided agent setup

The desktop app now has a dedicated **Set up agent** entry point in the top toolbar and Preferences.

Current flow:

1. paste a server config JSON / QR payload or reuse the current toolbar connection,
2. choose profile name, device name, and backup folder,
3. set snapshot + heartbeat intervals,
4. create/update the saved agent profile via `filedock agent init`,
5. preview or install the platform background service via `filedock agent install`,
6. optionally remove the service (and the saved profile) via `filedock agent uninstall`,
7. refresh verification status via `filedock agent status`.

Notes:
- The desktop app is the setup wizard; the persistent background worker is still the Rust CLI agent.
- Web preview can render the UI, but only the packaged Tauri desktop app can pick local folders and call the local `filedock` binary.
- The wizard previews whether setup will keep only device credentials or also retain the bootstrap token.

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
- Debug/dev builds now auto-skip `bundle.externalBin` when the host-specific sidecars are missing, so `cargo check -p filedock-desktop` and local dev loops do not need placeholder binaries.
- Release packaging still expects the real sidecars to exist first; run `./scripts/build-desktop-sidecars.sh` before `npm run tauri build`.
- Tauri expects binaries named with the host target triple (see `apps/desktop/src-tauri/binaries/README.md`).
- The app will default `FILEDOCK_PLUGIN_DIRS` to the directory of the bundled `filedock` binary, so plugins can live alongside it.
