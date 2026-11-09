# Average GPU engine use of one isolated Harbor's GPU process over a few seconds.
# Usage: measure-process-gpu.ps1 -Match <text in the electron command line> -Seconds 16
param([Parameter(Mandatory)][string]$Match, [int]$Seconds = 16)
$gpu = Get-CimInstance Win32_Process -Filter "name='electron.exe'" |
  Where-Object { $_.CommandLine -like "*--type=gpu-process*" -and $_.CommandLine -like "*$Match*" } |
  Select-Object -First 1
if (-not $gpu) {
  $parents = Get-CimInstance Win32_Process -Filter "name='electron.exe'" | Where-Object { $_.CommandLine -like "*$Match*" -and $_.CommandLine -notlike '*--type=*' }
  foreach ($p in $parents) {
    $gpu = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($p.ProcessId)" | Where-Object { $_.CommandLine -like '*--type=gpu-process*' } | Select-Object -First 1
    if ($gpu) { break }
  }
}
if (-not $gpu) { Write-Output 'NO_GPU_PROCESS'; exit 2 }
$id = $gpu.ProcessId
$totals = @{}
$samples = 0
for ($i = 0; $i -lt [Math]::Ceiling($Seconds / 2); $i++) {
  $set = Get-Counter -Counter '\GPU Engine(*)\Utilization Percentage' -SampleInterval 2 -MaxSamples 1 -ErrorAction SilentlyContinue
  foreach ($s in $set.CounterSamples) {
    if ($s.InstanceName -match "pid_${id}_.*engtype_(\w+)") {
      $e = $Matches[1]
      if (-not $totals.ContainsKey($e)) { $totals[$e] = 0.0 }
      $totals[$e] += $s.CookedValue
    }
  }
  $samples++
}
$parts = $totals.GetEnumerator() | Sort-Object Name | ForEach-Object { '{0}={1:N2}' -f $_.Name, ($_.Value / $samples) }
$cpu = (Get-Process -Id $id -ErrorAction SilentlyContinue).CPU
Write-Output ("pid=$id samples=$samples " + ($parts -join ' '))
