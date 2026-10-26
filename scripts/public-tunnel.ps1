$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$stdout = Join-Path $root '.data\public-tunnel.stdout.log'
$stderr = Join-Path $root '.data\public-tunnel.stderr.log'
$ssh = (Get-Command ssh.exe).Source
while ($true) {
  $process = Start-Process -FilePath $ssh -ArgumentList @(
    '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3', '-o', 'ExitOnForwardFailure=yes',
    '-R', 'tonarium-agent:80:127.0.0.1:43879', 'kokopi.me'
  ) -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  $unhealthy = 0
  while (-not $process.HasExited) {
    Start-Sleep -Seconds 5
    $message = (Get-Content -LiteralPath $stdout -Raw -ErrorAction SilentlyContinue) +
      (Get-Content -LiteralPath $stderr -Raw -ErrorAction SilentlyContinue)
    $message = $message -replace '\x1b\[[0-9;]*m', ''
    if ($message -match 'subdomain\s+tonarium-agent\.kokopi\.me\s+is unavailable') {
      Write-Output 'Requested subdomain is unavailable; reconnecting.'
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      break
    }
    if ($message -match 'https://tonarium-agent\.kokopi\.me') {
      try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri 'https://tonarium-agent.kokopi.me/api/state' -TimeoutSec 8
        if ($response.StatusCode -eq 200) { $unhealthy = 0 } else { $unhealthy++ }
      } catch { $unhealthy++ }
      if ($unhealthy -ge 3) {
        Write-Output 'Public dashboard is not responding; reconnecting.'
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        break
      }
    }
  }
  Start-Sleep -Seconds 20
}
