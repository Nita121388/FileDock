$ErrorActionPreference = "Stop"

# Update these values for your machine.
$FileDockExe = "filedock" # or full path to filedock.exe
$Config = "$env:USERPROFILE\\.config\\filedock\\agent.toml"

# Optional auth:
# $env:FILEDOCK_TOKEN = "change-me"
# $env:FILEDOCK_DEVICE_ID = "..."
# $env:FILEDOCK_DEVICE_TOKEN = "..."

if (-not (Test-Path $Config)) {
  Write-Host "Missing config: $Config"
  Write-Host "Tip: copy deploy/agent-config.example.toml to that path and edit it."
  exit 2
}

& $FileDockExe agent --config $Config
