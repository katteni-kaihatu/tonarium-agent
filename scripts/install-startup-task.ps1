param([string]$TaskName = 'TonariumAgent')
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$node = (Get-Command node -ErrorAction Stop).Source
if (-not (Test-Path (Join-Path $root '.env'))) { throw 'Create .env from .env.example before installing the startup task.' }
$action = New-ScheduledTaskAction -Execute $node -Argument ('"' + (Join-Path $root 'src\index.js') + '"') -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'Tonarium Discord feedback agent' -Force | Out-Null
Write-Host "Installed $TaskName. Start it with: Start-ScheduledTask -TaskName $TaskName"
