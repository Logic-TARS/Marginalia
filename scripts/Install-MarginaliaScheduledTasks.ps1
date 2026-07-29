[CmdletBinding()]
param(
    [string]$BackupAt = "03:00",
    [switch]$DisableSleepOnAC
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$pwshCommand = Get-Command pwsh.exe -ErrorAction SilentlyContinue
$pwsh = if ($pwshCommand) {
    $pwshCommand.Source
} else {
    Join-Path $PSHOME "powershell.exe"
}
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1)

$startAction = New-ScheduledTaskAction -Execute $pwsh -Argument (
    '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f
    (Join-Path $PSScriptRoot "Start-MarginaliaProduction.ps1")
)
$startTrigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
Register-ScheduledTask `
    -TaskName "Marginalia Production Startup" `
    -Action $startAction `
    -Trigger $startTrigger `
    -Principal $principal `
    -Settings $settings `
    -Force | Out-Null

$backupTime = [DateTime]::ParseExact($BackupAt, "HH:mm", $null)
$backupAction = New-ScheduledTaskAction -Execute $pwsh -Argument (
    '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f
    (Join-Path $PSScriptRoot "Backup-Marginalia.ps1")
)
$backupTrigger = New-ScheduledTaskTrigger -Daily -At $backupTime
Register-ScheduledTask `
    -TaskName "Marginalia Daily Backup" `
    -Action $backupAction `
    -Trigger $backupTrigger `
    -Principal $principal `
    -Settings $settings `
    -Force | Out-Null

if ($DisableSleepOnAC) {
    & powercfg /change standby-timeout-ac 0
    if ($LASTEXITCODE -ne 0) {
        throw "Could not disable AC sleep. Run this script from an elevated terminal."
    }
}

Write-Output "Installed Marginalia startup and daily $BackupAt backup tasks."
Write-Output "Also enable 'Start Docker Desktop when you sign in' in Docker Desktop settings."
