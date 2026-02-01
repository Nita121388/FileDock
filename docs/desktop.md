# Desktop App

The desktop app (Tauri) provides a multi-pane UI for browsing snapshots and (via plugins) remote filesystems like SFTP.

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

