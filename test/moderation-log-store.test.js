import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ModerationLogStore } from "../src/moderation-log-store.js";

const ENTRY_ID = "123e4567-e89b-42d3-a456-426614174000";
const GUILD_ID = "941800000000000201";
const CHANNEL_ID = "941800000000000202";
const ACTOR_ID = "941800000000000203";
const TARGET_ID = "941800000000000204";
const MESSAGE_ID = "941800000000000205";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "moderation-log-test-"));
}

function entry(overrides = {}) {
  return {
    id: ENTRY_ID,
    action: "mod-delete",
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    actorId: ACTOR_ID,
    targetId: TARGET_ID,
    requestedCount: 1,
    selectedCount: 1,
    messageIds: [MESSAGE_ID],
    status: "started",
    createdAt: "2026-11-06T12:00:00.000Z",
    ...overrides,
  };
}

test("moderation records persist privately and index deleted message IDs", () => {
  const dir = tempDir();
  const store = new ModerationLogStore(dir);
  store.begin(entry());

  const file = path.join(dir, "moderation-logs.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(store.isPrivateModerationDelete(MESSAGE_ID), true);
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /message content/i);

  const afterRestart = new ModerationLogStore(dir);
  assert.equal(afterRestart.isPrivateModerationDelete(MESSAGE_ID), true);
  afterRestart.finish(ENTRY_ID, {
    status: "completed",
    deletedCount: 1,
    skippedCount: 0,
    failedCount: 0,
    messageIds: [MESSAGE_ID],
  });

  assert.equal(afterRestart.list()[0].status, "completed");
  assert.equal(afterRestart.list()[0].deletedCount, 1);
});

test("moderation log storage refuses corrupt data without overwriting it", () => {
  const dir = tempDir();
  const file = path.join(dir, "moderation-logs.json");
  const original = '{"version":';
  fs.writeFileSync(file, original);

  assert.throws(() => new ModerationLogStore(dir), /invalid JSON/);
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("moderation entries reject invalid IDs and invalid count shapes", () => {
  const store = new ModerationLogStore(tempDir());
  assert.throws(() => store.begin(entry({ targetId: "not-a-snowflake" })), /invalid structure/);
  assert.throws(() => store.begin(entry({ selectedCount: 101 })), /invalid structure/);
  assert.deepEqual(store.list(), []);
});

test("channel-wide moderation records preserve a null target", () => {
  const dir = tempDir();
  const store = new ModerationLogStore(dir);
  store.begin(entry({ targetId: null }));

  const afterRestart = new ModerationLogStore(dir);
  assert.equal(afterRestart.list()[0].targetId, null);
  afterRestart.finish(ENTRY_ID, {
    status: "completed",
    deletedCount: 1,
    skippedCount: 0,
    failedCount: 0,
    messageIds: [MESSAGE_ID],
  });
  assert.equal(afterRestart.list()[0].targetId, null);
});
