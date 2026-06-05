# Fallbacks

- Windows `codex-auth login` accepts `codex.ps1` only after exhausting native Windows launchers from the current directory and PATH.
  Reason: real Windows Codex installs can expose npm wrapper layouts with `codex`, `codex.cmd`, and `codex.ps1`, while the extensionless `codex` file is a POSIX shell script that cannot be launched directly by a Windows process.
  Protected callers or data: Windows users whose PATH exposes only the PowerShell Codex wrapper after npm-style installation or wrapper cleanup.
  Removal conditions: remove this fallback once the supported Codex Windows launcher contract guarantees a single directly spawnable entry point, or once this repo intentionally narrows support to native Windows launchers only.
