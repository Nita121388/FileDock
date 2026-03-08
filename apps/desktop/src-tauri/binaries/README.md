# Desktop sidecar binaries

This folder is used by Tauri `bundle.externalBin` to ship `filedock` and optional plugins (e.g. `filedock-sftp`,
`filedock-ssh`) inside the desktop app bundle.

Tauri looks for platform-specific binaries using this naming pattern:

- `filedock-x86_64-pc-windows-msvc.exe`
- `filedock-x86_64-apple-darwin`
- `filedock-x86_64-unknown-linux-gnu`

Same for plugins (example: `filedock-sftp-x86_64-unknown-linux-gnu`,
`filedock-ssh-x86_64-unknown-linux-gnu`).

On a build machine, run:

```bash
./scripts/build-desktop-sidecars.sh
```

Then build the desktop app normally (Tauri will pick up the correct binaries).

For debug/dev builds, missing sidecars are now tolerated automatically so `cargo check -p filedock-desktop` does not need placeholder files. Release packaging still requires the real binaries above.
