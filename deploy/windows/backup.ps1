$ErrorActionPreference = "Stop"

# Update these values for your machine.
$FileDockExe = "filedock" # or full path to filedock.exe
$Server = "http://127.0.0.1:8787"
$Device = "windows-pc"
$Folder = "C:\\Users\\you\\Documents"

# Optional auth:
# $env:FILEDOCK_TOKEN = "change-me"
# $env:FILEDOCK_DEVICE_ID = "..."
# $env:FILEDOCK_DEVICE_TOKEN = "..."

& $FileDockExe push-folder-loop `
  --server $Server `
  --device $Device `
  --folder $Folder `
  --interval-secs 0

