# Desktop Packaging Quickstart

This is the fast local runbook for packaging the Electron desktop app,
signing it, notarizing the app and DMG, and preparing release-ready assets.
For the full release and publishing process, see `docs/desktop-release.md`.

## Inputs

Set the version once and reuse it:

```sh
export VERSION=0.1.3
export TASK=/tmp/codex-auth-desktop-release
export ROOT=/Users/m007/codes/codex-auth
export BUILD_ROOT="$TASK/repo"
export DESKTOP="$BUILD_ROOT/desktop"
export IDENTITY='Developer ID Application: yi liu (3DP337K4T3)'
```

Required local credentials:

- Code signing identity: `Developer ID Application: yi liu (3DP337K4T3)`
- Notarization environment:
  - `XC_APPLE_ID`
  - `XC_APPLE_APP_SPECIFIC_PASSWORD`
  - `XC_APPLE_TEAM_ID`

Do not write notarization credentials into files or command history.

## Preflight

```sh
mkdir -p "$TASK"

HOME="$TASK" git -C "$ROOT" status --short --branch
HOME="$TASK" rg -n "\"version\": \"$VERSION\"" \
  "$ROOT/desktop/package.json" \
  "$ROOT/desktop/package-lock.json"
HOME="$TASK" git -C "$ROOT" tag -l "desktop-v$VERSION"
HOME="$TASK" git -C "$ROOT" ls-remote --tags origin "desktop-v$VERSION"

security find-identity -v -p codesigning | sed -n '1,120p'
env | awk -F= '/^(APPLE_|XC_|NOTARYTOOL_)/ { print $1"=<set>" }' | sort
```

The tag checks should return no output before creating a new release tag.
The environment check should show the notarization variables above.

## Isolated Build Copy

Build from `/tmp` so generated artifacts and npm caches stay out of the repo:

```sh
rm -rf "$BUILD_ROOT"
mkdir -p "$BUILD_ROOT"

rsync -a --delete \
  --exclude='.git/' \
  --exclude='desktop/dist/' \
  --exclude='desktop/node_modules/' \
  --exclude='.DS_Store' \
  "$ROOT/" \
  "$BUILD_ROOT/"

cd "$DESKTOP"
HOME="$TASK" npm ci
```

## Build App, DMG, And ZIP

Use the normal user home for this command so Keychain signing identities and
notarization credentials are visible, but keep npm and Electron caches in
`/tmp`:

```sh
cd "$DESKTOP"
rm -rf "$DESKTOP/dist"

HOME=/Users/m007 \
npm_config_cache="$TASK/.npm" \
ELECTRON_CACHE="$TASK/.cache/electron" \
ELECTRON_BUILDER_CACHE="$TASK/.cache/electron-builder" \
npm run dist
```

The `afterSign` hook notarizes the `.app` bundle. It is normal to see
electron-builder print a skipped built-in notarization message before the
project script starts its own notarization.

Expected outputs:

```text
dist/Accounts for Codex-<version>-universal.dmg
dist/Accounts for Codex-<version>-universal-mac.zip
dist/mac-universal/Accounts for Codex.app
```

## Sign And Notarize The DMG

The app bundle is notarized by the build hook. The DMG needs a separate
signature, notarization submission, and staple:

```sh
DMG="$DESKTOP/dist/Accounts for Codex-$VERSION-universal.dmg"

HOME=/Users/m007 codesign --force \
  --sign "$IDENTITY" \
  --timestamp \
  "$DMG"

HOME=/Users/m007 xcrun notarytool submit "$DMG" \
  --apple-id "$XC_APPLE_ID" \
  --password "$XC_APPLE_APP_SPECIFIC_PASSWORD" \
  --team-id "$XC_APPLE_TEAM_ID" \
  --wait

HOME="$TASK" xcrun stapler staple "$DMG"
```

Save the notary submission ID from the output for release notes or auditing.
The final status must be `Accepted`.

## Validate

```sh
APP="$DESKTOP/dist/mac-universal/Accounts for Codex.app"
ZIP="$DESKTOP/dist/Accounts for Codex-$VERSION-universal-mac.zip"

HOME="$TASK" codesign -dv --verbose=4 "$APP"
HOME="$TASK" codesign -vvv --deep --strict "$APP"
HOME="$TASK" xcrun stapler validate "$APP"

HOME="$TASK" /usr/libexec/PlistBuddy \
  -c 'Print :CFBundleShortVersionString' \
  "$APP/Contents/Info.plist"

HOME="$TASK" codesign -dv --verbose=4 "$DMG"
HOME="$TASK" xcrun stapler validate "$DMG"
HOME="$TASK" spctl -a -vvv -t install "$DMG"
hdiutil verify "$DMG"

shasum -a 256 "$DMG" "$ZIP"
```

Expected DMG assessment:

```text
accepted
source=Notarized Developer ID
origin=Developer ID Application: yi liu (3DP337K4T3)
```

The app version printed by `PlistBuddy` must match `$VERSION`.

## Prepare Release Assets

```sh
rm -rf "$TASK/assets"
mkdir -p "$TASK/assets"

cp "$DMG" "$TASK/assets/codex-auth-desktop-$VERSION-universal.dmg"
cp "$ZIP" "$TASK/assets/codex-auth-desktop-$VERSION-universal-mac.zip"

cd "$TASK/assets"
shasum -a 256 \
  "codex-auth-desktop-$VERSION-universal.dmg" \
  "codex-auth-desktop-$VERSION-universal-mac.zip" \
  > "codex-auth-desktop-$VERSION-SHA256SUMS.txt"
```

Optional local handoff copy:

```sh
mkdir -p "$ROOT/desktop/dist"
cp "$TASK/assets/codex-auth-desktop-$VERSION-universal.dmg" \
  "$TASK/assets/codex-auth-desktop-$VERSION-universal-mac.zip" \
  "$TASK/assets/codex-auth-desktop-$VERSION-SHA256SUMS.txt" \
  "$ROOT/desktop/dist/"
```

`desktop/dist/` is ignored and must not be committed.

## 0.1.3 Reference Result

The 0.1.3 run produced these validated artifacts:

```text
codex-auth-desktop-0.1.3-universal.dmg
codex-auth-desktop-0.1.3-universal-mac.zip
codex-auth-desktop-0.1.3-SHA256SUMS.txt
```

DMG notarization submission:

```text
da689c0b-380d-4c9c-8798-e74271873a4e
```

SHA256:

```text
983a281d6d887b24a927b09137527e6c292d1eab010a36d197f1f903e6263631  codex-auth-desktop-0.1.3-universal.dmg
33fd1bdc8c9271e743eebc7dcf13535e3310eafc2ca598348ab745435265be64  codex-auth-desktop-0.1.3-universal-mac.zip
```
