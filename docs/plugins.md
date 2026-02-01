# Plugins

FileDock aims to stay small and predictable. Advanced or environment-specific features can be added
via *plugins*.

## What is a plugin?

A plugin is an external executable named:

`filedock-<name>`

Example: `filedock-notify`, `filedock-s3-lifecycle`, `filedock-mycompany-policy`.

Plugins run as separate processes and communicate via stdin/stdout JSON. This keeps the core binary
lightweight and avoids in-process ABI/versioning issues.

## Discovery

`filedock plugin list` discovers plugins from:

1) `FILEDOCK_PLUGIN_DIRS` (colon-separated directories)
2) `FILEDOCK_PLUGIN_DIR` (single directory)
3) `./plugins/bin` (repo-local convenience)
4) `PATH`

## Running a plugin

Run by name and pass a JSON payload on stdin:

```bash
filedock plugin run --name notify --json '{"event":"snapshot_done","snapshot_id":"..."}'
```

The plugin may write JSON (or plain text) to stdout.

Exit codes:
- `0`: success
- non-zero: failure (stderr is surfaced by the CLI)

## Minimal contract

Input:
- stdin: a single JSON document (string)

Output:
- stdout: optional JSON or plain text
- stderr: optional logs

## Example plugin

See `plugins/examples/filedock-notify` for a tiny example that echoes the input JSON.

