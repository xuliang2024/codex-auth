[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc")]
  [string]$Target,

  [Parameter(Mandatory = $true)]
  [string]$TargetDirectory
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$productName = "Accounts for Codex"
$binaryName = "codex-auth-desktop-tauri.exe"
$bundleDirectory = Join-Path $TargetDirectory "$Target\release\bundle\nsis"
$installDirectory = Join-Path $env:LOCALAPPDATA $productName
$appPath = Join-Path $installDirectory $binaryName
$uninstallerPath = Join-Path $installDirectory "uninstall.exe"
$appProcess = $null

$installers = @(Get-ChildItem -Path $bundleDirectory -Filter "*-setup.exe" -File)
if ($installers.Count -ne 1) {
  throw "Expected exactly one NSIS installer in '$bundleDirectory', found $($installers.Count)."
}

if (Test-Path $installDirectory) {
  throw "The NSIS smoke test requires a clean install directory: '$installDirectory'."
}

try {
  Write-Host "Installing $($installers[0].Name) silently."
  $installerProcess = Start-Process -FilePath $installers[0].FullName -ArgumentList "/S" -Wait -PassThru
  if ($installerProcess.ExitCode -ne 0) {
    throw "The NSIS installer exited with code $($installerProcess.ExitCode)."
  }

  if (-not (Test-Path $appPath -PathType Leaf)) {
    throw "The installed application was not found at '$appPath'."
  }
  if (-not (Test-Path $uninstallerPath -PathType Leaf)) {
    throw "The NSIS uninstaller was not found at '$uninstallerPath'."
  }

  Write-Host "Launching the installed application."
  $appProcess = Start-Process -FilePath $appPath -WorkingDirectory $installDirectory -PassThru
  Start-Sleep -Seconds 8
  if ($appProcess.HasExited) {
    throw "The installed application exited during the startup smoke test with code $($appProcess.ExitCode)."
  }

  Write-Host "The installed application remained running during the startup smoke test."
}
finally {
  if ($null -ne $appProcess -and -not $appProcess.HasExited) {
    Stop-Process -Id $appProcess.Id -Force
    $appProcess.WaitForExit()
  }

  if (Test-Path $uninstallerPath -PathType Leaf) {
    Write-Host "Uninstalling the application silently."
    $uninstallerProcess = Start-Process -FilePath $uninstallerPath -ArgumentList "/S" -Wait -PassThru
    if ($uninstallerProcess.ExitCode -ne 0) {
      throw "The NSIS uninstaller exited with code $($uninstallerProcess.ExitCode)."
    }

    for ($attempt = 0; $attempt -lt 10 -and (Test-Path $installDirectory); $attempt++) {
      Start-Sleep -Seconds 1
    }

    if (Test-Path $installDirectory) {
      throw "The install directory still exists after uninstalling: '$installDirectory'."
    }
  }
}

Write-Host "NSIS install, launch, and uninstall smoke test passed for $Target."
