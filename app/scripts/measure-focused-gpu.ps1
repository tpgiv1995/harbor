# Passive measurement of what Harbor costs the DISPLAY GPU while it is the focused window.
#
# Waits until Harbor is the OS foreground window, then samples the 3D engine of Harbor's GPU
# process and of dwm (the desktop compositor), per adapter. It touches nothing in Harbor: no
# inspector port, no injected script, no focus change. It always exits: after the rows, or
# after -WaitMinutes with Harbor never in the foreground.
#
# Why per adapter (luid) and why foreground-checked: on a laptop with two GPUs, counters summed
# by process mix both adapters and hide a saturated integrated GPU, and a sample taken while
# another window is focused measures the background hold, not the focused cost. A row is VALID
# only when Harbor was the foreground window both before and after it was taken.
#
#   powershell -File scripts\measure-focused-gpu.ps1                 # finds the running Harbor
#   powershell -File scripts\measure-focused-gpu.ps1 -MainPid 1234   # or name the main process
#
# Reference numbers and the rule they guard are in docs/claude/views.md (NO DECORATIVE GPU COST).
param([int]$MainPid = 0, [int]$WaitMinutes = 45, [int]$Rows = 3, [int]$Seconds = 8, [string]$Label = 'harbor')

Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
'@

function Get-Foreground {
  $p = 0
  [void][W.U]::GetWindowThreadProcessId([W.U]::GetForegroundWindow(), [ref]$p)
  $name = '?'
  try { $name = (Get-Process -Id $p -ErrorAction Stop).Name } catch { }
  [pscustomobject]@{ Pid = [int]$p; Name = $name }
}

if (-not $MainPid) {
  # Harbor records every boot; the last boot row names the main process.
  $lifecycle = Join-Path $env:USERPROFILE '.cache\harbor\perf\lifecycle.jsonl'
  if (Test-Path -LiteralPath $lifecycle) {
    $boot = Get-Content -LiteralPath $lifecycle | Where-Object { $_ -match '"kind":"boot"' } | Select-Object -Last 1
    if ($boot -match '"pid":(\d+)') { $MainPid = [int]$matches[1] }
  }
}
if (-not $MainPid -or -not (Get-Process -Id $MainPid -ErrorAction SilentlyContinue)) { "[$Label] no running Harbor main process found (pass -MainPid)"; exit 2 }
$gpuPid = (Get-CimInstance Win32_Process -Filter "Name='electron.exe' AND ParentProcessId=$MainPid" |
  Where-Object { $_.CommandLine -match '--type=gpu-process' } | Select-Object -First 1).ProcessId
"[$Label] main=$MainPid gpu=$gpuPid  waiting up to $WaitMinutes min for Harbor to be foreground  $(Get-Date -Format T)"

$deadline = (Get-Date).AddMinutes($WaitMinutes)
$streak = 0
while ((Get-Date) -lt $deadline -and $streak -lt 3) {
  if (-not (Get-Process -Id $MainPid -ErrorAction SilentlyContinue)) { "[$Label] Harbor main pid exited while waiting"; exit 3 }
  if ((Get-Foreground).Pid -eq $MainPid) { $streak++ } else { $streak = 0 }
  if ($streak -lt 3) { Start-Sleep -Milliseconds 1500 }
}
if ($streak -lt 3) { "[$Label] NEVER FOREGROUND within $WaitMinutes min; nothing measured"; exit 4 }

$dwm = (Get-Process dwm | Select-Object -First 1).Id
for ($r = 1; $r -le $Rows; $r++) {
  $before = Get-Foreground
  $sets = Get-Counter '\GPU Engine(*)\Utilization Percentage' -SampleInterval 2 -MaxSamples ([int]($Seconds / 2)) -ErrorAction SilentlyContinue
  $after = Get-Foreground
  $agg = @{}
  foreach ($set in $sets) {
    foreach ($c in $set.CounterSamples) {
      if ($c.InstanceName -match 'pid_(\d+)_luid_0x[0-9a-f]+_0x([0-9a-f]+)_phys_\d+_eng_\d+_engtype_3d') {
        $p = [int]$matches[1]
        if ($p -eq $gpuPid -or $p -eq $dwm) {
          $k = $(if ($p -eq $gpuPid) { 'harbor' } else { 'dwm' }) + " luid=$($matches[2])"
          $agg[$k] = $agg[$k] + $c.CookedValue / $sets.Count
        }
      }
    }
  }
  $parts = $agg.GetEnumerator() | Where-Object { $_.Value -gt 0.05 } | Sort-Object Key | ForEach-Object { '{0} = {1:N1}%' -f $_.Key, $_.Value }
  $valid = ($before.Pid -eq $MainPid -and $after.Pid -eq $MainPid)
  "[$Label row $r] " + ($parts -join ' | ') + "   foreground before=$($before.Name) after=$($after.Name)  VALID=$valid  $(Get-Date -Format T)"
}
