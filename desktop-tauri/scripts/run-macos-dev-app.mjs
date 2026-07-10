#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [binary, ...args] = process.argv.slice(2);
if (!binary) {
  console.error("The macOS development runner requires an application binary.");
  process.exit(1);
}

const appName = "Accounts for Codex";
const packageMetadata = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const appVersion = packageMetadata.version;
const launchDirectory = path.join(path.dirname(binary), ".accounts-for-codex-dev");
const appBundle = path.join(launchDirectory, `${appName}.app`);
const contentsDirectory = path.join(appBundle, "Contents");
const executableDirectory = path.join(contentsDirectory, "MacOS");
const launchPath = path.join(executableDirectory, appName);
const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>${appName}</string>
  <key>CFBundleExecutable</key>
  <string>${appName}</string>
  <key>CFBundleIdentifier</key>
  <string>com.loongphy.codex-auth-desktop.dev</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${appName}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${appVersion}</string>
  <key>CFBundleVersion</key>
  <string>${appVersion}</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;

try {
  fs.rmSync(appBundle, { recursive: true, force: true });
  fs.mkdirSync(executableDirectory, { recursive: true });
  fs.symlinkSync(path.resolve(binary), launchPath);
  fs.writeFileSync(path.join(contentsDirectory, "Info.plist"), infoPlist);
} catch (error) {
  console.error(`Failed to prepare the named macOS development app: ${error.message}`);
  process.exit(1);
}

const child = spawn(launchPath, args, {
  env: process.env,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => child.kill(signal));
}

child.once("error", (error) => {
  fs.rmSync(appBundle, { recursive: true, force: true });
  console.error(`Failed to launch the named macOS development app: ${error.message}`);
  process.exitCode = 1;
});

child.once("exit", (code) => {
  fs.rmSync(appBundle, { recursive: true, force: true });
  process.exit(code ?? 1);
});
