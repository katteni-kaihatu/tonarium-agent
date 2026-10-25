param([string]$TaskName = 'TonariumAgentTunnel')
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
$tunnelScript = Join-Path $root 'scripts\public-tunnel.ps1'
$action = New-ScheduledTaskAction -Execute $powershell -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $tunnelScript + '"') -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'Tonarium agent dashboard HTTPS tunnel' -Force | Out-Null
Write-Host "Installed $TaskName. Start it with: Start-ScheduledTask -TaskName $TaskName"
