import { ChannelType, EmbedBuilder } from "discord.js";

import { formatEmbedTitle, toRoyalBold } from "./embed-format.js";

export const ONBOARDING_CHANNEL_ID = "1567716077885071410";
export const PINK_CHECK_EMOJI_ID = "1568487503051235430";
export const PINK_CHECK_EMOJI = `<:pinkcheck:${PINK_CHECK_EMOJI_ID}>`;
export const ONBOARDING_FOOTER = "Sugar AI onboarding • React to verify";

const TEXT_CHANNEL_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
const REQUIRED_CHANNELS = [
  { name: "rules", type: ChannelType.GuildText },
  { name: "help", type: ChannelType.GuildText },
  { name: "start", type: ChannelType.GuildText },
  { name: "guide", type: ChannelType.GuildText },
  { name: "news", type: ChannelType.GuildAnnouncement },
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
  try {
    const fetchedChannels = await guild.channels.fetch();
    if (fetchedChannels?.values) currentChannels = fetchedChannels;
  } catch (error) {
    console.error(`[onboarding] could not list channels in guild ${guild.id} (${error?.code ?? "unknown error"})`);
  }

  const channels = new Map();
  for (const definition of REQUIRED_CHANNELS) {
    const sameNameChannels = [...(currentChannels?.values?.() ?? [])].filter(
      (channel) => channel.name === definition.name,
    );
    const existing = sameNameChannels.find((channel) => TEXT_CHANNEL_TYPES.has(channel.type));
    if (existing) {
      channels.set(definition.name, existing);
      continue;
    }
    if (sameNameChannels.length) {
      console.warn(`[onboarding] #${definition.name} already exists as a non-text channel in guild ${guild.id}; leaving it unchanged`);
      continue;
    }

    try {
      const created = await guild.channels.create({
        name: definition.name,
        type: definition.type,
      });
      channels.set(definition.name, created);
      currentChannels?.set?.(created.id, created);
    } catch (error) {
      if (definition.name === "news" && String(error?.code) === "50035") {
        console.warn(`[onboarding] announcement channel creation is unavailable in guild ${guild.id}; creating #news as a text channel`);
        try {
          const created = await guild.channels.create({
            name: definition.name,
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

export async function completeOnboardingVerification(guild, userId) {
  try {
    let roles = guild.roles.cache;
    let newRole = findRole(roles, "new");
    let memberRole = findRole(roles, "member");
    if ((!newRole || !memberRole) && typeof guild.roles.fetch === "function") {
      roles = await guild.roles.fetch();
      newRole = findRole(roles, "new");
      memberRole = findRole(roles, "member");
    }

    if (!newRole || !memberRole || newRole.id === memberRole.id) {
      console.error(`[onboarding] guild ${guild.id} needs distinct roles named "new" and "member"`);
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

export function createOnboardingService(client) {
  let targetChannelPromise;
  const completeChannelSets = new Map();
  const inFlightChannelSets = new Map();

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

  return {
    async provision() {
      const channel = await getTargetChannel();
      if (!channel?.guild) return false;
      const channels = await getGuildChannels(channel.guild);
      return REQUIRED_CHANNELS.every(({ name }) => channels.has(name));
    },

    async sendWelcome(member) {
      const channel = await getTargetChannel();
      if (!channel?.isTextBased?.() || channel.guildId !== member.guild.id) return false;

      let message;
      try {
        const channels = await getGuildChannels(member.guild);
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

function findRole(roles, name) {
  return [...(roles?.values?.() ?? [])].find((role) => role.name === name);
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
