#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const PRODUCT_NAME = "Codex Auth";

function maskValue(value) {
  if (!value) return "not set";
  if (value.length <= 6) return "***";
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

function getArgValue(...names) {
  for (const name of names) {
    const prefix = `${name}=`;
    const arg = process.argv.find((item) => item.startsWith(prefix));
    if (arg) return arg.slice(prefix.length);
  }
  return null;
}

function findDefaultAppPath() {
  const candidates = [
    path.join(process.cwd(), "dist", "mac-universal", `${PRODUCT_NAME}.app`),
    path.join(process.cwd(), "dist", "mac-arm64", `${PRODUCT_NAME}.app`),
    path.join(process.cwd(), "dist", "mac", `${PRODUCT_NAME}.app`),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

function resolveAppPath(context) {
  const explicitPath = getArgValue("--app-path", "--appPath") || process.env.APP_PATH;
  if (explicitPath) return path.resolve(explicitPath);

  if (context?.appOutDir && context?.packager?.appInfo?.productFilename) {
    return path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  }

  return findDefaultAppPath();
}

function getCredentials() {
  const keychainProfile =
    process.env.XC_NOTARY_KEYCHAIN_PROFILE ||
    process.env.APPLE_NOTARY_KEYCHAIN_PROFILE ||
    process.env.NOTARYTOOL_KEYCHAIN_PROFILE;
  if (keychainProfile) {
    return {
      summary: {
        method: "keychain profile",
        keychainProfile,
      },
      args: { keychainProfile },
      complete: true,
    };
  }

  const appleId = process.env.XC_APPLE_ID || process.env.APPLE_ID;
  const appleIdPassword =
    process.env.XC_APPLE_APP_SPECIFIC_PASSWORD ||
    process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.XC_APPLE_TEAM_ID || process.env.APPLE_TEAM_ID;

  return {
    summary: {
      method: "Apple ID",
      appleId: maskValue(appleId),
      appleIdPassword: appleIdPassword ? "set" : "not set",
      teamId: teamId || "not set",
    },
    args: { appleId, appleIdPassword, teamId },
    complete: Boolean(appleId && appleIdPassword && teamId),
  };
}

async function printAppSize(appPath) {
  try {
    const { stdout } = await execFileAsync("du", ["-sh", appPath]);
    const size = stdout.split(/\s+/)[0];
    if (size) console.log(`App bundle size: ${size}`);
  } catch {
    // Size reporting is best-effort.
  }
}

function printCredentialSummary(credentials) {
  console.log(`Credential method: ${credentials.summary.method}`);
  if (credentials.summary.keychainProfile) {
    console.log(`Keychain profile: ${credentials.summary.keychainProfile}`);
    return;
  }
  console.log(`Apple ID: ${credentials.summary.appleId}`);
  console.log(`App-specific password: ${credentials.summary.appleIdPassword}`);
  console.log(`Team ID: ${credentials.summary.teamId}`);
}

async function notarizeApp(context = {}) {
  if (process.env.SKIP_NOTARIZE === "1" || process.env.NOTARIZE_SKIP === "1") {
    console.log("Skipping notarization: SKIP_NOTARIZE is set.");
    return;
  }

  const platform = context.electronPlatformName || process.platform;
  if (platform !== "darwin") {
    console.log(`Skipping notarization: target platform is ${platform}.`);
    return;
  }

  const appPath = resolveAppPath(context);
  console.log("Starting macOS notarization.");
  console.log(`App path: ${appPath}`);

  if (!fs.existsSync(appPath)) {
    throw new Error(`App bundle was not found at ${appPath}.`);
  }

  await printAppSize(appPath);

  const credentials = getCredentials();
  printCredentialSummary(credentials);

  if (!credentials.complete) {
    console.log("Skipping notarization: notarization credentials are incomplete.");
    console.log("Set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID.");
    console.log("The XC_APPLE_ID, XC_APPLE_APP_SPECIFIC_PASSWORD, and XC_APPLE_TEAM_ID aliases are also supported.");
    console.log("Alternatively set APPLE_NOTARY_KEYCHAIN_PROFILE or NOTARYTOOL_KEYCHAIN_PROFILE.");
    return;
  }

  const { notarize } = await import("@electron/notarize");
  console.log("Submitting app to Apple notary service. This can take several minutes.");

  const progressInterval = setInterval(() => {
    console.log("Notarization is still in progress.");
  }, 60_000);

  try {
    await notarize({
      appPath,
      tool: "notarytool",
      ...credentials.args,
    });
  } finally {
    clearInterval(progressInterval);
  }

  console.log("Notarization completed successfully.");
}

module.exports = notarizeApp;
module.exports.default = notarizeApp;

if (require.main === module) {
  notarizeApp({ isFromMain: true }).catch((error) => {
    console.error("Notarization failed.");
    console.error(error?.message || String(error));
    process.exit(1);
  });
}
