import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env };
const args = process.argv.slice(2);
if (process.platform === "darwin") {
  const systemPath = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  env.PATH = [...systemPath, env.PATH || ""].filter(Boolean).join(":");
  const bundleIndex = args.indexOf("--bundles");
  const bundles = bundleIndex >= 0 ? args[bundleIndex + 1] || "" : "";
  const mayCreateDmg = ["build", "bundle"].includes(args[0])
    && (bundleIndex < 0 || bundles.split(",").includes("dmg"));
  if (mayCreateDmg && env.TAURI_DMG_USE_FINDER !== "1") {
    // create-dmg otherwise controls Finder through AppleScript, which can
    // hang in CI or when Terminal lacks Automation permission.
    env.CI = "true";
  }
  if (args[0] === "dev") {
    const runner = path.join(projectRoot, "scripts", "run-macos-dev-app.mjs");
    for (const target of ["AARCH64_APPLE_DARWIN", "X86_64_APPLE_DARWIN"]) {
      const key = `CARGO_TARGET_${target}_RUNNER`;
      env[key] ||= runner;
    }
  }
}

const cliEntry = path.join(
  projectRoot,
  "node_modules",
  "@tauri-apps",
  "cli",
  "tauri.js",
);
const result = spawnSync(process.execPath, [cliEntry, ...args], {
  env,
  stdio: "inherit",
  shell: false,
});

if (result.error) {
  console.error(`Failed to start the Tauri CLI: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
