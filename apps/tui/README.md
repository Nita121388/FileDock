# FileDock TUI (MVP)

This is a lightweight terminal UI that can browse snapshots and directories from a FileDock server.

Keys:

- `q`: quit
- `r`: refresh snapshots
- `Tab`: switch focus (snapshots pane <-> tree pane)
- `Up/Down`: move selection
- `Enter`: open selected snapshot / open selected directory
- `Backspace` or `b`: go up one directory (tree pane)

Auth:

- If the server runs with `FILEDOCK_TOKEN`, set the same env var before running this app.

