param(
  [Parameter(Mandatory=$false)][string]$Repo,
  [Parameter(Mandatory=$false)][string]$Version = "latest",
  [Parameter(Mandatory=$false)][string]$InstallDir,
  [Parameter(Mandatory=$false)][switch]$AddToPath
)
$ErrorActionPreference = "Stop"
function Get-DefaultRepo() {
  return "Dendro-X0/signaler"
}
function Get-RepoOrFail() {
  if ($Repo -and $Repo.Trim().Length -gt 0) { return $Repo.Trim() }
  $envRepo = $env:SIGNALER_REPO
  if ($envRepo -and $envRepo.Trim().Length -gt 0) { return $envRepo.Trim() }
  return (Get-DefaultRepo)
}
function Set-UserEnvVar($name, $value) {
  [Environment]::SetEnvironmentVariable($name, $value, "User")
}
function Resolve-InstallDir() {
  if ($InstallDir -and $InstallDir.Trim().Length -gt 0) { return $InstallDir }
  $base = Join-Path $env:LOCALAPPDATA "signaler"
  return (Join-Path $base "current")
}
function Get-LatestRelease($repoSlug) {
  $uri = "https://api.github.com/repos/$repoSlug/releases/latest"
  return Invoke-RestMethod -Uri $uri -Headers @{"User-Agent"="signaler-installer"}
}
function Get-ReleaseByTag($repoSlug, $tag) {
  $uri = "https://api.github.com/repos/$repoSlug/releases/tags/$tag"
  return Invoke-RestMethod -Uri $uri -Headers @{"User-Agent"="signaler-installer"}
}
function Select-PortableZipAsset($release) {
  foreach ($a in $release.assets) {
    if ($a.name -like "*-portable.zip") { return $a }
  }
  throw "No *-portable.zip asset found in release."
}
function Ensure-Dir($p) {
  if (!(Test-Path $p)) { New-Item -ItemType Directory -Force -Path $p | Out-Null }
}
function Expand-ZipToDir($zipPath, $destDir) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $destDir, $true)
}
function Get-UserPath() {
  return [Environment]::GetEnvironmentVariable("Path", "User")
}
function Set-UserPath($value) {
  [Environment]::SetEnvironmentVariable("Path", $value, "User")
}
$repoSlug = Get-RepoOrFail
Set-UserEnvVar "SIGNALER_REPO" $repoSlug
$env:SIGNALER_REPO = $repoSlug
$signalerCmd = Get-Command signaler -ErrorAction SilentlyContinue
if ($signalerCmd) {
  Write-Host "signaler is already installed. Running: signaler upgrade"
  $upgradeArgs = @("upgrade", "--repo", $repoSlug)
  if ($Version -ne "latest") { $upgradeArgs += @("--version", $Version) }
  & $signalerCmd.Source @upgradeArgs
  Write-Host "Done."
  exit 0
}
$installRoot = Resolve-InstallDir
$baseDir = Split-Path -Parent $installRoot
$binDir = Join-Path $baseDir "bin"
Ensure-Dir $installRoot
Ensure-Dir $binDir
$release = if ($Version -eq "latest") { Get-LatestRelease $repoSlug } else { Get-ReleaseByTag $repoSlug $Version }
$asset = Select-PortableZipAsset $release
$zipUrl = $asset.browser_download_url
$tmpZip = Join-Path $env:TEMP "signaler-portable.zip"
Write-Host "Downloading $zipUrl"
Invoke-WebRequest -Uri $zipUrl -OutFile $tmpZip -Headers @{"User-Agent"="signaler-installer"}
$stagingDir = Join-Path $env:TEMP ("signaler-staging-" + [Guid]::NewGuid().ToString("N"))
Ensure-Dir $stagingDir
Expand-ZipToDir $tmpZip $stagingDir
$portableRoot = Get-ChildItem -Directory $stagingDir | Select-Object -First 1
if (!$portableRoot) { throw "Portable zip did not contain a root directory." }
if (Test-Path $installRoot) { Remove-Item -Recurse -Force $installRoot }
Move-Item -Force $portableRoot.FullName $installRoot
$launcherPath = Join-Path $binDir "signaler.cmd"
$launcher = @"
@echo off
setlocal
set "ROOT=$installRoot"
node "%ROOT%\dist\bin.js" %*
"@
Set-Content -Path $launcherPath -Value $launcher -Encoding ASCII
Write-Host "Installed to: $installRoot"
Write-Host "Launcher: $launcherPath"
if ($AddToPath) {
  $path = Get-UserPath
  $segments = @()
  if ($path) { $segments = $path.Split(';') }
  if ($segments -notcontains $binDir) {
    $newPath = if ($path -and $path.Length -gt 0) { "$path;$binDir" } else { $binDir }
    Set-UserPath $newPath
    Write-Host "Added to user PATH. Restart your terminal." 
  } else {
    Write-Host "Bin dir already in PATH." 
  }
} else {
  Write-Host "Add this directory to PATH to run from anywhere: $binDir" 
}
Write-Host "Try: signaler --help" 
