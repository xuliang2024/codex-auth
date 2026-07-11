# Tauri Desktop Migration

This document tracks the parallel migration from Electron to Tauri 2. The
Electron app under `desktop/` remains the production release path until the
Tauri acceptance checks below are complete.

## Current Status

The first functional Tauri implementation lives under `desktop-tauri/` and
uses the same renderer as the Electron app.

Implemented:

- Shared HTML, CSS, translations, and renderer behavior.
- A runtime bridge that preserves the existing `window.codexAuth` API for both
  Electron preload IPC and Tauri commands.
- Registry loading, account switching and removal, private auth snapshots,
  managed provider configuration, and the `gpt-5.6-sol` provider default.
- ChatGPT browser OAuth with PKCE and a local callback on port 1455.
- API provider login and endpoint tests.
- Account usage refresh, token refresh, and expired-session reporting.
- File and share-link import/export.
- Announcement and external-link handling.
- External registry file watching.
- Tauri release size settings and command pruning.

The frontend never receives general filesystem access. Sensitive
`~/.codex` operations stay in Rust commands, and account directories/files are
written with `0700`/`0600` permissions on Unix systems.

## Isolated Development

Run builds and tests from an isolated copy:

```sh
export TASK=/tmp/codex-auth-tauri-migration
export ROOT=/Users/m007/codes/codex-auth
export RUSTUP_HOME_REAL="${RUSTUP_HOME:-$HOME/.rustup}"

rm -rf "$TASK/repo"
mkdir -p "$TASK/repo"
rsync -a --delete \
  --exclude='.git/' \
  --exclude='desktop/node_modules/' \
  --exclude='desktop/dist/' \
  --exclude='desktop-tauri/node_modules/' \
  --exclude='desktop-tauri/frontend-dist/' \
  --exclude='desktop-tauri/src-tauri/target/' \
  "$ROOT/" "$TASK/repo/"

cd "$TASK/repo/desktop-tauri"
HOME="$TASK" npm_config_cache="$TASK/.npm" npm ci
```

Run the bridge and Rust tests:

```sh
HOME="$TASK" npm test
HOME="$TASK" \
RUSTUP_HOME="$RUSTUP_HOME_REAL" \
CARGO_HOME="$TASK/.cargo" \
CARGO_TARGET_DIR="$TASK/target" \
cargo test --manifest-path src-tauri/Cargo.toml
```

Run the app without touching the real Codex account store:

```sh
HOME="$TASK" \
CODEX_HOME="$TASK/codex-home" \
RUSTUP_HOME="$RUSTUP_HOME_REAL" \
CARGO_HOME="$TASK/.cargo" \
CARGO_TARGET_DIR="$TASK/target" \
npm start
```

## Test Packaging

Build an ad-hoc-signed app or DMG:

```sh
HOME="$TASK" \
RUSTUP_HOME="$RUSTUP_HOME_REAL" \
CARGO_HOME="$TASK/.cargo" \
CARGO_TARGET_DIR="$TASK/target" \
APPLE_SIGNING_IDENTITY=- \
npm run build:dmg
```

Use `npm run build:app` instead when an unpacked `.app` is required. Expected
arm64 outputs are:

```text
$TASK/target/release/bundle/macos/Accounts for Codex.app
$TASK/target/release/bundle/dmg/Accounts for Codex_<version>_aarch64.dmg
```

The DMG-only build may remove its intermediate `.app` after packaging.

The migration audit produced a roughly 10 MB app and a 5.2 MB arm64 DMG.
Investigate an architecture-specific DMG above 15 MB.

The project launcher puts macOS system tools before the user's `PATH` so a
third-party executable named `cut` cannot break Tauri's DMG script. It also
skips Finder AppleScript decoration by default because that can hang in CI or
without Terminal Automation permission. Set `TAURI_DMG_USE_FINDER=1` only when
an interactive, positioned DMG layout is required and Finder automation has
already been approved.

## Acceptance Gates Before Replacing Electron

- [ ] Run live ChatGPT OAuth through direct, HTTP proxy, SOCKS proxy, and TUN
  network configurations.
- [ ] Test real provider endpoints and token refresh behavior.
- [x] Verify arm64 and x64 macOS builds on macOS 12 or newer.
- [x] Build, install, launch, and uninstall Windows x64 and arm64 NSIS
  installers on Windows CI.
- [x] Run visual regression checks on WKWebView and WebView2.
- [x] Validate Developer ID signing, Apple notarization, stapling, and Gatekeeper
  validation for both macOS architectures.
- [x] Keep the Rust registry implementation for desktop 0.2.x instead of
  introducing a release-stage Zig sidecar. See
  [ADR 0001](decisions/0001-tauri-registry-runtime.md).
- [ ] Update public download links only after signed artifacts exist.

Do not remove the Electron app or change the production download page before
all gates pass.
