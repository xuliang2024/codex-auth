# Tauri Desktop Development

The supported desktop application lives under `desktop-tauri/`. The former
Electron implementation was retired and removed on 2026-07-12; all desktop
features, fixes, tests, and packaging work belong to the Tauri application.

## Architecture

- The renderer uses static HTML, CSS, and JavaScript prepared by the scripts in
  `desktop-tauri/scripts/`.
- `window.codexAuth` is the renderer boundary for native Tauri commands.
- Rust owns registry access, OAuth, provider configuration, networking,
  import/export, file watching, and other privileged operations.
- Generated `frontend-dist/` and `visual-frontend-dist/` directories are build
  outputs. Edit their source inputs rather than the generated copies.

The frontend never receives general filesystem access. Sensitive `~/.codex`
operations stay in Rust commands, and account directories and files are written
with `0700` and `0600` permissions on Unix systems.

## Local Development

Install dependencies and start Tauri from the desktop project:

```sh
cd /Users/m007/codes/codex-auth/desktop-tauri
npm ci
npm start
```

Normal development runs use the current account store. Use the isolated setup
below for tests, review, and any run that must not touch real account data.

## Isolated Development

Create a repository copy and keep the test home, npm cache, Cargo cache, and
target directory under `/tmp`:

```sh
export TASK=/tmp/codex-auth-desktop-development
export ROOT=/Users/m007/codes/codex-auth
export RUSTUP_HOME_REAL="${RUSTUP_HOME:-$HOME/.rustup}"

rm -rf "$TASK/repo"
mkdir -p "$TASK/repo"
rsync -a --delete \
  --exclude='.git/' \
  --exclude='.DS_Store' \
  --exclude='desktop-tauri/dist/' \
  --exclude='desktop-tauri/node_modules/' \
  --exclude='desktop-tauri/frontend-dist/' \
  --exclude='desktop-tauri/visual-frontend-dist/' \
  --exclude='desktop-tauri/src-tauri/target/' \
  "$ROOT/" "$TASK/repo/"

cd "$TASK/repo/desktop-tauri"
HOME="$TASK" npm_config_cache="$TASK/.npm" npm ci
```

Run renderer bridge and Rust validation:

```sh
HOME="$TASK" npm test
HOME="$TASK" \
RUSTUP_HOME="$RUSTUP_HOME_REAL" \
CARGO_HOME="$TASK/.cargo" \
CARGO_TARGET_DIR="$TASK/target" \
cargo fmt --manifest-path src-tauri/Cargo.toml --check
HOME="$TASK" \
RUSTUP_HOME="$RUSTUP_HOME_REAL" \
CARGO_HOME="$TASK/.cargo" \
CARGO_TARGET_DIR="$TASK/target" \
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
HOME="$TASK" \
RUSTUP_HOME="$RUSTUP_HOME_REAL" \
CARGO_HOME="$TASK/.cargo" \
CARGO_TARGET_DIR="$TASK/target" \
cargo test --manifest-path src-tauri/Cargo.toml
```

Run the app against an isolated Codex account store:

```sh
HOME="$TASK" \
CODEX_HOME="$TASK/codex-home" \
RUSTUP_HOME="$RUSTUP_HOME_REAL" \
CARGO_HOME="$TASK/.cargo" \
CARGO_TARGET_DIR="$TASK/target" \
npm start
```

## Test Packaging

Build an ad-hoc-signed macOS DMG:

```sh
HOME="$TASK" \
RUSTUP_HOME="$RUSTUP_HOME_REAL" \
CARGO_HOME="$TASK/.cargo" \
CARGO_TARGET_DIR="$TASK/target" \
APPLE_SIGNING_IDENTITY=- \
npm run build:dmg
```

Use `npm run build:app` when an unpacked `.app` is needed. Expected native
arm64 outputs are:

```text
$TASK/target/release/bundle/macos/Accounts for Codex.app
$TASK/target/release/bundle/dmg/Accounts for Codex_<version>_aarch64.dmg
```

The DMG-only build may remove its intermediate `.app` after packaging. An
architecture-specific DMG above 15 MB should be investigated for unintended
resources or build settings.

The project launcher puts macOS system tools before the user's `PATH` so an
unrelated executable named `cut` cannot intercept the DMG script. It also skips
Finder AppleScript decoration by default because that can hang in CI or without
Terminal Automation permission. Set `TAURI_DMG_USE_FINDER=1` only for an
interactive positioned layout after Finder automation has been approved.

For signed production packaging and the complete release checklist, follow
[`docs/desktop-release.md`](desktop-release.md).
