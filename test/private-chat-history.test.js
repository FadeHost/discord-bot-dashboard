import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChannelType, PermissionFlagsBits } from "discord.js";

import { PrivateChatStore } from "../src/private-chat-store.js";
import { clearPrivateChatHistory, ensurePrivateChatPanels } from "../src/private-chat-system.js";
import { formatEmbedTitle } from "../src/embed-format.js";

const CHANNEL_ID = "123456789012345678";
const GUILD_ID = "223456789012345678";
const OWNER_ID = "323456789012345678";
const BOT_ID = "423456789012345678";

function makeDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sugar-private-chat-history-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function makeMessage(id, { authorId, title, controlIds = [] }, events) {
  const message = {
    id,
    author: { id: authorId },
    embeds: title ? [{ title }] : [],
    components: controlIds.length
      ? [{ components: controlIds.map((customId) => ({ customId })) }]
      : [],
    deleted: false,
    async delete() {
      this.deleted = true;
      events.push(id);
    },
  };
  message.editCalls = [];
  message.edit = async (payload) => {
    message.editCalls.push(payload);
    if (payload.components) message.components = payload.components;
    return message;
  };
  return message;
}

function makeChannel(history, canManageMessages = true) {
  let fetchCount = 0;
  const channel = {
    id: CHANNEL_ID,
    type: ChannelType.GuildText,
    permissionsFor: (user) => ({
      has: (permission) =>
        user?.id === BOT_ID && permission === PermissionFlagsBits.ManageMessages && canManageMessages,
    }),
    messages: {
      fetch: async (query = {}) => {
        if (typeof query === "string") {
          const message = history.find((item) => item.id === query && !item.deleted);
          if (!message) throw Object.assign(new Error("Unknown message"), { code: 10008 });
          return message;
        }
        const { limit = 100, before } = query;
        fetchCount += 1;
        const page = history
          .filter((message) => !message.deleted && (!before || BigInt(message.id) < BigInt(before)))
          .sort((first, second) => (BigInt(first.id) > BigInt(second.id) ? -1 : 1))
          .slice(0, limit);
        return new Map(page.map((message) => [message.id, message]));
      },
    },
  };
  return { channel, getFetchCount: () => fetchCount };
}

function createChat(store) {
  return store.create({
    channelId: CHANNEL_ID,
    guildId: GUILD_ID,
    ownerId: OWNER_ID,
    memberIds: ["523456789012345678"],
    displayName: "Friends",
  });
}

test("clearing history removes conversation messages and preserves both setup messages and controls", async (t) => {
  const directory = makeDirectory(t);
  const store = new PrivateChatStore(directory);
  const originalChat = createChat(store);
  const events = [];
  const baseId = 123456789012345600n;
  const welcomeId = String(baseId + 1n);
  const guideId = String(baseId + 2n);
  const welcomeControls = [
    "private-chat:add",
    "private-chat:remove",
    "private-chat:rename",
    "private-chat:leave",
    "private-chat:delete",
    "private-chat:commands",
    "private-chat:clear-history",
  ];
  const welcome = makeMessage(
    welcomeId,
    {
      authorId: BOT_ID,
      title: formatEmbedTitle("Private Chat Created"),
      controlIds: welcomeControls,
    },
    events,
  );
  const guide = makeMessage(
    guideId,
    { authorId: BOT_ID, title: formatEmbedTitle("Private Chat Commands") },
    events,
  );
  const conversation = Array.from({ length: 105 }, (_, index) =>
    makeMessage(String(baseId + BigInt(index + 3)), { authorId: OWNER_ID }, events),
  );
  const { channel, getFetchCount } = makeChannel([welcome, guide, ...conversation]);

  const deletedCount = await clearPrivateChatHistory(channel, store, { id: BOT_ID });

  assert.equal(deletedCount, 105);
  assert.equal(getFetchCount(), 4, "the setup scan and deletion both traverse paginated history");
  assert.equal(welcome.deleted, false);
  assert.equal(guide.deleted, false);
  assert.ok(conversation.every((message) => message.deleted));
  assert.deepEqual(
    welcome.components[0].components.map((component) => component.customId),
    welcomeControls,
    "the original interactive controls remain attached to the welcome message",
  );
  assert.deepEqual(store.getProtectedMessageIds(CHANNEL_ID), [welcomeId, guideId]);

  const afterClear = store.get(CHANNEL_ID);
  assert.equal(afterClear.guildId, originalChat.guildId);
  assert.equal(afterClear.ownerId, originalChat.ownerId);
  assert.deepEqual(afterClear.memberIds, originalChat.memberIds);
  assert.equal(afterClear.displayName, originalChat.displayName);
});

test("existing panels gain Clear History without replacing the original embed or buttons", async (t) => {
  const store = new PrivateChatStore(makeDirectory(t));
  createChat(store);
  const events = [];
  const baseId = 123456789012345600n;
  const welcome = makeMessage(
    String(baseId + 1n),
    {
      authorId: BOT_ID,
      title: "Private Chat Created 🎀",
      controlIds: [
        "private-chat:add",
        "private-chat:remove",
        "private-chat:rename",
        "private-chat:leave",
        "private-chat:delete",
        "private-chat:commands",
      ],
    },
    events,
  );
  const guide = makeMessage(
    String(baseId + 2n),
    { authorId: BOT_ID, title: formatEmbedTitle("Private Chat Commands") },
    events,
  );
  const originalEmbeds = structuredClone(welcome.embeds);
  const { channel } = makeChannel([welcome, guide]);
  let channelFetchCount = 0;
  const client = {
    user: { id: BOT_ID },
    channels: {
      fetch: async () => {
        channelFetchCount += 1;
        return channel;
      },
    },
  };

  await ensurePrivateChatPanels(client, store, GUILD_ID);

  assert.deepEqual(welcome.embeds, originalEmbeds);
  assert.equal(welcome.editCalls.length, 1);
  assert.ok(!Object.hasOwn(welcome.editCalls[0], "embeds"));
  assert.deepEqual(
    welcome.components.flatMap((row) =>
      row.components.map((component) => component.customId ?? component.data?.custom_id),
    ),
    [
      "private-chat:add",
      "private-chat:remove",
      "private-chat:rename",
      "private-chat:leave",
      "private-chat:delete",
      "private-chat:commands",
      "private-chat:clear-history",
    ],
  );
  assert.equal(guide.editCalls.length, 0);
  assert.deepEqual(store.getProtectedMessageIds(CHANNEL_ID), [
    String(baseId + 1n),
    String(baseId + 2n),
  ]);

  const restartedStore = new PrivateChatStore(path.dirname(store.file));
  const migratedFetchCount = channelFetchCount;
  await ensurePrivateChatPanels(client, restartedStore, GUILD_ID);
  assert.equal(channelFetchCount, migratedFetchCount, "the completed panel migration is skipped after restart");
  assert.equal(welcome.editCalls.length, 1, "the saved button is not added twice after restart");
});

test("persisted setup message IDs keep clear history working after a bot restart", async (t) => {
  const directory = makeDirectory(t);
  const firstStore = new PrivateChatStore(directory);
  createChat(firstStore);
  const welcomeId = "623456789012345678";
  const guideId = "723456789012345678";
  firstStore.setProtectedMessageIds(CHANNEL_ID, [welcomeId, guideId]);

  const restartedStore = new PrivateChatStore(directory);
  const events = [];
  const welcome = makeMessage(
    welcomeId,
    { authorId: BOT_ID, title: formatEmbedTitle("Private Chat Created") },
    events,
  );
  const guide = makeMessage(
    guideId,
    { authorId: BOT_ID, title: formatEmbedTitle("Private Chat Commands") },
    events,
  );
  const ordinary = makeMessage("823456789012345678", { authorId: OWNER_ID }, events);
  const { channel, getFetchCount } = makeChannel([welcome, guide, ordinary]);

  assert.equal(await clearPrivateChatHistory(channel, restartedStore, { id: BOT_ID }), 1);
  assert.equal(getFetchCount(), 1, "saved IDs are used directly without rescanning setup messages");
  assert.equal(welcome.deleted, false);
  assert.equal(guide.deleted, false);
  assert.equal(ordinary.deleted, true);
  assert.deepEqual(restartedStore.getProtectedMessageIds(CHANNEL_ID), [welcomeId, guideId]);
});

test("missing Manage Messages permission fails safely without deleting messages", async (t) => {
  const store = new PrivateChatStore(makeDirectory(t));
  createChat(store);
  store.setProtectedMessageIds(CHANNEL_ID, ["623456789012345678", "723456789012345678"]);
  const events = [];
  const ordinary = makeMessage("823456789012345678", { authorId: OWNER_ID }, events);
  const { channel, getFetchCount } = makeChannel([ordinary], false);

  await assert.rejects(
    clearPrivateChatHistory(channel, store, { id: BOT_ID }),
    /Manage Messages permission/,
  );
  assert.equal(getFetchCount(), 0);
  assert.equal(ordinary.deleted, false);
});
