# Device Agent / Scheduling

FileDock's Rust CLI (`filedock`) can run as a simple "agent" by using `push-folder-loop`.

This document shows practical ways to schedule it on common platforms.

## Config-file agent mode (recommended)

Instead of wiring many env vars/flags into schedulers, you can run the agent from a config file:

```bash
filedock agent --config ./agent.toml
```

Example config: `deploy/agent-config.example.toml`.

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
filedock device-heartbeat --server http://127.0.0.1:8787 --status "online"
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
- Create `/etc/filedock/<name>.env` to hold env vars (tokens).
- If you use `filedock-backup@.timer`, the schedule is owned by systemd and `--interval-secs` should be `0`.
- If you use `filedock-agent@.service`, the schedule is owned by `agent.toml` (`interval_secs`).

## macOS (launchd) template

See `deploy/launchd/com.filedock.backup.plist` (runs `filedock agent --config ...` and keeps it alive).

## Windows (Task Scheduler) example

See `deploy/windows/backup.ps1` (runs `filedock agent --config ...`).

Create a Task Scheduler entry that runs the script every N minutes.
