# v1 Acceptance Checklist

This is the practical definition of "v1 quality" for FileDock.
The goal is: a user can install, back up, browse, restore, and transfer files reliably.

## A) Core backup flow (CLI)

- [ ] Start `filedock-server` (open mode) and verify `/health`.
- [ ] `filedock push-folder` succeeds on a medium folder (10k+ files).
- [ ] `filedock snapshots` shows the new snapshot.
- [ ] `filedock tree` works for root and nested paths.
- [ ] `filedock pull-folder` restores the snapshot and matches hashes.

## B) Core backup flow (auth mode)

- [ ] Same as (A) with `FILEDOCK_TOKEN` enabled on the server.
- [ ] CLI works with `FILEDOCK_TOKEN` set.
- [ ] Device registration works (server token required for registration when token auth is enabled).
- [ ] Device auth headers work for normal operations (`FILEDOCK_DEVICE_ID` + `FILEDOCK_DEVICE_TOKEN`).

## C) Desktop UX (Tauri)

- [ ] App starts and can connect to a server.
- [ ] One window can show multiple devices in tabs and split panes.
- [ ] Drag/drop docking works and layout persists across restart.
- [ ] Device Browser can browse snapshots and trees reliably.
- [ ] Drag-copy file between panes enqueues a job and completes.
- [ ] Drag-copy folder between panes enqueues `copy_folder` and completes.
- [ ] Conflict policy works: overwrite / skip / rename.
- [ ] Pause/resume/cancel behaves correctly and doesn't wedge the queue.
- [ ] Queue concurrency + bandwidth limit controls behave as expected.

## D) Reliability / crash-resume

- [ ] Restart desktop mid-transfer: jobs are not stuck in "running" and can be retried.
- [ ] `copy_folder` resume works (continues from `nextIndex` and avoids re-copying already-copied paths).

## E) Security posture (MVP)

- [ ] Docs clearly explain token auth mode and recommended settings for non-local use.
- [ ] Desktop caches are keyed by full connection identity (no cross-auth reuse).

## Tools

- End-to-end smoke (server+CLI): `scripts/smoke.sh`
- Local build and artifact collection: `scripts/build.sh`, `scripts/release.sh`
- Local sanity checks: `scripts/check.sh`

