[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$TargetDirectory,

  [Parameter(Mandatory = $true)]
  [string]$Target,

  [Parameter(Mandatory = $true)]
  [string]$Output
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class VisualCaptureNativeMethods {
  [StructLayout(LayoutKind.Sequential)]
  public struct Rect {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct Point {
    public int X;
    public int Y;
  }

  [DllImport("user32.dll")]
  public static extern bool GetClientRect(IntPtr window, out Rect rect);

  [DllImport("user32.dll")]
  public static extern bool ClientToScreen(IntPtr window, ref Point point);

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr window);
}
"@

$binaryPath = Join-Path $TargetDirectory "$Target\release\codex-auth-desktop-tauri.exe"
$outputPath = [System.IO.Path]::GetFullPath($Output)
$outputDirectory = Split-Path -Parent $outputPath
if (-not (Test-Path $binaryPath -PathType Leaf)) {
  throw "The WebView2 visual-test binary was not found at '$binaryPath'."
}
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
Remove-Item $outputPath -Force -ErrorAction SilentlyContinue

$appProcess = Start-Process -FilePath $binaryPath -WorkingDirectory (Split-Path -Parent $binaryPath) -PassThru
$bitmap = $null
$graphics = $null
try {
  $windowHandle = [IntPtr]::Zero
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    Start-Sleep -Milliseconds 250
    $appProcess.Refresh()
    if ($appProcess.HasExited) {
      throw "The WebView2 visual-test app exited with code $($appProcess.ExitCode)."
    }
    if ($appProcess.MainWindowHandle -ne [IntPtr]::Zero) {
      $windowHandle = $appProcess.MainWindowHandle
      break
    }
  }
  if ($windowHandle -eq [IntPtr]::Zero) {
    throw "The WebView2 visual-test window did not become available."
  }

  [VisualCaptureNativeMethods]::SetForegroundWindow($windowHandle) | Out-Null
  Start-Sleep -Seconds 2

  $rect = [VisualCaptureNativeMethods+Rect]::new()
  $origin = [VisualCaptureNativeMethods+Point]::new()
  if (-not [VisualCaptureNativeMethods]::GetClientRect($windowHandle, [ref]$rect)) {
    throw "Could not read the WebView2 client bounds."
  }
  if (-not [VisualCaptureNativeMethods]::ClientToScreen($windowHandle, [ref]$origin)) {
    throw "Could not map the WebView2 client bounds to the screen."
  }

  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -ne 1000 -or $height -ne 700) {
    throw "Expected a 1000x700 WebView2 viewport, found ${width}x${height}."
  }

  $bitmap = [System.Drawing.Bitmap]::new($width, $height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($origin.X, $origin.Y, 0, 0, $bitmap.Size)
  $bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)

  $brightSamples = 0
  $accentSamples = 0
  for ($x = 0; $x -lt $width; $x += 20) {
    for ($y = 0; $y -lt $height; $y += 20) {
      $color = $bitmap.GetPixel($x, $y)
      if ([Math]::Max($color.R, [Math]::Max($color.G, $color.B)) -gt 90) {
        $brightSamples++
      }
      if (($color.B -gt 140 -and $color.B -gt $color.R + 25) -or
          ($color.G -gt 120 -and $color.G -gt $color.R + 25)) {
        $accentSamples++
      }
    }
  }
  if ($brightSamples -lt 25 -or $accentSamples -lt 5) {
    throw "The WebView2 screenshot does not contain the expected rendered UI colors."
  }

  Write-Host "Captured a ${width}x${height} WebView2 screenshot at '$outputPath'."
  Write-Host "Visual samples: bright=$brightSamples accent=$accentSamples."
}
finally {
  if ($null -ne $graphics) {
    $graphics.Dispose()
  }
  if ($null -ne $bitmap) {
    $bitmap.Dispose()
  }
  if (-not $appProcess.HasExited) {
    Stop-Process -Id $appProcess.Id -Force
    $appProcess.WaitForExit()
  }
}
