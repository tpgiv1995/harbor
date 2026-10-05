# Harbor phone server, as a Windows Scheduled Task that starts at logon.
#
# EDIT $AppDir below to your checkout's `app` directory, then run this once in
# PowerShell. It does not need to be elevated for a per-user logon task.
#
#   powershell -ExecutionPolicy Bypass -File .\harbor-server-task.ps1
#
# Remove it again with:
#   Unregister-ScheduledTask -TaskName 'HarborServer' -Confirm:$false
#
# This is a template with the right shape. It has not been registered on the
# Legion as part of an automated batch (registration is an operator step:
# Tailscale must already be a service that starts at logon, `npm run build:web`
# must have produced app/dist-web/, and the task should start AFTER Tailscale
# so MagicDNS discovery is not empty on the first boot). Read setup/mobile.md
# and setup/windows/README.md first.

$AppDir = "$env:USERPROFILE\dev\harbor\app"

# Loopback by default. To reach it from a phone, either set this to the
# machine's own Tailscale address (`tailscale ip -4`) or leave it and put
# `tailscale serve --bg --https=443 http://127.0.0.1:8787` in front. Anything
# that is neither loopback nor 100.64.0.0/10 is refused at startup, on purpose.
$ServerHost = '127.0.0.1'
$ServerPort = '8787'

$LogDir = "$env:LOCALAPPDATA\harbor"
$Log = "$LogDir\harbor-server.log"

if (-not (Test-Path $AppDir)) {
  Write-Error "AppDir does not exist: $AppDir. Edit this script before running it."
  exit 1
}
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) {
  Write-Error 'node is not on PATH. Install Node 22 or newer first.'
  exit 1
}
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# Run node directly (no cmd.exe wrapper) to minimize console flash at logon.
# HONEST LIMIT: powershell.exe -WindowStyle Hidden can still flash briefly at
# logon. Env vars are set on the action; stdout/stderr append to one log via a
# tiny PowerShell -WindowStyle Hidden trampoline that still owns redirection.
$nodePath = $node.Source
$inner = @"
`$env:HARBOR_SERVER_HOST = '$ServerHost'
`$env:HARBOR_SERVER_PORT = '$ServerPort'
Set-Location -LiteralPath '$AppDir'
& '$nodePath' 'src\server\index.js' *>> '$Log'
"@
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))

$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -EncodedCommand $encoded"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# Delay past Tailscale's own logon start so MagicDNS discovery is usually
# non-empty on the first listen. The server also re-resolves MagicDNS on each
# WebSocket upgrade, so a late Tailscale start still heals without a restart.
$trigger.Delay = 'PT30S'
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
             -DontStopIfGoingOnBatteries -StartWhenAvailable `
             -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
             -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName 'HarborServer' -Action $action -Trigger $trigger `
  -Settings $settings -Description 'Harbor phone server (loopback; pair with tailscale serve)' -Force | Out-Null

Write-Host "Registered scheduled task 'HarborServer'."
Write-Host "  app dir : $AppDir"
Write-Host "  bind    : ${ServerHost}:${ServerPort}"
Write-Host "  log     : $Log"
Write-Host 'Start it now with:  Start-ScheduledTask -TaskName HarborServer'
Write-Host 'Then:               tailscale serve --bg --https=443 http://127.0.0.1:8787'
Write-Host 'Mint a phone link:  cd app; npm run mint:server-link'
