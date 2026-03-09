# Agent + Onboarding M1

This document turns the roadmap item into a concrete milestone.

The goal is to make FileDock feel like a real "set it and forget it" backup product:
a user should be able to connect a device, choose a folder, install a persistent agent,
and get recurring backups without hand-editing env vars or scheduler files.

## Current baseline

Already implemented today:

- CLI agent runtime via `filedock agent --config <path>`.
- Periodic backup loop via `push-folder-loop`.
- Device registration API: `POST /v1/auth/device/register`.
- Heartbeats: `POST /v1/devices/{device_id}/heartbeat` and `filedock device-heartbeat`.
- Server config export via JSON and QR payloads:
  - `GET /v1/admin/config/export`
  - `GET /v1/admin/config/qr`
  - `filedock config export`
  - `filedock config qr`
- Desktop import of server config JSON / QR payload text.
- Platform service templates for systemd, launchd, and Windows Task Scheduler.

What is still missing is the productized flow that stitches those parts together.

## Milestone goal

From a clean device, a user can:

1. import a server onboarding payload (JSON or QR-derived payload),
2. register the device,
3. choose a folder and schedule,
4. save a local agent profile in the platform-default location,
5. install/start the background agent,
6. confirm that the server sees heartbeats and recurring snapshots.

Target: a technically comfortable single-user setup should take less than 5 minutes.

## Scope

### In scope

- Guided onboarding for one device at a time.
- Named agent profiles, with one folder per profile.
- Local config persistence in standard per-platform locations.
- Platform install/start helpers for Linux, macOS, and Windows.
- Device registration during onboarding.
- Bootstrap from exported server config JSON / QR payload.
- Basic local + server-visible status checks.

### Out of scope

- Live filesystem watching.
- Multi-folder profiles in one config.
- Remote service control from the server.
- Secret vault / keychain integration.
- Camera-based QR scanning in the desktop app.
  - M1 can accept pasted QR payload text and JSON import.
  - Native camera scanning can come later.

## Product requirements

### R1. Guided bootstrap input

The onboarding flow must accept a server payload that contains at least:

- `server_base_url`
- optional bootstrap `token`
- optional pre-provisioned `device_id` / `device_token`

The payload can come from:

- `filedock config export`
- `filedock config qr`
- server `/v1/admin/config/export`
- server `/v1/admin/config/qr`

### R2. Device auth should replace bootstrap auth

If onboarding starts with a server token, the client should use it only long enough to:

- register the device,
- obtain `device_id` + `device_token`,
- save device credentials into the agent profile.

By default, the saved agent profile should not keep the bootstrap server token after device
registration succeeds.

### R3. First-class local agent profile

The user should not need to manage env files manually.

M1 should define standard config paths:

- Linux: `~/.config/filedock/agents/<profile>.toml`
- macOS: `~/Library/Application Support/FileDock/agents/<profile>.toml`
- Windows: `%APPDATA%\\FileDock\\agents\\<profile>.toml`

Each profile stores:

- server URL
- device name
- folder path
- interval
- heartbeat interval / status
- exclude / ignore settings
- device credentials

### R4. Installable background service

The onboarding flow must be able to install a persistent background runner using the local
profile.

Expected behavior:

- Linux: install/start a systemd user or system service using a generated config path.
- macOS: install/start a launchd plist using the generated config path.
- Windows: create/update a Task Scheduler entry using the generated config path.

The flow must be safe to re-run for the same profile to update schedule or folder settings.

### R5. Best-effort status visibility

After setup, the user should be able to confirm:

- config path
- service installed / not installed (best effort)
- service running / last run state (best effort)
- last server heartbeat seen
- whether at least one snapshot has been uploaded for this device

### R6. Single-user safety defaults

M1 should keep the current single-user model but reduce accidental credential overreach:

- save device credentials instead of admin token when possible;
- make bootstrap-token persistence opt-in, not default;
- surface the exact auth mode in generated config previews.

### R7. Clear failure surfaces

Common failures must produce specific messages:

- invalid server URL
- token rejected / registration unauthorized
- folder path missing or unreadable
- background service install failed
- heartbeat works but snapshot upload fails

## Acceptance criteria

### A1. Clean-device onboarding

On a clean machine with only FileDock installed, the user can complete onboarding from exported
server JSON/QR payload to a saved agent profile without editing raw TOML by hand.

### A2. Persistent scheduling

After onboarding, the agent survives logout/reboot according to the chosen platform service model
and performs recurring backups on schedule.

### A3. Device-scoped auth persistence

If setup began with a server token, the persisted agent config contains device credentials and does
not keep the bootstrap token unless the user explicitly chooses an advanced fallback.

### A4. Server visibility

Within one schedule interval plus heartbeat interval, the server shows:

- the registered device in `GET /v1/devices`
- updated `last_seen`
- at least one snapshot associated with that device after a successful run

### A5. Idempotent reconfiguration

Running onboarding again for the same profile updates config and service definitions without leaving
multiple conflicting service entries behind.

### A6. Cross-platform minimum bar

The following flows are documented and locally verifiable:

- Linux: create profile, install service, run, verify heartbeat/snapshot
- macOS: create profile, install service, run, verify heartbeat/snapshot
- Windows: create profile, install scheduled task, run, verify heartbeat/snapshot

## Technical design

## Design principle

Deliver M1 by reusing the APIs and runtime pieces that already exist.
The first cut should avoid introducing new server-side concepts unless they unblock the UX in a
meaningful way.

### 1. Reuse current server API surface

The current server already exposes the key building blocks:

- config export payloads
- device registration
- heartbeat updates
- snapshot listing

So M1 should avoid inventing a new onboarding protocol first.
The client-side flow can be:

1. import config payload,
2. call device registration if device credentials are missing,
3. write the local agent profile,
4. install/start the background service,
5. check device/snapshot visibility.

Server-side work should stay optional unless we later decide we need richer device telemetry.

### 2. Add first-class CLI onboarding commands

The CLI should grow from "runtime only" into "lifecycle management":

- `filedock device register --server ... --device-name ...`
- `filedock agent init --profile <name> --folder <path> ...`
- `filedock agent install --profile <name>`
- `filedock agent uninstall --profile <name>`
- `filedock agent status --profile <name>`

Notes:

- `agent init` should create/update the TOML file in the default profile directory.
- `agent install` should generate or update the platform service wiring.
- `agent status` should combine local config inspection with best-effort server checks.

### 3. Persist local runtime state for status UX

In addition to `agent.toml`, the runtime should write a lightweight state file, for example:

- Linux: `~/.local/state/filedock/agents/<profile>.json`
- macOS: `~/Library/Application Support/FileDock/state/<profile>.json`
- Windows: `%LOCALAPPDATA%\\FileDock\\state\\<profile>.json`

Suggested contents:

- last run started / finished timestamps
- last snapshot id
- last error summary
- last successful heartbeat time
- current profile name and folder

This keeps `agent status` and future desktop UI simple without forcing the server to become the
only source of truth for local service health.

### 4. Desktop should act as the setup wizard, not the long-running agent

The desktop app should provide the guided onboarding UX, but the persistent worker should remain the
existing CLI agent.

Recommended desktop flow:

1. import server payload (JSON or pasted QR payload),
2. choose profile name, device name, and folder,
3. choose schedule and heartbeat interval,
4. register device if needed,
5. preview generated config,
6. install/start the background agent,
7. show verification status.

This keeps runtime responsibility in Rust CLI code and avoids turning the Tauri app into the daemon.

### 5. Service installers should reuse existing templates

Do not hand-maintain separate logic per platform if existing templates already cover most of it.

Use the existing assets in `deploy/` as the source of truth and fill in only the generated values:

- config path
- profile name / service label
- executable path
- optional working directory

### 6. Security posture for M1

- Imported server token is a bootstrap credential.
- Device credential is the steady-state credential.
- Generated config previews should show which credential will actually be persisted.
- Any advanced option to retain the bootstrap token should be visually marked as not recommended.

## Task breakdown

### T1. Config/profile foundation

- Add shared helpers for platform-default profile directories.
- Add shared helpers for state-file directories.
- Define profile naming rules and collision behavior.
- Add unit tests for config path resolution and profile serialization.

### T2. CLI lifecycle commands

- Implement `device register` command.
- Implement `agent init` command.
- Implement `agent install` command.
- Implement `agent uninstall` command.
- Implement `agent status` command.
- Add tests for generated config content and service-file rendering.

### T3. Agent runtime state reporting

- Write/update local runtime state after startup, heartbeat, success, and failure.
- Keep state writes crash-safe enough for normal desktop usage.
- Add tests for state-file update behavior.

### T4. Desktop onboarding UX

- Add a dedicated onboarding entry point instead of hiding everything under raw JSON import.
- Build a step-by-step flow around payload import, folder pick, schedule, register, preview, install.
- Reuse the existing config import parser for bootstrap.
- Add unit coverage for payload handling and generated agent profile previews.

### T5. Verification + docs

- Update `docs/agent.md` with the user-facing guided flow.
- Update `docs/quickstart.md` to point at the new lifecycle commands.
- Add a validation checklist for Linux/macOS/Windows onboarding.
- Extend CI coverage where possible for config generation and template rendering.

## Suggested milestone slices

### Slice 1: CLI-first usable path

Deliver a fully working CLI onboarding path first:

- register device
- create profile
- install service
- check status

This gives immediate value and stabilizes the model before desktop UX work.

### Slice 2: Desktop wizard

Add the friendly guided setup on top of the stabilized CLI lifecycle commands.

### Slice 3: Richer status and polish

Improve verification UX, error copy, and cross-platform docs.

## Open questions

- Do we want system-level or user-level services as the default on Linux?
- Should Windows use Task Scheduler first, or a Windows Service wrapper later?
- Should profile names be user-visible and stable, or generated from device+folder by default?
- Do we want to allow bootstrap-token persistence for headless edge cases in M1, or push that to an
  advanced/manual path only?
