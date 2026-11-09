import test from "node:test";
import assert from "node:assert/strict";
import { MessageType } from "discord.js";

import { shouldPubliclyLogDeletedMessage } from "../src/bot.js";
import { mergeApplicationCommands } from "../src/command-registry.js";
import {
  buildMessageDeletionCommands,
  handleMessageDeletionInteraction,
  MESSAGE_DELETION_LIMITS,
} from "../src/message-deletion.js";

const ACTOR_ID = "941800000000000101";
const TARGET_ID = "941800000000000102";
const OTHER_ID = "941800000000000103";
const BOT_ID = "941800000000000104";
const GUILD_ID = "941800000000000105";
const CHANNEL_ID = "941800000000000106";
const VIP_ROLE_ID = "941800000000000107";
const MOD_ROLE_ID = "941800000000000108";
const FIRST_MESSAGE_ID = 941800000000001000n;

function makeMessage(index, authorId, options = {}) {
  const id = String(FIRST_MESSAGE_ID + BigInt(index));
  return {
    id,
    author: { id: authorId, bot: false, ...(options.author ?? {}) },
    channelId: CHANNEL_ID,
    deleted: false,
    pinned: false,
    system: false,
    type: MessageType.Default,
    components: [],
    webhookId: null,
    deletedIds: options.deletedIds ?? [],
    ...(options.message ?? {}),
    async delete() {
      if (options.deleteError) throw options.deleteError;
      this.deleted = true;
      this.deletedIds.push(this.id);
    },
  };
}

function makeAuditLog() {
  const entries = [];
  const privateIds = new Set();
  return {
    entries,
    begin(entry) {
      const copy = { ...entry, messageIds: [...entry.messageIds] };
      entries.push(copy);
      for (const id of copy.messageIds) privateIds.add(id);
      return copy;
    },
    finish(id, result) {
      const entry = entries.find((item) => item.id === id);
      assert.ok(entry);
      Object.assign(entry, result, { messageIds: [...result.messageIds] });
      for (const messageId of result.messageIds) privateIds.add(messageId);
      return entry;
    },
    isPrivateModerationDelete(id) {
      return privateIds.has(id);
    },
  };
}

function makeHarness({
  commandName = "delete",
  amount = 1,
  memberRoleIds = [],
  targetRoleIds = [],
  targetId = TARGET_ID,
  omitTargetUser = false,
  messages = [],
  config = {},
  canDelete = true,
  historyError = null,
  auditLog = makeAuditLog(),
} = {}) {
  const deletedIds = [];
  const allMessages = messages.map((message) => {
    message.deletedIds = deletedIds;
    return message;
  });
  const channel = {
    id: CHANNEL_ID,
    guildId: GUILD_ID,
    permissionsFor: () => ({ has: () => canDelete }),
    messages: {
      fetch: async (options = {}) => {
        if (historyError) throw historyError;
        if (typeof options === "string") {
          const found = allMessages.find((message) => message.id === options && !message.deleted);
          if (!found) throw Object.assign(new Error("Unknown message"), { code: 10008 });
          return found;
        }
        const before = options.before ? BigInt(options.before) : null;
        const page = allMessages
          .filter((message) => !message.deleted && (before === null || BigInt(message.id) < before))
          .sort((left, right) => (BigInt(left.id) > BigInt(right.id) ? -1 : 1))
          .slice(0, options.limit ?? 100);
        return new Map(page.map((message) => [message.id, message]));
      },
    },
  };
  const targetMember = {
    id: targetId,
    user: { id: targetId, bot: false },
    roles: { cache: new Map(targetRoleIds.map((id) => [id, { id }])) },
  };
  const guild = {
    members: {
      me: { id: BOT_ID },
      fetch: async (id) => {
        if (id === targetId) return targetMember;
        throw new Error("Unknown member");
      },
    },
  };
  const events = [];
  const interaction = {
    commandName,
    channelId: CHANNEL_ID,
    guildId: GUILD_ID,
    channel,
    guild,
    user: { id: ACTOR_ID },
    member: { roles: { cache: new Map(memberRoleIds.map((id) => [id, { id }])) } },
    deferred: false,
    replied: false,
    isChatInputCommand: () => true,
    isButton: () => false,
    inGuild: () => true,
    options: {
      getInteger: () => amount,
      getUser: () => (omitTargetUser ? null : { id: targetId, bot: false }),
    },
    deferReply: async (payload) => {
      interaction.deferred = true;
      events.push({ type: "defer-reply", payload });
    },
    editReply: async (payload) => {
      events.push({ type: "edit-reply", payload });
    },
    reply: async (payload) => events.push({ type: "reply", payload }),
    update: async (payload) => events.push({ type: "update", payload }),
    deferUpdate: async () => events.push({ type: "defer-update" }),
  };
  const settings = {
    get: () => ({
      vipRoleIds: [],
      moderatorRoleIds: [],
      ...config,
    }),
  };
  return {
    context: { settings, moderationLogs: auditLog },
    interaction,
    events,
    allMessages,
    deletedIds,
    auditLog,
    targetMember,
    channel,
  };
}

function makeConfirmation(harness, customId, { userId = ACTOR_ID, roleIds = [] } = {}) {
  const events = [];
  const interaction = {
    customId,
    channelId: CHANNEL_ID,
    guildId: GUILD_ID,
    channel: harness.channel,
    guild: harness.interaction.guild,
    user: { id: userId },
    member: { roles: { cache: new Map(roleIds.map((id) => [id, { id }])) } },
    deferred: false,
    replied: false,
    isChatInputCommand: () => false,
    isButton: () => true,
    inGuild: () => true,
    deferUpdate: async () => {
      interaction.deferred = true;
      events.push({ type: "defer-update" });
    },
    editReply: async (payload) => events.push({ type: "edit-reply", payload }),
    reply: async (payload) => events.push({ type: "reply", payload }),
    update: async (payload) => events.push({ type: "update", payload }),
  };
  return { interaction, events };
}

function response(harness) {
  return harness.events.findLast((event) => event.type === "edit-reply")?.payload;
}

test("the three deletion commands register with bounded amounts", () => {
  const commands = buildMessageDeletionCommands();
  assert.deepEqual(commands.map((command) => command.name), ["delete", "vip-delete", "mod-delete"]);
  assert.equal(MESSAGE_DELETION_LIMITS.regular, 20);
  assert.ok(MESSAGE_DELETION_LIMITS.vip > MESSAGE_DELETION_LIMITS.regular);
  assert.equal(commands[0].options[0].max_value, MESSAGE_DELETION_LIMITS.regular);
  assert.equal(commands[1].options[0].max_value, MESSAGE_DELETION_LIMITS.vip);
  assert.equal(commands[2].options.find((option) => option.name === "amount").max_value, MESSAGE_DELETION_LIMITS.moderator);
  for (const command of commands) {
    assert.equal(command.options.find((option) => option.name === "amount").required, true);
    assert.notEqual(command.options.find((option) => option.name === "member").required, true);
  }
  assert.deepEqual(commands[2].options.map((option) => option.name), ["amount", "member"]);
});

test("command registration replaces only commands owned by this feature", () => {
  const merged = mergeApplicationCommands(
    [{ name: "other" }, { name: "delete" }, { name: "show-hide" }],
    [{ name: "delete" }, { name: "vip-delete" }],
    ["show-hide"],
  );
  assert.deepEqual(merged, [{ name: "other" }, { name: "delete" }, { name: "vip-delete" }]);
});

test("/delete without a member removes only the invoker's own eligible messages", async () => {
  const own = makeMessage(1, ACTOR_ID);
  const other = makeMessage(2, OTHER_ID);
  const botSetup = makeMessage(3, BOT_ID, { author: { bot: true } });
  const pinned = makeMessage(4, ACTOR_ID, { message: { pinned: true } });
  const systemMessage = makeMessage(5, ACTOR_ID, { message: { system: true } });
  const controls = makeMessage(6, ACTOR_ID, { message: { components: [{ type: 1 }] } });
  const webhook = makeMessage(7, ACTOR_ID, { message: { webhookId: "941800000000000109" } });
  const harness = makeHarness({
    commandName: "delete",
    amount: 20,
    omitTargetUser: true,
    messages: [own, other, botSetup, pinned, systemMessage, controls, webhook],
  });

  await handleMessageDeletionInteraction(harness.interaction, harness.context);

  assert.deepEqual(harness.deletedIds, [own.id]);
  assert.equal(other.deleted, false);
  assert.equal(botSetup.deleted, false);
  assert.equal(pinned.deleted, false);
  assert.equal(systemMessage.deleted, false);
  assert.equal(controls.deleted, false);
  assert.equal(webhook.deleted, false);
  assert.match(response(harness).content, /Deleted 1 message from your own/);
});

test("/delete ignores a selected member and still removes only the invoker's messages", async () => {
  const own = makeMessage(1, ACTOR_ID);
  const other = makeMessage(2, TARGET_ID);
  const harness = makeHarness({ commandName: "delete", amount: 2, messages: [own, other] });

  await handleMessageDeletionInteraction(harness.interaction, harness.context);

  assert.deepEqual(harness.deletedIds, [own.id]);
  assert.equal(other.deleted, false);
});

test("/vip-delete checks configured role IDs and remains self-only", async () => {
  const own = makeMessage(1, ACTOR_ID);
  const other = makeMessage(2, TARGET_ID);
  const harness = makeHarness({
    commandName: "vip-delete",
    amount: 2,
    memberRoleIds: [VIP_ROLE_ID],
    config: { vipRoleIds: [VIP_ROLE_ID] },
    messages: [own, other],
  });
  let targetOptionRead = false;
  harness.interaction.options.getUser = () => {
    targetOptionRead = true;
    return { id: TARGET_ID };
  };

  await handleMessageDeletionInteraction(harness.interaction, harness.context);

  assert.deepEqual(harness.deletedIds, [own.id]);
  assert.equal(other.deleted, false);
  assert.equal(targetOptionRead, false);
});

test("/vip-delete without a member removes only the VIP executor's messages", async () => {
  const own = makeMessage(1, ACTOR_ID);
  const other = makeMessage(2, TARGET_ID);
  const harness = makeHarness({
    commandName: "vip-delete",
    amount: 2,
    memberRoleIds: [VIP_ROLE_ID],
    config: { vipRoleIds: [VIP_ROLE_ID] },
    omitTargetUser: true,
    messages: [own, other],
  });

  await handleMessageDeletionInteraction(harness.interaction, harness.context);

  assert.deepEqual(harness.deletedIds, [own.id]);
  assert.equal(other.deleted, false);
});

test("/vip-delete denies users without a configured matching role ID", async () => {
  const own = makeMessage(1, ACTOR_ID);
  const harness = makeHarness({
    commandName: "vip-delete",
    memberRoleIds: ["941800000000000110"],
    config: { vipRoleIds: [VIP_ROLE_ID] },
    messages: [own],
  });

  await handleMessageDeletionInteraction(harness.interaction, harness.context);

  assert.deepEqual(harness.deletedIds, []);
  assert.match(response(harness).content, /authorized VIP role/);
});

test("/mod-delete requires the configured moderator role and logs target deletions privately", async () => {
  const targetMessage = makeMessage(1, TARGET_ID);
  const unrelatedMessage = makeMessage(2, OTHER_ID);
  const harness = makeHarness({
    commandName: "mod-delete",
    amount: 1,
    memberRoleIds: [MOD_ROLE_ID],
    targetRoleIds: [VIP_ROLE_ID],
    config: { vipRoleIds: [VIP_ROLE_ID], moderatorRoleIds: [MOD_ROLE_ID] },
    messages: [targetMessage, unrelatedMessage],
  });

  await handleMessageDeletionInteraction(harness.interaction, harness.context);

  assert.deepEqual(harness.deletedIds, [targetMessage.id]);
  assert.equal(unrelatedMessage.deleted, false);
  assert.equal(harness.auditLog.entries.length, 1);
  assert.equal(harness.auditLog.entries[0].action, "mod-delete");
  assert.equal(harness.auditLog.entries[0].actorId, ACTOR_ID);
  assert.equal(harness.auditLog.entries[0].targetId, TARGET_ID);
  assert.equal(harness.auditLog.entries[0].status, "completed");
  assert.equal(harness.auditLog.isPrivateModerationDelete(targetMessage.id), true);
  assert.doesNotMatch(JSON.stringify(harness.auditLog.entries[0]), /message content/i);
  assert.equal(shouldPubliclyLogDeletedMessage({ id: targetMessage.id, guild: {}, author: { bot: false } }, harness.auditLog), false);
  assert.equal(shouldPubliclyLogDeletedMessage({ id: unrelatedMessage.id, guild: {}, author: { bot: false } }, harness.auditLog), true);
});

test("/mod-delete without a member deletes eligible messages from any author in the channel", async () => {
  const ownMessage = makeMessage(1, ACTOR_ID);
  const otherMessage = makeMessage(2, TARGET_ID);
  const thirdPartyMessage = makeMessage(3, OTHER_ID);
  const botMessage = makeMessage(4, BOT_ID, { author: { bot: true } });
  const pinnedMessage = makeMessage(5, OTHER_ID, { message: { pinned: true } });
  const systemMessage = makeMessage(6, OTHER_ID, { message: { system: true } });
  const controlsMessage = makeMessage(7, OTHER_ID, { message: { components: [{ type: 1 }] } });
  const webhookMessage = makeMessage(8, OTHER_ID, { message: { webhookId: "941800000000000109" } });
  const harness = makeHarness({
    commandName: "mod-delete",
    amount: 10,
    memberRoleIds: [MOD_ROLE_ID],
    config: { moderatorRoleIds: [MOD_ROLE_ID] },
    omitTargetUser: true,
    messages: [
      ownMessage,
      otherMessage,
      thirdPartyMessage,
      botMessage,
      pinnedMessage,
      systemMessage,
      controlsMessage,
      webhookMessage,
    ],
  });

  await handleMessageDeletionInteraction(harness.interaction, harness.context);

  assert.deepEqual(harness.deletedIds, [thirdPartyMessage.id, otherMessage.id, ownMessage.id]);
  assert.equal(botMessage.deleted, false);
  assert.equal(pinnedMessage.deleted, false);
  assert.equal(systemMessage.deleted, false);
  assert.equal(controlsMessage.deleted, false);
  assert.equal(webhookMessage.deleted, false);
  assert.equal(harness.auditLog.entries[0].selectedCount, 3);
  assert.equal(harness.auditLog.entries[0].targetId, null);
  assert.equal(shouldPubliclyLogDeletedMessage({ id: thirdPartyMessage.id, guild: {}, author: { bot: false } }, harness.auditLog), false);
  assert.match(response(harness).content, /from this channel/);
});

test("/mod-delete does not authorize by role name and rejects unauthorized users", async () => {
  const own = makeMessage(1, TARGET_ID);
  const harness = makeHarness({
    commandName: "mod-delete",
    memberRoleIds: ["941800000000000110"],
    config: { moderatorRoleIds: [MOD_ROLE_ID] },
    messages: [own],
  });

  await handleMessageDeletionInteraction(harness.interaction, harness.context);

  assert.deepEqual(harness.deletedIds, []);
  assert.equal(harness.auditLog.entries.length, 0);
  assert.match(response(harness).content, /authorized moderator role/);
});

test("moderator deletion cannot target another configured moderator", async () => {
  const message = makeMessage(1, TARGET_ID);
  const harness = makeHarness({
    commandName: "mod-delete",
    memberRoleIds: [MOD_ROLE_ID],
    targetRoleIds: [MOD_ROLE_ID],
    config: { moderatorRoleIds: [MOD_ROLE_ID] },
    messages: [message],
  });

  await handleMessageDeletionInteraction(harness.interaction, harness.context);

  assert.deepEqual(harness.deletedIds, []);
  assert.match(response(harness).content, /cannot target a member with an authorized moderator role/);
});

test("large deletions wait for confirmation and only the requester can confirm", async () => {
  const ownMessages = Array.from({ length: 11 }, (_, index) => makeMessage(index + 1, ACTOR_ID));
  const harness = makeHarness({ commandName: "delete", amount: 11, messages: ownMessages });
  await handleMessageDeletionInteraction(harness.interaction, harness.context);

  assert.deepEqual(harness.deletedIds, []);
  const customId = response(harness).components[0].components[0].data.custom_id;
  const stranger = makeConfirmation(harness, customId, { userId: OTHER_ID });
  await handleMessageDeletionInteraction(stranger.interaction, harness.context);
  assert.deepEqual(harness.deletedIds, []);
  assert.match(stranger.events[0].payload.content, /Only the person who requested/);

  const owner = makeConfirmation(harness, customId);
  await handleMessageDeletionInteraction(owner.interaction, harness.context);
  assert.equal(harness.deletedIds.length, 11);
  assert.equal(owner.events[0].type, "defer-update");
  assert.match(owner.events.at(-1).payload.content, /Deleted 11 messages/);
});

test("VIP role is rechecked when a large deletion is confirmed", async () => {
  const ownMessages = Array.from({ length: 11 }, (_, index) => makeMessage(index + 1, ACTOR_ID));
  const harness = makeHarness({
    commandName: "vip-delete",
    amount: 11,
    memberRoleIds: [VIP_ROLE_ID],
    config: { vipRoleIds: [VIP_ROLE_ID] },
    messages: ownMessages,
  });
  await handleMessageDeletionInteraction(harness.interaction, harness.context);
  const customId = response(harness).components[0].components[0].data.custom_id;

  const confirmation = makeConfirmation(harness, customId, { roleIds: [] });
  await handleMessageDeletionInteraction(confirmation.interaction, harness.context);

  assert.deepEqual(harness.deletedIds, []);
  assert.match(confirmation.events.at(-1).payload.content, /authorized VIP role/);
});

test("/mod-delete confirms channel-wide deletion when member is omitted", async () => {
  const messages = Array.from({ length: 11 }, (_, index) => makeMessage(index + 1, index % 2 ? ACTOR_ID : TARGET_ID));
  const harness = makeHarness({
    commandName: "mod-delete",
    amount: 11,
    memberRoleIds: [MOD_ROLE_ID],
    config: { moderatorRoleIds: [MOD_ROLE_ID] },
    omitTargetUser: true,
    messages,
  });
  await handleMessageDeletionInteraction(harness.interaction, harness.context);
  const customId = response(harness).components[0].components[0].data.custom_id;

  const confirmation = makeConfirmation(harness, customId, { roleIds: [MOD_ROLE_ID] });
  await handleMessageDeletionInteraction(confirmation.interaction, harness.context);

  assert.equal(harness.deletedIds.length, 11);
  assert.match(confirmation.events.at(-1).payload.content, /Deleted 11 messages from this channel/);
  assert.equal(harness.auditLog.entries[0].targetId, null);
});

test("cancelled large deletions do not delete anything", async () => {
  const ownMessages = Array.from({ length: 11 }, (_, index) => makeMessage(index + 1, ACTOR_ID));
  const harness = makeHarness({ amount: 11, messages: ownMessages });
  await handleMessageDeletionInteraction(harness.interaction, harness.context);
  const customId = response(harness).components[0].components[1].data.custom_id;

  const cancellation = makeConfirmation(harness, customId);
  await handleMessageDeletionInteraction(cancellation.interaction, harness.context);

  assert.deepEqual(harness.deletedIds, []);
  assert.match(cancellation.events[0].payload.content, /cancelled/);
});

test("missing bot permissions and inaccessible message history return clear errors", async () => {
  const own = makeMessage(1, ACTOR_ID);
  const noPermission = makeHarness({ messages: [own], canDelete: false });
  await handleMessageDeletionInteraction(noPermission.interaction, noPermission.context);
  assert.deepEqual(noPermission.deletedIds, []);
  assert.match(response(noPermission).content, /Manage Messages/);

  const inaccessible = makeHarness({ messages: [own], historyError: new Error("forbidden") });
  await handleMessageDeletionInteraction(inaccessible.interaction, inaccessible.context);
  assert.deepEqual(inaccessible.deletedIds, []);
  assert.match(response(inaccessible).content, /could not read message history/);
});

test("per-message Discord errors are reported without claiming success", async () => {
  const message = makeMessage(1, ACTOR_ID, { deleteError: Object.assign(new Error("forbidden"), { code: 50013 }) });
  const harness = makeHarness({ messages: [message] });

  await handleMessageDeletionInteraction(harness.interaction, harness.context);

  assert.deepEqual(harness.deletedIds, []);
  assert.match(response(harness).content, /could not be deleted/);
});
