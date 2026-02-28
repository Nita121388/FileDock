# Roadmap

This is a living document.

## v1 (current state)

Implemented (see `progress/` for exact commits):
- Server: chunk storage, snapshot metadata + manifests, browse tree + download, optional static token auth, device registry + device-token auth, streaming downloads.
- CLI: push/pull folders (chunked + dedup), exclusions, retries, progress, periodic `push-folder-loop`.
- TUI: snapshot browser (read-only).
- Desktop: tabbed workspaces, split panes with draggable docking + pane tabs, live snapshot browsing, transfer queue, cross-server copy (file/folder), upload local file, concurrency/bandwidth limits, resume-friendly copy.
- Scripts/docs: `scripts/` helpers, quickstart, deploy notes, smoke tests, CI checks, acceptance checklist.

## Next (near-term)

- Agent/daemon: run on devices, schedule backups, store credentials/config locally.
- Snapshot retention policies: keep last N / keep daily/weekly, prune old snapshots safely.
- Encryption at rest (optional): per-device key, client-side encryption before upload.
- Better ignore rules: `.gitignore`-style files, default excludes (node_modules, .git, etc).
- Restore UX: desktop \"restore folder\" workflow (not only per-file download).
- Onboarding config export: copyable JSON + QR code + CLI export for server configs.

## Later

- Remote discovery: mDNS / QR pairing (LAN) for \"find my server\" / easier onboarding.
- Additional backends: S3-compatible storage, pluggable metadata DB.
- Multi-user + ACLs (if needed): separate tenants, per-user auth, device permissions.
