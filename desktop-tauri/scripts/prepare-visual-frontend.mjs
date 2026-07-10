import "./prepare-frontend.mjs";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "frontend-dist");
const output = path.join(root, "visual-frontend-dist");
const renderer = path.join(output, "renderer");
const indexPath = path.join(renderer, "index.html");

fs.rmSync(output, { recursive: true, force: true });
fs.cpSync(source, output, { recursive: true });
fs.copyFileSync(path.join(root, "scripts", "visual-fixture.js"), path.join(renderer, "visual-fixture.js"));

const index = fs.readFileSync(indexPath, "utf8");
const marker = '  <script src="i18n.js"></script>';
if (!index.includes(marker)) {
  throw new Error("Could not locate the renderer script marker for the visual fixture.");
}
fs.writeFileSync(
  indexPath,
  index.replace(marker, `  <script src="visual-fixture.js"></script>\n${marker}`),
);

console.log("Prepared the deterministic visual-regression frontend.");
