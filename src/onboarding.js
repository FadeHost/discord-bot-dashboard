import { ChannelType, EmbedBuilder } from "discord.js";

import { formatEmbedTitle, toRoyalBold } from "./embed-format.js";
import { JOIN_ROLE_ID } from "./join-role-access.js";

export const ONBOARDING_CHANNEL_ID = "1567716077885071410";
export const PINK_CHECK_EMOJI_ID = "1568487503051235430";
export const PINK_CHECK_EMOJI = `<:pinkcheck:${PINK_CHECK_EMOJI_ID}>`;
export const ONBOARDING_FOOTER = "Sugar AI onboarding • React to verify";
export const ONBOARDING_GUIDE_FOOTER = "Sugar AI onboarding • #start guide";

const TEXT_CHANNEL_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
const REQUIRED_CHANNELS = [
  {
    name: "rules",
    label: "rules",
    emoji: "📄",
    aliases: ["rules", "server-rules"],
    type: ChannelType.GuildText,
  },
  {
    name: "help",
    label: "help",
    emoji: "❓",
    aliases: ["help", "server-help", "information"],
    type: ChannelType.GuildText,
  },
  {
    name: "start",
    label: "start",
    emoji: "👋",
    aliases: ["start", "start-here", "get-started", "getting-started"],
    type: ChannelType.GuildText,
  },
  {
    name: "guide",
    label: "guide",
    emoji: "📖",
    aliases: ["guide", "server-guide"],
    type: ChannelType.GuildText,
  },
  {
    name: "news",
    label: "announcements",
    emoji: "📢",
    aliases: ["news", "announcement", "announcements", "updates"],
    type: ChannelType.GuildAnnouncement,
  },
];

const CHANNEL_GUIDANCE = {
  rules: "Read the server rules before joining conversations.",
  help: "Visit this channel for help and information.",
  start: "Begin here for your first steps in the server.",
  guide: "Use this guide to learn how the server works.",
  news: "Announcements and updates are posted here.",
};

export async function ensureOnboardingChannels(guild) {
  let currentChannels = guild.channels.cache;
  let channelInventoryAvailable = false;
  try {
    const fetchedChannels = await guild.channels.fetch();
    if (fetchedChannels?.values) {
      currentChannels = fetchedChannels;
      channelInventoryAvailable = true;
    }
  } catch (error) {
    console.error(`[onboarding] could not list channels in guild ${guild.id} (${error?.code ?? "unknown error"})`);
  }

  const channels = new Map();
  for (const definition of REQUIRED_CHANNELS) {
    const intendedChannels = [...(currentChannels?.values?.() ?? [])].filter(
      (channel) => channelPurpose(channel.name) === definition.name,
    );
    const existingTextChannels = intendedChannels
      .filter((channel) => TEXT_CHANNEL_TYPES.has(channel.type))
      .sort((left, right) => channelPreference(left, definition) - channelPreference(right, definition));
    let existing = existingTextChannels[0];
    if (existing) {
      if (intendedChannels.length > 1) {
        console.warn(
          `[onboarding] multiple channels match #${definition.name} in guild ${guild.id}; reusing the best existing match`,
        );
      } else if (
        channelInventoryAvailable &&
        isPlainOnboardingAlias(existing.name, definition) &&
        typeof existing.setName === "function"
      ) {
        try {
          const renamed = await existing.setName(
            formatOnboardingChannelName(definition),
            "Apply Kittisugar channel naming style",
          );
          if (renamed) existing = renamed;
          currentChannels?.set?.(existing.id, existing);
        } catch (error) {
          console.warn(
            `[onboarding] could not restyle the existing #${definition.name} channel in guild ${guild.id} (${error?.code ?? "unknown error"}); reusing it without creating a duplicate`,
          );
        }
      }
      channels.set(definition.name, existing);
      continue;
    }
    if (intendedChannels.length) {
      console.warn(
        `[onboarding] a non-text channel matches #${definition.name} in guild ${guild.id}; leaving it unchanged`,
      );
      continue;
    }
    if (!channelInventoryAvailable) {
      console.warn(
        `[onboarding] cannot confirm #${definition.name} is absent in guild ${guild.id}; skipping channel creation`,
      );
      continue;
    }

    try {
      const created = await guild.channels.create({
        name: formatOnboardingChannelName(definition),
        type: definition.type,
      });
      channels.set(definition.name, created);
      currentChannels?.set?.(created.id, created);
    } catch (error) {
      if (definition.name === "news" && String(error?.code) === "50035") {
        console.warn(`[onboarding] announcement channel creation is unavailable in guild ${guild.id}; creating #news as a text channel`);
        try {
          const created = await guild.channels.create({
            name: formatOnboardingChannelName(definition),
            type: ChannelType.GuildText,
          });
          channels.set(definition.name, created);
          currentChannels?.set?.(created.id, created);
          continue;
        } catch (fallbackError) {
          console.error(`[onboarding] could not create #news in guild ${guild.id} (${fallbackError?.code ?? "unknown error"})`);
          continue;
        }
      }

      console.error(
        `[onboarding] could not create #${definition.name} in guild ${guild.id} (${error?.code ?? "unknown error"})`,
      );
    }
  }

  return channels;
}

function formatOnboardingChannelName(definition) {
  return `${definition.emoji} | ୨୧ • ${toRoyalBold(definition.label)}`;
}

function channelPurpose(channelName) {
  const normalizedName = normalizeOnboardingChannelName(channelName);
  if (!normalizedName) return null;
  return REQUIRED_CHANNELS.find((definition) =>
    definition.aliases.some((alias) => normalizeOnboardingChannelName(alias) === normalizedName),
  )?.name ?? null;
}

function normalizeOnboardingChannelName(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[୨୧]/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function isPlainOnboardingAlias(channelName, definition) {
  return definition.aliases.includes(String(channelName ?? "").toLowerCase());
}

function channelPreference(channel, definition) {
  if (channel.name === formatOnboardingChannelName(definition)) return 0;
  return isPlainOnboardingAlias(channel.name, definition) ? 2 : 1;
}

export function buildOnboardingWelcomePayload({ guildName, memberId, channels }) {
  const channelMention = (name) => {
    const channel = channels.get(name);
    return channel?.id ? `<#${channel.id}>` : `#${name}`;
  };
  const embed = new EmbedBuilder()
    .setColor(0xf472b6)
    .setTitle(formatEmbedTitle(`Welcome to ${guildName}`))
    .setDescription(
      [
        "Read the channels below to get started.",
        `React with ${PINK_CHECK_EMOJI} to verify. Sugar will remove the \`new\` role and add the \`member\` role.`,
      ].join("\n\n"),
    )
    .addFields(
      ...REQUIRED_CHANNELS.map(({ name }) => ({
        name: toRoyalBold(name === "news" ? "News & announcements" : name),
        value: `${CHANNEL_GUIDANCE[name]} ${channelMention(name)}`,
      })),
    )
    .setFooter({ text: ONBOARDING_FOOTER });

  return {
    content: `Welcome <@${memberId}>!`,
    embeds: [embed],
    allowedMentions: { parse: [], users: [memberId] },
  };
}

export function buildOnboardingGuidePayload({ channels }) {
  const channelMention = (name) => {
    const channel = channels.get(name);
    return channel?.id ? `<#${channel.id}>` : `#${name}`;
  };
  const embed = new EmbedBuilder()
    .setColor(0xf472b6)
    .setTitle(formatEmbedTitle("Your Kittisugar welcome guide"))
    .setDescription("Welcome to Kittisugar! Follow these little steps to settle in ♡")
    .addFields(
      {
        name: toRoyalBold("01 · Read the rules"),
        value: `Start with ${channelMention("rules")} before joining conversations.`,
      },
      {
        name: toRoyalBold("02 · Get your member role"),
        value:
          `Find Sugar's pink welcome message in <#${ONBOARDING_CHANNEL_ID}> and react with ${PINK_CHECK_EMOJI}. ` +
          "Sugar will remove your `new` role and add the `member` role.",
      },
      {
        name: toRoyalBold("03 · Find your way around"),
        value: [
          `${channelMention("help")} — help and information only; there is no ticket system.`,
          `${channelMention("guide")} — how the server works.`,
          `${channelMention("news")} — community announcements and updates.`,
        ].join("\n"),
      },
    )
    .setFooter({ text: ONBOARDING_GUIDE_FOOTER });

  return {
    embeds: [embed],
    allowedMentions: { parse: [] },
  };
}

export async function completeOnboardingVerification(guild, userId) {
  try {
    let roles = guild.roles.cache;
    let newRole = findJoinRole(roles);
    let memberRole = findRole(roles, "member");
    if ((!newRole || !memberRole) && typeof guild.roles.fetch === "function") {
      roles = await guild.roles.fetch();
      newRole = findJoinRole(roles);
      memberRole = findRole(roles, "member");
    }

    if (!newRole || !memberRole || newRole.id === memberRole.id) {
      console.error(`[onboarding] guild ${guild.id} needs distinct join and member roles`);
      return false;
    }

    const member = await guild.members.fetch(userId);
    if (!member.roles.cache.has(newRole.id)) return false;

    if (!member.roles.cache.has(memberRole.id)) {
      await member.roles.add(memberRole, "Member completed Sugar AI onboarding");
    }
    await member.roles.remove(newRole, "Member completed Sugar AI onboarding");
    return true;
  } catch (error) {
    console.error(`[onboarding] could not verify member ${userId} in guild ${guild?.id ?? "unknown"} (${error?.code ?? "unknown error"})`);
    return false;
  }
}

export async function handleOnboardingReaction(client, reaction, user) {
  if (user?.bot || reaction?.emoji?.id !== PINK_CHECK_EMOJI_ID) return false;

  try {
    let resolvedReaction = reaction;
    if (resolvedReaction.partial) resolvedReaction = await resolvedReaction.fetch();
    let message = resolvedReaction.message;
    if (message?.partial) message = await message.fetch();

    if (
      message?.author?.id !== client.user?.id ||
      message.channelId !== ONBOARDING_CHANNEL_ID ||
      !message.content?.includes(`<@${user.id}>`) ||
      !message.embeds?.some((embed) => embed.footer?.text === ONBOARDING_FOOTER)
    ) {
      return false;
    }

    return await completeOnboardingVerification(message.guild, user.id);
  } catch (error) {
    console.error(`[onboarding] could not process pink-check reaction (${error?.code ?? "unknown error"})`);
    return false;
  }
}

export function createOnboardingService(client, { guideStore } = {}) {
  let targetChannelPromise;
  const completeChannelSets = new Map();
  const inFlightChannelSets = new Map();
  const inFlightGuides = new Map();

  async function getTargetChannel() {
    if (!targetChannelPromise) {
      targetChannelPromise = Promise.resolve()
        .then(() => client.channels.fetch(ONBOARDING_CHANNEL_ID))
        .then((channel) => {
          if (!channel) {
            targetChannelPromise = null;
            console.error(`[onboarding] welcome channel ${ONBOARDING_CHANNEL_ID} was not found`);
            return null;
          }
          return channel;
        })
        .catch((error) => {
          targetChannelPromise = null;
          console.error(`[onboarding] could not fetch welcome channel ${ONBOARDING_CHANNEL_ID} (${error?.code ?? "unknown error"})`);
          return null;
        });
    }
    return targetChannelPromise;
  }

  async function getGuildChannels(guild) {
    if (completeChannelSets.has(guild.id)) return completeChannelSets.get(guild.id);
    if (inFlightChannelSets.has(guild.id)) return inFlightChannelSets.get(guild.id);

    const pending = ensureOnboardingChannels(guild)
      .then((channels) => {
        if (REQUIRED_CHANNELS.every(({ name }) => channels.has(name))) {
          completeChannelSets.set(guild.id, channels);
        }
        return channels;
      })
      .finally(() => inFlightChannelSets.delete(guild.id));
    inFlightChannelSets.set(guild.id, pending);
    return pending;
  }

  async function ensureStartGuide(channel, channels) {
    if (!channel?.isTextBased?.() || !channel.messages?.fetch) return false;
    if (inFlightGuides.has(channel.id)) return inFlightGuides.get(channel.id);

    const pending = publishOrUpdateStartGuide(channel, channels)
      .catch((error) => {
        console.error(`[onboarding] could not ensure the #start guide in guild ${channel.guildId ?? "unknown"} (${error?.code ?? "unknown error"})`);
        return false;
      })
      .finally(() => inFlightGuides.delete(channel.id));
    inFlightGuides.set(channel.id, pending);
    return pending;
  }

  async function publishOrUpdateStartGuide(channel, channels) {
    let message = null;
    const savedMessageId = guideStore?.getMessageId(channel.id);

    if (savedMessageId) {
      try {
        message = await channel.messages.fetch(savedMessageId);
      } catch (error) {
        if (String(error?.code) !== "10008") throw error;
      }
    }

    if (!isManagedStartGuide(message, client.user?.id)) {
      const recentMessages = await channel.messages.fetch({ limit: 100 });
      message = [...(recentMessages?.values?.() ?? [])].find((candidate) =>
        isManagedStartGuide(candidate, client.user?.id),
      );
    }

    const payload = buildOnboardingGuidePayload({ channels });
    if (message) {
      await message.edit(payload);
    } else {
      message = await channel.send(payload);
    }

    if (message?.id) guideStore?.setMessageId(channel.id, message.id);
    return true;
  }

  return {
    async provision() {
      const channel = await getTargetChannel();
      if (!channel?.guild) return false;
      const channels = await getGuildChannels(channel.guild);
      const startChannel = channels.get("start");
      if (startChannel) await ensureStartGuide(startChannel, channels);
      return REQUIRED_CHANNELS.every(({ name }) => channels.has(name));
    },

    async sendWelcome(member) {
      const channel = await getTargetChannel();
      if (!channel?.isTextBased?.()) {
        console.error(`[onboarding] welcome channel ${ONBOARDING_CHANNEL_ID} is not text-based`);
        return false;
      }
      if (channel.guildId !== member.guild.id) {
        console.error(`[onboarding] welcome channel ${ONBOARDING_CHANNEL_ID} is not in guild ${member.guild.id}`);
        return false;
      }

      let message;
      try {
        const channels = await getGuildChannels(member.guild);
        const startChannel = channels.get("start");
        if (startChannel) await ensureStartGuide(startChannel, channels);
        message = await channel.send(
          buildOnboardingWelcomePayload({
            guildName: member.guild.name,
            memberId: member.id,
            channels,
          }),
        );
      } catch (error) {
        console.error(`[onboarding] could not post welcome in ${ONBOARDING_CHANNEL_ID} (${error?.code ?? "unknown error"})`);
        return false;
      }

      const emoji = await resolvePinkCheckEmoji(client, member.guild);
      if (!emoji) {
        console.error(`[onboarding] pink-check emoji ${PINK_CHECK_EMOJI_ID} is not available in guild ${member.guild.id}`);
        return false;
      }
      try {
        await message.react(emoji);
        return true;
      } catch (error) {
        console.error(`[onboarding] could not add the pink-check reaction in ${ONBOARDING_CHANNEL_ID} (${error?.code ?? "unknown error"})`);
        return false;
      }
    },

    handleReaction(reaction, user) {
      return handleOnboardingReaction(client, reaction, user);
    },

    invalidateGuild(guildId) {
      completeChannelSets.delete(guildId);
    },
  };
}

function isManagedStartGuide(message, botId) {
  return Boolean(
    botId &&
      message?.author?.id === botId &&
      message.embeds?.some((embed) => embed.footer?.text === ONBOARDING_GUIDE_FOOTER),
  );
}

function findRole(roles, name) {
  return [...(roles?.values?.() ?? [])].find((role) => role.name === name);
}

function findJoinRole(roles) {
  return roles?.get?.(JOIN_ROLE_ID) ??
    [...(roles?.values?.() ?? [])].find((role) => role.id === JOIN_ROLE_ID);
}

async function resolvePinkCheckEmoji(client, guild) {
  let emoji = guild.emojis?.cache?.get(PINK_CHECK_EMOJI_ID) ?? client.emojis?.cache?.get(PINK_CHECK_EMOJI_ID);
  if (!emoji && typeof guild.emojis?.fetch === "function") {
    try {
      emoji = await guild.emojis.fetch(PINK_CHECK_EMOJI_ID);
    } catch {
      return null;
    }
  }
  return emoji ?? null;
}
