# Desktop Release

This document records the manual release process for the Electron desktop app
under `desktop/`. It is separate from the CLI/npm release process in
`docs/release.md`.

## Scope

- Current desktop release tags use `desktop-v<version>`.
- Current GitHub Release assets are macOS Universal DMG, macOS Universal ZIP,
  and a SHA256 checksum file.
- `desktop/dist/` and `desktop/node_modules/` are ignored build outputs and
  should not be committed.
- If a release also changes any `.zig` file, run `zig build run -- list` as
  required by `AGENTS.md`.

## Version Files

Update both desktop version fields:

- `desktop/package.json`
- `desktop/package-lock.json`

The desktop version is independent from the CLI version in `src/version.zig`.
For a normal desktop patch release, bump only the desktop package version.

## Preflight

From an isolated task directory:

```sh
mkdir -p /tmp/codex-auth-desktop-release
```

Check the release target:

```sh
HOME=/tmp/codex-auth-desktop-release git -C /Users/m007/codes/codex-auth status --short --branch
HOME=/tmp/codex-auth-desktop-release git -C /Users/m007/codes/codex-auth tag -l 'desktop-v<version>'
HOME=/tmp/codex-auth-desktop-release git -C /Users/m007/codes/codex-auth ls-remote --tags origin 'desktop-v<version>'
```

Confirm macOS signing and notarization inputs:

```sh
security find-identity -v -p codesigning | sed -n '1,120p'
env | rg '^(APPLE|XC_|NOTARYTOOL)='
```

Expected signing identity:

```text
Developer ID Application: yi liu (3DP337K4T3)
```

Expected notarization environment can use either the `APPLE_*` names or these
aliases:

```text
XC_APPLE_ID
XC_APPLE_APP_SPECIFIC_PASSWORD
XC_APPLE_TEAM_ID
```

Do not write notarization credentials into files or command history.

## Isolated Build Copy

Build from a `/tmp` copy so Electron output and npm caches stay out of the
working tree:

```sh
rm -rf /tmp/codex-auth-desktop-release/repo
mkdir -p /tmp/codex-auth-desktop-release/repo
rsync -a --delete \
  --exclude='.git/' \
  --exclude='desktop/dist/' \
  --exclude='desktop/node_modules/' \
  --exclude='.DS_Store' \
  /Users/m007/codes/codex-auth/ \
  /tmp/codex-auth-desktop-release/repo/
```

Install dependencies in the isolated copy:

```sh
cd /tmp/codex-auth-desktop-release/repo/desktop
HOME=/tmp/codex-auth-desktop-release npm ci
```

## Build, Sign, And Notarize

The login keychain identities may not be visible when `HOME` is forced to the
isolated `/tmp` directory. Keep the worktree and caches isolated, but run the
Electron signing step with the user's normal home so macOS Keychain can expose
the Developer ID identity:

```sh
rm -rf /tmp/codex-auth-desktop-release/repo/desktop/dist

HOME=/Users/m007 \
npm_config_cache=/tmp/codex-auth-desktop-release/.npm \
ELECTRON_CACHE=/tmp/codex-auth-desktop-release/.cache/electron \
ELECTRON_BUILDER_CACHE=/tmp/codex-auth-desktop-release/.cache/electron-builder \
npm run dist
```

Run this from:

```sh
/tmp/codex-auth-desktop-release/repo/desktop
```

The `afterSign` hook notarizes the `.app` bundle. The DMG also needs its own
signing, notarization, and stapling step:

```sh
HOME=/Users/m007 codesign --force \
  --sign 'Developer ID Application: yi liu (3DP337K4T3)' \
  --timestamp \
  '/tmp/codex-auth-desktop-release/repo/desktop/dist/Accounts for Codex-<version>-universal.dmg'

HOME=/Users/m007 xcrun notarytool submit \
  '/tmp/codex-auth-desktop-release/repo/desktop/dist/Accounts for Codex-<version>-universal.dmg' \
  --apple-id "$XC_APPLE_ID" \
  --password "$XC_APPLE_APP_SPECIFIC_PASSWORD" \
  --team-id "$XC_APPLE_TEAM_ID" \
  --wait

HOME=/tmp/codex-auth-desktop-release xcrun stapler staple \
  '/tmp/codex-auth-desktop-release/repo/desktop/dist/Accounts for Codex-<version>-universal.dmg'
```

## Validation

Verify the app bundle:

```sh
HOME=/tmp/codex-auth-desktop-release codesign -dv --verbose=4 \
  '/tmp/codex-auth-desktop-release/repo/desktop/dist/mac-universal/Accounts for Codex.app'

HOME=/tmp/codex-auth-desktop-release codesign -vvv --deep --strict \
  '/tmp/codex-auth-desktop-release/repo/desktop/dist/mac-universal/Accounts for Codex.app'

HOME=/tmp/codex-auth-desktop-release xcrun stapler validate \
  '/tmp/codex-auth-desktop-release/repo/desktop/dist/mac-universal/Accounts for Codex.app'
```

Verify the DMG:

```sh
HOME=/tmp/codex-auth-desktop-release xcrun stapler validate \
  '/tmp/codex-auth-desktop-release/repo/desktop/dist/Accounts for Codex-<version>-universal.dmg'

HOME=/tmp/codex-auth-desktop-release spctl -a -vvv -t install \
  '/tmp/codex-auth-desktop-release/repo/desktop/dist/Accounts for Codex-<version>-universal.dmg'
```

Expected DMG result:

```text
accepted
source=Notarized Developer ID
origin=Developer ID Application: yi liu (3DP337K4T3)
```

Check the app version:

```sh
HOME=/tmp/codex-auth-desktop-release /usr/libexec/PlistBuddy \
  -c 'Print :CFBundleShortVersionString' \
  '/tmp/codex-auth-desktop-release/repo/desktop/dist/mac-universal/Accounts for Codex.app/Contents/Info.plist'
```

Optionally run syntax checks for desktop JavaScript changes:

```sh
HOME=/tmp/codex-auth-desktop-release node --check /tmp/codex-auth-desktop-release/repo/desktop/main.js
HOME=/tmp/codex-auth-desktop-release node --check /tmp/codex-auth-desktop-release/repo/desktop/lib/registry.js
HOME=/tmp/codex-auth-desktop-release node --check /tmp/codex-auth-desktop-release/repo/desktop/lib/oauth.js
HOME=/tmp/codex-auth-desktop-release node --check /tmp/codex-auth-desktop-release/repo/desktop/renderer/app.js
HOME=/tmp/codex-auth-desktop-release node --check /tmp/codex-auth-desktop-release/repo/desktop/renderer/i18n.js
```

## Release Assets

Prepare release assets using these names:

```sh
rm -rf /tmp/codex-auth-desktop-release/assets
mkdir -p /tmp/codex-auth-desktop-release/assets

cp '/tmp/codex-auth-desktop-release/repo/desktop/dist/Accounts for Codex-<version>-universal.dmg' \
  '/tmp/codex-auth-desktop-release/assets/codex-auth-desktop-<version>-universal.dmg'

cp '/tmp/codex-auth-desktop-release/repo/desktop/dist/Accounts for Codex-<version>-universal-mac.zip' \
  '/tmp/codex-auth-desktop-release/assets/codex-auth-desktop-<version>-universal-mac.zip'

cd /tmp/codex-auth-desktop-release/assets
shasum -a 256 \
  codex-auth-desktop-<version>-universal.dmg \
  codex-auth-desktop-<version>-universal-mac.zip \
  > codex-auth-desktop-<version>-SHA256SUMS.txt
```

If useful for local handoff, copy the final artifacts back into
`/Users/m007/codes/codex-auth/desktop/dist/`. The directory is ignored by git.

## Commit And Tag

Stage only source and version files. Do not stage `.DS_Store`, `desktop/dist/`,
or `desktop/node_modules/`.

```sh
HOME=/tmp/codex-auth-desktop-release git -C /Users/m007/codes/codex-auth diff --cached --check
HOME=/tmp/codex-auth-desktop-release git -C /Users/m007/codes/codex-auth commit -m "feat(desktop): <summary>"
HOME=/tmp/codex-auth-desktop-release git -C /Users/m007/codes/codex-auth tag -a desktop-v<version> -m "Accounts for Codex <version>"
```

Push:

```sh
HOME=/tmp/codex-auth-desktop-release git -C /Users/m007/codes/codex-auth push origin main
HOME=/tmp/codex-auth-desktop-release git -C /Users/m007/codes/codex-auth push origin desktop-v<version>
```

If `HOME=/tmp/...` cannot read GitHub credentials, use a temporary `GIT_ASKPASS`
script or run the push from a shell that already has access to the macOS git
credential helper. Do not commit the helper script, token, or generated auth
files.

## GitHub Release

Create the release:

```sh
GH_TOKEN="$TOKEN" HOME=/tmp/codex-auth-desktop-release gh release create desktop-v<version> \
  /tmp/codex-auth-desktop-release/assets/codex-auth-desktop-<version>-universal.dmg \
  /tmp/codex-auth-desktop-release/assets/codex-auth-desktop-<version>-universal-mac.zip \
  /tmp/codex-auth-desktop-release/assets/codex-auth-desktop-<version>-SHA256SUMS.txt \
  --repo xuliang2024/codex-auth \
  --title "Accounts for Codex <version>" \
  --notes "Accounts for Codex <version>" \
  --latest
```

If `gh auth status` is stale but the macOS git credential helper has a valid
GitHub token, pass the token to `gh` through `GH_TOKEN` without writing it to a
file.

Verify the public release and asset URLs:

```sh
HOME=/tmp/codex-auth-desktop-release curl -fsSL \
  https://api.github.com/repos/xuliang2024/codex-auth/releases/tags/desktop-v<version>
```

The release should contain:

- `codex-auth-desktop-<version>-universal.dmg`
- `codex-auth-desktop-<version>-universal-mac.zip`
- `codex-auth-desktop-<version>-SHA256SUMS.txt`

## Troubleshooting

- If `HOME=/tmp/... security find-identity -v -p codesigning` shows `0 valid
  identities found`, run the signing build with `HOME=/Users/m007` while keeping
  the repo copy and caches under `/tmp`.
- If the `.app` is notarized but the DMG is rejected by `spctl`, sign,
  notarize, and staple the DMG separately.
- If `codesign` fails with `errSecInternalComponent`, the private key access
  control may need to allow `codesign`. Do not put the login keychain password
  in chat or in repository files.
- If the GitHub upload is slow or silent, wait; the DMG and ZIP together are
  roughly 400 MB.
