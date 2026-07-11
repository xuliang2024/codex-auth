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

function Get-PeSubsystem {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $reader = [System.IO.BinaryReader]::new([System.IO.File]::OpenRead($Path))
  try {
    $stream = $reader.BaseStream
    if ($stream.Length -lt 64) {
      throw "The executable is too small to contain a valid PE header: '$Path'."
    }

    $stream.Position = 0
    if ($reader.ReadUInt16() -ne 0x5a4d) {
      throw "The executable does not contain a valid MZ signature: '$Path'."
    }

    $stream.Position = 0x3c
    $peOffset = [int64]($reader.ReadUInt32())
    if ($peOffset -gt $stream.Length - 24) {
      throw "The executable has an invalid PE header offset: '$Path'."
    }

    $stream.Position = $peOffset
    if ($reader.ReadUInt32() -ne 0x00004550) {
      throw "The executable does not contain a valid PE signature: '$Path'."
    }

    $stream.Position = $peOffset + 20
    $optionalHeaderSize = [int]($reader.ReadUInt16())
    $optionalHeaderOffset = $peOffset + 24
    if ($optionalHeaderSize -lt 70 -or $optionalHeaderOffset + $optionalHeaderSize -gt $stream.Length) {
      throw "The executable has an invalid PE optional header: '$Path'."
    }

    $stream.Position = $optionalHeaderOffset
    $optionalHeaderMagic = $reader.ReadUInt16()
    if ($optionalHeaderMagic -ne 0x010b -and $optionalHeaderMagic -ne 0x020b) {
      throw "The executable has an unsupported PE optional header: '$Path'."
    }

    $stream.Position = $optionalHeaderOffset + 68
    return [int]($reader.ReadUInt16())
  }
  finally {
    $reader.Dispose()
  }
}

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

  $appSubsystem = Get-PeSubsystem -Path $appPath
  if ($appSubsystem -ne 2) {
    throw "The installed application must use the Windows GUI subsystem (2), found $appSubsystem."
  }
  Write-Host "The installed application uses the Windows GUI subsystem."

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
