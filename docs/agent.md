# Device Agent / Scheduling

FileDock's Rust CLI (`filedock`) can run as a simple config-file agent and now also exposes CLI helpers for device registration, profile creation, service install, and status checks.

This document shows the current agent workflow and the lower-level scheduling templates behind it.

## Desktop guided flow

If you are using the Tauri desktop app, open **Set up agent** from the toolbar or Preferences.
The desktop flow wraps the CLI lifecycle commands below:

- import server JSON / QR payload,
- choose profile + folder + schedule,
- create/update the saved agent profile,
- preview/install or remove the platform service,
- verify local/service/server-visible status.

The desktop app stays the wizard only; the long-running background worker is still `filedock agent`.

## Config-file agent mode (recommended)

Instead of wiring many env vars/flags into schedulers, you can run the agent from a config file:

```bash
filedock agent --config ./agent.toml
```

Example config: `deploy/agent-config.example.toml`.

If you want a scheduler-friendly command that runs exactly one snapshot and exits:

```bash
filedock agent run-once --config ./agent.toml
```

## Guided CLI workflow

Create or update a named profile in the platform-default config directory:

```bash
filedock agent init \
  --profile laptop \
  --server http://127.0.0.1:8787 \
  --folder /home/you/Documents
```

Notes:
- `agent init` auto-registers a device when it can and stores `device_id` / `device_token` in the saved profile.
- If you bootstrap from exported server JSON, you can pass it directly with `--import-json '<json>'` or point `--import-json` at a file path.
- By default, the bootstrap server token is dropped once device credentials exist; use `--keep-bootstrap-token` only for advanced/manual cases.

Preview or install the current-platform background service for that profile:

```bash
filedock agent install --profile laptop --dry-run
filedock agent install --profile laptop
```

Install modes:

- Default (`--mode daemon`): keep a long-running agent alive; cadence is owned by `interval_secs` in the saved profile.
- Optional (`--mode scheduled`): use OS-native schedulers to run `agent run-once` periodically (cadence is still sourced
  from `interval_secs` in the saved profile, but the scheduler owns the timer).

Example:

```bash
filedock agent install --profile laptop --mode scheduled --dry-run
filedock agent install --profile laptop --mode scheduled
```

Check local/service/server-visible status:

```bash
filedock agent status --profile laptop
```

Remove the platform service later if needed, and optionally delete the saved profile too:

```bash
filedock agent uninstall --profile laptop
filedock agent uninstall --profile laptop --delete-config
```

If you only want device credentials without writing a profile first:

```bash
filedock device register --server http://127.0.0.1:8787 --device-name laptop
```

## CLI mode (works everywhere)

Run once:

```bash
filedock push-folder-loop \
  --server http://127.0.0.1:8787 \
  --device "laptop" \
  --folder /home/you/Documents \
  --interval-secs 0
```

Run forever (every 15 minutes):

```bash
filedock push-folder-loop \
  --server http://127.0.0.1:8787 \
  --device "laptop" \
  --folder /home/you/Documents \
  --interval-secs 900
```

If the server is in auth mode:

```bash
export FILEDOCK_TOKEN="change-me"
```

If you registered a device and use device-token auth:

```bash
export FILEDOCK_DEVICE_ID="..."
export FILEDOCK_DEVICE_TOKEN="..."
```

## Heartbeats (optional)

Devices can send a heartbeat to update their "last seen" timestamp:

```bash
export FILEDOCK_DEVICE_ID="..."
export FILEDOCK_DEVICE_TOKEN="..."
filedock device heartbeat --server http://127.0.0.1:8787 --status "online"
```

In config-file agent mode (`filedock agent --config ...`), heartbeats run on their own timer (`heartbeat_secs`),
independent of the snapshot interval (`interval_secs`).

## Linux (systemd) templates

See:
- `deploy/systemd/filedock-backup@.service`
- `deploy/systemd/filedock-backup@.timer`

You can also run the config-file agent via systemd using:
- `deploy/systemd/filedock-agent@.service`

Recommended pattern:
- For day-to-day usage, prefer `filedock agent init` + `filedock agent install`; on Linux this writes a user-level systemd unit for the saved profile.
- Create `/etc/filedock/<name>.env` only if you are managing the low-level templates manually.
- If you use `filedock-backup@.timer`, the schedule is owned by systemd and `--interval-secs` should be `0`.
- If you use `filedock-agent@.service`, the schedule is owned by `agent.toml` (`interval_secs`).

## macOS (launchd) template

See `deploy/launchd/com.filedock.backup.plist` (runs `filedock agent --config ...` and keeps it alive).

## Windows (Task Scheduler) example

See `deploy/windows/backup.ps1` (runs `filedock agent --config ...`).

Create a Task Scheduler entry that runs the script every N minutes.
