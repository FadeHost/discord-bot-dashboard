import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  MessageType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";

export const MESSAGE_DELETION_LIMITS = Object.freeze({
  regular: 20,
  vip: 100,
  moderator: 100,
  confirmationThreshold: 10,
  scan: 2_000,
});

const COMMANDS = Object.freeze({
  delete: { kind: "self", max: MESSAGE_DELETION_LIMITS.regular, roleField: null },
  "vip-delete": { kind: "self", max: MESSAGE_DELETION_LIMITS.vip, roleField: "vipRoleIds" },
  "mod-delete": { kind: "moderator", max: MESSAGE_DELETION_LIMITS.moderator, roleField: "moderatorRoleIds" },
});
const CONFIRM_PREFIX = "message-delete:";
const PENDING_TTL_MS = 5 * 60 * 1_000;
const REQUIRED_BOT_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.ManageMessages,
];
const pendingOperations = new Map();

export function buildMessageDeletionCommands() {
  return [
    buildSelfDeleteCommand("delete", MESSAGE_DELETION_LIMITS.regular),
    buildSelfDeleteCommand("vip-delete", MESSAGE_DELETION_LIMITS.vip),
    new SlashCommandBuilder()
      .setName("mod-delete")
      .setDescription(`Delete up to ${MESSAGE_DELETION_LIMITS.moderator} recent messages in this channel or from a member`)
      .addIntegerOption((option) =>
        option
          .setName("amount")
          .setDescription(`Number of messages to delete (maximum ${MESSAGE_DELETION_LIMITS.moderator})`)
          .setMinValue(1)
          .setMaxValue(MESSAGE_DELETION_LIMITS.moderator)
          .setRequired(true),
      )
      .addUserOption((option) =>
        option
          .setName("member")
          .setDescription("Member whose messages will be deleted (leave blank for eligible messages from this channel)"),
      )
      .toJSON(),
  ];
}

function buildSelfDeleteCommand(name, max) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(`Delete up to ${max} of your own recent messages`)
    .addIntegerOption((option) =>
      option
        .setName("amount")
        .setDescription(`Number of your messages to delete (maximum ${max})`)
        .setMinValue(1)
        .setMaxValue(max)
        .setRequired(true),
    )
    .addUserOption((option) =>
      option.setName("member").setDescription("Optional member selection; only your own messages will be deleted"),
    )
    .toJSON();
}

export function attachMessageDeletionSystem(client, context) {
  client.on(Events.InteractionCreate, (interaction) => {
    if (!isDeletionInteraction(interaction)) return;
    void handleMessageDeletionInteraction(interaction, context).catch(async (error) => {
      console.error(`[message-deletion] interaction failed: ${error?.code ?? "unknown error"}`);
      await replyWithError(interaction, "Discord could not complete that deletion. Check the bot's permissions and try again.");
    });
  });
}

export async function handleMessageDeletionInteraction(interaction, context) {
  if (interaction.isChatInputCommand?.() && Object.hasOwn(COMMANDS, interaction.commandName)) {
    await handleDeleteCommand(interaction, context);
    return true;
  }
  if (interaction.isButton?.() && interaction.customId?.startsWith(CONFIRM_PREFIX)) {
    await handleConfirmationButton(interaction, context);
    return true;
  }
  return false;
}

async function handleDeleteCommand(interaction, context) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const commandName = interaction.commandName;
    const definition = COMMANDS[commandName];
    validateGuildChannel(interaction);

    const amount = interaction.options.getInteger("amount", true);
    if (!Number.isInteger(amount) || amount < 1 || amount > definition.max) {
      throw new UserFacingError(`Choose an amount from 1 to ${definition.max}.`);
    }

    const config = getGuildSettings(context.settings, interaction.guildId);
    validateRole(interaction.member, config, definition.roleField, commandName);
    await requireBotDeletePermissions(interaction);

    let targetId = interaction.user.id;
    if (definition.kind === "moderator") {
      const targetUser = interaction.options.getUser("member", false);
      if (targetUser?.bot) {
        throw new UserFacingError("Choose a human server member to moderate.");
      }
      if (targetUser) {
        if (targetUser.id !== interaction.user.id) {
          const targetMember = await fetchGuildMember(interaction.guild, targetUser.id);
          validateModeratorTarget(targetMember, config);
        }
        targetId = targetUser.id;
      } else {
        targetId = null;
      }
    }

    const scanLimit = Math.max(amount, MESSAGE_DELETION_LIMITS.scan);
    const messages = await collectMessages(interaction.channel, targetId, amount, scanLimit);
    if (!messages.length) {
      return interaction.editReply("No eligible messages were found in the recent channel history.");
    }

    if (messages.length > MESSAGE_DELETION_LIMITS.confirmationThreshold) {
      const operationId = randomUUID();
      prunePendingOperations();
      pendingOperations.set(operationId, {
        operationId,
        commandName,
        actorId: interaction.user.id,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        targetId,
        requestedCount: amount,
        messages,
        createdAt: Date.now(),
      });
      const targetText =
        definition.kind === "moderator"
          ? targetId === null
            ? " from this channel"
            : ` from <@${targetId}>`
          : " of your own";
      return interaction.editReply({
        content: `This will delete ${messages.length} eligible messages${targetText}. Confirm to continue; protected messages will be skipped.`,
        components: [confirmationRow(operationId)],
        allowedMentions: { parse: [] },
      });
    }

    const result = await executeOperation(
      {
        commandName,
        actorId: interaction.user.id,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        targetId,
        requestedCount: amount,
        messages,
      },
      { ...context, interaction, config },
    );
    return interaction.editReply({
      content: formatResult(result, definition.kind === "moderator", targetId),
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    return interaction.editReply({ content: userMessage(error), components: [] });
  }
}

async function handleConfirmationButton(interaction, context) {
  const match = interaction.customId.match(/^message-delete:(confirm|cancel):([0-9a-f-]{36})$/i);
  if (!match) {
    await interaction.reply({ content: "This deletion confirmation is invalid.", ephemeral: true });
    return;
  }

  const [, action, operationId] = match;
  const operation = pendingOperations.get(operationId);
  if (!operation || Date.now() - operation.createdAt > PENDING_TTL_MS) {
    pendingOperations.delete(operationId);
    await interaction.reply({ content: "This confirmation expired. Nothing was deleted.", ephemeral: true });
    return;
  }
  if (interaction.user.id !== operation.actorId) {
    await interaction.reply({ content: "Only the person who requested this deletion can confirm it.", ephemeral: true });
    return;
  }
  if (
    interaction.guildId !== operation.guildId ||
    interaction.channelId !== operation.channelId ||
    !interaction.inGuild?.()
  ) {
    await interaction.reply({ content: "This confirmation is only valid in its original server and channel.", ephemeral: true });
    return;
  }
  if (action === "cancel") {
    pendingOperations.delete(operationId);
    await interaction.update({
      content: "Deletion cancelled. Nothing was deleted.",
      components: [],
      allowedMentions: { parse: [] },
    });
    return;
  }
  if (operation.running) {
    await interaction.reply({ content: "This deletion is already being processed.", ephemeral: true });
    return;
  }

  operation.running = true;
  try {
    await interaction.deferUpdate();
    validateGuildChannel(interaction);
    const definition = COMMANDS[operation.commandName];
    const config = getGuildSettings(context.settings, interaction.guildId);
    validateRole(interaction.member, config, definition.roleField, operation.commandName);
    await requireBotDeletePermissions(interaction);
    if (
      definition.kind === "moderator" &&
      operation.targetId !== null &&
      operation.targetId !== operation.actorId
    ) {
      const targetMember = await fetchGuildMember(interaction.guild, operation.targetId);
      validateModeratorTarget(targetMember, config);
    }

    const result = await executeOperation(operation, { ...context, interaction, config });
    await interaction.editReply({
      content: formatResult(result, definition.kind === "moderator", operation.targetId),
      components: [],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await interaction.editReply({ content: userMessage(error), components: [] });
  } finally {
    pendingOperations.delete(operationId);
  }
}

async function executeOperation(operation, { moderationLogs, interaction }) {
  const isModeratorAction = operation.commandName === "mod-delete";
  let logId = null;

  if (isModeratorAction) {
    if (!moderationLogs || typeof moderationLogs.begin !== "function") {
      throw new UserFacingError("The private moderation log is unavailable. Nothing was deleted.");
    }
    logId = randomUUID();
    try {
      moderationLogs.begin({
        id: logId,
        action: "mod-delete",
        guildId: operation.guildId,
        channelId: operation.channelId,
        actorId: operation.actorId,
        targetId: operation.targetId,
        requestedCount: operation.requestedCount,
        selectedCount: operation.messages.length,
        messageIds: operation.messages.map((message) => message.id),
        status: "started",
      });
    } catch (error) {
      console.error("[message-deletion] private moderation log could not be written");
      throw new UserFacingError("The private moderation log could not be written. Nothing was deleted.");
    }
  }

  const result = await deleteEligibleMessages(operation.messages, operation.targetId);
  let auditLogWarning = false;
  if (isModeratorAction) {
    try {
      moderationLogs.finish(logId, {
        status: result.failedCount || result.deletedCount !== operation.messages.length ? "partial" : "completed",
        deletedCount: result.deletedCount,
        skippedCount: result.skippedCount,
        failedCount: result.failedCount,
        messageIds: result.deletedIds,
      });
    } catch {
      auditLogWarning = true;
      console.error("[message-deletion] private moderation log could not be finalized");
    }
  }

  return { ...result, auditLogWarning, requestedCount: operation.requestedCount };
}

async function deleteEligibleMessages(messages, targetId) {
  let deletedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  const deletedIds = [];

  for (const message of messages) {
    if (!isEligibleMessage(message, targetId)) {
      skippedCount += 1;
      continue;
    }
    try {
      await message.delete();
      deletedCount += 1;
      deletedIds.push(message.id);
    } catch (error) {
      if (isMissingMessageError(error)) {
        skippedCount += 1;
        continue;
      }
      failedCount += 1;
      console.error(`[message-deletion] failed to delete a message (${error?.code ?? "unknown error"})`);
      if (isPermissionError(error)) {
        skippedCount += messages.length - deletedCount - skippedCount - failedCount;
        break;
      }
    }
  }

  return { deletedCount, skippedCount, failedCount, deletedIds };
}

async function collectMessages(channel, targetId, amount, scanLimit) {
  const selected = [];
  const selectedIds = new Set();
  let scanned = 0;
  let before;

  try {
    while (selected.length < amount && scanned < scanLimit) {
      const limit = Math.min(100, scanLimit - scanned);
      const page = await channel.messages.fetch({ limit, ...(before ? { before } : {}) });
      const messages = [...page.values()].sort(compareNewestFirst);
      if (!messages.length) break;

      for (const message of messages) {
        if (!selectedIds.has(message.id) && isEligibleMessage(message, targetId)) {
          selected.push(message);
          selectedIds.add(message.id);
          if (selected.length >= amount) break;
        }
      }

      scanned += messages.length;
      const nextBefore = messages.at(-1)?.id;
      if (!nextBefore || nextBefore === before || messages.length < limit) break;
      before = nextBefore;
    }
  } catch {
    throw new UserFacingError("I could not read message history here. Check the bot's channel permissions and try again.");
  }

  return selected;
}

function compareNewestFirst(left, right) {
  try {
    const leftId = BigInt(left.id);
    const rightId = BigInt(right.id);
    return leftId > rightId ? -1 : leftId < rightId ? 1 : 0;
  } catch {
    return 0;
  }
}

function isEligibleMessage(message, targetId) {
  return Boolean(
    message &&
      !message.deleted &&
      typeof message.author?.id === "string" &&
      (targetId === null || message.author.id === targetId) &&
      !message.author?.bot &&
      !message.webhookId &&
      !message.system &&
      !message.pinned &&
      !(Array.isArray(message.components) && message.components.length) &&
      (message.type === undefined || message.type === MessageType.Default),
  );
}

function validateGuildChannel(interaction) {
  if (!interaction.inGuild?.() || !interaction.guildId || !interaction.channel) {
    throw new UserFacingError("These commands can only be used in a server text channel.");
  }
  if (typeof interaction.channel.messages?.fetch !== "function") {
    throw new UserFacingError("This channel does not support message deletion.");
  }
}

function getGuildSettings(settings, guildId) {
  if (!settings || typeof settings.get !== "function") {
    throw new UserFacingError("The server's deletion settings are unavailable.");
  }
  return settings.get(guildId);
}

function validateRole(member, config, field, commandName) {
  if (!field) return;
  const roleIds = Array.isArray(config?.[field]) ? config[field] : [];
  const label = field === "vipRoleIds" ? "VIP" : "moderator";
  if (!roleIds.length) {
    throw new UserFacingError(`No ${label} role IDs are configured in the dashboard.`);
  }
  if (!memberHasAnyRole(member, roleIds)) {
    throw new UserFacingError(`You need an authorized ${label} role to use /${commandName}.`);
  }
}

function memberHasAnyRole(member, roleIds) {
  const roleCache = member?.roles?.cache;
  const roleArray = Array.isArray(member?.roles) ? member.roles : [];
  return roleIds.some((id) => roleCache?.has?.(id) || roleArray.includes(id));
}

async function requireBotDeletePermissions(interaction) {
  const guild = interaction.guild;
  let botMember = guild?.members?.me;
  if (!botMember && typeof guild?.members?.fetchMe === "function") {
    try {
      botMember = await guild.members.fetchMe();
    } catch {
      botMember = null;
    }
  }
  const permissions = botMember ? interaction.channel.permissionsFor?.(botMember) : null;
  if (!permissions || REQUIRED_BOT_PERMISSIONS.some((permission) => !permissions.has(permission))) {
    throw new UserFacingError(
      "Sugar needs View Channel, Read Message History, and Manage Messages in this channel to delete messages.",
    );
  }
}

async function fetchGuildMember(guild, userId) {
  try {
    return await guild.members.fetch(userId);
  } catch {
    throw new UserFacingError("That member is not available in this server.");
  }
}

function validateModeratorTarget(member, config) {
  if (!member || member.user?.bot) {
    throw new UserFacingError("Moderators can only target human server members.");
  }
  const moderatorRoleIds = Array.isArray(config?.moderatorRoleIds) ? config.moderatorRoleIds : [];
  if (moderatorRoleIds.length && memberHasAnyRole(member, moderatorRoleIds)) {
    throw new UserFacingError("This command cannot target a member with an authorized moderator role.");
  }
}

function confirmationRow(operationId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CONFIRM_PREFIX}confirm:${operationId}`)
      .setLabel("Confirm deletion")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`${CONFIRM_PREFIX}cancel:${operationId}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary),
  );
}

function formatResult(result, moderatorAction, targetId) {
  const owner = moderatorAction ? (targetId === null ? "this channel" : `<@${targetId}>`) : "your own";
  const details = [`Deleted ${result.deletedCount} ${plural(result.deletedCount, "message")} from ${owner}.`];
  if (result.skippedCount) details.push(`${result.skippedCount} protected or unavailable ${plural(result.skippedCount, "message")} were skipped.`);
  if (result.failedCount) details.push(`${result.failedCount} ${plural(result.failedCount, "message")} could not be deleted; check the bot's permissions.`);
  if (result.auditLogWarning) details.push("The private audit entry remains marked as started and needs review.");
  return details.join(" ");
}

function plural(count, noun) {
  return count === 1 ? noun : `${noun}s`;
}

function userMessage(error) {
  if (error instanceof UserFacingError) return error.message;
  console.error(`[message-deletion] request failed (${error?.code ?? "unknown error"})`);
  return "Discord could not complete that deletion. Check the bot's permissions and try again.";
}

async function replyWithError(interaction, content) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content, components: [] });
    } else {
      await interaction.reply({ content, ephemeral: true });
    }
  } catch {
    // The interaction may already have expired; nothing else can be sent.
  }
}

function isMissingMessageError(error) {
  return String(error?.code) === "10008" || String(error?.code) === "UnknownMessage";
}

function isPermissionError(error) {
  return ["50001", "50013", "Missing Access", "Missing Permissions"].includes(
    String(error?.code ?? error?.message),
  );
}

function isDeletionInteraction(interaction) {
  return (
    (interaction.isChatInputCommand?.() && Object.hasOwn(COMMANDS, interaction.commandName)) ||
    (interaction.isButton?.() && interaction.customId?.startsWith(CONFIRM_PREFIX))
  );
}

class UserFacingError extends Error {}

function prunePendingOperations() {
  const expiredBefore = Date.now() - PENDING_TTL_MS;
  for (const [id, operation] of pendingOperations) {
    if (operation.createdAt < expiredBefore) pendingOperations.delete(id);
  }
}
