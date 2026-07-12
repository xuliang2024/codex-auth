# Tauri Desktop Release

The production desktop application lives under `desktop-tauri/`. It is the
only supported desktop implementation. The former Electron application was
retired and removed on 2026-07-12.

Desktop releases are separate from the CLI/npm process in
[`docs/release.md`](release.md).

## Scope

- Desktop release tags use `desktop-v<version>`.
- Supported release targets are macOS arm64, macOS x64, Windows arm64, and
  Windows x64.
- macOS releases use Tauri DMG bundles. Windows releases use Tauri NSIS
  installers.
- `desktop-tauri/dist/`, `desktop-tauri/node_modules/`, generated frontend
  directories, and Rust target directories are build outputs and must not be
  committed.
- CI exercises all four targets with ad-hoc or unsigned packages. Do not treat
  a CI artifact as a production release unless its platform signature has been
  configured and verified.
- If a release also changes a `.zig` file, run `zig build run -- list` as
  required by `AGENTS.md`.

## Version Files

Keep the desktop version aligned in all of these files:

- `desktop-tauri/package.json`
- `desktop-tauri/package-lock.json`
- `desktop-tauri/src-tauri/tauri.conf.json`
- `desktop-tauri/src-tauri/Cargo.toml`
- `desktop-tauri/src-tauri/Cargo.lock`

The desktop version is independent from the CLI version in `src/version.zig`.
The `version-consistency` test included in `npm test` rejects mismatched desktop
versions.

## Preflight

Create an isolated task directory and check that the release tag is unused:

```sh
export TASK=/tmp/codex-auth-desktop-release
export ROOT=/Users/m007/codes/codex-auth
export VERSION=<version>

mkdir -p "$TASK"
HOME="$TASK" git -C "$ROOT" status --short --branch
HOME="$TASK" git -C "$ROOT" tag -l "desktop-v$VERSION"
HOME="$TASK" git -C "$ROOT" ls-remote --tags origin "desktop-v$VERSION"
```

The two tag checks must return no matching tag. Confirm the latest full CI run
for the release commit is green before packaging.

## Isolated Validation

Build and test from a copy under `/tmp`:

```sh
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

## Test Packaging

On macOS, an ad-hoc DMG can be built without using production credentials:

```sh
cd "$TASK/repo/desktop-tauri"
HOME="$TASK" \
RUSTUP_HOME="$RUSTUP_HOME_REAL" \
CARGO_HOME="$TASK/.cargo" \
CARGO_TARGET_DIR="$TASK/target" \
APPLE_SIGNING_IDENTITY=- \
npm run build:dmg
```

Use `npm run build:app` when an unpacked `.app` is needed. Ad-hoc packages are
for validation only and must not be published.

## Production Packaging

Build each target on its matching platform with the production signing and,
for macOS, notarization credentials available to Tauri. Never set
`APPLE_SIGNING_IDENTITY=-` for a published build.

The commands used by the CI target matrix are:

```sh
# macOS arm64
npm run build -- --target aarch64-apple-darwin --bundles dmg

# macOS x64
npm run build -- --target x86_64-apple-darwin --bundles dmg

# Windows arm64
npm run build -- --target aarch64-pc-windows-msvc --bundles nsis

# Windows x64
npm run build -- --target x86_64-pc-windows-msvc --bundles nsis
```

Keep `HOME`, npm caches, and `CARGO_TARGET_DIR` under the isolated task
directory. If a platform signing service requires access to the normal keychain
or certificate store, expose only that credential store to the packaging step;
do not copy credentials into the repository or task directory.

Target-specific bundles are written below:

```text
$CARGO_TARGET_DIR/<target>/release/bundle/dmg/
$CARGO_TARGET_DIR/<target>/release/bundle/nsis/
```

## Package Validation

For each macOS target, validate the app signature, notarization ticket, DMG,
and version before publishing:

```sh
codesign -dv --verbose=4 "/path/to/Accounts for Codex.app"
codesign -vvv --deep --strict "/path/to/Accounts for Codex.app"
xcrun stapler validate "/path/to/Accounts for Codex.app"
xcrun stapler validate "/path/to/Accounts for Codex_<version>_<arch>.dmg"
spctl -a -vvv -t install "/path/to/Accounts for Codex_<version>_<arch>.dmg"
hdiutil verify "/path/to/Accounts for Codex_<version>_<arch>.dmg"
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
  "/path/to/Accounts for Codex.app/Contents/Info.plist"
```

The version must match `$VERSION`, and Gatekeeper must report a notarized
Developer ID build.

For each Windows target, run the repository smoke test on the matching runner
and confirm that Authenticode reports a valid production signature:

```powershell
./scripts/smoke-nsis.ps1 -Target "<target>" -TargetDirectory "<cargo-target-dir>"
Get-AuthenticodeSignature "<installer-path>"
```

Install and launch every release bundle on a clean test account. At minimum,
exercise account listing, ChatGPT login cancellation, API provider creation and
editing, account switching, and import/export without using a real production
account registry.

## Release Assets

Rename the verified bundles consistently before upload:

```text
codex-auth-desktop-<version>-macos-arm64.dmg
codex-auth-desktop-<version>-macos-x64.dmg
codex-auth-desktop-<version>-win-arm64.exe
codex-auth-desktop-<version>-win-x64.exe
codex-auth-desktop-<version>-SHA256SUMS.txt
```

Collect the four installers under `$TASK/assets`, then generate checksums:

```sh
cd "$TASK/assets"
shasum -a 256 \
  "codex-auth-desktop-$VERSION-macos-arm64.dmg" \
  "codex-auth-desktop-$VERSION-macos-x64.dmg" \
  "codex-auth-desktop-$VERSION-win-arm64.exe" \
  "codex-auth-desktop-$VERSION-win-x64.exe" \
  > "codex-auth-desktop-$VERSION-SHA256SUMS.txt"
```

## Commit And Tag

Stage only intended source, documentation, and version files. Do not stage
generated frontend files, target directories, installers, credentials, or
`.DS_Store` files.

```sh
HOME="$TASK" git -C "$ROOT" diff --cached --check
HOME="$TASK" git -C "$ROOT" commit -m "feat(desktop): <summary>"
HOME="$TASK" git -C "$ROOT" tag -a "desktop-v$VERSION" \
  -m "Accounts for Codex $VERSION"
HOME="$TASK" git -C "$ROOT" push origin main
HOME="$TASK" git -C "$ROOT" push origin "desktop-v$VERSION"
```

Do not reuse a desktop version or tag after it has been published.

## GitHub Release

Create the release only after all four installers and the checksum file have
passed validation:

```sh
GH_TOKEN="$TOKEN" HOME="$TASK" gh release create "desktop-v$VERSION" \
  "$TASK/assets/codex-auth-desktop-$VERSION-macos-arm64.dmg" \
  "$TASK/assets/codex-auth-desktop-$VERSION-macos-x64.dmg" \
  "$TASK/assets/codex-auth-desktop-$VERSION-win-arm64.exe" \
  "$TASK/assets/codex-auth-desktop-$VERSION-win-x64.exe" \
  "$TASK/assets/codex-auth-desktop-$VERSION-SHA256SUMS.txt" \
  --repo xuliang2024/codex-auth \
  --title "Accounts for Codex $VERSION" \
  --notes "Accounts for Codex $VERSION" \
  --latest
```

Verify the public release and every asset URL. Only after the assets are
publicly available should `site/downloads.js`, `site/index.html`, and
`site/downloads/SHA256SUMS.txt` be updated to reference them.
