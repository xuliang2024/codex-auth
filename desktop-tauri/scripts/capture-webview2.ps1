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
$capturedBitmap = $null
$captureGraphics = $null
$normalizedBitmap = $null
$normalizedGraphics = $null
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

  $origin = $null
  $width = 0
  $height = 0
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    $appProcess.Refresh()
    $windowHandle = $appProcess.MainWindowHandle
    if ($windowHandle -ne [IntPtr]::Zero) {
      $candidateRect = [VisualCaptureNativeMethods+Rect]::new()
      $candidateOrigin = [VisualCaptureNativeMethods+Point]::new()
      if ([VisualCaptureNativeMethods]::GetClientRect($windowHandle, [ref]$candidateRect) -and
          [VisualCaptureNativeMethods]::ClientToScreen($windowHandle, [ref]$candidateOrigin)) {
        $candidateWidth = $candidateRect.Right - $candidateRect.Left
        $candidateHeight = $candidateRect.Bottom - $candidateRect.Top
        if ($candidateWidth -gt 0 -and $candidateHeight -gt 0) {
          $origin = $candidateOrigin
          $width = $candidateWidth
          $height = $candidateHeight
          break
        }
      }
    }
    Start-Sleep -Milliseconds 250
  }
  if ($width -lt 600 -or $height -lt 480 -or $null -eq $origin) {
    throw "Could not obtain usable WebView2 client bounds (last size ${width}x${height})."
  }

  Write-Host "Capturing WebView2 window '$($appProcess.MainWindowTitle)' from ${width}x${height}."
  $brightSamples = 0
  $accentSamples = 0
  $rendered = $false
  $maxCaptureAttempts = 30
  for ($captureAttempt = 1; $captureAttempt -le $maxCaptureAttempts; $captureAttempt++) {
    $appProcess.Refresh()
    if ($appProcess.HasExited) {
      throw "The WebView2 visual-test app exited with code $($appProcess.ExitCode)."
    }

    if ($null -ne $normalizedGraphics) {
      $normalizedGraphics.Dispose()
      $normalizedGraphics = $null
    }
    if ($null -ne $normalizedBitmap) {
      $normalizedBitmap.Dispose()
      $normalizedBitmap = $null
    }
    if ($null -ne $captureGraphics) {
      $captureGraphics.Dispose()
      $captureGraphics = $null
    }
    if ($null -ne $capturedBitmap) {
      $capturedBitmap.Dispose()
      $capturedBitmap = $null
    }

    $capturedBitmap = [System.Drawing.Bitmap]::new($width, $height)
    $captureGraphics = [System.Drawing.Graphics]::FromImage($capturedBitmap)
    $captureGraphics.CopyFromScreen($origin.X, $origin.Y, 0, 0, $capturedBitmap.Size)

    $normalizedBitmap = [System.Drawing.Bitmap]::new(1000, 700)
    $normalizedGraphics = [System.Drawing.Graphics]::FromImage($normalizedBitmap)
    $normalizedGraphics.DrawImage($capturedBitmap, 0, 0, 1000, 700)
    $normalizedBitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)

    $brightSamples = 0
    $accentSamples = 0
    for ($x = 0; $x -lt 1000; $x += 20) {
      for ($y = 0; $y -lt 700; $y += 20) {
        $color = $normalizedBitmap.GetPixel($x, $y)
        if ([Math]::Max($color.R, [Math]::Max($color.G, $color.B)) -gt 90) {
          $brightSamples++
        }
        if (($color.B -gt 140 -and $color.B -gt $color.R + 25) -or
            ($color.G -gt 120 -and $color.G -gt $color.R + 25)) {
          $accentSamples++
        }
      }
    }
    if ($brightSamples -ge 25 -and $accentSamples -ge 5) {
      $rendered = $true
      break
    }
    if ($captureAttempt -lt $maxCaptureAttempts) {
      Write-Host "WebView2 UI is not ready on capture attempt $captureAttempt/$maxCaptureAttempts (bright=$brightSamples accent=$accentSamples); retrying."
      Start-Sleep -Milliseconds 500
    }
  }
  if (-not $rendered) {
    throw "The WebView2 screenshot did not contain the expected rendered UI colors after $maxCaptureAttempts attempts (bright=$brightSamples accent=$accentSamples)."
  }

  Write-Host "Captured a normalized 1000x700 WebView2 screenshot at '$outputPath'."
  Write-Host "Visual samples: bright=$brightSamples accent=$accentSamples."
}
finally {
  if ($null -ne $normalizedGraphics) {
    $normalizedGraphics.Dispose()
  }
  if ($null -ne $normalizedBitmap) {
    $normalizedBitmap.Dispose()
  }
  if ($null -ne $captureGraphics) {
    $captureGraphics.Dispose()
  }
  if ($null -ne $capturedBitmap) {
    $capturedBitmap.Dispose()
  }
  if (-not $appProcess.HasExited) {
    Stop-Process -Id $appProcess.Id -Force
    $appProcess.WaitForExit()
  }
}
