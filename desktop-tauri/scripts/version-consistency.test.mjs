import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (relativePath) => JSON.parse(
  fs.readFileSync(path.join(projectRoot, relativePath), "utf8"),
);

test("Tauri package versions stay aligned", () => {
  const packageJson = readJson("package.json");
  const packageLock = readJson("package-lock.json");
  const tauriConfig = readJson("src-tauri/tauri.conf.json");
  const cargoToml = fs.readFileSync(path.join(projectRoot, "src-tauri/Cargo.toml"), "utf8");
  const cargoLock = fs.readFileSync(path.join(projectRoot, "src-tauri/Cargo.lock"), "utf8");
  const cargoVersion = cargoToml.match(/^version = "([^"]+)"$/m)?.[1];
  const lockedCargoVersion = cargoLock.match(
    /\[\[package\]\]\nname = "codex-auth-desktop-tauri"\nversion = "([^"]+)"/,
  )?.[1];

  assert.match(packageJson.version, /^\d+\.\d+\.\d+$/);
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[""].version, packageJson.version);
  assert.equal(tauriConfig.version, packageJson.version);
  assert.equal(cargoVersion, packageJson.version);
  assert.equal(lockedCargoVersion, packageJson.version);
});
