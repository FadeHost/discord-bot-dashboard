import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MAX_PRIVATE_CHAT_MEMBERS,
  PrivateChatStore,
} from "../src/private-chat-store.js";
import {
  formatPrivateChatChannelName,
  normalizeCategoryName,
  normalizePrivateChatLabel,
  PRIVATE_CHAT_LOBBY_CHANNEL_ID,
} from "../src/private-chat-format.js";
import {
  buildPrivateChatCommand,
  buildPrivateChatPermissionOverwrites,
} from "../src/private-chat-system.js";
import { PermissionFlagsBits } from "discord.js";

function makeDirectory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sugar-private-chats-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("private-chat metadata persists and supports owner-managed membership and rename", (t) => {
  const dir = makeDirectory(t);
  const store = new PrivateChatStore(dir);
  store.create({
    channelId: "123456789012345678",
    guildId: "223456789012345678",
    ownerId: "323456789012345678",
    memberIds: ["423456789012345678"],
    displayName: "Brian",
  });

  store.addMembers("123456789012345678", ["523456789012345678"]);
  store.removeMembers("123456789012345678", ["423456789012345678"]);
  store.rename("123456789012345678", "Brian Moser");
  store.setLobbyGuideMessageId("623456789012345678", "723456789012345678");

  const restored = new PrivateChatStore(dir);
  assert.deepEqual(restored.get("123456789012345678"), {
    guildId: "223456789012345678",
    ownerId: "323456789012345678",
    memberIds: ["523456789012345678"],
    displayName: "Brian Moser",
    createdAt: restored.get("123456789012345678").createdAt,
  });
  assert.equal(restored.getLobbyGuideMessageId("623456789012345678"), "723456789012345678");
  assert.equal(restored.listGuild("223456789012345678").length, 1);
  assert.equal(restored.delete("123456789012345678"), true);
  assert.equal(restored.get("123456789012345678"), null);
  assert.equal(restored.delete("123456789012345678"), false);
});

test("private-chat store enforces owner and five-invitee limits", (t) => {
  const store = new PrivateChatStore(makeDirectory(t));
  store.create({
    channelId: "123456789012345678",
    guildId: "223456789012345678",
    ownerId: "323456789012345678",
    displayName: "test",
  });
  const ids = Array.from({ length: MAX_PRIVATE_CHAT_MEMBERS + 1 }, (_, index) =>
    `${4 + index}23456789012345678`,
  );

  assert.throws(
    () => store.addMembers("123456789012345678", ids),
    /at most 5 invited people/,
  );
  store.addMembers("123456789012345678", ids.slice(0, MAX_PRIVATE_CHAT_MEMBERS));
  assert.throws(() => store.addMembers("123456789012345678", [ids[MAX_PRIVATE_CHAT_MEMBERS]]), /at most 5/);
  assert.throws(() => store.addMembers("123456789012345678", ["323456789012345678"]), /owner/);
  assert.throws(() => store.removeMembers("123456789012345678", ["323456789012345678"]), /owner/);
  assert.throws(() => store.create({
    channelId: "123456789012345678",
    guildId: "223456789012345678",
    ownerId: "323456789012345678",
    displayName: "duplicate",
  }), /already registered/);
});

test("private-chat store rejects corrupt data without replacing it", (t) => {
  const dir = makeDirectory(t);
  const filename = path.join(dir, "private-chats.json");
  fs.writeFileSync(filename, "{");

  assert.throws(() => new PrivateChatStore(dir), /invalid JSON/);
  assert.equal(fs.readFileSync(filename, "utf8"), "{");
});

test("private-chat names use Discord-safe formatting and match decorative General categories", () => {
  assert.equal(normalizePrivateChatLabel("Brian Moser"), "brian-moser");
  assert.equal(formatPrivateChatChannelName("Brian Moser"), "🧍｜9e—brian-moser—9e°♡");
  assert.equal(normalizeCategoryName("୨୧ ─────── 𝓖𝓮𝓷𝓮𝓻𝓪𝓵 ─────── ୨୧"), "general");
  assert.throws(() => normalizePrivateChatLabel("🎀"), /letter or number/);
});

test("private-chat command exposes create, add, remove, rename, delete, leave, and help", () => {
  const command = buildPrivateChatCommand();
  const subcommands = command.options.map((option) => option.name);
  assert.deepEqual(subcommands, ["create", "add", "remove", "rename", "delete", "leave", "commands"]);

  const create = command.options.find((option) => option.name === "create");
  assert.equal(create.options.filter((option) => option.type === 6).length, MAX_PRIVATE_CHAT_MEMBERS);
  assert.equal(PRIVATE_CHAT_LOBBY_CHANNEL_ID, "1568179043356901376");
});

test("private channels deny everyone and grant only named members and the bot", () => {
  const overwrites = buildPrivateChatPermissionOverwrites({
    everyoneId: "123456789012345678",
    ownerId: "223456789012345678",
    memberIds: ["323456789012345678"],
    botId: "423456789012345678",
  });

  assert.deepEqual(overwrites[0].deny, [PermissionFlagsBits.ViewChannel]);
  assert.ok(overwrites[1].allow.includes(PermissionFlagsBits.ViewChannel));
  assert.ok(overwrites[2].allow.includes(PermissionFlagsBits.SendMessages));
  assert.ok(overwrites[3].allow.includes(PermissionFlagsBits.ManageChannels));
  assert.ok(!overwrites[1].allow.includes(PermissionFlagsBits.ManageChannels));
});
