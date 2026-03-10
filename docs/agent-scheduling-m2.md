# Agent Scheduling M2 (Daemon vs Scheduled Runner)

This document proposes the next agent/scheduling milestone after the onboarding + profile lifecycle work.

The current agent model already works, but it is intentionally simple: a long-running process loops on a fixed
interval (`interval_secs`) and platform "install" helpers keep that process alive.

M2 adds a more "OS-native" option: install a scheduled runner that wakes up periodically, runs one snapshot,
then exits.

## Goals

- Preserve the existing default behavior (`daemon`): a long-running agent controlled by the profile TOML.
- Add an opt-in `scheduled` mode:
  - The OS scheduler owns cadence.
  - The agent runs once per trigger and exits (no always-on loop).
- Keep a single profile format (TOML) for all modes; no new server concepts.
- Keep `agent install` idempotent: re-running updates cadence/service definitions cleanly.

## Why (problem statement)

The current "daemon" mode is easy to ship and works everywhere, but has tradeoffs:

- It runs continuously (even though snapshots are periodic).
- On some platforms it may only start at user logon depending on how the job is installed.
- Sleep/resume behavior is OS-dependent; an OS-native timer can be more predictable.

Scheduled runners can be more battery/CPU friendly and align with users' expectations ("run every N minutes").

## Proposed CLI changes

### 1) Add `agent run-once`

New command:

- `filedock agent run-once --config <path>`

Behavior:

- Load the agent config TOML.
- Apply auth env (token/device credentials) like the current agent runtime.
- Send an optional heartbeat at start (if `heartbeat_secs > 0`).
- Upload one snapshot.
- Send an optional heartbeat at end (status includes the snapshot id).
- Exit 0 on success, non-zero on error.

Notes:

- This should run exactly one snapshot regardless of `interval_secs` in the config.
- The existing long-running entrypoint (`filedock agent --config ...`) stays unchanged.

### 2) Extend `agent install` with a mode switch

Extend:

- `filedock agent install --profile <name> [--dry-run]`

to:

- `filedock agent install --profile <name> [--dry-run] [--mode daemon|scheduled]`

Defaults:

- `--mode daemon` (keeps current behavior and avoids surprising desktop users).

In `scheduled` mode:

- `agent install` reads `interval_secs` from the profile TOML.
- The OS scheduler is configured to run `filedock agent run-once --config <profile_path>` on that cadence.

### 3) Uninstall/status behavior

- `agent uninstall` should remove whatever was installed:
  - daemon: service only
  - scheduled: scheduler + any helper units/files
- `agent status` should continue reporting "best-effort" service visibility.
  - If needed, add a `note` that clarifies whether the installed unit is a daemon or a timer-based runner.

## Platform design

### Linux (systemd --user)

Daemon mode (existing):

- Writes `~/.config/systemd/user/filedock-agent-<profile>.service`
- `ExecStart=<exe> agent --config <profile_path>`
- Enables + starts the service.

Scheduled mode (new):

- Writes two files in `~/.config/systemd/user/`:
  - `filedock-agent-<profile>.service` (Type=oneshot)
  - `filedock-agent-<profile>.timer`
- Service:
  - `ExecStart=<exe> agent run-once --config <profile_path>`
  - `Wants/After=network-online.target`
- Timer:
  - `OnBootSec=2m` (give networking a moment)
  - `OnUnitActiveSec=<interval_secs>s`
  - `Persistent=true` (catch-up behavior after downtime)
- Enables + starts the timer unit.

### macOS (launchd LaunchAgents)

Daemon mode (existing):

- LaunchAgent with `RunAtLoad=true` and `KeepAlive=true`.
- ProgramArguments: `<exe> agent --config <profile_path>`

Scheduled mode (new):

- LaunchAgent with `RunAtLoad=true` and `StartInterval=<interval_secs>`.
- ProgramArguments: `<exe> agent run-once --config <profile_path>`
- `KeepAlive` is not used (job exits after each run).

### Windows (Task Scheduler)

Daemon mode (existing):

- Creates a task at user logon that starts the long-running agent:
  - `<exe> agent --config <profile_path>`

Scheduled mode (new, best-effort):

- Creates/updates a task that runs every N minutes:
  - `N = max(1, interval_secs / 60)` (documented rounding if needed)
  - Runs: `<exe> agent run-once --config <profile_path>`
- Note: Without additional credentials, tasks typically run only when the user is logged on.

## Acceptance criteria (M2)

- A1. `filedock agent run-once --config <path>` runs a single snapshot + optional heartbeat and exits.
- A2. `agent install --mode scheduled` correctly wires cadence based on the saved profile.
- A3. `agent uninstall` removes scheduled mode units/tasks cleanly (no leftovers that keep firing).
- A4. `agent status` remains useful and does not regress desktop onboarding verification.
- A5. Idempotence: re-running `agent install` updates cadence/service definitions without creating duplicates.

## Verification plan

Linux (manual):

- `filedock agent init --profile test --folder ... --server ... --interval-secs 300 --no-register`
- `filedock agent install --profile test --mode scheduled --dry-run` (preview shows service+timer)
- `filedock agent install --profile test --mode scheduled`
- `systemctl --user list-timers | rg filedock-agent-test`
- `filedock agent status --profile test`
- `filedock agent uninstall --profile test --delete-config`

macOS + Windows:

- Documented best-effort steps; validated as far as possible via `--dry-run` output and probe commands.

## Non-goals / Out of scope

- Cron expressions / calendar scheduling (daily at 03:00, weekdays only).
- System-wide installs that require admin/root privileges.
- Battery/idle detection beyond what the OS scheduler provides.
- Remote server-driven scheduling.

