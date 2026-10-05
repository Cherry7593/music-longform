param([int]$RootPid, [string]$StopFile, [string]$PidFile)
# Read only explicitly held benchmark PIDs, never all ffmpeg processes by name.
$ErrorActionPreference = 'Stop'
$known = @{}
$totalCpu = 0.0
$first = $true
while (-not (Test-Path -LiteralPath $StopFile)) {
  try {
    # A writer may be updating the tiny file; skip that sample rather than invent data.
    try { $active = Get-Content -LiteralPath $PidFile -Raw | ConvertFrom-Json } catch { Start-Sleep -Milliseconds 100; continue }
    $ids = @($RootPid) + @($active | ForEach-Object { [int]$_.pid })
    $rss = 0.0
    $observed = @()
    foreach ($n in ($ids | Select-Object -Unique)) {
      $p = Get-Process -Id $n -ErrorAction SilentlyContinue
      if ($null -eq $p) { continue }
      try {
        $birth = $p.StartTime.ToUniversalTime().Ticks
        $key = "$n|$birth"
        $cpu = $p.TotalProcessorTime.TotalSeconds
        if ($known.ContainsKey($key)) { $totalCpu += [Math]::Max(0, $cpu - $known[$key]) }
        elseif (-not $first) { $totalCpu += $cpu }
        $known[$key] = $cpu
        $rss += [double]$p.WorkingSet64
        if ($n -ne $RootPid) { $observed += $n }
      } catch { continue } # child closed during sample
    }
    $os = Get-CimInstance Win32_OperatingSystem -Property FreePhysicalMemory,TotalVisibleMemorySize
    [Console]::Out.WriteLine((@{ at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); processTreeRssBytes = $rss; sampledCpuSeconds = $totalCpu; observedToolPids = $observed; freeMemoryBytes = [double]$os.FreePhysicalMemory * 1024; totalMemoryBytes = [double]$os.TotalVisibleMemorySize * 1024 } | ConvertTo-Json -Compress))
    $first = $false
  } catch { [Console]::Out.WriteLine((@{ error = ('Windows held-process counters unavailable: ' + $_.Exception.Message) } | ConvertTo-Json -Compress)); break }
  Start-Sleep -Milliseconds 750
}
