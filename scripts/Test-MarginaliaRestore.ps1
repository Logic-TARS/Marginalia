[CmdletBinding()]
param(
    [string]$BackupRoot = "G:\Backups\Marginalia",
    [string]$Backup,
    [string]$HelperImage = "marginalia-api:production",
    [switch]$KeepVolume
)

$ErrorActionPreference = "Stop"

function Get-Sha256Hex([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace("-", "")
    }
    finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}

$backupBase = [IO.Path]::GetFullPath($BackupRoot)
if (-not $Backup) {
    $latest = Get-ChildItem -LiteralPath $backupBase -Directory |
        Where-Object {
            $_.Name -match "^\d{8}-\d{6}$" -and
            (Test-Path -LiteralPath (Join-Path $_.FullName "manifest.json"))
        } |
        Sort-Object Name -Descending |
        Select-Object -First 1
    if (-not $latest) {
        throw "No timestamped backup exists under $backupBase"
    }
    $Backup = $latest.FullName
}

$backupPath = [IO.Path]::GetFullPath($Backup)
$manifestPath = Join-Path $backupPath "manifest.json"
$dataPath = Join-Path $backupPath "data"
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $dataPath -PathType Container)) {
    throw "Backup is missing manifest.json or data/: $backupPath"
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
foreach ($file in $manifest.files) {
    $candidate = [IO.Path]::GetFullPath((Join-Path $dataPath $file.path))
    if (-not $candidate.StartsWith($dataPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Manifest contains an unsafe path: $($file.path)"
    }
    $actual = Get-Sha256Hex $candidate
    if ($actual -ne $file.sha256) {
        throw "Hash mismatch: $($file.path)"
    }
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker is required for the temporary-volume restore drill."
}

$volume = "marginalia_restore_drill_$((Get-Date).ToString('yyyyMMddHHmmss'))"
$container = "${volume}_helper"
$roundTripPath = Join-Path ([IO.Path]::GetTempPath()) $volume
& docker volume create $volume | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "Could not create restore volume $volume"
}

try {
    $localImages = @(& docker images --format "{{.Repository}}:{{.Tag}}" |
        Where-Object { $_ -and $_ -notmatch "^<none>:" })
    if ($localImages -notcontains $HelperImage) {
        $HelperImage = ($localImages | Select-Object -First 1)
    }
    if (-not $HelperImage) {
        throw "No local Docker image is available to attach the temporary volume."
    }

    & docker create --name $container `
        --mount "source=$volume,target=/restore" `
        $HelperImage | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Could not create the helper container from $HelperImage"
    }

    & docker cp "$dataPath\." "${container}:/restore"
    if ($LASTEXITCODE -ne 0) {
        throw "Could not copy the backup into $volume"
    }

    New-Item -ItemType Directory -Path $roundTripPath -Force | Out-Null
    & docker cp "${container}:/restore/." $roundTripPath
    if ($LASTEXITCODE -ne 0) {
        throw "Could not read the restored data back from $volume"
    }

    foreach ($file in $manifest.files) {
        $restoredFile = Join-Path $roundTripPath $file.path
        if ((Get-Sha256Hex $restoredFile) -ne $file.sha256) {
            throw "Restored hash mismatch: $($file.path)"
        }
    }
    $restoredDatabase = Join-Path $roundTripPath "marginalia.db"
    $repoRoot = Split-Path -Parent $PSScriptRoot
    $python = Join-Path $repoRoot ".venv\Scripts\python.exe"
    if (-not (Test-Path -LiteralPath $python)) {
        $python = "python"
    }
    $check = & $python -c `
        "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute('PRAGMA integrity_check').fetchone()[0]); c.close()" `
        $restoredDatabase
    if ($LASTEXITCODE -ne 0 -or $check.Trim() -ne "ok") {
        throw "Restored SQLite validation failed: $check"
    }

    Write-Output "Restore drill passed: $backupPath"
    Write-Output "Temporary volume: $volume; helper image: $HelperImage; SQLite integrity: $($check.Trim())"
}
finally {
    $helperContainer = (& docker ps -aq --filter "name=^/$container$")
    if ($helperContainer) {
        & docker rm -f $container | Out-Null
    }
    if (Test-Path -LiteralPath $roundTripPath) {
        Remove-Item -LiteralPath $roundTripPath -Recurse -Force
    }
    if (-not $KeepVolume) {
        & docker volume rm $volume | Out-Null
    }
}
