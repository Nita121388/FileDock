# Roadmap

This is a living document.

## v1 (current state)

Implemented (see `progress/` for exact commits):
- Server: chunk storage, snapshot metadata + manifests, browse tree + download, optional static token auth, device registry + device-token auth, streaming downloads.
- CLI: push/pull folders (chunked + dedup), exclusions, retries, progress, periodic `push-folder-loop`.
- TUI: snapshot browser (read-only).
- Desktop: tabbed workspaces, split panes with draggable docking + pane tabs, live snapshot browsing, transfer queue, cross-server copy (file/folder), upload local file, concurrency/bandwidth limits, resume-friendly copy, service health indicator, saved node presets, one-click local backup, icon+tooltip actions, resizable browser columns, dedicated add-terminal action, terminal presets / quick-launch flows, and guided agent setup backed by the CLI lifecycle commands.
- Scripts/docs: `scripts/` helpers, quickstart, deploy notes, smoke tests, CI checks, acceptance checklist, and snapshot retention policies (`keep-last`, `keep-days`, `keep-daily`, `keep-weekly`).
- Onboarding baseline: server config export (JSON + QR), CLI export helpers, desktop config import, and platform agent templates.

## Next (near-term)

- Guided agent onboarding polish: richer verification UX, config/service previews, setup cleanup/remove-service flow, and cross-platform validation for the new desktop setup flow.
- Agent scheduling (optional): add a `run-once` agent mode plus `agent install --mode scheduled` so platforms can use native timers (systemd timers / launchd StartInterval / Windows periodic tasks) instead of keeping a long-running loop alive.
- Encryption at rest (optional): per-device key, client-side encryption before upload.
- Better ignore rules: `.gitignore`-style files, default excludes (node_modules, .git, etc).
- Restore UX: desktop "restore folder" workflow (not only per-file download).

## Later

- Remote discovery: mDNS / QR pairing (LAN) for \"find my server\" / easier onboarding.
- Additional backends: S3-compatible storage, pluggable metadata DB.
- Multi-user + ACLs (if needed): separate tenants, per-user auth, device permissions.
