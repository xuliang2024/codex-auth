import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "frontend-dist");

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(path.join(output, "build"), { recursive: true });
fs.cpSync(path.join(root, "renderer"), path.join(output, "renderer"), {
  recursive: true,
});
fs.copyFileSync(
  path.join(root, "src-tauri", "icons", "icon.svg"),
  path.join(output, "build", "icon.svg"),
);

console.log("Prepared the Tauri desktop frontend.");
