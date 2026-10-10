[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-p]{32}$')]
    [string] $ExtensionId,

    [ValidateSet('Chrome', 'Chromium')]
    [string] $Browser = 'Chrome',

    [switch] $Uninstall
)

$ErrorActionPreference = 'Stop'
$hostName = 'com.lyricvibe.native_audio'
$launcher = Join-Path $PSScriptRoot 'launch_native_host.cmd'
$localAppData = [Environment]::GetFolderPath('LocalApplicationData')
if (-not $localAppData) { throw 'LOCALAPPDATA is unavailable.' }
$manifestDirectory = Join-Path $localAppData 'LyricVibe\NativeMessaging'
$manifestPath = Join-Path $manifestDirectory "$hostName.json"
$registryProduct = if ($Browser -eq 'Chrome') { 'Google\Chrome' } else { 'Chromium' }
$registryPath = "Registry::HKEY_CURRENT_USER\Software\$registryProduct\NativeMessagingHosts\$hostName"

if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw "Native host launcher is missing: $launcher" }

if ($Uninstall) {
    if (-not (Test-Path -LiteralPath $registryPath)) { Write-Output 'Native host registration is already absent.'; exit 0 }
    $registeredManifest = (Get-Item -LiteralPath $registryPath).GetValue('')
    if ([IO.Path]::GetFullPath([string]$registeredManifest) -ine [IO.Path]::GetFullPath($manifestPath)) {
        throw 'Refusing to remove a native messaging registration owned by another manifest.'
    }
    if ($PSCmdlet.ShouldProcess($registryPath, 'Remove LyricVibe native host registration')) {
        Remove-Item -LiteralPath $registryPath -Recurse -Force
        Write-Output 'Removed the current-user registry registration. The manifest file was retained for recovery.'
    }
    exit 0
}

$manifest = [ordered]@{
    name = $hostName
    description = 'LyricVibe bounded in-memory native audio alignment'
    path = [IO.Path]::GetFullPath($launcher)
    type = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
}
$manifestJson = ($manifest | ConvertTo-Json -Depth 4) + "`n"

if (Test-Path -LiteralPath $registryPath) {
    $registeredManifest = (Get-Item -LiteralPath $registryPath).GetValue('')
    if ([IO.Path]::GetFullPath([string]$registeredManifest) -ine [IO.Path]::GetFullPath($manifestPath)) {
        throw 'A different manifest is already registered for this native host name.'
    }
}
if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
    $existing = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $expectedOrigin = "chrome-extension://$ExtensionId/"
    if ($existing.name -cne $hostName -or $existing.type -cne 'stdio' -or
        [IO.Path]::GetFullPath([string]$existing.path) -ine [IO.Path]::GetFullPath($launcher) -or
        $existing.allowed_origins.Count -ne 1 -or $existing.allowed_origins[0] -cne $expectedOrigin) {
        throw 'A conflicting manifest already exists; refusing to overwrite it.'
    }
} else {
    if ($PSCmdlet.ShouldProcess($manifestPath, 'Write exact-origin native host manifest')) {
        New-Item -ItemType Directory -Path $manifestDirectory -Force | Out-Null
        [IO.File]::WriteAllText($manifestPath, $manifestJson, [Text.UTF8Encoding]::new($false))
    }
}

if ($PSCmdlet.ShouldProcess($registryPath, "Register $hostName for $Browser in current user")) {
    New-Item -Path $registryPath -Force | Out-Null
    Set-Item -LiteralPath $registryPath -Value $manifestPath
}
Write-Output "Manifest: $manifestPath"
Write-Output "Allowed extension origin: chrome-extension://$ExtensionId/"
