import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Tauri keeps the window drag command and marks the full header as draggable", () => {
  const capability = JSON.parse(
    fs.readFileSync(path.join(projectRoot, "src-tauri/capabilities/default.json"), "utf8"),
  );
  const renderer = fs.readFileSync(
    path.resolve(projectRoot, "..", "desktop/renderer/index.html"),
    "utf8",
  );

  assert.ok(capability.permissions.includes("core:window:allow-start-dragging"));
  assert.match(renderer, /<header class="titlebar" data-tauri-drag-region="deep">/);
});
