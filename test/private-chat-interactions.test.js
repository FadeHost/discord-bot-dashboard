import test from "node:test";
import assert from "node:assert/strict";
import { ChannelType } from "discord.js";

import { handlePrivateChatInteraction } from "../src/private-chat-system.js";

const OWNER_ID = "323456789012345678";
const MEMBER_ID = "423456789012345678";
const CHANNEL_ID = "523456789012345678";
const GUILD_ID = "623456789012345678";

function makeInteraction(
  action,
  {
    userId = OWNER_ID,
    memberIds = [MEMBER_ID],
    history = [],
    protectedMessageIds = null,
  } = {},
) {
  const events = [];
  const channel = {
    id: CHANNEL_ID,
    type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => true }),
    messages: {
      fetch: async () => new Map(history.filter((message) => !message.deleted).map((message) => [message.id, message])),
    },
    permissionOverwrites: {
      cache: new Map(memberIds.map((id) => [id, {}])),
      delete: async (id) => events.push({ type: "access-removed", id }),
    },
    send: async (payload) => events.push({ type: "private-channel-message", payload }),
  };
  const chat = {
    guildId: GUILD_ID,
    ownerId: OWNER_ID,
    memberIds: [...memberIds],
    displayName: "Friends",
  };
  const store = {
    get: (id) => (id === CHANNEL_ID ? chat : null),
    removeMembers: (_id, ids) => events.push({ type: "members-removed", ids }),
    getProtectedMessageIds: () => protectedMessageIds,
    setProtectedMessageIds: (_id, ids) => events.push({ type: "protected-message-ids-saved", ids }),
  };
  const interaction = {
    customId: `private-chat:${action}`,
    channelId: CHANNEL_ID,
    guildId: GUILD_ID,
    channel,
    user: { id: userId },
    deferred: false,
    replied: false,
    isChatInputCommand: () => false,
    isButton: () => true,
    isUserSelectMenu: () => false,
    isModalSubmit: () => false,
    inGuild: () => true,
    reply: async (payload) => events.push({ type: "reply", payload }),
    update: async (payload) => events.push({ type: "update", payload }),
    showModal: async (modal) => events.push({ type: "modal", modal }),
    deferReply: async () => {
      interaction.deferred = true;
      events.push({ type: "deferred" });
    },
    deferUpdate: async () => events.push({ type: "deferred-update" }),
    editReply: async (payload) => events.push({ type: "edit-reply", payload }),
    followUp: async (payload) => events.push({ type: "follow-up", payload }),
  };
  return { events, interaction, store };
}

test("private-chat buttons route to their existing controls", async () => {
  const context = { client: {}, store: {}, lobbyChannelId: "923456789012345678" };

  const create = makeInteraction("create");
  create.interaction.channelId = context.lobbyChannelId;
  await handlePrivateChatInteraction(create.interaction, context);
  assert.equal(create.events[0].type, "modal");
  assert.equal(create.events[0].modal.data.custom_id, "private-chat:create-modal");

  const commands = makeInteraction("commands");
  await handlePrivateChatInteraction(commands.interaction, context);
  assert.equal(commands.events[0].type, "reply");
  assert.match(commands.events[0].payload.content, /\/priv-chat add user:/);
  assert.doesNotMatch(commands.events[0].payload.content, /administrators?/iu);

  const add = makeInteraction("add");
  await handlePrivateChatInteraction(add.interaction, { ...context, store: add.store });
  assert.equal(add.events[0].type, "reply");
  assert.equal(add.events[0].payload.components[0].components[0].data.custom_id, "private-chat:add-select");

  const remove = makeInteraction("remove");
  await handlePrivateChatInteraction(remove.interaction, { ...context, store: remove.store });
  assert.equal(remove.events[0].type, "reply");
  assert.equal(remove.events[0].payload.components[0].components[0].data.custom_id, "private-chat:remove-select");

  const rename = makeInteraction("rename");
  await handlePrivateChatInteraction(rename.interaction, { ...context, store: rename.store });
  assert.equal(rename.events[0].type, "modal");
  assert.equal(rename.events[0].modal.data.custom_id, "private-chat:rename-modal");

  const leave = makeInteraction("leave", { userId: MEMBER_ID });
  await handlePrivateChatInteraction(leave.interaction, { ...context, store: leave.store });
  assert.deepEqual(
    leave.events.map((event) => event.type),
    ["deferred", "private-channel-message", "access-removed", "members-removed", "edit-reply"],
  );

  const deleteChat = makeInteraction("delete");
  await handlePrivateChatInteraction(deleteChat.interaction, { ...context, store: deleteChat.store });
  assert.equal(deleteChat.events[0].type, "reply");
  assert.equal(
    deleteChat.events[0].payload.components[0].components[0].data.custom_id,
    "private-chat:delete-confirm",
  );

  const clearPrompt = makeInteraction("clear-history");
  await handlePrivateChatInteraction(clearPrompt.interaction, {
    ...context,
    store: clearPrompt.store,
  });
  assert.match(clearPrompt.events[0].payload.content, /welcome and command guide will be kept/i);
  assert.deepEqual(
    clearPrompt.events[0].payload.components[0].components.map((button) => button.data.custom_id),
    ["private-chat:clear-history-confirm", "private-chat:clear-history-cancel"],
  );

  const ordinaryMessage = {
    id: "723456789012345678",
    deleted: false,
    delete: async () => {
      ordinaryMessage.deleted = true;
      clearConfirmation.events.push({ type: "history-deleted" });
    },
  };
  const clearConfirmation = makeInteraction("clear-history-confirm", {
    history: [ordinaryMessage],
    protectedMessageIds: ["823456789012345678", "923456789012345678"],
  });
  await handlePrivateChatInteraction(clearConfirmation.interaction, {
    client: { user: { id: "123456789012345678" } },
    store: clearConfirmation.store,
    lobbyChannelId: "923456789012345678",
  });
  assert.deepEqual(
    clearConfirmation.events.map((event) => event.type),
    ["deferred-update", "history-deleted", "follow-up"],
  );
  assert.match(clearConfirmation.events.at(-1).payload.content, /1 conversation message was cleared/);

  const clearCancelled = makeInteraction("clear-history-cancel");
  await handlePrivateChatInteraction(clearCancelled.interaction, context);
  assert.equal(clearCancelled.events[0].payload.content, "History clearing cancelled.");
  assert.deepEqual(clearCancelled.events[0].payload.components, []);
});

test("non-owners cannot use owner-only private-chat buttons", async () => {
  for (const action of ["add", "remove", "rename", "delete", "clear-history", "clear-history-confirm"]) {
    const { interaction, store } = makeInteraction(action, { userId: MEMBER_ID });
    await assert.rejects(
      handlePrivateChatInteraction(interaction, { client: {}, store, lobbyChannelId: "923456789012345678" }),
      /Only the person who created this private chat/,
      `${action} should remain owner-only`,
    );
  }
});
