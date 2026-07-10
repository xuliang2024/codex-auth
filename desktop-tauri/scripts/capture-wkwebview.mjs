import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};

const binary = option("--binary");
const output = option("--output");
if (process.platform !== "darwin") {
  console.error("WKWebView capture is only available on macOS.");
  process.exit(1);
}
if (!binary || !output) {
  console.error("Usage: node scripts/capture-wkwebview.mjs --binary <path> --output <png>");
  process.exit(1);
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(scriptDirectory, "run-macos-dev-app.mjs");
const windowFinder = path.join(scriptDirectory, "find-macos-window.swift");
const expectedTitle = "Accounts for Codex Visual Test";
const outputPath = path.resolve(output);
const binaryPath = path.resolve(binary);
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

if (!fs.existsSync(binaryPath)) {
  console.error(`The visual-test binary does not exist: ${binaryPath}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.rmSync(outputPath, { force: true });

const child = spawn(process.execPath, [runner, binaryPath], {
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});
let childExit = null;
child.once("exit", (code, signal) => {
  childExit = { code, signal };
});

try {
  let windowId = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (childExit) {
      throw new Error(`The visual-test app exited before capture (${JSON.stringify(childExit)}).`);
    }
    const result = spawnSync("swift", [windowFinder, expectedTitle], { encoding: "utf8" });
    if (result.status === 0 && /^\d+$/.test(result.stdout.trim())) {
      windowId = result.stdout.trim();
      break;
    }
    await delay(250);
  }
  if (!windowId) {
    throw new Error(`Could not find the '${expectedTitle}' window.`);
  }

  await delay(2000);
  const capture = spawnSync("/usr/sbin/screencapture", ["-x", "-o", "-l", windowId, outputPath], {
    encoding: "utf8",
  });
  if (capture.status !== 0 || !fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
    throw new Error(`WKWebView capture failed: ${capture.stderr || capture.stdout}`);
  }

  const resize = spawnSync("sips", ["--resampleHeightWidth", "700", "1000", outputPath], {
    encoding: "utf8",
  });
  if (resize.status !== 0) {
    throw new Error(`Could not normalize the WKWebView screenshot: ${resize.stderr || resize.stdout}`);
  }
  console.log(`Captured WKWebView visual evidence at ${outputPath}.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (!childExit) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      delay(2000),
    ]);
  }
  if (!childExit) child.kill("SIGKILL");
}
