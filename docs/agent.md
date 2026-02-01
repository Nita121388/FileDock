# Device Agent / Scheduling

FileDock's Rust CLI (`filedock`) can run as a simple "agent" by using `push-folder-loop`.

This document shows practical ways to schedule it on common platforms.

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

## Linux (systemd) templates

See:
- `deploy/systemd/filedock-backup@.service`
- `deploy/systemd/filedock-backup@.timer`

Recommended pattern:
- Create `/etc/filedock/<name>.env` to hold env vars (tokens).
- Enable the timer instance: `filedock-backup@<name>.timer`.

## macOS (launchd) template

See `deploy/launchd/com.filedock.backup.plist`.

## Windows (Task Scheduler) example

See `deploy/windows/backup.ps1`.

Create a Task Scheduler entry that runs the script every N minutes.
