import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  Events,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
} from "discord.js";

import { MAX_PRIVATE_CHAT_MEMBERS } from "./private-chat-store.js";
import { buildMessageDeletionCommands } from "./message-deletion.js";
import { registerApplicationCommands } from "./command-registry.js";
import { formatEmbedTitle, toRoyalBold } from "./embed-format.js";
import { formatPrivateChatChannelName, normalizeCategoryName } from "./private-chat-format.js";

const PREFIX = "private-chat:";
const COMMAND_NAME = "priv-chat";
const GUIDE_TITLE = formatEmbedTitle("Create Private Chat");
const LEGACY_GUIDE_TITLE = "Create Private Chat 🎀";
const LEGACY_PRIVATE_CHAT_TITLE = "Private Chat Created 🎀";
const PRIVATE_CHAT_WELCOME_TITLES = new Set([
  formatEmbedTitle("Private Chat Created"),
  LEGACY_PRIVATE_CHAT_TITLE,
]);
const PRIVATE_CHAT_SETUP_TITLES = new Set([
  formatEmbedTitle("Private Chat Created"),
  formatEmbedTitle("Private Chat Commands"),
  LEGACY_PRIVATE_CHAT_TITLE,
]);
const PRIVATE_CHAT_PANEL_CONTROL_IDS = new Set([
  `${PREFIX}add`,
  `${PREFIX}remove`,
  `${PREFIX}rename`,
  `${PREFIX}leave`,
  `${PREFIX}delete`,
  `${PREFIX}commands`,
  `${PREFIX}clear-history`,
]);
const MEMBER_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AddReactions,
];

export function buildPrivateChatCommand() {
  return new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setDescription("Create and manage private chats")
    .addSubcommand((subcommand) => {
      subcommand
        .setName("create")
        .setDescription("Create a private chat")
        .addStringOption((option) =>
          option.setName("name").setDescription("Name shown in the private channel").setRequired(true).setMaxLength(40),
        );
      for (let index = 1; index <= MAX_PRIVATE_CHAT_MEMBERS; index += 1) {
        subcommand.addUserOption((option) =>
          option.setName(`invite_${index}`).setDescription(`Optional person ${index} to invite`),
        );
      }
      return subcommand;
    })
    .addSubcommand((subcommand) =>
      subcommand
        .setName("add")
        .setDescription("Invite someone to this private chat")
        .addUserOption((option) => option.setName("user").setDescription("Person to invite").setRequired(true)),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("remove")
        .setDescription("Remove someone from this private chat")
        .addUserOption((option) => option.setName("user").setDescription("Person to remove").setRequired(true)),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("rename")
        .setDescription("Rename this private chat")
        .addStringOption((option) =>
          option.setName("name").setDescription("New name for the chat").setRequired(true).setMaxLength(40),
        ),
    )
    .addSubcommand((subcommand) => subcommand.setName("delete").setDescription("Permanently delete this private chat"))
    .addSubcommand((subcommand) => subcommand.setName("leave").setDescription("Leave a private chat"))
    .addSubcommand((subcommand) => subcommand.setName("commands").setDescription("Show private-chat instructions"))
    .toJSON();
}

export function buildPrivateChatPermissionOverwrites({ everyoneId, ownerId, memberIds, botId }) {
  return [
    // Explicit overwrites prevent the channel from syncing any category access.
    { id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] },
    { id: ownerId, allow: MEMBER_PERMISSIONS },
    ...memberIds.map((id) => ({ id, allow: MEMBER_PERMISSIONS })),
    {
      id: botId,
      allow: [...MEMBER_PERMISSIONS, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages],
    },
  ];
}

/**
 * Attach private-chat interactions to the existing bot client.
 *
 * @param {import("discord.js").Client} client
 * @param {{token: string, applicationId: string, store: import("./private-chat-store.js").PrivateChatStore, lobbyChannelId: string}} options
 */
export function attachPrivateChatSystem(client, { token, applicationId, store, lobbyChannelId }) {
  if (!store) throw new Error("A private-chat store is required.");

  let readyHandled = false;
  client.once(Events.ClientReady, () => {
    readyHandled = true;
    void initializePrivateChatLobby(client, { token, applicationId, store, lobbyChannelId }).catch((error) => {
      console.error(`[private-chats] setup failed: ${error.message}`);
    });
  });

  client.on(Events.GuildCreate, (guild) => {
    if (!readyHandled) return;
    void registerApplicationCommands({
      token,
      applicationId,
      guildId: guild.id,
      commands: buildMessageDeletionCommands(),
      removeCommandNames: ["show-hide"],
    }).catch((error) => {
      console.error(`[commands] could not register guild commands in ${guild.id}: ${error.message}`);
    });
  });

  client.on(Events.ChannelDelete, (channel) => {
    try {
      store.delete(channel.id);
    } catch (error) {
      console.error(`[private-chats] could not remove deleted channel metadata: ${error.message}`);
    }
  });

  client.on(Events.InteractionCreate, (interaction) => {
    if (!isPrivateChatInteraction(interaction)) return;
    void handlePrivateChatInteraction(interaction, { client, store, lobbyChannelId }).catch(async (error) => {
      console.error(`[private-chats] interaction failed in ${interaction.channelId ?? "unknown channel"}: ${error.message}`);
      await sendEphemeral(interaction, error.message || "The private-chat action failed. Please try again.");
    });
  });
}

async function initializePrivateChatLobby(client, { token, applicationId, store, lobbyChannelId }) {
  let lobby = null;
  let lobbyError = null;
  try {
    lobby = await client.channels.fetch(lobbyChannelId);
  } catch (error) {
    lobbyError = error;
  }

  const guildIds = new Set(client.guilds.cache.keys());
  if (lobby?.guildId) guildIds.add(lobby.guildId);
  for (const guildId of guildIds) {
    const commands = [...buildMessageDeletionCommands()];
    if (lobby?.type === ChannelType.GuildText && guildId === lobby.guildId) {
      commands.unshift(buildPrivateChatCommand());
    }
    try {
      await registerApplicationCommands({
        token,
        applicationId,
        guildId,
        commands,
        removeCommandNames: ["show-hide"],
      });
      console.log(`[commands] registered in server ${guildId}`);
    } catch (error) {
      console.error(`[commands] registration failed in ${guildId}: ${error.message}`);
    }
  }

  if (!lobby || lobby.type !== ChannelType.GuildText) {
    throw new Error(
      `The configured private-chat lobby ${lobbyChannelId} is not an available server text channel` +
        (lobbyError ? ` (${lobbyError.code ?? "fetch failed"})` : "."),
    );
  }

  try {
    await ensureLobbyGuide(lobby, client, store);
  } catch (error) {
    console.error(`[private-chats] could not ensure the lobby guide: ${error.message}`);
  }

  try {
    await ensurePrivateChatPanels(client, store, lobby.guildId);
  } catch (error) {
    console.error(`[private-chats] could not update existing private-chat panels: ${error.message}`);
  }
}

async function ensureLobbyGuide(lobby, client, store) {
  let guide = null;
  const savedMessageId = store.getLobbyGuideMessageId(lobby.id);

  if (savedMessageId) {
    try {
      guide = await lobby.messages.fetch(savedMessageId);
    } catch (error) {
      if (error?.code !== 10008 && error?.code !== 10003) throw error;
    }
  }

  if (!guide) {
    const recentMessages = await lobby.messages.fetch({ limit: 50 });
    guide = recentMessages.find(
      (message) =>
        message.author.id === client.user.id &&
        message.embeds.some((embed) => [GUIDE_TITLE, LEGACY_GUIDE_TITLE].includes(embed.title)),
    );
  }

  if (guide) {
    await guide.edit(buildPrivateChatLobbyGuidePayload());
  } else {
    guide = await lobby.send(buildPrivateChatLobbyGuidePayload());
  }

  store.setLobbyGuideMessageId(lobby.id, guide.id);
  if (!guide.pinned) {
    try {
      await guide.pin();
    } catch (error) {
      console.error(`[private-chats] guide was posted but could not be pinned: ${error.message}`);
    }
  }
}

export async function ensurePrivateChatPanels(client, store, guildId) {
  for (const chat of store.listGuild(guildId)) {
    try {
      if (store.isClearHistoryPanelReady(chat.channelId)) continue;
      const channel = await client.channels.fetch(chat.channelId);
      if (!channel || channel.type !== ChannelType.GuildText) continue;

      let protectedMessageIds = store.getProtectedMessageIds(chat.channelId);
      if (protectedMessageIds === null) {
        protectedMessageIds = await findProtectedSetupMessageIds(channel, client.user.id);
        if (protectedMessageIds.length) {
          store.setProtectedMessageIds(chat.channelId, protectedMessageIds);
        }
      }

      for (const messageId of protectedMessageIds ?? []) {
        let message;
        try {
          message = await channel.messages.fetch(messageId);
        } catch (error) {
          if (error?.code === 10008 || error?.code === 10003) continue;
          throw error;
        }

        if (!isPrivateChatWelcomePanelMessage(message, client.user.id)) continue;
        if (!messageHasPrivateChatButton(message, `${PREFIX}clear-history`)) {
          const payload = buildPrivateChatWelcomePayload(
            chat.ownerId,
            chat.memberIds.map((id) => ({ id })),
          );
          await message.edit({ components: payload.components, allowedMentions: { parse: [] } });
        }
        store.markClearHistoryPanelReady(chat.channelId);
        break;
      }
    } catch (error) {
      console.error(`[private-chats] could not update the panel in ${chat.channelId}: ${error.message}`);
    }
  }
}

export function buildPrivateChatLobbyGuidePayload() {
  const embed = new EmbedBuilder()
    .setColor(0xf472b6)
    .setTitle(GUIDE_TITLE)
    .setDescription(
      [
        "A private space for you and the people you invite. Chat with friends or bots, make a list, or use it however you like.",
        "",
        "• Use a button to create a private chat, or run `/priv-chat create` and provide a name. You can optionally invite up to five people.",
        "",
        toRoyalBold("Name format"),
        "`👤｜୨୧•your-text`",
        "",
        "Instructions inside the chat are available from the **Commands** button or `/priv-chat commands`.",
      ].join("\n"),
    );

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}create`).setLabel("Create private chat").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${PREFIX}commands`).setLabel("Commands").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [buttons] };
}

export function buildPrivateChatWelcomePayload(ownerId, invitees = []) {
  const memberIds = invitees.map((user) => user.id);
  const userIds = [ownerId, ...memberIds];
  const mentions = userIds.map((id) => `<@${id}>`);
  const welcomeList = mentions.length > 2
    ? `${mentions.slice(0, -1).join(", ")} and ${mentions.at(-1)}`
    : mentions.join(" and ");
  const welcome = `Welcome ${welcomeList}.`;
  const embed = new EmbedBuilder()
    .setColor(0xf472b6)
    .setTitle(formatEmbedTitle("Private Chat Created"))
    .setDescription(`Your private chat is ready!\n\n${welcome}`);

  const firstRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}add`).setLabel("Add people").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${PREFIX}remove`).setLabel("Remove someone").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${PREFIX}rename`).setLabel("Rename chat").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${PREFIX}leave`).setLabel("Leave chat").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${PREFIX}delete`).setLabel("Delete chat").setStyle(ButtonStyle.Danger),
  );
  const secondRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}commands`).setLabel("Commands").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${PREFIX}clear-history`).setLabel("Clear History").setStyle(ButtonStyle.Danger),
  );
  return {
    embeds: [embed],
    components: [firstRow, secondRow],
    allowedMentions: { parse: [], users: userIds },
  };
}

export function buildPrivateChatCommandsPayload() {
  const embed = new EmbedBuilder()
    .setColor(0xf472b6)
    .setTitle(formatEmbedTitle("Private Chat Commands"))
    .setDescription("Use these commands inside this private channel")
    .addFields(
      {
        name: toRoyalBold("Create"),
        value: [
          "`/priv-chat create name:<name>` — Create a private chat.",
          "Optional invite options: `invite_1` through `invite_5`.",
        ].join("\n"),
      },
      {
        name: toRoyalBold("Membership"),
        value: [
          "`/priv-chat add user:<user>` — Invite a server member. The owner only.",
          "`/priv-chat remove user:<user>` — Remove an invitee. The owner only.",
        ].join("\n"),
      },
      {
        name: toRoyalBold("Chat"),
        value: [
          "`/priv-chat rename name:<name>` — Rename the channel. The owner only.",
          "`/priv-chat leave` — Leave the private chat. The owner cannot leave.",
          "`/priv-chat delete` — Permanently delete the channel and its messages. The owner must confirm.",
        ].join("\n"),
      },
      {
        name: toRoyalBold("Help"),
        value: "`/priv-chat commands` — Show the command guide.",
      },
    );

  return { embeds: [embed] };
}

function helpMessage() {
  return [
    "**Private Chat Commands**",
    "`/priv-chat create name:<name>` — create a private channel; optionally add up to five people.",
    "`/priv-chat add user:<person>` — invite someone. The owner only.",
    "`/priv-chat remove user:<person>` — remove an invitee. The owner only.",
    "`/priv-chat rename name:<name>` — rename the chat. The owner only.",
    "`/priv-chat delete` — permanently delete this channel and its messages. The owner must confirm.",
    "`/priv-chat leave` — remove your own access. The owner cannot leave their chat.",
    "`/priv-chat commands` — show this guide.",
    "",
    "You can also use the buttons in the private-chat panel.",
  ].join("\n");
}

function isPrivateChatInteraction(interaction) {
  return (
    (interaction.isChatInputCommand() && interaction.commandName === COMMAND_NAME) ||
    (interaction.isButton() && interaction.customId.startsWith(PREFIX)) ||
    (interaction.isUserSelectMenu() && interaction.customId.startsWith(PREFIX)) ||
    (interaction.isModalSubmit() && interaction.customId.startsWith(PREFIX))
  );
}

export async function handlePrivateChatInteraction(interaction, { client, store, lobbyChannelId }) {
  if (interaction.isChatInputCommand()) {
    await handleSlashCommand(interaction, { client, store, lobbyChannelId });
  } else if (interaction.isButton()) {
    await handleButton(interaction, { client, store, lobbyChannelId });
  } else if (interaction.isUserSelectMenu()) {
    await handleUserSelect(interaction, { client, store });
  } else if (interaction.isModalSubmit()) {
    await handleModalSubmit(interaction, { client, store, lobbyChannelId });
  }
}

async function handleSlashCommand(interaction, { client, store, lobbyChannelId }) {
  await interaction.deferReply({ ephemeral: true });
  if (!interaction.inGuild()) {
    return interaction.editReply("Private chats can only be managed inside the server.");
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "commands") return interaction.editReply(helpMessage());

  if (subcommand === "create") {
    if (interaction.channelId !== lobbyChannelId) {
      return interaction.editReply(`Create private chats in <#${lobbyChannelId}>.`);
    }

    const displayName = interaction.options.getString("name", true);
    const invitees = [];
    for (let index = 1; index <= MAX_PRIVATE_CHAT_MEMBERS; index += 1) {
      const user = interaction.options.getUser(`invite_${index}`);
      if (user) invitees.push(user);
    }
    const channel = await createPrivateChat(interaction, client, store, displayName, invitees);
    return interaction.editReply(`Private chat created:\n<#${channel.id}>`);
  }

  const context = getPrivateChatContext(interaction, store);

  if (subcommand === "leave") {
    if (interaction.user.id === context.chat.ownerId) {
      return interaction.editReply("The owner cannot leave their private chat. Use `/priv-chat delete` to remove it.");
    }
    await removeChatMembers(context.channel, context.chat, [interaction.user.id], store);
    return interaction.editReply("You no longer have access to this private chat.");
  }

  requireOwner(interaction, context.chat);

  if (subcommand === "add") {
    const user = interaction.options.getUser("user", true);
    await addChatMembers(context.channel, context.chat, [user.id], store, client);
    return interaction.editReply(`<@${user.id}> can now access this private chat.`);
  }

  if (subcommand === "remove") {
    const user = interaction.options.getUser("user", true);
    await removeChatMembers(context.channel, context.chat, [user.id], store);
    return interaction.editReply(`<@${user.id}> was removed from this private chat.`);
  }

  if (subcommand === "rename") {
    const displayName = interaction.options.getString("name", true);
    await renamePrivateChat(context.channel, context.chat, displayName, store);
    return interaction.editReply(`Private chat renamed to **${displayName.trim()}**.`);
  }

  if (subcommand === "delete") {
    return interaction.editReply({
      content: "This permanently deletes the channel and all its messages. Continue?",
      components: [deleteConfirmationRow()],
    });
  }

  return interaction.editReply("Unknown private-chat command.");
}

async function handleButton(interaction, { client, store, lobbyChannelId }) {
  const action = interaction.customId.slice(PREFIX.length);

  if (action === "commands") return sendEphemeral(interaction, helpMessage());

  if (action === "create") {
    if (interaction.channelId !== lobbyChannelId) {
      return sendEphemeral(interaction, `Create private chats in <#${lobbyChannelId}>.`);
    }
    return interaction.showModal(nameModal("create-modal", "Create Private Chat", ""));
  }

  if (action === "delete-cancel") {
    return interaction.update({ content: "Deletion cancelled.", components: [], embeds: [] });
  }

  if (action === "clear-history-cancel") {
    return interaction.update({ content: "History clearing cancelled.", components: [] });
  }

  if (action === "delete-confirm") {
    const context = getPrivateChatContext(interaction, store);
    requireOwner(interaction, context.chat);
    await interaction.deferUpdate();
    await context.channel.delete(`Private chat deleted by owner ${interaction.user.id}`);
    store.delete(context.channel.id);
    return interaction.followUp({ content: "Private chat deleted.", ephemeral: true });
  }

  if (action === "clear-history-confirm") {
    const context = getPrivateChatContext(interaction, store);
    requireOwner(interaction, context.chat);
    await interaction.deferUpdate();
    const deletedCount = await clearPrivateChatHistory(context.channel, store, client.user);
    const summary =
      deletedCount === 1 ? "1 conversation message was cleared." : `${deletedCount} conversation messages were cleared.`;
    return interaction.followUp({
      content: `${summary} The welcome and command guide were kept.`,
      ephemeral: true,
    });
  }

  const context = getPrivateChatContext(interaction, store);

  if (action === "clear-history") {
    requireOwner(interaction, context.chat);
    return sendEphemeral(
      interaction,
      "Clear regular conversation messages from this channel? The welcome and command guide will be kept.",
      [clearHistoryConfirmationRow()],
    );
  }

  if (action === "add") {
    requireOwner(interaction, context.chat);
    const slots = MAX_PRIVATE_CHAT_MEMBERS - context.chat.memberIds.length;
    if (slots < 1) return sendEphemeral(interaction, "This chat already has five invited people.");
    const menu = new UserSelectMenuBuilder()
      .setCustomId(`${PREFIX}add-select`)
      .setPlaceholder("Choose people to invite")
      .setMinValues(1)
      .setMaxValues(slots);
    const row = new ActionRowBuilder().addComponents(menu);
    return sendEphemeral(interaction, "Choose up to five people. The chat limit is five invitees total.", [row]);
  }

  if (action === "remove") {
    requireOwner(interaction, context.chat);
    if (!context.chat.memberIds.length) return sendEphemeral(interaction, "No one has been invited to this chat yet.");
    const menu = new UserSelectMenuBuilder()
      .setCustomId(`${PREFIX}remove-select`)
      .setPlaceholder("Choose someone to remove")
      .setMinValues(1)
      .setMaxValues(Math.min(MAX_PRIVATE_CHAT_MEMBERS, context.chat.memberIds.length));
    return sendEphemeral(interaction, "Choose one or more invited people to remove.", [
      new ActionRowBuilder().addComponents(menu),
    ]);
  }

  if (action === "rename") {
    requireOwner(interaction, context.chat);
    return interaction.showModal(nameModal("rename-modal", "Rename Private Chat", context.chat.displayName));
  }

  if (action === "leave") {
    if (interaction.user.id === context.chat.ownerId) {
      return sendEphemeral(interaction, "The owner cannot leave their private chat. Use the delete button to remove it.");
    }
    await interaction.deferReply({ ephemeral: true });
    await removeChatMembers(context.channel, context.chat, [interaction.user.id], store);
    return interaction.editReply("You no longer have access to this private chat.");
  }

  if (action === "delete") {
    requireOwner(interaction, context.chat);
    return sendEphemeral(
      interaction,
      "This permanently deletes the channel and all its messages. Continue?",
      [deleteConfirmationRow()],
    );
  }
}

async function handleUserSelect(interaction, { client, store }) {
  await interaction.deferReply({ ephemeral: true });
  const context = getPrivateChatContext(interaction, store);
  requireOwner(interaction, context.chat);
  const ids = interaction.values;

  if (interaction.customId === `${PREFIX}add-select`) {
    await addChatMembers(context.channel, context.chat, ids, store, client);
    return interaction.editReply(`Added ${ids.map((id) => `<@${id}>`).join(", ")} to this private chat.`);
  }

  if (interaction.customId === `${PREFIX}remove-select`) {
    await removeChatMembers(context.channel, context.chat, ids, store);
    return interaction.editReply(`Removed ${ids.map((id) => `<@${id}>`).join(", ")} from this private chat.`);
  }
}

async function handleModalSubmit(interaction, { client, store, lobbyChannelId }) {
  await interaction.deferReply({ ephemeral: true });
  const displayName = interaction.fields.getTextInputValue("name");

  if (interaction.customId === `${PREFIX}create-modal`) {
    if (!interaction.inGuild() || interaction.channelId !== lobbyChannelId) {
      return interaction.editReply(`Create private chats in <#${lobbyChannelId}>.`);
    }
    const channel = await createPrivateChat(interaction, client, store, displayName, []);
    return interaction.editReply(`Private chat created:\n<#${channel.id}>`);
  }

  if (interaction.customId === `${PREFIX}rename-modal`) {
    const context = getPrivateChatContext(interaction, store);
    requireOwner(interaction, context.chat);
    await renamePrivateChat(context.channel, context.chat, displayName, store);
    return interaction.editReply(`Private chat renamed to **${displayName.trim()}**.`);
  }
}

function nameModal(customId, title, value) {
  const input = new TextInputBuilder()
    .setCustomId("name")
    .setLabel("Chat name")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(40);
  if (value) input.setValue(value);

  return new ModalBuilder()
    .setCustomId(`${PREFIX}${customId}`)
    .setTitle(title)
    .addComponents(new ActionRowBuilder().addComponents(input));
}

function deleteConfirmationRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}delete-confirm`).setLabel("Delete chat").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`${PREFIX}delete-cancel`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
  );
}

function clearHistoryConfirmationRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}clear-history-confirm`)
      .setLabel("Confirm clear")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}clear-history-cancel`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary),
  );
}

/**
 * Delete ordinary channel messages while preserving the bot's initial private-chat setup messages.
 * Persisted message IDs make the protection survive restarts; older chats are indexed from history once.
 */
export async function clearPrivateChatHistory(channel, store, botUser) {
  const permissions = channel.permissionsFor?.(botUser);
  if (!permissions?.has(PermissionFlagsBits.ManageMessages)) {
    throw new Error("Sugar needs Manage Messages permission in this private channel to clear history.");
  }

  let protectedMessageIds = store.getProtectedMessageIds(channel.id);
  if (protectedMessageIds === null) {
    protectedMessageIds = await findProtectedSetupMessageIds(channel, botUser.id);
    store.setProtectedMessageIds(channel.id, protectedMessageIds);
  }
  const protectedIds = new Set(protectedMessageIds);
  let deletedCount = 0;
  let before;

  // Delete one at a time: bulk deletion can include protected messages and cannot remove older messages.
  while (true) {
    const page = await fetchMessagePage(channel, before);
    if (!page.length) break;

    for (const message of page) {
      if (protectedIds.has(message.id)) continue;
      try {
        await message.delete("Private chat owner cleared conversation history");
        deletedCount += 1;
      } catch (error) {
        if (String(error?.code) === "10008") continue;
        throw new Error(
          "Could not clear all conversation messages. Some may already be deleted; verify Sugar has Manage Messages permission and try again.",
        );
      }
    }

    const oldestId = getOldestMessageId(page);
    if (page.length < 100) break;
    if (!oldestId || oldestId === before) {
      throw new Error("Could not safely continue through this channel's message history.");
    }
    before = oldestId;
  }

  return deletedCount;
}

async function findProtectedSetupMessageIds(channel, botUserId) {
  const protectedMessageIds = new Set();
  let before;

  while (true) {
    const page = await fetchMessagePage(channel, before);
    if (!page.length) break;

    for (const message of page) {
      if (isPrivateChatSetupMessage(message, botUserId)) protectedMessageIds.add(message.id);
    }

    const oldestId = getOldestMessageId(page);
    if (page.length < 100) break;
    if (!oldestId || oldestId === before) {
      throw new Error("Could not safely locate the private-chat setup messages.");
    }
    before = oldestId;
  }

  return [...protectedMessageIds].sort((first, second) => (BigInt(first) < BigInt(second) ? -1 : 1));
}

async function fetchMessagePage(channel, before) {
  const options = before ? { limit: 100, before } : { limit: 100 };
  const messages = await channel.messages.fetch(options);
  return [...messages.values()];
}

function getOldestMessageId(messages) {
  if (!messages.length) return null;
  return messages.reduce(
    (oldest, message) => (BigInt(message.id) < BigInt(oldest) ? message.id : oldest),
    messages[0].id,
  );
}

function isPrivateChatSetupMessage(message, botUserId) {
  if (message.author?.id !== botUserId) return false;
  if (message.embeds?.some((embed) => PRIVATE_CHAT_SETUP_TITLES.has(embed.title))) return true;
  return messageHasPrivateChatButton(message);
}

function isPrivateChatWelcomePanelMessage(message, botUserId) {
  if (message.author?.id !== botUserId) return false;
  return (
    message.embeds?.some((embed) => PRIVATE_CHAT_WELCOME_TITLES.has(embed.title)) ||
    messageHasPrivateChatButton(message)
  );
}

function messageHasPrivateChatButton(message, targetCustomId) {
  return (
    message.components?.some((row) =>
      row.components?.some((component) => {
        const customId = component.customId ?? component.custom_id ?? component.data?.custom_id;
        return targetCustomId ? customId === targetCustomId : PRIVATE_CHAT_PANEL_CONTROL_IDS.has(customId);
      }),
    ) ?? false
  );
}

export async function createPrivateChat(interaction, client, store, displayName, invitees) {
  const channelName = formatPrivateChatChannelName(displayName);
  const inviteeIds = invitees.map((user) => user.id);
  if (new Set(inviteeIds).size !== inviteeIds.length) {
    throw new Error("The same person was selected more than once.");
  }
  if (inviteeIds.includes(interaction.user.id)) {
    throw new Error("You own this chat already and do not need to invite yourself.");
  }
  if (inviteeIds.length > MAX_PRIVATE_CHAT_MEMBERS) {
    throw new Error(`A private chat can have at most ${MAX_PRIVATE_CHAT_MEMBERS} invited people.`);
  }
  if (inviteeIds.includes(client.user.id)) {
    throw new Error("Sugar AI already has access to chats it creates.");
  }

  const guild = interaction.guild;
  if (!guild) throw new Error("Private chats can only be created inside the server.");
  await fetchGuildMembers(guild, inviteeIds);
  const category = await findGeneralCategory(guild);
  const permissionOverwrites = buildPrivateChatPermissionOverwrites({
    everyoneId: guild.roles.everyone.id,
    ownerId: interaction.user.id,
    memberIds: inviteeIds,
    botId: client.user.id,
  });

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites,
    reason: "Private chat created by its owner",
  });

  try {
    store.create({
      channelId: channel.id,
      guildId: guild.id,
      ownerId: interaction.user.id,
      memberIds: inviteeIds,
      displayName,
    });
  } catch (error) {
    try {
      await channel.delete("Rollback after saving private-chat metadata failed");
    } catch (rollbackError) {
      console.error(`[private-chats] could not roll back ${channel.id}: ${rollbackError.message}`);
    }
    throw new Error("The channel was created, but its owner data could not be saved. Ask an admin to check the bot storage.");
  }

  const creationMessages = [
    ["welcome", buildPrivateChatWelcomePayload(interaction.user.id, invitees)],
    ["command guide", buildPrivateChatCommandsPayload()],
  ];
  const protectedMessageIds = [];
  let setupMessagesComplete = true;
  for (const [label, payload] of creationMessages) {
    try {
      const message = await channel.send(payload);
      if (message?.id) protectedMessageIds.push(message.id);
      else setupMessagesComplete = false;
    } catch (error) {
      setupMessagesComplete = false;
      console.error(
        `[private-chats] chat ${channel.id} was created but its ${label} could not be posted: ${error.message}`,
      );
    }
  }
  if (setupMessagesComplete && protectedMessageIds.length === creationMessages.length) {
    try {
      store.setProtectedMessageIds(channel.id, protectedMessageIds);
      store.markClearHistoryPanelReady(channel.id);
    } catch (error) {
      console.error(`[private-chats] setup-message IDs for ${channel.id} could not be saved: ${error.message}`);
    }
  }
  return channel;
}

async function findGeneralCategory(guild) {
  let categories = findGeneralCategories(guild);
  if (!categories.length) {
    await guild.channels.fetch();
    categories = findGeneralCategories(guild);
  }
  if (categories.length !== 1) {
    throw new Error(
      categories.length
        ? "There is more than one category named General. Rename the duplicates so private chats have one destination."
        : "I could not find the General category. Create it first, then try again.",
    );
  }
  return categories[0];
}

function findGeneralCategories(guild) {
  return [...guild.channels.cache.values()].filter(
    (channel) =>
      channel.type === ChannelType.GuildCategory &&
      normalizeCategoryName(channel.name) === "general",
  );
}

async function fetchGuildMembers(guild, userIds) {
  try {
    return await Promise.all(userIds.map((id) => guild.members.fetch(id)));
  } catch {
    throw new Error("Every invite must be a member of this server.");
  }
}

export async function addChatMembers(channel, chat, userIds, store, client) {
  const ids = validateMemberIds(chat, userIds, true);
  await fetchGuildMembers(channel.guild, ids);
  if (ids.includes(client.user.id)) throw new Error("Sugar AI already has access to chats it creates.");
  if (ids.some((id) => channel.permissionOverwrites.cache.has(id))) {
    throw new Error("A selected person already has a channel-specific override. Ask an admin to review it first.");
  }

  store.addMembers(channel.id, ids);
  const added = [];
  try {
    for (const id of ids) {
      await channel.permissionOverwrites.edit(id, memberPermissionOptions(), {
        reason: "Private chat owner invited a member",
      });
      added.push(id);
    }
  } catch {
    for (const id of added) {
      try {
        await channel.permissionOverwrites.delete(id, "Rollback after failed private-chat invite");
      } catch (rollbackError) {
        console.error(`[private-chats] could not roll back invite for ${id}: ${rollbackError.message}`);
      }
    }
    try {
      store.removeMembers(channel.id, ids);
    } catch (rollbackError) {
      console.error(`[private-chats] could not roll back invite metadata for ${channel.id}: ${rollbackError.message}`);
    }
    throw new Error("Discord could not grant access. No invite was saved; try again or contact an admin.");
  }

  const mentions = ids.map((id) => `<@${id}>`).join(", ");
  const subjectVerb = ids.length === 1 ? "was added" : "were added";
  try {
    await sendPrivateChatActivity(channel, `${mentions} ${subjectVerb} to this private chat.`, ids);
  } catch (error) {
    console.error(`[private-chats] could not post the add notice in ${channel.id}: ${error.message}`);
  }
}

export async function removeChatMembers(channel, chat, userIds, store) {
  const ids = validateMemberIds(chat, userIds, false);
  const mentions = ids.map((id) => `<@${id}>`).join(", ");
  const verb = ids.length === 1 ? "is" : "are";
  try {
    await sendPrivateChatActivity(channel, `${mentions} ${verb} being removed from this private chat.`, ids);
  } catch (error) {
    console.error(`[private-chats] could not post the removal notice in ${channel.id}: ${error.message}`);
    throw new Error("The removal notice could not be posted, so channel access was not changed.");
  }

  const removedOverwrites = [];
  try {
    for (const id of ids) {
      if (channel.permissionOverwrites.cache.has(id)) {
        await channel.permissionOverwrites.delete(id, "Private chat owner removed a member");
        removedOverwrites.push(id);
      }
    }
    store.removeMembers(channel.id, ids);
  } catch (error) {
    for (const id of removedOverwrites) {
      try {
        await channel.permissionOverwrites.edit(id, memberPermissionOptions(), {
          reason: "Rollback after failed private-chat removal",
        });
      } catch (rollbackError) {
        console.error(`[private-chats] could not restore access for ${id}: ${rollbackError.message}`);
      }
    }
    throw error;
  }
}

function validateMemberIds(chat, userIds, adding) {
  if (!Array.isArray(userIds) || !userIds.length) throw new Error("Select at least one person.");
  if (new Set(userIds).size !== userIds.length) throw new Error("The same person was selected more than once.");
  if (userIds.includes(chat.ownerId)) throw new Error("The chat owner cannot be added or removed.");
  if (adding) {
    if (userIds.some((id) => chat.memberIds.includes(id))) {
      throw new Error("One or more selected people are already in this private chat.");
    }
    if (chat.memberIds.length + userIds.length > MAX_PRIVATE_CHAT_MEMBERS) {
      throw new Error(`A private chat can have at most ${MAX_PRIVATE_CHAT_MEMBERS} invited people.`);
    }
  } else if (userIds.some((id) => !chat.memberIds.includes(id))) {
    throw new Error("One or more selected people are not invited to this private chat.");
  }
  return userIds;
}

function memberPermissionOptions() {
  return {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
    AttachFiles: true,
    EmbedLinks: true,
    AddReactions: true,
  };
}

export async function renamePrivateChat(channel, chat, displayName, store) {
  const nextChannelName = formatPrivateChatChannelName(displayName);
  const updated = store.rename(channel.id, displayName);
  try {
    await channel.setName(nextChannelName, "Private chat owner renamed the channel");
  } catch {
    try {
      store.rename(channel.id, chat.displayName);
    } catch (rollbackError) {
      console.error(`[private-chats] could not restore rename metadata for ${channel.id}: ${rollbackError.message}`);
    }
    throw new Error("Discord could not rename this channel. The previous name was kept.");
  }
  try {
    await sendPrivateChatActivity(channel, `This private chat is now named ${nextChannelName}.`);
  } catch (error) {
    console.error(`[private-chats] could not post the rename notice in ${channel.id}: ${error.message}`);
  }
  return updated;
}

async function sendPrivateChatActivity(channel, content, userIds = []) {
  return channel.send({
    content,
    allowedMentions: {
      parse: [],
      ...(userIds.length ? { users: userIds } : {}),
    },
  });
}

function getPrivateChatContext(interaction, store) {
  if (!interaction.inGuild() || !interaction.channel || interaction.channel.type !== ChannelType.GuildText) {
    throw new Error("Use this command inside a private-chat channel.");
  }
  const chat = store.get(interaction.channelId);
  if (!chat || chat.guildId !== interaction.guildId) {
    throw new Error("This is not a registered private-chat channel.");
  }
  return { chat, channel: interaction.channel };
}

function requireOwner(interaction, chat) {
  if (interaction.user.id !== chat.ownerId) {
    throw new Error("Only the person who created this private chat can manage it.");
  }
}

async function sendEphemeral(interaction, content, components = []) {
  const payload = { content, components, ephemeral: true };
  if (interaction.deferred) {
    return interaction.editReply({ content, components, embeds: [] });
  }
  if (interaction.replied) return interaction.followUp(payload);
  return interaction.reply(payload);
}
