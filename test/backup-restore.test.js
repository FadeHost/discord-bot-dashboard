import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function createFixture(t, { includeSettings = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sugar-backup-test-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const root = path.join(base, "project");
  const dataDir = path.join(base, "data");
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.mkdirSync(path.join(root, "nested", "node_modules", "fixture"), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  for (const script of ["backup.sh", "restore.sh"]) {
    fs.copyFileSync(
      path.join(REPO_ROOT, "scripts", script),
      path.join(root, "scripts", script),
    );
  }
  fs.copyFileSync(
    path.join(REPO_ROOT, "src", "settings.js"),
    path.join(root, "src", "settings.js"),
  );
  fs.writeFileSync(path.join(root, "index.js"), "export const fixture = true;\n");
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"fixture"}\n');
  fs.writeFileSync(path.join(root, ".env"), "FAKE_BACKUP_TEST_SECRET=not-real\n");
  fs.writeFileSync(path.join(root, ".env.example"), "OPTIONAL_VALUE=\n");
  fs.writeFileSync(path.join(root, ".env.production"), "FAKE_BACKUP_TEST_SECRET=not-real\n");
  fs.writeFileSync(path.join(root, ".npmrc"), "//registry.example/:_authToken=fake\n");
  fs.writeFileSync(
    path.join(root, "config", "credentials.json"),
    '{"fake":"not-a-real-credential"}\n',
  );
  fs.writeFileSync(
    path.join(root, "nested", "node_modules", "fixture", "index.js"),
    "module.exports = 'excluded';\n",
  );
  fs.writeFileSync(path.join(dataDir, ".env"), "FAKE_DATA_SECRET=not-real\n");
  fs.writeFileSync(
    path.join(dataDir, "credentials.json"),
    '{"fake":"not-a-real-data-credential"}\n',
  );

  const settingsFile = path.join(dataDir, "settings.json");
  if (includeSettings) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({
        "941800000000000001": {
          welcomeChannelId: "941800000000000002",
          welcomeMessage: "Welcome {user}",
          logChannelId: null,
        },
      }),
    );
  }

  return { base, root, dataDir, settingsFile };
}

function runScript(fixture, script, args) {
  return spawnSync(
    "bash",
    [path.join(fixture.root, "scripts", script), ...args],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        NODE_ENV: "production",
        DATA_DIR: fixture.dataDir,
        TMPDIR: fixture.base,
      },
    },
  );
}

function listArchive(archive) {
  return execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

test("FadeHost-style backup includes settings and code, excludes credentials and staging files", (t) => {
  const fixture = createFixture(t);
  const outputDir = path.join(fixture.dataDir, "sugar-backups");
  const result = runScript(fixture, "backup.sh", [outputDir]);

  assert.equal(result.status, 0, result.stderr);
  const match = result.stdout.match(/Backup created: (.+)/);
  assert.ok(match, result.stdout);
  const archive = match[1];
  const entries = listArchive(archive);

  assert.ok(entries.includes("./index.js"));
  assert.ok(entries.includes("./package.json"));
  assert.ok(entries.includes("./data/settings.json"));
  assert.ok(entries.includes("./.env.example"));
  assert.ok(
    !entries.some(
      (entry) => entry === "./.env" || (entry.startsWith("./.env.") && entry !== "./.env.example"),
    ),
  );
  assert.ok(!entries.includes("./data/.env"));
  assert.ok(!entries.includes("./data/credentials.json"));
  assert.ok(!entries.some((entry) => entry.includes("node_modules")));
  assert.ok(!entries.some((entry) => entry.toLowerCase().includes("credential")));
  assert.ok(!entries.some((entry) => entry.endsWith(".npmrc")));
  assert.ok(!entries.some((entry) => entry.includes("sugar-backups/")));

  const restoreDir = path.join(fixture.base, "restored");
  const restored = runScript(fixture, "restore.sh", [archive, restoreDir]);
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(
    fs.readFileSync(path.join(restoreDir, "data", "settings.json"), "utf8"),
    fs.readFileSync(fixture.settingsFile, "utf8"),
  );
  assert.equal(fs.readFileSync(path.join(restoreDir, "index.js"), "utf8"), "export const fixture = true;\n");
  assert.equal(fs.existsSync(path.join(restoreDir, ".env")), false);
  assert.equal(fs.existsSync(path.join(restoreDir, "config", "credentials.json")), false);

  fs.writeFileSync(path.join(restoreDir, "keep.txt"), "preserve");
  const secondRestore = runScript(fixture, "restore.sh", [archive, restoreDir]);
  assert.notEqual(secondRestore.status, 0);
  assert.equal(fs.readFileSync(path.join(restoreDir, "keep.txt"), "utf8"), "preserve");
});

test("backup does not fabricate settings.json when it is absent", (t) => {
  const fixture = createFixture(t, { includeSettings: false });
  const outputDir = path.join(fixture.base, "external-backups");
  const result = runScript(fixture, "backup.sh", [outputDir]);

  assert.equal(result.status, 0, result.stderr);
  const archive = result.stdout.match(/Backup created: (.+)/)?.[1];
  assert.ok(archive, result.stdout);
  assert.ok(!listArchive(archive).includes("./data/settings.json"));
});

test("restore rejects archives containing symlinks before extraction", (t) => {
  const fixture = createFixture(t);
  const source = path.join(fixture.base, "unsafe");
  const archive = path.join(fixture.base, "unsafe.tar.gz");
  const destination = path.join(fixture.base, "unsafe-restore");
  fs.mkdirSync(source);
  fs.symlinkSync("/tmp/backup-test-target", path.join(source, "escape"));
  execFileSync("tar", ["-czf", archive, "-C", source, "."]);

  const result = runScript(fixture, "restore.sh", [archive, destination]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /link or special file/);
  assert.equal(fs.existsSync(destination), false);
});
