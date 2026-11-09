import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, PermissionFlagsBits } from "discord.js";

import { formatEmbedTitle, toRoyalBold } from "./embed-format.js";
import { buildNsfwVisibilityControlRow } from "./nsfw-visibility-system.js";
import {
  SELF_ROLE_CATEGORIES,
  SELF_ROLE_CHANNEL_NAME,
  SELF_ROLE_EMBED_FOOTER,
  SELF_ROLE_PINK,
  SELF_ROLE_PREFIX,
  SELF_ROLE_STAFF_KEY,
  SELF_ROLE_STAFF_NAME,
  getSelfRoleDefinition,
  getSelfRoleCategory,
  normalizeSelfRoleName,
} from "./self-role-catalog.js";

export const MAX_GUILD_ROLES = 250;
const TEXT_CHANNEL_TYPES = new Set([ChannelType.GuildText]);
const SELF_ROLE_CHANNEL_ALIASES = new Set(["self-roles", "self roles", "selfroles"]);
const ROLE_SETUP_REASON = "Provision the approved Sugar AI self-role picker";

export async function provisionSelfRoleGuild(guild, client, store) {
  const inventory = await fetchSelfRoleChannelInventory(guild);
  if (!inventory) return false;

  const matches = getSelfRoleChannelMatches(inventory);
  const textMatches = matches
    .filter((channel) => TEXT_CHANNEL_TYPES.has(channel.type))
    .sort((left, right) => selfRoleChannelPreference(left) - selfRoleChannelPreference(right));
  const selectedChannel = textMatches[0];
  const needsCreate = matches.length === 0;
  const needsRename =
    matches.length === 1 &&
    selectedChannel &&
    selectedChannel.name !== SELF_ROLE_CHANNEL_NAME &&
    typeof selectedChannel.setName === "function";
  const requiredPermissions = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ReadMessageHistory,
  ];
  if (needsCreate || needsRename) requiredPermissions.push(PermissionFlagsBits.ManageChannels);
  if (getProvisionableRoleDefinitions().length) requiredPermissions.push(PermissionFlagsBits.ManageRoles);

  if (!(await botHasPermissions(guild, requiredPermissions))) {
    console.warn(`[self-roles] bot is missing a required permission in guild ${guild.id}; setup was skipped`);
    return false;
  }

  const channel = await ensureSelfRoleChannel(guild, inventory);
  if (!channel) return false;

  const roleIds = await ensureSelfRoles(guild, store);
  await ensureSelfRolePanel(channel, client, store, roleIds);
  return true;
}

export async function ensureSelfRoleChannel(guild, knownInventory = null) {
  const inventory = knownInventory ?? (await fetchSelfRoleChannelInventory(guild));
  if (!inventory) return null;

  const matches = getSelfRoleChannelMatches(inventory);
  const textMatches = matches
    .filter((channel) => TEXT_CHANNEL_TYPES.has(channel.type))
    .sort((left, right) => selfRoleChannelPreference(left) - selfRoleChannelPreference(right));

  if (textMatches.length) {
    let channel = textMatches[0];
    if (matches.length > 1) {
      console.warn(`[self-roles] multiple channels match the self-role channel in guild ${guild.id}; reusing one without changing the others`);
    } else if (channel.name !== SELF_ROLE_CHANNEL_NAME && typeof channel.setName === "function") {
      try {
        channel = (await channel.setName(SELF_ROLE_CHANNEL_NAME, "Apply Kittisugar self-role channel naming")) ?? channel;
      } catch (error) {
        console.warn(`[self-roles] could not restyle the existing self-role channel in guild ${guild.id}; reusing it (${error?.code ?? "unknown error"})`);
      }
    }
    return channel;
  }

  if (matches.length) {
    console.warn(`[self-roles] a non-text channel matches the self-role channel in guild ${guild.id}; leaving it unchanged`);
    return null;
  }

  try {
    return await guild.channels.create({
      name: SELF_ROLE_CHANNEL_NAME,
      type: ChannelType.GuildText,
      reason: "Create Sugar AI's member self-role channel",
    });
  } catch (error) {
    console.error(`[self-roles] could not create the self-role channel in guild ${guild.id} (${error?.code ?? "unknown error"})`);
    return null;
  }
}
export async function ensureSelfRoles(guild, store) {
  const definitions = getProvisionableRoleDefinitions();
  if (!definitions.length) return {};

  let roles;
  try {
    roles = await guild.roles.fetch();
  } catch (error) {
    throw new Error(`Could not list roles in guild ${guild.id}; self-role setup was stopped (${error?.code ?? "unknown error"}).`);
  }
  if (!roles?.values) throw new Error(`Role inventory is unavailable in guild ${guild.id}; self-role setup was stopped.`);

  const current = store.getGuild(guild.id);
  const matches = new Map();

  for (const definition of definitions) {
    const storedId = definition.key === SELF_ROLE_STAFF_KEY ? current.staffRoleId : current.roleIds[definition.key];
    const storedRole = storedId ? roles.get(storedId) : null;
    const nameMatches = [...roles.values()].filter(
      (role) => normalizeSelfRoleName(role.name) === normalizeSelfRoleName(definition.name),
    );
    if (definition.key === SELF_ROLE_STAFF_KEY && !storedRole && nameMatches.length) {
      throw new Error(
        `An existing role matches "${definition.name}" but is not registered as this feature's review role; it was not reused to avoid exposing private tickets.`,
      );
    }
    const candidates = storedRole ? [storedRole] : nameMatches;
    if (candidates.length > 1) {
      candidates.sort(
        (left, right) =>
          Number(right.name === definition.name) - Number(left.name === definition.name) ||
          Number(left.managed) - Number(right.managed),
      );
    }
    const role = candidates[0] ?? null;

    if (role && (role.managed || hasAnyPermissions(role))) {
      throw new Error(
        `The existing role matching "${definition.name}" has permissions or is managed; it was not changed or assigned.`,
      );
    }
    if (role && role.editable === false) {
      throw new Error(`The bot cannot manage the existing self-role "${definition.name}" due to role hierarchy.`);
    }
    matches.set(definition.key, { definition, role });
  }

  const missingCount = [...matches.values()].filter(({ role }) => !role).length;
  if (roles.size + missingCount > MAX_GUILD_ROLES) {
    throw new Error(
      `Guild ${guild.id} needs ${missingCount} new roles but has room for only ${Math.max(0, MAX_GUILD_ROLES - roles.size)}.`,
    );
  }

  const roleIds = {};
  for (const { definition, role: existing } of matches.values()) {
    let role = existing;
    if (!role) {
      try {
        role = await guild.roles.create({
          name: definition.name,
          color: definition.color ?? undefined,
          permissions: [],
          hoist: false,
          mentionable: false,
          reason: ROLE_SETUP_REASON,
        });
      } catch (error) {
        throw new Error(
          `Could not create the self-role "${definition.name}" in guild ${guild.id} (${error?.code ?? "unknown error"}).`,
        );
      }
      roles.set?.(role.id, role);
    } else if (role.name !== definition.name || (definition.color !== null && role.color !== definition.color)) {
      if (typeof role.edit !== "function") {
        throw new Error(`The existing self-role "${definition.name}" needs styling, but the bot cannot edit it.`);
      }
      try {
        role = await role.edit(
          {
            name: definition.name,
            ...(definition.color !== null ? { color: definition.color } : {}),
          },
          "Apply the approved Kittisugar self-role name and color",
        );
      } catch (error) {
        throw new Error(
          `Could not style the existing self-role "${definition.name}" in guild ${guild.id} (${error?.code ?? "unknown error"}).`,
        );
      }
      roles.set?.(role.id, role);
    }

    store.setRoleId(guild.id, definition.key, role.id);
    if (definition.key === SELF_ROLE_STAFF_KEY) continue;
    roleIds[definition.key] = role.id;
  }

  return roleIds;
}

export function buildSelfRolePickerPayload() {
  const embed = new EmbedBuilder()
    .setColor(SELF_ROLE_PINK)
    .setTitle(formatEmbedTitle("Choose your self roles"))
    .setDescription(
      [
        "Choose one of the five approved categories below. Your role options are waiting for approval, so no unapproved role choices are active.",
        "",
        "Use the age-restricted channels menu below to show or hide channels you can already access.",
        "",
        "Any future age role will be self-declared only. It will never verify age, grant age-restricted access, or change Discord's native channel restrictions.",
        "",
        "Color lets you enter a custom hex value. Sugar only creates or updates a permissionless color role when it can safely manage that role.",
      ].join("\n"),
    )
    .addFields(
      SELF_ROLE_CATEGORIES.map((category) => ({
        name: toRoyalBold(category.label),
        value:
          category.key === "color"
            ? "Customize your own color, or remove it."
            : category.key === "age"
              ? "Self-declared only; never age verification."
              : "Role choices will be added after approval.",
      })),
    )
    .setFooter({ text: SELF_ROLE_EMBED_FOOTER });

  const row = new ActionRowBuilder().addComponents(
    SELF_ROLE_CATEGORIES.map((category) =>
      new ButtonBuilder()
        .setCustomId(`${SELF_ROLE_PREFIX}open:${category.key}`)
        .setLabel(toRoyalBold(category.label))
        .setStyle(ButtonStyle.Primary),
    ),
  );

  return {
    embeds: [embed],
    components: [row, buildNsfwVisibilityControlRow()],
    allowedMentions: { parse: [] },
  };
}

export async function ensureSelfRolePanel(channel, client, store, roleIds) {
  const guildId = channel.guildId ?? channel.guild?.id;
  if (!guildId) throw new Error("The self-role channel has no guild.");

  const current = store.getGuild(guildId);
  let message = null;
  if (current.channelId === channel.id && current.messageId) {
    try {
      message = await channel.messages.fetch(current.messageId);
    } catch (error) {
      if (error?.code !== 10008 && error?.code !== 10003) throw error;
    }
  }

  if (!isManagedPanel(message, client.user?.id)) {
    const recentMessages = await channel.messages.fetch({ limit: 100 });
    message = [...(recentMessages?.values?.() ?? [])].find((candidate) =>
      isManagedPanel(candidate, client.user?.id),
    ) ?? null;
  }

  const payload = buildSelfRolePickerPayload();
  if (message) {
    await message.edit(payload);
  } else {
    message = await channel.send(payload);
  }

  store.setChannel(guildId, channel.id, message.id);
  return { message, roleIds };
}

function isManagedPanel(message, botId) {
  return Boolean(
    botId &&
      message?.author?.id === botId &&
      message.embeds?.some((embed) => embed.footer?.text === SELF_ROLE_EMBED_FOOTER),
  );
}

export function isSelfRoleChannelName(name) {
  const normalized = normalizeSelfRoleName(name).replace(/[୨୧]/gu, "");
  return [...SELF_ROLE_CHANNEL_ALIASES].some((alias) => normalizeSelfRoleName(alias) === normalized);
}

function getSelfRoleChannelMatches(inventory) {
  return [...inventory.values()].filter((channel) => isSelfRoleChannelName(channel.name));
}

async function fetchSelfRoleChannelInventory(guild) {
  try {
    const inventory = await guild.channels.fetch();
    if (inventory?.values) return inventory;
    console.warn(`[self-roles] channel inventory is unavailable in guild ${guild.id}; skipping setup`);
  } catch (error) {
    console.warn(`[self-roles] could not list channels in guild ${guild.id}; skipping creation to avoid duplicates (${error?.code ?? "unknown error"})`);
  }
  return null;
}

function getProvisionableRoleDefinitions() {
  const definitions = SELF_ROLE_CATEGORIES.flatMap((category) =>
    category.options
      .map((option) => getSelfRoleDefinition(`${category.key}:${option.key}`))
      .filter(Boolean),
  );
  if (getSelfRoleCategory("age")?.options.some((option) => option.key === "under-18")) {
    definitions.push({ key: SELF_ROLE_STAFF_KEY, name: SELF_ROLE_STAFF_NAME, color: null });
  }
  return definitions;
}

async function botHasPermissions(guild, requiredPermissions) {
  let botMember = guild.members?.me;
  if (!botMember && typeof guild.members?.fetchMe === "function") {
    try {
      botMember = await guild.members.fetchMe();
    } catch {
      return false;
    }
  }
  if (!botMember?.permissions?.has) return false;
  try {
    return requiredPermissions.every((permission) => botMember.permissions.has(permission));
  } catch {
    return false;
  }
}

function selfRoleChannelPreference(channel) {
  return channel.name === SELF_ROLE_CHANNEL_NAME ? 0 : 1;
}

function hasAnyPermissions(role) {
  try {
    return BigInt(role?.permissions?.bitfield ?? 0) !== 0n;
  } catch {
    return true;
  }
}
