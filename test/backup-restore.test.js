import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function createFixture(
  t,
  {
    includeSettings = true,
    includeMemory = true,
    includePrivateChats = true,
    includeModerationLogs = true,
    includeOnboardingGuide = true,
    includeSelfRoles = true,
    includeNsfwVisibility = true,
  } = {},
) {
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
  const memoryFile = path.join(dataDir, "memory.json");
  const privateChatsFile = path.join(dataDir, "private-chats.json");
  const moderationLogsFile = path.join(dataDir, "moderation-logs.json");
  const onboardingGuideFile = path.join(dataDir, "onboarding-guide.json");
  const selfRolesFile = path.join(dataDir, "self-roles.json");
  const nsfwVisibilityFile = path.join(dataDir, "nsfw-visibility.json");
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
  if (includeMemory) {
    fs.writeFileSync(
      memoryFile,
      JSON.stringify({
        "941800000000000001:941800000000000005": [
          { role: "user", content: "hello", timestamp: 1793950711000 },
          { role: "assistant", content: "hi there", timestamp: 1793950712000 },
        ],
      }),
    );
  }
  if (includePrivateChats) {
    fs.writeFileSync(
      privateChatsFile,
      JSON.stringify({
        version: 1,
        chats: {
          "941800000000000003": {
            guildId: "941800000000000001",
            ownerId: "941800000000000005",
            memberIds: ["941800000000000006"],
            displayName: "Backup test chat",
            createdAt: "2026-11-06T07:38:31.000Z",
          },
        },
        lobbyGuideMessageIds: {
          "941800000000000004": "941800000000000007",
        },
      }),
    );
  }
  if (includeModerationLogs) {
    fs.writeFileSync(
      moderationLogsFile,
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: "123e4567-e89b-42d3-a456-426614174000",
            action: "mod-delete",
            guildId: "941800000000000001",
            channelId: "941800000000000002",
            actorId: "941800000000000005",
            targetId: "941800000000000006",
            requestedCount: 1,
            selectedCount: 1,
            messageIds: ["941800000000000007"],
            status: "completed",
            deletedCount: 1,
            skippedCount: 0,
            failedCount: 0,
            createdAt: "2026-11-06T07:38:31.000Z",
            completedAt: "2026-11-06T07:38:32.000Z",
          },
        ],
      }),
    );
  }
  if (includeOnboardingGuide) {
    fs.writeFileSync(
      onboardingGuideFile,
      JSON.stringify({ version: 1, messageIds: { "941800000000000004": "941800000000000007" } }),
    );
  }
  if (includeSelfRoles) {
    fs.writeFileSync(
      selfRolesFile,
      JSON.stringify({
        version: 1,
        guilds: {
          "941800000000000001": {
            channelId: null,
            messageId: null,
            staffRoleId: null,
            roleIds: {},
            tickets: {},
          },
        },
      }),
    );
  }
  if (includeNsfwVisibility) {
    fs.writeFileSync(nsfwVisibilityFile, JSON.stringify({ version: 1, hidden: {} }));
  }

  return {
    base,
    root,
    dataDir,
    settingsFile,
    memoryFile,
    privateChatsFile,
    moderationLogsFile,
    onboardingGuideFile,
    selfRolesFile,
    nsfwVisibilityFile,
  };
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

test("FadeHost-style backup and restore preserve app data and code without including credentials", (t) => {
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
  assert.ok(entries.includes("./data/memory.json"));
  assert.ok(entries.includes("./data/private-chats.json"));
  assert.ok(entries.includes("./data/moderation-logs.json"));
  assert.ok(entries.includes("./data/onboarding-guide.json"));
  assert.ok(entries.includes("./data/self-roles.json"));
  assert.ok(entries.includes("./data/nsfw-visibility.json"));
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
  assert.equal(
    fs.readFileSync(path.join(restoreDir, "data", "memory.json"), "utf8"),
    fs.readFileSync(fixture.memoryFile, "utf8"),
  );
  assert.equal(
    fs.readFileSync(path.join(restoreDir, "data", "private-chats.json"), "utf8"),
    fs.readFileSync(fixture.privateChatsFile, "utf8"),
  );
  assert.equal(
    fs.readFileSync(path.join(restoreDir, "data", "moderation-logs.json"), "utf8"),
    fs.readFileSync(fixture.moderationLogsFile, "utf8"),
  );
  assert.equal(
    fs.readFileSync(path.join(restoreDir, "data", "onboarding-guide.json"), "utf8"),
    fs.readFileSync(fixture.onboardingGuideFile, "utf8"),
  );
  assert.equal(
    fs.readFileSync(path.join(restoreDir, "data", "self-roles.json"), "utf8"),
    fs.readFileSync(fixture.selfRolesFile, "utf8"),
  );
  assert.equal(
    fs.readFileSync(path.join(restoreDir, "data", "nsfw-visibility.json"), "utf8"),
    fs.readFileSync(fixture.nsfwVisibilityFile, "utf8"),
  );
  assert.equal(fs.readFileSync(path.join(restoreDir, "index.js"), "utf8"), "export const fixture = true;\n");
  assert.equal(fs.existsSync(path.join(restoreDir, ".env")), false);
  assert.equal(fs.existsSync(path.join(restoreDir, "config", "credentials.json")), false);

  fs.writeFileSync(path.join(restoreDir, "keep.txt"), "preserve");
  const secondRestore = runScript(fixture, "restore.sh", [archive, restoreDir]);
  assert.notEqual(secondRestore.status, 0);
  assert.equal(fs.readFileSync(path.join(restoreDir, "keep.txt"), "utf8"), "preserve");
});

test("backup does not fabricate app data files that are absent", (t) => {
  const fixture = createFixture(t, {
    includeSettings: false,
    includeMemory: false,
    includePrivateChats: false,
    includeModerationLogs: false,
    includeOnboardingGuide: false,
    includeNsfwVisibility: false,
  });
  const outputDir = path.join(fixture.base, "external-backups");
  const result = runScript(fixture, "backup.sh", [outputDir]);

  assert.equal(result.status, 0, result.stderr);
  const archive = result.stdout.match(/Backup created: (.+)/)?.[1];
  assert.ok(archive, result.stdout);
  const entries = listArchive(archive);
  assert.ok(!entries.includes("./data/settings.json"));
  assert.ok(!entries.includes("./data/memory.json"));
  assert.ok(!entries.includes("./data/private-chats.json"));
  assert.ok(!entries.includes("./data/moderation-logs.json"));
  assert.ok(!entries.includes("./data/onboarding-guide.json"));
  assert.ok(!entries.includes("./data/nsfw-visibility.json"));
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
