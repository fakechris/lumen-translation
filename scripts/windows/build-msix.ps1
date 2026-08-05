<#
.SYNOPSIS
Pack the built Lumen Translation executable into an unsigned MSIX for
Microsoft Store ingestion.

.DESCRIPTION
Adapted from the sibling lumen-asr repo's script so both products submit
packages built the same way. The Store signs the package itself after
certification; sideloading this output still needs a trusted signature.

Note on Store viability: Lumen installs a global WH_KEYBOARD_LL hook to
dismiss the selection popup when the user starts typing. That is legitimate
and the package declares no capability beyond runFullTrust, but keyboard hooks
do attract Store review scrutiny. The NSIS installer is the primary
distribution channel; this package exists so the Store option stays open.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ExecutablePath,

    [Parameter(Mandatory = $true)]
    [string]$OutputPath,

    [string]$Version = "0.1.0.0",
    [string]$IdentityName = "LumenTranslation.Dev",
    [string]$Publisher = "CN=Lumen Translation Development, OID.2.25.269339209217466799157659632861705434293=1",
    [string]$PublisherDisplayName = "Lumen Translation Development",

    [ValidateSet("x64", "x86", "arm64")]
    [string]$Architecture = "x64",

    [string]$IconPath,
    [switch]$KeepStaging
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if ([string]::IsNullOrWhiteSpace($IconPath)) {
    $IconPath = Join-Path $repoRoot "apps\desktop\src-tauri\icons\icon.png"
}

$resolvedExecutable = (Resolve-Path -LiteralPath $ExecutablePath).Path
$resolvedIcon = (Resolve-Path -LiteralPath $IconPath).Path
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)

if ([System.IO.Path]::GetExtension($resolvedOutput) -ne ".msix") {
    throw "OutputPath must end in .msix: $resolvedOutput"
}

if ($IdentityName -notmatch "^[A-Za-z0-9.-]{3,50}$" -or $IdentityName.EndsWith(".")) {
    throw "IdentityName must be 3-50 characters using letters, digits, periods, or hyphens."
}

# Store versions are always four-part; accept the three-part form used in
# tauri.conf.json and pad it.
$versionParts = @($Version.Split("."))
if ($versionParts.Count -eq 3) {
    $versionParts += "0"
}
if ($versionParts.Count -ne 4) {
    throw "MSIX Version must have three or four numeric components: $Version"
}
foreach ($part in $versionParts) {
    $parsed = 0
    if (-not [int]::TryParse($part, [ref]$parsed) -or $parsed -lt 0 -or $parsed -gt 65535) {
        throw "Each MSIX version component must be between 0 and 65535: $Version"
    }
}
$normalizedVersion = $versionParts -join "."

if ([string]::IsNullOrWhiteSpace($Publisher) -or [string]::IsNullOrWhiteSpace($PublisherDisplayName)) {
    throw "Publisher and PublisherDisplayName must not be empty."
}

$kitsRoot = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
$makeAppx = Get-ChildItem -Path $kitsRoot -Recurse -Filter "makeappx.exe" -File |
    Where-Object { $_.Directory.Name -eq "x64" } |
    Sort-Object { [version]$_.Directory.Parent.Name } -Descending |
    Select-Object -First 1
if ($null -eq $makeAppx) {
    throw "makeappx.exe was not found. Install the Windows 10/11 SDK."
}

$outputDirectory = Split-Path -Parent $resolvedOutput
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

$stagingRoot = Join-Path ([System.IO.Path]::GetTempPath()) "lumen-translation-msix-$([guid]::NewGuid().ToString('N'))"
$assetsDirectory = Join-Path $stagingRoot "Assets"
New-Item -ItemType Directory -Path $assetsDirectory -Force | Out-Null

function Write-SquarePng {
    param(
        [Parameter(Mandatory = $true)]
        [System.Drawing.Image]$Source,
        [Parameter(Mandatory = $true)]
        [int]$Size,
        [Parameter(Mandatory = $true)]
        [string]$Destination
    )

    $bitmap = [System.Drawing.Bitmap]::new($Size, $Size)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.DrawImage($Source, 0, 0, $Size, $Size)
        $bitmap.Save($Destination, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

try {
    Add-Type -AssemblyName System.Drawing
    $sourceIcon = [System.Drawing.Image]::FromFile($resolvedIcon)
    try {
        Write-SquarePng -Source $sourceIcon -Size 44 -Destination (Join-Path $assetsDirectory "Square44x44Logo.png")
        Write-SquarePng -Source $sourceIcon -Size 150 -Destination (Join-Path $assetsDirectory "Square150x150Logo.png")
        Write-SquarePng -Source $sourceIcon -Size 50 -Destination (Join-Path $assetsDirectory "StoreLogo.png")
    }
    finally {
        $sourceIcon.Dispose()
    }

    Copy-Item -LiteralPath $resolvedExecutable -Destination (Join-Path $stagingRoot "lumen-translation-desktop.exe")

    $escape = [System.Security.SecurityElement]
    $manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:uap10="http://schemas.microsoft.com/appx/manifest/uap/windows10/10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap uap10 rescap">
  <Identity
    Name="$($escape::Escape($IdentityName))"
    Publisher="$($escape::Escape($Publisher))"
    Version="$normalizedVersion"
    ProcessorArchitecture="$Architecture" />
  <Properties>
    <DisplayName>Lumen Translation</DisplayName>
    <PublisherDisplayName>$($escape::Escape($PublisherDisplayName))</PublisherDisplayName>
    <Description>Select text anywhere in Windows and translate it.</Description>
    <Logo>Assets\StoreLogo.png</Logo>
  </Properties>
  <Resources>
    <Resource Language="en-us" />
    <Resource Language="zh-cn" />
  </Resources>
  <Dependencies>
    <TargetDeviceFamily
      Name="Windows.Desktop"
      MinVersion="10.0.19041.0"
      MaxVersionTested="10.0.26100.0" />
  </Dependencies>
  <Capabilities>
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
  <Applications>
    <Application
      Id="LumenTranslation"
      Executable="lumen-translation-desktop.exe"
      uap10:RuntimeBehavior="packagedClassicApp"
      uap10:TrustLevel="mediumIL">
      <uap:VisualElements
        DisplayName="Lumen Translation"
        Description="Select text anywhere in Windows and translate it."
        BackgroundColor="transparent"
        Square150x150Logo="Assets\Square150x150Logo.png"
        Square44x44Logo="Assets\Square44x44Logo.png"
        uap:AppListEntry="default" />
    </Application>
  </Applications>
</Package>
"@
    [System.IO.File]::WriteAllText(
        (Join-Path $stagingRoot "AppxManifest.xml"),
        $manifest,
        [System.Text.UTF8Encoding]::new($false)
    )

    & $makeAppx.FullName pack /o /d $stagingRoot /p $resolvedOutput
    if ($LASTEXITCODE -ne 0) {
        throw "MakeAppx failed with exit code $LASTEXITCODE."
    }

    $package = Get-Item -LiteralPath $resolvedOutput
    $hash = Get-FileHash -LiteralPath $resolvedOutput -Algorithm SHA256
    [pscustomobject]@{
        Package = $package.FullName
        Version = $normalizedVersion
        Architecture = $Architecture
        IdentityName = $IdentityName
        Publisher = $Publisher
        Bytes = $package.Length
        Sha256 = $hash.Hash
    } | Format-List
}
finally {
    if ($KeepStaging) {
        Write-Host "MSIX staging retained at $stagingRoot"
    }
    elseif (Test-Path -LiteralPath $stagingRoot) {
        Remove-Item -LiteralPath $stagingRoot -Recurse -Force
    }
}
