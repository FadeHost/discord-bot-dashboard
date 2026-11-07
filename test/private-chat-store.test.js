import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChannelType, PermissionFlagsBits } from "discord.js";

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
  buildPrivateChatCommandsPayload,
  buildPrivateChatLobbyGuidePayload,
  buildPrivateChatPermissionOverwrites,
  buildPrivateChatWelcomePayload,
  createPrivateChat,
  handlePrivateChatInteraction,
  addChatMembers,
  removeChatMembers,
  renamePrivateChat,
} from "../src/private-chat-system.js";
import { toRoyalBold } from "../src/embed-format.js";

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
  store.setProtectedMessageIds("123456789012345678", ["823456789012345678", "923456789012345678"]);
  store.markClearHistoryPanelReady("123456789012345678");

  const restored = new PrivateChatStore(dir);
  assert.deepEqual(restored.get("123456789012345678"), {
    guildId: "223456789012345678",
    ownerId: "323456789012345678",
    memberIds: ["523456789012345678"],
    displayName: "Brian Moser",
    createdAt: restored.get("123456789012345678").createdAt,
    protectedMessageIds: ["823456789012345678", "923456789012345678"],
    clearHistoryPanelReady: true,
  });
  assert.equal(restored.getLobbyGuideMessageId("623456789012345678"), "723456789012345678");
  assert.deepEqual(restored.getProtectedMessageIds("123456789012345678"), [
    "823456789012345678",
    "923456789012345678",
  ]);
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

test("legacy private-chat records without protected message IDs load without being rewritten", (t) => {
  const directory = makeDirectory(t);
  const filename = path.join(directory, "private-chats.json");
  const raw = JSON.stringify({
    version: 1,
    chats: {
      "123456789012345678": {
        guildId: "223456789012345678",
        ownerId: "323456789012345678",
        memberIds: ["423456789012345678"],
        displayName: "Legacy chat",
        createdAt: "2026-11-06T00:00:00.000Z",
      },
    },
    lobbyGuideMessageIds: {},
  });
  fs.writeFileSync(filename, raw);

  const store = new PrivateChatStore(directory);

  assert.equal(store.getProtectedMessageIds("123456789012345678"), null);
  assert.equal(store.get("123456789012345678").displayName, "Legacy chat");
  assert.equal(fs.readFileSync(filename, "utf8"), raw);
});

test("private-chat names use Discord-safe formatting and match decorative General categories", () => {
  assert.equal(normalizePrivateChatLabel("Brian Moser"), "brian-moser");
  assert.equal(formatPrivateChatChannelName("Brian Moser"), "👤｜9e—𝓫𝓻𝓲𝓪𝓷-𝓶𝓸𝓼𝓮𝓻—9e°♡");
  assert.equal(normalizeCategoryName("୨୧ ─────── 𝓖𝓮𝓷𝓮𝓻𝓪𝓵 ─────── ୨୧"), "general");
  assert.throws(() => normalizePrivateChatLabel("🎀"), /letter or number/);
});

test("the lobby creation guide keeps its buttons and uses the 👤 name example", () => {
  const payload = buildPrivateChatLobbyGuidePayload();
  const description = payload.embeds[0].data.description;

  assert.equal(payload.embeds[0].data.title, `${toRoyalBold("Create Private Chat")} 🎀`);
  assert.match(description, /👤｜9e—your-text—9e°♡/);
  assert.doesNotMatch(description, new RegExp(toRoyalBold("Create a private chat")));
  assert.match(description, /• Use a button to create a private chat/u);
  assert.ok(
    description.includes("Instructions inside the chat are available from the **Commands** button or `/priv-chat commands`."),
  );
  assert.doesNotMatch(description, /administrators?/iu);
  assert.match(description, new RegExp(toRoyalBold("Name format")));
  assert.doesNotMatch(description, /\u{1F9CD}|\u2642\uFE0F/u);
  assert.deepEqual(
    payload.components[0].components.map((button) => button.data.custom_id),
    ["private-chat:create", "private-chat:commands"],
  );
  assert.deepEqual(
    payload.components[0].components.map((button) => button.data.label),
    ["Create private chat", "Commands"],
  );
});

test("private-chat creation builders make separate, styled welcome and command embeds", () => {
  const ownerId = "323456789012345678";
  const invitees = [{ id: "423456789012345678" }, { id: "523456789012345678" }];
  const welcome = buildPrivateChatWelcomePayload(ownerId, invitees);
  const guide = buildPrivateChatCommandsPayload();

  assert.equal(welcome.embeds.length, 1);
  assert.equal(guide.embeds.length, 1);
  assert.notEqual(welcome.embeds[0].data, guide.embeds[0].data);
  assert.equal(welcome.embeds[0].data.title, `${toRoyalBold("Private Chat Created")} 🎀`);
  assert.equal(
    welcome.embeds[0].data.description,
    "Your private chat is ready!\n\nWelcome <@323456789012345678>, <@423456789012345678> and <@523456789012345678>.",
  );
  assert.deepEqual(welcome.allowedMentions, {
    parse: [],
    users: [ownerId, ...invitees.map((user) => user.id)],
  });
  assert.deepEqual(
    welcome.components.flatMap((row) => row.components.map((button) => button.data.custom_id)),
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
  assert.equal(welcome.components[1].components[0].data.custom_id, "private-chat:commands");
  assert.equal(welcome.components[1].components[0].data.label, "Commands");
  assert.equal(guide.embeds[0].data.title, `${toRoyalBold("Private Chat Commands")} 🎀`);
  assert.equal(guide.embeds[0].data.description, "Use these commands inside this private channel");
  assert.doesNotMatch(guide.embeds[0].data.description, new RegExp(toRoyalBold("Use these commands inside this private channel")));

  const commandGuide = guide.embeds[0].data.fields.map((field) => `${field.name}\n${field.value}`).join("\n");
  assert.doesNotMatch(commandGuide, /administrators?/iu);
  for (const syntax of [
    "/priv-chat add user:<user>",
    "/priv-chat remove user:<user>",
    "/priv-chat rename name:<name>",
    "/priv-chat leave",
    "/priv-chat delete",
  ]) {
    assert.ok(commandGuide.includes(syntax), `missing actual command syntax: ${syntax}`);
  }
  assert.deepEqual(
    guide.embeds[0].data.fields.map((field) => field.name),
    ["Create", "Membership", "Chat", "Help"].map(toRoyalBold),
  );
});

function makeCreationFixture({ failChannelCreation = false, failStore = false } = {}) {
  const events = [];
  const channel = {
    id: "523456789012345678",
    send: async (payload) => {
      const messageId = events.filter((event) => event.type === "private-chat-message").length === 0
        ? "823456789012345678"
        : "923456789012345678";
      events.push({ type: "private-chat-message", payload, id: messageId });
      return { id: messageId };
    },
    delete: async () => events.push({ type: "channel-deleted" }),
  };
  const category = {
    id: "623456789012345678",
    name: "General",
    type: ChannelType.GuildCategory,
  };
  const guild = {
    id: "223456789012345678",
    roles: { everyone: { id: "123456789012345678" } },
    members: { fetch: async () => null },
    channels: {
      cache: new Map([[category.id, category]]),
      create: async (options) => {
        events.push({ type: "channel-created", options });
        if (failChannelCreation) throw new Error("channel create failed");
        return channel;
      },
    },
  };
  const client = {
    user: { id: "423456789012345678" },
    channels: {
      fetch: async (channelId) => {
        events.push({ type: "unexpected-channel-fetch", channelId });
        throw new Error("Creation must not fetch the public lobby.");
      },
    },
  };
  const store = {
    create: () => {
      events.push({ type: "metadata-saved" });
      if (failStore) throw new Error("store write failed");
    },
    setProtectedMessageIds: (_channelId, messageIds) => {
      events.push({ type: "protected-message-ids-saved", messageIds });
    },
    markClearHistoryPanelReady: (channelId) => events.push({ type: "clear-history-panel-ready", channelId }),
  };

  return {
    events,
    channel,
    client,
    guild,
    store,
    interaction: { user: { id: "323456789012345678" }, guild },
  };
}

test("successful private-chat creation posts welcome and command embeds only in the new channel", async () => {
  const fixture = makeCreationFixture();
  const invitees = [{ id: "723456789012345678" }];

  const channel = await createPrivateChat(
    fixture.interaction,
    fixture.client,
    fixture.store,
    "Brian Moser",
    invitees,
  );

  assert.equal(channel.id, fixture.channel.id);
  assert.deepEqual(
    fixture.events.map((event) => event.type),
    [
      "channel-created",
      "metadata-saved",
      "private-chat-message",
      "private-chat-message",
      "protected-message-ids-saved",
      "clear-history-panel-ready",
    ],
  );
  const messages = fixture.events.filter((event) => event.type === "private-chat-message");
  assert.equal(messages[0].payload.embeds[0].data.title, `${toRoyalBold("Private Chat Created")} 🎀`);
  assert.equal(messages[1].payload.embeds[0].data.title, `${toRoyalBold("Private Chat Commands")} 🎀`);
  assert.ok(messages.every((event) => event.payload.embeds.length === 1));
  assert.deepEqual(
    fixture.events.find((event) => event.type === "protected-message-ids-saved").messageIds,
    ["823456789012345678", "923456789012345678"],
  );
  assert.ok(!fixture.events.some((event) => event.type === "unexpected-channel-fetch"));
  assert.equal(
    fixture.events.find((event) => event.type === "channel-created").options.name,
    "👤｜9e—𝓫𝓻𝓲𝓪𝓷-𝓶𝓸𝓼𝓮𝓻—9e°♡",
  );
});

test("slash and modal creation replies put the dynamic channel mention on its own line", async () => {
  for (const mode of ["slash", "modal"]) {
    const fixture = makeCreationFixture();
    const interaction = {
      ...fixture.interaction,
      channelId: "923456789012345678",
      customId: "private-chat:create-modal",
      inGuild: () => true,
      isChatInputCommand: () => mode === "slash",
      isButton: () => false,
      isUserSelectMenu: () => false,
      isModalSubmit: () => mode === "modal",
      options: {
        getSubcommand: () => "create",
        getString: () => "Friends",
        getUser: () => null,
      },
      fields: { getTextInputValue: () => "Friends" },
      deferReply: async (payload) => fixture.events.push({ type: "deferred", payload }),
      editReply: async (content) => fixture.events.push({ type: "edit-reply", content }),
    };

    await handlePrivateChatInteraction(interaction, {
      client: fixture.client,
      store: fixture.store,
      lobbyChannelId: "923456789012345678",
    });

    assert.equal(
      fixture.events.at(-1).content,
      `Private chat created:\n<#${fixture.channel.id}>`,
      `${mode} creation should use a separate line and the actual channel ID`,
    );
  }
});

test("private-chat creation does not announce when Discord channel creation fails", async () => {
  const fixture = makeCreationFixture({ failChannelCreation: true });

  await assert.rejects(
    createPrivateChat(
      fixture.interaction,
      fixture.client,
      fixture.store,
      "Brian Moser",
      [],
    ),
    /channel create failed/,
  );
  assert.deepEqual(fixture.events.map((event) => event.type), ["channel-created"]);
});

test("private-chat creation does not announce when metadata cannot be saved", async () => {
  const fixture = makeCreationFixture({ failStore: true });

  await assert.rejects(
    createPrivateChat(
      fixture.interaction,
      fixture.client,
      fixture.store,
      "Brian Moser",
      [],
    ),
    /owner data could not be saved/,
  );
  assert.deepEqual(fixture.events.map((event) => event.type), ["channel-created", "metadata-saved", "channel-deleted"]);
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
  assert.ok(overwrites[3].allow.includes(PermissionFlagsBits.ManageMessages));
  assert.ok(!overwrites[1].allow.includes(PermissionFlagsBits.ManageChannels));
  assert.ok(!overwrites[1].allow.includes(PermissionFlagsBits.ManageMessages));
  assert.ok(!overwrites[2].allow.includes(PermissionFlagsBits.ManageMessages));
});

test("adding a member posts a private, mention-enabled notice after access is granted", async () => {
  const events = [];
  const memberId = "523456789012345678";
  const channel = {
    id: "623456789012345678",
    guild: { members: { fetch: async (id) => events.push({ type: "member-fetched", id }) } },
    permissionOverwrites: {
      cache: new Map(),
      edit: async (id) => events.push({ type: "access-granted", id }),
    },
    send: async (payload) => events.push({ type: "activity", payload }),
  };
  const store = {
    addMembers: () => events.push({ type: "metadata-added" }),
  };

  await addChatMembers(
    channel,
    { ownerId: "323456789012345678", memberIds: [] },
    [memberId],
    store,
    { user: { id: "423456789012345678" } },
  );

  assert.deepEqual(events.map((event) => event.type), [
    "member-fetched",
    "metadata-added",
    "access-granted",
    "activity",
  ]);
  assert.equal(events.at(-1).payload.content, `<@${memberId}> was added to this private chat.`);
  assert.deepEqual(events.at(-1).payload.allowedMentions, { parse: [], users: [memberId] });
});

test("removal notice is posted before channel access is revoked", async () => {
  const events = [];
  const memberId = "523456789012345678";
  const channel = {
    id: "623456789012345678",
    permissionOverwrites: {
      cache: new Map([[memberId, {}]]),
      delete: async (id) => events.push({ type: "access-removed", id }),
    },
    send: async (payload) => events.push({ type: "activity", payload }),
  };
  const store = {
    removeMembers: () => events.push({ type: "metadata-removed" }),
  };

  await removeChatMembers(channel, { ownerId: "323456789012345678", memberIds: [memberId] }, [memberId], store);

  assert.deepEqual(events.map((event) => event.type), ["activity", "access-removed", "metadata-removed"]);
  assert.equal(events[0].payload.content, `<@${memberId}> is being removed from this private chat.`);
  assert.deepEqual(events[0].payload.allowedMentions, { parse: [], users: [memberId] });
});

test("failed removal notice leaves channel access unchanged", async () => {
  const memberId = "523456789012345678";
  let accessRemoved = false;
  const channel = {
    id: "623456789012345678",
    permissionOverwrites: {
      cache: new Map([[memberId, {}]]),
      delete: async () => {
        accessRemoved = true;
      },
    },
    send: async () => {
      throw new Error("Discord send failed");
    },
  };

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(
      removeChatMembers(channel, { ownerId: "323456789012345678", memberIds: [memberId] }, [memberId], {
        removeMembers() {},
      }),
      /notice could not be posted/,
    );
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(accessRemoved, false);
});

test("renaming updates the channel before posting a private activity notice", async () => {
  const events = [];
  const channel = {
    id: "623456789012345678",
    setName: async (name) => {
      events.push({ type: "renamed", name });
      channel.name = name;
    },
    send: async (payload) => events.push({ type: "activity", payload }),
  };
  const store = {
    rename: (_id, displayName) => ({ displayName }),
  };

  await renamePrivateChat(channel, { displayName: "Old name" }, "New name", store);

  assert.deepEqual(events.map((event) => event.type), ["renamed", "activity"]);
  assert.equal(events[0].name, "👤｜9e—𝓷𝓮𝔀-𝓷𝓪𝓶𝓮—9e°♡");
  assert.match(events[1].payload.content, /👤｜9e—𝓷𝓮𝔀-𝓷𝓪𝓶𝓮—9e°♡/);
  assert.deepEqual(events[1].payload.allowedMentions, { parse: [] });
});
