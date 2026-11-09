import {
  ActionRowBuilder,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from "discord.js";

import { formatEmbedTitle, toRoyalBold } from "./embed-format.js";
import {
  SELF_ROLE_CATEGORIES,
  SELF_ROLE_CHANNEL_NAME,
  SELF_ROLE_EMBED_FOOTER,
  SELF_ROLE_PINK,
  HIDE_CHANNELS_EMOJI,
  SELF_ROLE_STAFF_KEY,
  getSelfRoleDefinition,
  getSelfRoleCategory,
  getSelfRolePanelFooter,
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
    PermissionFlagsBits.AddReactions,
    PermissionFlagsBits.ManageChannels,
  ];
  if (getProvisionableRoleDefinitions().length) requiredPermissions.push(PermissionFlagsBits.ManageRoles);

  if (!(await botHasPermissions(guild, requiredPermissions))) {
    console.warn(`[self-roles] bot is missing a required permission in guild ${guild.id}; setup was skipped`);
    return false;
  }

  const channel = await ensureSelfRoleChannel(guild, inventory);
  if (!channel) return false;

  const roleIds = await ensureSelfRoles(guild, store);
  await ensureSelfRolePanels(channel, client, store, roleIds);
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
    roleIds[definition.key] = role.id;
  }

  return roleIds;
}

export function buildAgeSelectionRow(roleIds = {}, member = null) {
  const category = getSelfRoleCategory("age");
  if (!category?.options.length) throw new Error("Age role options are not available.");

  const options = category.options.map((option) => {
    const definition = getSelfRoleDefinition(`age:${option.key}`);
    const item = new StringSelectMenuOptionBuilder()
      .setLabel(toRoyalBold(option.label))
      .setValue(option.key)
      .setEmoji(option.emoji);
    const roleId = roleIds[definition.key];
    if (roleId && member?.roles?.cache?.has?.(roleId)) item.setDefault(true);
    return item;
  });
  const menu = new StringSelectMenuBuilder()
    .setCustomId("self-role:select:age")
    .setPlaceholder(toRoyalBold("Choose your age"))
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options);
  return new ActionRowBuilder().addComponents(menu);
}

export function buildSelfRolePanelPayloads(roleIds = {}) {
  const makeEmbed = (panelKey, title, description) =>
    new EmbedBuilder()
      .setColor(SELF_ROLE_PINK)
      .setTitle(formatEmbedTitle(title))
      .setDescription(description)
      .setFooter({ text: getSelfRolePanelFooter(panelKey) });
  const age = getSelfRoleCategory("age");
  const ageOptions = age.options.map((option) => `${option.emoji}  ${toRoyalBold(option.label)}`).join("\n");
  const inactivePanels = SELF_ROLE_CATEGORIES
    .filter(({ key }) => ["gender", "sexuality", "interests", "color"].includes(key))
    .map((category) => ({
      key: category.key,
      payload: {
        embeds: [
          makeEmbed(
            category.key,
            category.label,
            `${category.description} No choices are active until they are approved.`,
          ),
        ],
      },
      reactions: {},
    }));
  const panels = [
    {
      key: "intro",
      payload: {
        embeds: [
          makeEmbed(
            "intro",
            "Self-Role Guide",
            [
              "Choose one self-declared Age role from the selector. It is not age verification.",
              "",
              `React with ${HIDE_CHANNELS_EMOJI} in Hide Channels to hide designated NSFW channels. Remove your reaction to restore your previous visibility.`,
              "",
              "Discord's native age restrictions always remain in force.",
            ].join("\n"),
          ),
        ],
      },
      reactions: {},
    },
    {
      key: "age",
      payload: {
        embeds: [
          makeEmbed(
            "age",
            "Age",
            [
              "Select one option below. Choosing a different age replaces your previous Age role.",
              "Age is self-declared, not age verification. Selecting 18- limits visibility to #support; it never grants access to age-restricted channels.",
              "",
              ageOptions,
            ].join("\n"),
          ),
        ],
        components: [buildAgeSelectionRow(roleIds)],
      },
      reactions: {},
    },
    ...inactivePanels.slice(0, 3),
    inactivePanels[3],
    {
      key: "hide-channels",
      payload: {
        embeds: [
          makeEmbed(
            "hide-channels",
            "Hide Channels",
            [
              `React with ${HIDE_CHANNELS_EMOJI} to hide NSFW channels you can already access.`,
              "Remove your reaction to restore the previous visibility.",
              "This only changes channel visibility; it never grants access or changes Discord's native age restrictions.",
            ].join("\n"),
          ),
        ],
      },
      reactions: { [HIDE_CHANNELS_EMOJI]: "hide-nsfw" },
    },
  ];

  return panels.map((panel) => ({
    ...panel,
    payload: {
      ...panel.payload,
      components: panel.payload.components ?? [],
      allowedMentions: { parse: [] },
    },
  }));
}

export function buildSelfRolePickerPayload(roleIds = {}) {
  return buildSelfRolePanelPayloads(roleIds)[0].payload;
}

export async function ensureSelfRolePanels(channel, client, store, roleIds) {
  const guildId = channel.guildId ?? channel.guild?.id;
  if (!guildId) throw new Error("The self-role channel has no guild.");

  const current = store.getGuild(guildId);
  const recentMessages = await channel.messages.fetch({ limit: 100 });
  if (!recentMessages?.values) throw new Error("The self-role message history is unavailable.");
  const recent = [...recentMessages.values()];
  const result = {};

  for (const panel of buildSelfRolePanelPayloads(roleIds)) {
    let message = null;
    const savedId =
      store.getPanelMessageId(guildId, panel.key) ?? (panel.key === "intro" ? current.messageId : null);
    if (savedId && current.channelId === channel.id) {
      try {
        message = await channel.messages.fetch(savedId);
      } catch (error) {
        if (error?.code !== 10008 && error?.code !== 10003) throw error;
      }
      if (!isManagedPanel(message, client.user?.id, panel.key)) message = null;
    }
    if (!message) {
      message = recent.find((candidate) => isManagedPanel(candidate, client.user?.id, panel.key)) ?? null;
    }

    message = message ? await message.edit(panel.payload) : await channel.send(panel.payload);
    store.setReactionPanelMessage(guildId, panel.key, channel.id, message.id, panel.reactions);
    result[panel.key] = message;

    if (panel.key === "hide-channels" && typeof message.react === "function") {
      try {
        await message.react(HIDE_CHANNELS_EMOJI);
      } catch (error) {
        console.warn(
          `[self-roles] could not seed the Hide Channels reaction in guild ${guildId} (${error?.code ?? "unknown error"})`,
        );
      }
    }
  }

  return { messages: result, roleIds };
}

export async function ensureSelfRolePanel(channel, client, store, roleIds) {
  return ensureSelfRolePanels(channel, client, store, roleIds);
}

function isManagedPanel(message, botId, panelKey) {
  const footers = message?.embeds?.map((embed) => embed.footer?.text) ?? [];
  const isLegacyIntro = panelKey === "intro" && footers.includes(SELF_ROLE_EMBED_FOOTER);
  return Boolean(
    botId &&
      message?.author?.id === botId &&
      (footers.includes(getSelfRolePanelFooter(panelKey)) || isLegacyIntro),
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
  return SELF_ROLE_CATEGORIES.flatMap((category) =>
    category.options
      .map((option) => getSelfRoleDefinition(`${category.key}:${option.key}`))
      .filter(Boolean),
  );
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
