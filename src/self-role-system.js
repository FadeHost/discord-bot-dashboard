import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  Events,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";

import { formatEmbedTitle, toRoyalBold } from "./embed-format.js";
import { ONBOARDING_CHANNEL_ID } from "./onboarding.js";
import {
  SELF_ROLE_CATEGORIES,
  SELF_ROLE_CLEAR_VALUE,
  SELF_ROLE_PINK,
  SELF_ROLE_PREFIX,
  SELF_ROLE_TICKET_MARKER,
  getSelfRoleCategory,
  getSelfRoleDefinition,
} from "./self-role-catalog.js";
import { MAX_GUILD_ROLES, provisionSelfRoleGuild } from "./self-role-provisioning.js";

const MEMBER_ROLE_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
];
const STAFF_TICKET_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
];
const BOT_TICKET_PERMISSIONS = [
  ...STAFF_TICKET_PERMISSIONS,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageMessages,
];
const channelSetupQueues = new Map();
const roleSelectionQueues = new Map();
const ticketCreationQueues = new Map();

export function attachSelfRoleSystem(client, { store }) {
  if (!store) throw new Error("A self-role store is required.");

  let readyHandled = false;
  let targetGuildId = null;
  client.once(Events.ClientReady, () => {
    readyHandled = true;
    return resolveAndProvisionTargetGuild(client, store).then((guildId) => {
      targetGuildId = guildId;
    });
  });

  client.on(Events.GuildCreate, (guild) => {
    if (!readyHandled || guild.id !== targetGuildId) return;
    void provisionGuild(guild, client, store).catch((error) => {
      console.error(`[self-roles] setup failed in guild ${guild.id}: ${error.message}`);
    });
  });

  client.on(Events.ChannelDelete, (channel) => {
    if (!channel.guildId) return;
    try {
      store.clearChannel(channel.guildId, channel.id);
      store.removeTicket(channel.guildId, channel.id);
    } catch (error) {
      console.error(`[self-roles] could not clear deleted-channel metadata: ${error.message}`);
    }
  });

  client.on(Events.InteractionCreate, (interaction) => {
    if (!isSelfRoleInteraction(interaction)) return;
    void handleSelfRoleInteraction(interaction, { client, store }).catch(async (error) => {
      console.error(
        `[self-roles] interaction failed in guild ${interaction.guildId ?? "unknown"}: ${error.message}`,
      );
      await replyWithError(interaction, safeErrorMessage(error));
    });
  });
}

async function resolveAndProvisionTargetGuild(client, store) {
  try {
    const targetChannel = await client.channels.fetch(ONBOARDING_CHANNEL_ID);
    const guild = targetChannel?.guild ?? client.guilds.cache.get(targetChannel?.guildId);
    if (!guild) {
      console.error(`[self-roles] could not resolve the welcome server from channel ${ONBOARDING_CHANNEL_ID}`);
      return null;
    }
    await provisionGuild(guild, client, store);
    return guild.id;
  } catch (error) {
    console.error(`[self-roles] could not locate the welcome server (${error?.code ?? "unknown error"})`);
    return null;
  }
}

export async function provisionGuild(guild, client, store) {
  return runQueued(channelSetupQueues, guild.id, async () => {
    try {
      return await provisionSelfRoleGuild(guild, client, store);
    } catch (error) {
      console.error(`[self-roles] setup failed in guild ${guild.id}: ${error.message}`);
      return false;
    }
  });
}

export function buildSelfRoleSelectionRow(categoryKey, roleIds, member) {
  const category = getSelfRoleCategory(categoryKey);
  if (!category) throw new Error("That self-role category is not available.");
  if (!category.options.length) throw new Error("Role choices for this category are waiting for approval.");

  let hasSingleDefault = false;
  const options = category.options.map((option) => {
    const definition = getSelfRoleDefinition(`${category.key}:${option.key}`);
    const roleId = roleIds[definition.key];
    const item = new StringSelectMenuOptionBuilder()
      .setLabel(toRoyalBold(option.label))
      .setValue(option.key);
    const selected = roleId && member?.roles?.cache?.has?.(roleId);
    if (selected && (category.selection === "multiple" || !hasSingleDefault)) {
      item.setDefault(true);
      hasSingleDefault = true;
    }
    if (option.description) item.setDescription(toRoyalBold(option.description));
    if (option.hex) item.setDescription(option.hex);
    return item;
  });

  if (category.selection === "single") {
    options.push(
      new StringSelectMenuOptionBuilder()
        .setLabel(toRoyalBold("Clear selection"))
        .setValue(SELF_ROLE_CLEAR_VALUE),
    );
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${SELF_ROLE_PREFIX}select:${category.key}`)
    .setPlaceholder(toRoyalBold(`Choose ${category.label}`))
    .setMinValues(category.selection === "single" ? 1 : 0)
    .setMaxValues(category.selection === "single" ? 1 : category.options.length)
    .addOptions(options);

  return new ActionRowBuilder().addComponents(menu);
}

export function buildReviewTicketPermissionOverwrites({ everyoneId, memberId, staffRoleId, botId }) {
  const requiredIds = { everyoneId, memberId, staffRoleId, botId };
  for (const [label, id] of Object.entries(requiredIds)) {
    if (!isSnowflake(id)) throw new Error(`A valid ${label} is required for private ticket access.`);
  }
  if (new Set(Object.values(requiredIds)).size !== Object.keys(requiredIds).length) {
    throw new Error("The member, staff role, bot, and everyone must have distinct IDs.");
  }

  return [
    { id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] },
    { id: memberId, allow: MEMBER_ROLE_PERMISSIONS },
    { id: staffRoleId, allow: STAFF_TICKET_PERMISSIONS },
    { id: botId, allow: BOT_TICKET_PERMISSIONS },
  ];
}

export function buildReviewTicketPayload(memberId, staffRoleId) {
  if (!isSnowflake(memberId)) throw new Error("A valid member is required for a review ticket.");
  if (!isSnowflake(staffRoleId)) throw new Error("A valid staff role is required for a review ticket.");

  const embed = new EmbedBuilder()
    .setColor(SELF_ROLE_PINK)
    .setTitle(formatEmbedTitle("Under 18 Staff Review"))
    .setDescription(
      [
        `The member <@${memberId}> selected Under 18 themselves.`,
        "",
        "This is a self-declaration, not age verification. No automatic jail or punishment is applied.",
        "A staff member can review this ticket and close it when finished.",
      ].join("\n"),
    )
    .setFooter({ text: toRoyalBold("Private staff review") });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${SELF_ROLE_PREFIX}ticket-close`)
      .setLabel(toRoyalBold("Close review"))
      .setStyle(ButtonStyle.Secondary),
  );

  return {
    content: `<@&${staffRoleId}> A member selected Under 18 and requested a private review.`,
    embeds: [embed],
    components: [row],
    allowedMentions: { parse: [], users: [memberId], roles: [staffRoleId] },
  };
}

export async function handleSelfRoleInteraction(interaction, { client, store }) {
  if (!interaction.inGuild?.() || !interaction.guild || !interaction.guildId) {
    return replyEphemeral(interaction, "Self-roles can only be used inside the server.");
  }

  if (interaction.isButton?.()) {
    if (interaction.customId === `${SELF_ROLE_PREFIX}ticket-close`) {
      return closeReviewTicket(interaction, { client, store });
    }
    if (interaction.customId === `${SELF_ROLE_PREFIX}color:set`) {
      const config = store.getGuild(interaction.guildId);
      if (!isActiveColorControl(interaction, config)) {
        return replyEphemeral(interaction, "This color control is no longer active.");
      }
      return interaction.showModal(buildColorCustomizationModal());
    }
    if (interaction.customId === `${SELF_ROLE_PREFIX}color:remove`) {
      return removeMemberColor(interaction, { store });
    }
    const match = interaction.customId.match(/^self-role:open:([a-z-]+)$/u);
    if (match) return openCategoryPicker(interaction, { client, store }, match[1]);
    return replyEphemeral(interaction, "That self-role control is not available.");
  }

  if (interaction.isStringSelectMenu?.()) {
    const match = interaction.customId.match(/^self-role:select:([a-z-]+)$/u);
    if (match) return submitCategorySelection(interaction, { client, store }, match[1]);
  }
  if (
    interaction.isModalSubmit?.() &&
    interaction.customId === `${SELF_ROLE_PREFIX}color:submit`
  ) {
    return setMemberColor(interaction, { store });
  }

  return replyEphemeral(interaction, "That self-role control is not available.");
}

export function isSelfRoleInteraction(interaction) {
  return Boolean(
    (interaction.isButton?.() || interaction.isStringSelectMenu?.() || interaction.isModalSubmit?.()) &&
      typeof interaction.customId === "string" &&
      interaction.customId.startsWith(SELF_ROLE_PREFIX),
  );
}

export async function applySelfRoleSelection(member, guild, store, categoryKey, selectedValues) {
  const category = getSelfRoleCategory(categoryKey);
  if (!category) throw new Error("That self-role category is not available.");
  if (!category.options.length) throw new Error("Role choices for this category are waiting for approval.");
  const selectedKeys = validateSelfRoleSelection(category, selectedValues);
  const guildConfig = store.getGuild(guild.id);
  const currentRoleIds = guildConfig.roleIds;
  const managedRoles = category.options.map((option) => {
    const key = `${category.key}:${option.key}`;
    const roleId = currentRoleIds[key];
    const role = roleId ? guild.roles.cache.get(roleId) : null;
    if (!role || role.managed || hasAnyPermissions(role) || role.editable === false) {
      throw new Error("A self-role is missing or cannot be safely managed. Please contact a server admin.");
    }
    return { option, role };
  });

  const existing = new Set(member.roles.cache.keys());
  const toAdd = managedRoles
    .filter(({ option, role }) => selectedKeys.has(option.key) && !existing.has(role.id))
    .map(({ role }) => role);
  const toRemove = managedRoles
    .filter(({ option, role }) => existing.has(role.id) && !selectedKeys.has(option.key))
    .map(({ role }) => role);

  if (toAdd.length) {
    await member.roles.add(toAdd, "Member selected an approved self-role");
  }
  try {
    if (toRemove.length) await member.roles.remove(toRemove, "Member changed or cleared a self-role selection");
  } catch (error) {
    if (toAdd.length) {
      await member.roles.remove(toAdd, "Rollback incomplete self-role selection").catch(() => {});
    }
    throw error;
  }

  return {
    added: toAdd.map((role) => role.id),
    removed: toRemove.map((role) => role.id),
    selected: [...selectedKeys],
  };
}

export function validateSelfRoleSelection(categoryKey, selectedValues) {
  const category = typeof categoryKey === "string" ? getSelfRoleCategory(categoryKey) : categoryKey;
  if (!category) throw new Error("That self-role category is not available.");
  if (!Array.isArray(selectedValues)) throw new Error("Select valid role options from the menu.");

  const selected = new Set(selectedValues);
  if (selected.size !== selectedValues.length) throw new Error("Duplicate role choices were rejected.");
  if (category.selection === "single") {
    if (
      selected.size > 1 ||
      [...selected].some(
        (value) => value !== SELF_ROLE_CLEAR_VALUE && !category.options.some((option) => option.key === value),
      )
    ) {
      throw new Error("Choose only one approved option in this category.");
    }
  } else if (
    [...selected].some((value) => !category.options.some((option) => option.key === value)) ||
    selected.size > category.options.length
  ) {
    throw new Error("One or more choices are not part of the approved list.");
  }

  return selected.has(SELF_ROLE_CLEAR_VALUE) ? new Set() : selected;
}

export async function ensureReviewTicket(interaction, { client, store }) {
  const { guild, user } = interaction;
  const guildId = guild.id;
  const memberId = user.id;

  return runQueued(ticketCreationQueues, `${guildId}:${memberId}`, async () => {
    const config = store.getGuild(guildId);
    const staffRole = config.staffRoleId ? guild.roles.cache.get(config.staffRoleId) : null;
    if (!staffRole || staffRole.managed || hasAnyPermissions(staffRole) || staffRole.editable === false) {
      throw new Error("The private review staff role is not ready. Please contact a server admin.");
    }

    const botId = client.user?.id;
    const everyoneId = guild.roles.everyone?.id ?? guild.id;
    const existing = store.getOpenTicket(guildId, memberId);
    if (existing) {
      let channel;
      try {
        channel = await guild.channels.fetch(existing.channelId);
      } catch (error) {
        if (error?.code !== 10003 && error?.code !== 10008) throw error;
      }
      if (
        channel &&
        isMatchingReviewTicket(channel, guildId, memberId, {
          everyoneId,
          staffRoleId: staffRole.id,
          botId,
        })
      ) {
        return { channel, created: false };
      }
      if (channel) {
        throw new Error("An existing review ticket could not be verified. Contact a server admin before opening another.");
      }
      store.removeTicket(guildId, existing.channelId);
    }

    const topic = `${SELF_ROLE_TICKET_MARKER}:${guildId}:${memberId}`;
    const channelName = `🎟️ | ୨୧ • ${toRoyalBold("review")}-${memberId.slice(-6)}`;
    let channel;
    try {
      channel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        topic,
        permissionOverwrites: buildReviewTicketPermissionOverwrites({
          everyoneId,
          memberId,
          staffRoleId: staffRole.id,
          botId,
        }),
        reason: "Open a private, self-declared age review ticket",
      });
    } catch (error) {
      throw new Error(`Could not open the private staff-review ticket (${error?.code ?? "unknown error"}).`);
    }

    try {
      store.setTicket(guildId, { channelId: channel.id, memberId });
      await channel.send(buildReviewTicketPayload(memberId, staffRole.id));
    } catch (error) {
      store.removeTicket(guildId, channel.id);
      await channel.delete("Could not finish setting up the private review ticket").catch(() => {});
      throw error;
    }

    return { channel, created: true };
  });
}

async function openCategoryPicker(interaction, { client, store }, categoryKey) {
  const category = getSelfRoleCategory(categoryKey);
  if (!category) return replyEphemeral(interaction, "That self-role category is not available.");
  const config = store.getGuild(interaction.guildId);
  if (!isActiveSelfRolePanel(interaction, config, client)) {
    return replyEphemeral(interaction, "This self-role panel is no longer active.");
  }

  if (category.key === "color") {
    return interaction.reply({
      content: `${toRoyalBold("Color")} — set a custom hex color for your own permissionless role, or remove your color role.`,
      components: [buildColorCustomizationRow()],
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
  }
  if (!category.options.length) {
    return replyEphemeral(
      interaction,
      `${toRoyalBold(category.label)} role options are waiting for your approval. No roles are available in this category yet.`,
    );
  }

  try {
    const member = await resolveGuildMember(interaction);
    const row = buildSelfRoleSelectionRow(category.key, config.roleIds, member);
    return interaction.reply({
      content: `${toRoyalBold(category.label)} — ${category.description}`,
      components: [row],
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    return replyEphemeral(interaction, safeErrorMessage(error));
  }
}

async function submitCategorySelection(interaction, { client, store }, categoryKey) {
  const category = getSelfRoleCategory(categoryKey);
  const config = store.getGuild(interaction.guildId);
  if (!category || interaction.channelId !== config.channelId) {
    return replyEphemeral(interaction, "That self-role control is no longer active.");
  }

  await interaction.deferUpdate();
  try {
    const member = await resolveGuildMember(interaction);
    const values = Array.isArray(interaction.values) ? interaction.values : [];
    validateSelfRoleSelection(categoryKey, values);
    let ticket = null;
    if (categoryKey === "age" && values.includes("under-18")) {
      ticket = await ensureReviewTicket(interaction, { client, store });
    }

    const result = await runQueued(roleSelectionQueues, `${interaction.guildId}:${member.id}:${categoryKey}`, () =>
      applySelfRoleSelection(member, interaction.guild, store, categoryKey, values),
    );
    const response = buildSelectionResult(category, result, ticket);
    return interaction.editReply({ content: response, components: [] });
  } catch (error) {
    return interaction.editReply({ content: safeErrorMessage(error), components: [] });
  }
}

export function buildColorCustomizationRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${SELF_ROLE_PREFIX}color:set`)
      .setLabel(toRoyalBold("Set custom color"))
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${SELF_ROLE_PREFIX}color:remove`)
      .setLabel(toRoyalBold("Remove my color"))
      .setStyle(ButtonStyle.Secondary),
  );
}

export function buildColorCustomizationModal() {
  const input = new TextInputBuilder()
    .setCustomId("hex")
    .setLabel("Hex color")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("#EFAAC9")
    .setMaxLength(7)
    .setRequired(true);

  return new ModalBuilder()
    .setCustomId(`${SELF_ROLE_PREFIX}color:submit`)
    .setTitle(toRoyalBold("Customize your color"))
    .addComponents(new ActionRowBuilder().addComponents(input));
}

export function parseCustomRoleColor(value) {
  const hex = String(value ?? "").trim();
  if (!/^#[\da-f]{6}$/iu.test(hex)) throw new Error("Enter a valid six-digit hex color, such as #EFAAC9.");
  return Number.parseInt(hex.slice(1), 16);
}

async function setMemberColor(interaction, { store }) {
  if (!isValidColorInteraction(interaction, store)) {
    return replyEphemeral(interaction, "This color control is no longer active.");
  }
  const colorValue = interaction.fields.getTextInputValue("hex");
  let color;
  try {
    color = parseCustomRoleColor(colorValue);
  } catch (error) {
    return replyEphemeral(interaction, error.message);
  }

  await interaction.deferReply({ ephemeral: true });
  const member = await resolveGuildMember(interaction);
  if (!botCanManageRoles(interaction.guild)) {
    return interaction.editReply("Sugar needs Manage Roles and must rank above your color role to customize it.");
  }

  const config = store.getGuild(interaction.guildId);
  let roleId = config.colorRoleIds?.[member.id] ?? null;
  let roleCache = interaction.guild.roles.cache;
  if (typeof interaction.guild.roles.fetch === "function") {
    try {
      roleCache = await interaction.guild.roles.fetch();
    } catch {
      return interaction.editReply("Sugar could not check the server roles. No color role was changed.");
    }
  }
  let role = roleId ? roleCache.get(roleId) : null;
  if (roleId && !role) {
    store.setColorRoleId(interaction.guildId, member.id, null);
    roleId = null;
  }

  if (role && (role.managed || hasAnyPermissions(role) || role.editable === false)) {
    return interaction.editReply("Your saved color role cannot be safely managed. Please contact a server admin.");
  }

  if (!role) {
    if (roleCache.size >= MAX_GUILD_ROLES) {
      return interaction.editReply("The server has reached Discord's role limit, so Sugar cannot create a color role.");
    }
    try {
      role = await interaction.guild.roles.create({
        name: `${toRoyalBold("Color")} · ${member.id.slice(-6)}`,
        color,
        permissions: [],
        hoist: false,
        mentionable: false,
        reason: `Create a permissionless personal color role for member ${member.id}`,
      });
    } catch {
      return interaction.editReply("Sugar could not create your color role. Check Manage Roles and role hierarchy.");
    }
  } else {
    try {
      role = await role.edit({ color }, `Update personal color role for member ${member.id}`);
    } catch {
      return interaction.editReply("Sugar could not update your color role. Check Manage Roles and role hierarchy.");
    }
  }

  const createdRole = !roleId;
  if (role.managed || hasAnyPermissions(role) || role.editable === false) {
    if (createdRole) await role.delete?.("Remove an unsafe personal color role").catch(() => {});
    return interaction.editReply("That role cannot be safely assigned as a self-role.");
  }

  try {
    if (!member.roles.cache.has(role.id)) {
      await member.roles.add(role, "Member customized their personal color role");
    }
    store.setColorRoleId(interaction.guildId, member.id, role.id);
  } catch {
    if (createdRole) {
      await member.roles.remove(role, "Roll back an incomplete personal color assignment").catch(() => {});
      await role.delete?.("Roll back an incomplete personal color assignment").catch(() => {});
    }
    return interaction.editReply("Sugar could not assign your color role. Check Manage Roles and role hierarchy.");
  }

  return interaction.editReply(`Your custom color role was updated to #${color.toString(16).padStart(6, "0").toUpperCase()}.`);
}

async function removeMemberColor(interaction, { store }) {
  const config = store.getGuild(interaction.guildId);
  if (!isActiveColorControl(interaction, config)) {
    return replyEphemeral(interaction, "This color control is no longer active.");
  }

  await interaction.deferReply({ ephemeral: true });
  const member = await resolveGuildMember(interaction);
  const roleId = config.colorRoleIds?.[member.id];
  if (!roleId) return interaction.editReply("You do not have a custom color role to remove.");

  const role = interaction.guild.roles.cache.get(roleId);
  if (!role) {
    store.setColorRoleId(interaction.guildId, member.id, null);
    return interaction.editReply("Your custom color role was already removed.");
  }
  if (role.managed || hasAnyPermissions(role) || role.editable === false || !botCanManageRoles(interaction.guild)) {
    return interaction.editReply("Sugar cannot safely remove this role. Check Manage Roles and role hierarchy.");
  }

  try {
    if (member.roles.cache.has(role.id)) {
      await member.roles.remove(role, "Member removed their personal color role");
    }
    return interaction.editReply("Your custom color role was removed.");
  } catch {
    return interaction.editReply("Sugar could not remove your color role. Check Manage Roles and role hierarchy.");
  }
}

function isActiveSelfRolePanel(interaction, config, client) {
  return Boolean(
    interaction.channelId === config.channelId &&
      interaction.message?.id === config.messageId &&
      interaction.message?.author?.id === client.user?.id,
  );
}

function isActiveColorControl(interaction, config) {
  return Boolean(
    interaction.channelId === config.channelId &&
      interaction.message?.author?.bot &&
      interaction.message?.components?.some((row) =>
        row.components?.some((component) => component.customId?.startsWith(`${SELF_ROLE_PREFIX}color:`)),
      ),
  );
}

function isValidColorInteraction(interaction, store) {
  if (!interaction.inGuild?.() || !interaction.guild || !interaction.guildId) return false;
  const config = store.getGuild(interaction.guildId);
  return (
    interaction.customId === `${SELF_ROLE_PREFIX}color:submit` &&
    interaction.channelId === config.channelId
  );
}

function botCanManageRoles(guild) {
  try {
    return Boolean(guild.members.me?.permissions?.has?.(PermissionFlagsBits.ManageRoles));
  } catch {
    return false;
  }
}

function buildSelectionResult(category, result, ticket) {
  if (ticket) {
    const status = ticket.created ? "A private staff-review ticket is open" : "Your existing private review ticket is open";
    return `${toRoyalBold(category.label)} updated. ${status}: <#${ticket.channel.id}>. This is self-declared, not age verification; no automatic jail or punishment is applied.`;
  }
  if (!result.selected.length) return `${toRoyalBold(category.label)} selection cleared.`;
  const count = result.selected.length;
  return `${toRoyalBold(category.label)} updated. ${count} approved role${count === 1 ? "" : "s"} selected.`;
}

async function closeReviewTicket(interaction, { client, store }) {
  const ticket = store.getTicket(interaction.guildId, interaction.channelId);
  if (!ticket) {
    return replyEphemeral(interaction, "This is not an active Sugar AI review ticket.");
  }
  if (ticket.status !== "open") return replyEphemeral(interaction, "This review ticket is already closed.");

  const config = store.getGuild(interaction.guildId);
  const everyoneId = interaction.guild.roles.everyone?.id ?? interaction.guildId;
  if (
    !isMatchingReviewTicket(interaction.channel, interaction.guildId, ticket.memberId, {
      everyoneId,
      staffRoleId: config.staffRoleId,
      botId: client.user?.id,
    })
  ) {
    return replyEphemeral(interaction, "This ticket's private permissions changed. A server admin should review it.");
  }

  const member = await resolveGuildMember(interaction);
  const isStaff = Boolean(config.staffRoleId && member.roles.cache.has(config.staffRoleId));
  const isAdmin = hasPermission(interaction.memberPermissions, PermissionFlagsBits.Administrator);
  const isOwner = interaction.guild.ownerId === interaction.user.id;
  if (!isStaff && !isAdmin && !isOwner) {
    return replyEphemeral(interaction, "Only the configured staff role or a server administrator can close this ticket.");
  }

  await interaction.deferUpdate();
  try {
    await interaction.channel.permissionOverwrites.edit(
      ticket.memberId,
      { SendMessages: false },
      `Review ticket closed by staff member ${interaction.user.id}`,
    );
    store.closeTicket(interaction.guildId, interaction.channelId, interaction.user.id);
    return interaction.editReply({
      content: `${toRoyalBold("Review closed")} · The member can still read the ticket, but cannot send new messages.`,
      components: [],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    return interaction.editReply({
      content: `Could not close this review ticket (${error?.code ?? "unknown error"}). No messages were deleted.`,
      components: interaction.message?.components ?? [],
      allowedMentions: { parse: [] },
    });
  }
}

async function resolveGuildMember(interaction) {
  if (interaction.member?.roles?.cache && typeof interaction.member.roles.add === "function") {
    return interaction.member;
  }
  return interaction.guild.members.fetch(interaction.user.id);
}

function isMatchingReviewTicket(channel, guildId, memberId, access) {
  return Boolean(
    channel?.type === ChannelType.GuildText &&
      channel.guildId === guildId &&
      channel.topic === `${SELF_ROLE_TICKET_MARKER}:${guildId}:${memberId}` &&
      hasSafeReviewTicketAccess(channel, {
        everyoneId: access?.everyoneId ?? guildId,
        memberId,
        staffRoleId: access?.staffRoleId,
        botId: access?.botId,
      }),
  );
}

export function hasSafeReviewTicketAccess(channel, { everyoneId, memberId, staffRoleId, botId }) {
  const overwrites = channel?.permissionOverwrites?.cache;
  const expectedIds = [everyoneId, memberId, staffRoleId, botId];
  if (
    !overwrites?.get ||
    expectedIds.some((id) => !isSnowflake(id)) ||
    new Set(expectedIds).size !== expectedIds.length ||
    overwrites.size !== expectedIds.length ||
    expectedIds.some((id) => !overwrites.has(id))
  ) {
    return false;
  }

  const everyone = overwrites.get(everyoneId);
  const member = overwrites.get(memberId);
  const staff = overwrites.get(staffRoleId);
  const bot = overwrites.get(botId);
  if (
    !overwriteHas(everyone, "deny", PermissionFlagsBits.ViewChannel) ||
    overwriteHas(everyone, "allow", PermissionFlagsBits.ViewChannel) ||
    !overwriteHas(member, "allow", PermissionFlagsBits.ViewChannel) ||
    !overwriteHas(member, "allow", PermissionFlagsBits.SendMessages) ||
    !overwriteHas(member, "allow", PermissionFlagsBits.ReadMessageHistory) ||
    !overwriteHas(staff, "allow", PermissionFlagsBits.ViewChannel) ||
    !overwriteHas(staff, "allow", PermissionFlagsBits.SendMessages) ||
    !overwriteHas(staff, "allow", PermissionFlagsBits.ReadMessageHistory) ||
    !overwriteHas(bot, "allow", PermissionFlagsBits.ViewChannel) ||
    !overwriteHas(bot, "allow", PermissionFlagsBits.SendMessages) ||
    !overwriteHas(bot, "allow", PermissionFlagsBits.ReadMessageHistory) ||
    !overwriteHas(bot, "allow", PermissionFlagsBits.ManageChannels) ||
    !overwriteHas(bot, "allow", PermissionFlagsBits.ManageMessages) ||
    overwriteHas(member, "deny", PermissionFlagsBits.ViewChannel) ||
    overwriteHas(member, "deny", PermissionFlagsBits.SendMessages) ||
    overwriteHas(member, "deny", PermissionFlagsBits.ReadMessageHistory) ||
    overwriteHas(staff, "deny", PermissionFlagsBits.ViewChannel) ||
    overwriteHas(staff, "deny", PermissionFlagsBits.SendMessages) ||
    overwriteHas(staff, "deny", PermissionFlagsBits.ReadMessageHistory)
  ) {
    return false;
  }

  return (
    hasOnlyAllowedPermissions(member, MEMBER_ROLE_PERMISSIONS) &&
    hasOnlyAllowedPermissions(staff, STAFF_TICKET_PERMISSIONS) &&
    hasOnlyAllowedPermissions(bot, BOT_TICKET_PERMISSIONS)
  );
}

function overwriteHas(overwrite, kind, permission) {
  try {
    return Boolean(overwrite?.[kind]?.has?.(permission));
  } catch {
    return false;
  }
}

function hasOnlyAllowedPermissions(overwrite, allowedFlags) {
  try {
    const allowed = allowedFlags.reduce((flags, permission) => flags | BigInt(permission), 0n);
    const actual = BigInt(overwrite?.allow?.bitfield ?? 0);
    return (actual & ~allowed) === 0n;
  } catch {
    return false;
  }
}

function hasAnyPermissions(role) {
  try {
    return BigInt(role?.permissions?.bitfield ?? 0) !== 0n;
  } catch {
    return true;
  }
}

function hasPermission(permissions, flag) {
  try {
    return Boolean(permissions?.has?.(flag));
  } catch {
    return false;
  }
}

async function replyEphemeral(interaction, content) {
  const payload = { content, ephemeral: true, allowedMentions: { parse: [] } };
  if (interaction.deferred || interaction.replied) return interaction.followUp(payload);
  return interaction.reply(payload);
}

async function replyWithError(interaction, content) {
  try {
    if (interaction.deferred) {
      await interaction.editReply({ content, components: [] });
    } else if (interaction.replied) {
      await interaction.followUp({ content, ephemeral: true, allowedMentions: { parse: [] } });
    } else {
      await replyEphemeral(interaction, content);
    }
  } catch {
    // A failed interaction acknowledgement must not take the bot down.
  }
}

function safeErrorMessage(error) {
  const message = String(error?.message ?? "");
  if (message && message.length <= 300) return message;
  return "That self-role action could not be completed. Please try again or contact a server admin.";
}

function runQueued(queues, key, operation) {
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  queues.set(key, current);
  return current.finally(() => {
    if (queues.get(key) === current) queues.delete(key);
  });
}

function isSnowflake(value) {
  return typeof value === "string" && /^\d{5,25}$/u.test(value);
}
