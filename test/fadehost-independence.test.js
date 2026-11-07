import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the deletion commands use FadeHost DATA_DIR and add no Replit runtime dependency", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const entrypoint = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
  const implementation = fs.readFileSync(path.join(ROOT, "src", "message-deletion.js"), "utf8");

  assert.ok(entrypoint.includes("resolveDataDir()"));
  assert.ok(entrypoint.includes("new ModerationLogStore(dataDir)"));
  assert.doesNotMatch(entrypoint, /REPLIT_|@replit\//iu);
  assert.doesNotMatch(implementation, /REPLIT_|@replit\//iu);
  assert.ok(
    Object.keys(packageJson.dependencies ?? {}).every(
      (name) => !name.toLowerCase().includes("replit"),
    ),
  );
});
