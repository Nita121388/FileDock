# SFTP (SSH) Connector

This document describes the planned/implemented SFTP (SSH) connector for FileDock.

Design goals:
- keep FileDock core lightweight (SSH lives in a plugin)
- enable a "VPS file pane" experience in the desktop app
- support read/write operations (browse/upload/download/move/delete)

## Implementation approach

The SFTP connector is implemented as an external plugin executable:

`filedock-sftp`

It is invoked via:

```bash
filedock plugin run --name sftp --json '<payload>'
```

## JSON protocol

The plugin reads one JSON document on stdin:

```json
{
  "op": "list|stat|download|upload|mkdir|mv|rm",
  "conn": {
    "host": "example.com",
    "port": 22,
    "user": "root",
    "auth": {
      "password": "",
      "key_path": "~/.ssh/id_ed25519",
      "agent": false
    },
    "known_hosts": {
      "policy": "strict|accept-new|insecure",
      "path": "~/.ssh/known_hosts"
    },
    "base_path": ""
  },
  "args": { }
}
```

Response is one JSON document on stdout:

```json
{ "ok": true, "data": { } }
```

On failure:

```json
{ "ok": false, "error": { "code": "not_found", "message": "..." } }
```

Notes:
- All remote paths are POSIX paths.
- If `base_path` is set, all requested paths are joined under it and traversal is rejected.

## Operations

### list

Args:

```json
{ "path": "/var/log" }
```

Returns:

```json
{ "entries": [ { "name": "syslog", "kind": "file", "size": 123, "mtime_unix": 1700000000 } ] }
```

### stat

Args:

```json
{ "path": "/etc/hosts" }
```

Returns:

```json
{ "kind": "file", "size": 123, "mtime_unix": 1700000000 }
```

### download

Args:

```json
{ "remote_path": "/etc/hosts", "local_path": "/tmp/hosts" }
```

Returns:

```json
{ "bytes_written": 123 }
```

### upload

Args:

```json
{ "local_path": "/tmp/a.txt", "remote_path": "/root/a.txt", "mkdirs": true }
```

### mkdir

Args:

```json
{ "path": "/root/newdir", "parents": true }
```

### mv

Args:

```json
{ "from": "/root/a.txt", "to": "/root/b.txt" }
```

### rm

Args:

```json
{ "path": "/root/b.txt", "recursive": false }
```

For safety, recursive delete is intentionally unsupported in the MVP.

## Building the plugin (Go implementation)

From the repo root:

```bash
go build -o plugins/bin/filedock-sftp ./plugins/sftp
```

