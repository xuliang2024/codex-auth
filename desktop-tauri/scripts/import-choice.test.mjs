import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const rendererDir = path.join(scriptsDir, "..", "renderer");

test("import choice advertises direct Sub2API JSON support", () => {
  const index = fs.readFileSync(path.join(rendererDir, "index.html"), "utf8");
  const app = fs.readFileSync(path.join(rendererDir, "app.js"), "utf8");
  const i18n = fs.readFileSync(path.join(rendererDir, "i18n.js"), "utf8");

  assert.match(index, /id="choice-tertiary" class="choice-option choice-option-sub2api hidden"/);
  assert.match(app, /secondaryLabel: t\("confirm\.importSub2Api"\)/);
  assert.match(app, /tertiaryLabel: t\("confirm\.importLink"\)/);
  assert.match(app, /if \(choice === "tertiary"\)/);
  assert.equal((i18n.match(/"confirm\.importSub2Api":/g) ?? []).length, 3);
});
