param(
    [string]$TargetDir = "",
    [switch]$Offline
)
$ErrorActionPreference = 'Stop'
$companionRoot = Split-Path -Parent $PSScriptRoot
$nativeRoot = Join-Path $companionRoot 'native-recycle'
if (-not $TargetDir) { $TargetDir = Join-Path $nativeRoot 'target' }
$TargetDir = [IO.Path]::GetFullPath($TargetDir)
$cargoArgs = @('build', '--release', '--locked', '--manifest-path', (Join-Path $nativeRoot 'Cargo.toml'), '--target-dir', $TargetDir)
if ($Offline) { $cargoArgs += '--offline' }
& cargo @cargoArgs
if ($LASTEXITCODE -ne 0) { throw "Native helper build failed ($LASTEXITCODE)" }
$binDir = Join-Path $companionRoot 'bin'
New-Item -ItemType Directory -Path $binDir -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $TargetDir 'release/muse-history-recycle.exe') -Destination (Join-Path $binDir 'muse-history-recycle.exe') -Force
