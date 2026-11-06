import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  Events,
  ModalBuilder,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
} from "discord.js";

import { MAX_PRIVATE_CHAT_MEMBERS } from "./private-chat-store.js";
import { formatPrivateChatChannelName, normalizeCategoryName } from "./private-chat-format.js";

const PREFIX = "private-chat:";
const COMMAND_NAME = "priv-chat";
const GUIDE_TITLE = "Create Private Chat 🎀";
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
    .addSubcommand((subcommand) => subcommand.setName("commands").setDescription("Show private-chat commands"))
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
      allow: [...MEMBER_PERMISSIONS, PermissionFlagsBits.ManageChannels],
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

  client.once(Events.ClientReady, () => {
    void initializePrivateChatLobby(client, { token, applicationId, store, lobbyChannelId }).catch((error) => {
      console.error(`[private-chats] setup failed: ${error.message}`);
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
  const lobby = await client.channels.fetch(lobbyChannelId);
  if (!lobby || lobby.type !== ChannelType.GuildText) {
    throw new Error(`The configured private-chat lobby ${lobbyChannelId} is not a server text channel.`);
  }

  try {
    await registerPrivateChatCommand({ token, applicationId, guildId: lobby.guildId });
    console.log(`[private-chats] /${COMMAND_NAME} registered for the lobby server`);
  } catch (error) {
    console.error(`[private-chats] slash-command registration failed: ${error.message}`);
  }

  try {
    await ensureLobbyGuide(lobby, client, store);
  } catch (error) {
    console.error(`[private-chats] could not ensure the lobby guide: ${error.message}`);
  }
}

async function registerPrivateChatCommand({ token, applicationId, guildId }) {
  if (!token || !applicationId || !guildId) {
    throw new Error("The bot token, application ID, and lobby server ID are required.");
  }

  const rest = new REST({ version: "10" }).setToken(token);
  const route = Routes.applicationGuildCommands(applicationId, guildId);
  const existing = await rest.get(route);
  if (!Array.isArray(existing)) throw new Error("Discord returned an invalid guild-command list.");

  // Guild command registration replaces the full list, so preserve commands
  // owned by this application that are unrelated to private chats.
  const commands = existing.filter((command) => command.name !== COMMAND_NAME);
  commands.push(buildPrivateChatCommand());
  if (commands.length > 100) throw new Error("The server command limit would be exceeded.");
  await rest.put(route, { body: commands });
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
        message.embeds.some((embed) => embed.title === GUIDE_TITLE),
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

export function buildPrivateChatLobbyGuidePayload() {
  const embed = new EmbedBuilder()
    .setColor(0xf472b6)
    .setTitle(GUIDE_TITLE)
    .setDescription(
      [
        "A private space for you and the people you invite. Chat with friends or bots, make a list, or use it however you like.",
        "",
        "**Create a private chat**",
        "Use the button below, or run `/priv-chat create` and provide a name. You can optionally invite up to five people.",
        "",
        "**Name format**",
        "`👤｜9e—your-text—9e°♡`",
        "",
        "Use the **Commands** button or `/priv-chat commands` for instructions.",
        "Server administrators with the **Administrator** permission can still access private channels.",
      ].join("\n"),
    );

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}create`).setLabel("Create private chat").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${PREFIX}commands`).setLabel("Commands").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [buttons] };
}

function privateChatPanel() {
  const embed = new EmbedBuilder()
    .setColor(0xf472b6)
    .setTitle("Private Chat Created 🎀")
    .setDescription("Your private channel is ready. Use the commands or buttons below to manage access and rename the chat.");

  const firstRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}add`).setLabel("Add people").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${PREFIX}remove`).setLabel("Remove someone").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${PREFIX}rename`).setLabel("Rename chat").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${PREFIX}leave`).setLabel("Leave chat").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${PREFIX}delete`).setLabel("Delete chat").setStyle(ButtonStyle.Danger),
  );
  const secondRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}commands`).setLabel("Commands").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [firstRow, secondRow] };
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
    "You can also use the buttons in the private-chat panel. Server administrators with **Administrator** can still access private channels.",
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

async function handlePrivateChatInteraction(interaction, { client, store, lobbyChannelId }) {
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
    const channel = await createPrivateChat(interaction, client, store, displayName, invitees, lobbyChannelId);
    return interaction.editReply(`Private chat created: ${channel}`);
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

  if (action === "delete-confirm") {
    const context = getPrivateChatContext(interaction, store);
    requireOwner(interaction, context.chat);
    await interaction.deferUpdate();
    await context.channel.delete(`Private chat deleted by owner ${interaction.user.id}`);
    store.delete(context.channel.id);
    return interaction.followUp({ content: "Private chat deleted.", ephemeral: true });
  }

  const context = getPrivateChatContext(interaction, store);

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
    const channel = await createPrivateChat(interaction, client, store, displayName, [], lobbyChannelId);
    return interaction.editReply(`Private chat created: ${channel}`);
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

export async function createPrivateChat(interaction, client, store, displayName, invitees, lobbyChannelId) {
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

  try {
    await channel.send(privateChatPanel());
  } catch (error) {
    console.error(`[private-chats] chat ${channel.id} was created but its control panel could not be posted: ${error.message}`);
  }

  try {
    const lobby = await client.channels.fetch(lobbyChannelId);
    if (!lobby || typeof lobby.send !== "function") {
      throw new Error(`The private-chat lobby ${lobbyChannelId} is unavailable.`);
    }
    await lobby.send({
      content: `A new private chat has been created! 🎀\n<#${channel.id}>\nYour private space is ready ♡`,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error(
      `[private-chats] chat ${channel.id} was created but its lobby announcement could not be posted: ${error.message}`,
    );
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

async function addChatMembers(channel, chat, userIds, store, client) {
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
}

async function removeChatMembers(channel, chat, userIds, store) {
  const ids = validateMemberIds(chat, userIds, false);
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

async function renamePrivateChat(channel, chat, displayName, store) {
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
  return updated;
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
