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
# This is a template with the right shape, not a validated artifact. Harbor's
# Electron window has never been opened on Windows; the session daemon and pty
# layer have been proven there. Read setup/windows/README.md first.

$AppDir = "$env:USERPROFILE\dev\harbor\app"

# Loopback by default. To reach it from a phone, either set this to the
# machine's own Tailscale address (`tailscale ip -4`) or leave it and put
# `tailscale serve` in front. Anything that is neither loopback nor
# 100.64.0.0/10 is refused at startup, on purpose.
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

# Redirection needs a shell, so the task runs cmd, which sets the environment
# and then execs node. Output is appended to one log rather than discarded: the
# next silent failure should leave a trace.
$inner = "set HARBOR_SERVER_HOST=$ServerHost && set HARBOR_SERVER_PORT=$ServerPort && " +
         "cd /d `"$AppDir`" && `"$($node.Source)`" src\server\index.js >> `"$Log`" 2>&1"

$action    = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c $inner"
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
             -DontStopIfGoingOnBatteries -StartWhenAvailable `
             -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
             -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName 'HarborServer' -Action $action -Trigger $trigger `
  -Settings $settings -Description 'Harbor phone server' -Force | Out-Null

Write-Host "Registered scheduled task 'HarborServer'."
Write-Host "  app dir : $AppDir"
Write-Host "  bind    : ${ServerHost}:${ServerPort}"
Write-Host "  log     : $Log"
Write-Host 'Start it now with:  Start-ScheduledTask -TaskName HarborServer'
