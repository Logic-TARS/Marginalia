[CmdletBinding()]
param(
    [string]$SourceData,
    [string]$Destination = "G:\Backups\Marginalia",
    [ValidateRange(1, 365)]
    [int]$Retention = 14,
    [switch]$SkipServiceStop
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

$repoRoot = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $repoRoot "docker-compose.prod.yml"
if (-not $SourceData) {
    $SourceData = Join-Path $repoRoot "backend\data"
}

$sourcePath = [IO.Path]::GetFullPath($SourceData)
$destinationPath = [IO.Path]::GetFullPath($Destination)
$destinationRoot = [IO.Path]::GetPathRoot($destinationPath)
if ($destinationPath.TrimEnd("\") -eq $destinationRoot.TrimEnd("\")) {
    throw "Destination must be a dedicated backup directory, not a drive root."
}
if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) {
    throw "Source data directory does not exist: $sourcePath"
}

New-Item -ItemType Directory -Path $destinationPath -Force | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupRoot = Join-Path $destinationPath $stamp
$backupData = Join-Path $backupRoot "data"
New-Item -ItemType Directory -Path $backupData -Force | Out-Null

$restartProduction = $false
try {
    if (-not $SkipServiceStop -and (Get-Command docker -ErrorAction SilentlyContinue)) {
        $running = @(& docker compose -f $composeFile ps --services --status running 2>$null)
        $restartProduction = $running -contains "api"
        if ($restartProduction) {
            & docker compose -f $composeFile stop cloudflared api
            if ($LASTEXITCODE -ne 0) {
                throw "Could not stop the production services for a consistent snapshot."
            }
        } else {
            $listenerPids = @(
                Get-NetTCPConnection -State Listen -LocalPort 8720 -ErrorAction SilentlyContinue |
                    Select-Object -ExpandProperty OwningProcess -Unique
            )
            $nativeUvicorn = @(
                Get-CimInstance Win32_Process |
                    Where-Object {
                        $_.ProcessId -in $listenerPids -and
                        $_.CommandLine -match "uvicorn"
                    }
            )
            if ($nativeUvicorn) {
                throw "A native uvicorn process is still using the data. Stop it before the final consistency snapshot, or use -SkipServiceStop only for a non-production drill."
            }
        }
    }

    Get-ChildItem -LiteralPath $sourcePath -Force | Copy-Item `
        -Destination $backupData -Recurse -Force

    $databasePath = Join-Path $backupData "marginalia.db"
    if (-not (Test-Path -LiteralPath $databasePath -PathType Leaf)) {
        throw "The snapshot does not contain marginalia.db."
    }

    $python = Join-Path $repoRoot ".venv\Scripts\python.exe"
    if (-not (Test-Path -LiteralPath $python)) {
        $python = "python"
    }
    $integrity = & $python -c `
        "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute('PRAGMA integrity_check').fetchone()[0]); c.close()" `
        $databasePath
    if ($LASTEXITCODE -ne 0 -or $integrity.Trim() -ne "ok") {
        throw "SQLite integrity check failed: $integrity"
    }

    $files = @(
        Get-ChildItem -LiteralPath $backupData -Recurse -File | ForEach-Object {
            $relativePath = $_.FullName.Substring(
                $backupData.TrimEnd("\").Length
            ).TrimStart("\")
            [ordered]@{
                path = $relativePath
                bytes = $_.Length
                sha256 = Get-Sha256Hex $_.FullName
            }
        }
    )
    $manifest = [ordered]@{
        formatVersion = 1
        createdAt = (Get-Date).ToString("o")
        source = $sourcePath
        sqliteIntegrity = $integrity.Trim()
        files = $files
    }
    $manifest | ConvertTo-Json -Depth 5 |
        Set-Content -LiteralPath (Join-Path $backupRoot "manifest.json") -Encoding utf8

    $expired = @(Get-ChildItem -LiteralPath $destinationPath -Directory |
        Where-Object { $_.Name -match "^\d{8}-\d{6}$" } |
        Sort-Object Name -Descending |
        Select-Object -Skip $Retention)
    foreach ($directory in $expired) {
        $resolved = [IO.Path]::GetFullPath($directory.FullName)
        if ([IO.Path]::GetDirectoryName($resolved) -ne $destinationPath) {
            throw "Refusing to remove a backup outside $destinationPath"
        }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }

    Write-Output "Backup complete: $backupRoot"
    Write-Output "Files: $($files.Count); SQLite integrity: $($integrity.Trim())"
}
catch {
    if ((Test-Path -LiteralPath $backupRoot) -and
        ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($backupRoot)) -eq $destinationPath)) {
        Remove-Item -LiteralPath $backupRoot -Recurse -Force
    }
    throw
}
finally {
    if ($restartProduction) {
        & docker compose -f $composeFile up -d
        if ($LASTEXITCODE -ne 0) {
            Write-Error "Backup finished, but production services did not restart."
        }
    }
}
