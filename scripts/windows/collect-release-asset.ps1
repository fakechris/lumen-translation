<#
.SYNOPSIS
Pick the NSIS installer out of Tauri's bundle directory and give it the
release asset name.

.DESCRIPTION
Fails loudly when the bundle directory holds anything other than exactly one
installer: a stale artefact from a previous run would otherwise be published
silently under the new version's name.
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$BundleDirectory,

    [Parameter(Mandatory = $true)]
    [string]$VersionTag,

    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'

if ($VersionTag -notmatch '^v\d+\.\d+\.\d+$') {
    throw "VersionTag must use vMAJOR.MINOR.PATCH format: $VersionTag"
}

$bundle = (Resolve-Path -LiteralPath $BundleDirectory).Path
$installers = @(Get-ChildItem -LiteralPath $bundle -File -Filter '*-setup.exe')
if ($installers.Count -ne 1) {
    throw "Expected exactly one NSIS installer in $bundle, found $($installers.Count)"
}

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$output = Join-Path $OutputDirectory "Lumen-Translation-$VersionTag-windows-x64-setup.exe"
Copy-Item -LiteralPath $installers[0].FullName -Destination $output -Force

if (-not (Test-Path -LiteralPath $output -PathType Leaf)) {
    throw "Windows release asset was not created: $output"
}

Write-Output $output
