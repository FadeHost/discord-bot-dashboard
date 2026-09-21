// The bot half: welcome messages and a channel log.
//
// Everything it does is read out of the settings file, which the dashboard
// writes, so a change takes effect on the next event with no restart.

import { ChannelType, Client, EmbedBuilder, Events, GatewayIntentBits, PermissionFlagsBits, Partials } from "discord.js";

import { renderWelcome } from "./settings.js";

const COLORS = { join: 0x4ade80, leave: 0xf87171, edit: 0xfbbf24, delete: 0xf87171 };

/**
 * Start the bot.
 *
 * @param {object} options
 * @param {string} options.token
 * @param {import("./settings.js").SettingsStore} options.settings
 * @returns {Client}
 */
export function createBot({ token, settings }) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      // Privileged. Turn Server Members on in the Developer Portal.
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      // Privileged. Turn Message Content on to log what a deleted message said.
      GatewayIntentBits.MessageContent,
    ],
    // Without these, a deleted or edited message that is not in the cache
    // (anything from before the bot started) arrives empty and is dropped.
    partials: [Partials.Message, Partials.Channel],
  });

  client.once(Events.ClientReady, () => {
    console.log(`[bot] logged in as ${client.user.tag} in ${client.guilds.cache.size} server(s)`);
  });

  client.on(Events.GuildMemberAdd, async (member) => {
    const config = settings.get(member.guild.id);

    if (config.welcomeChannelId) {
      const text = renderWelcome(config.welcomeMessage, {
        mention: `<@${member.id}>`,
        username: member.user.username,
        guildName: member.guild.name,
        memberCount: member.guild.memberCount,
      });

      await send(client, config.welcomeChannelId, { content: text });
    }

    await log(client, config.logChannelId, {
      title: "Member joined",
      color: COLORS.join,
      description: `<@${member.id}> (${member.user.tag})`,
      footer: `${member.guild.memberCount} members`,
    });
  });

  client.on(Events.GuildMemberRemove, async (member) => {
    const config = settings.get(member.guild.id);

    await log(client, config.logChannelId, {
      title: "Member left",
      color: COLORS.leave,
      description: `${member.user?.tag ?? member.id}`,
      footer: `${member.guild.memberCount} members`,
    });
  });

  client.on(Events.MessageDelete, async (message) => {
    if (!message.guild || message.author?.bot) return;

    const config = settings.get(message.guild.id);

    await log(client, config.logChannelId, {
      title: "Message deleted",
      color: COLORS.delete,
      description: quote(message.content) || "(no text, or it was posted before the bot started)",
      fields: [
        { name: "Author", value: message.author ? `<@${message.author.id}>` : "unknown", inline: true },
        { name: "Channel", value: `<#${message.channelId}>`, inline: true },
      ],
    });
  });

  client.on(Events.MessageUpdate, async (before, after) => {
    if (!after.guild || after.author?.bot) return;
    if (before.content === after.content) return;

    const config = settings.get(after.guild.id);

    await log(client, config.logChannelId, {
      title: "Message edited",
      color: COLORS.edit,
      description: `[Jump to it](${after.url})`,
      fields: [
        { name: "Before", value: quote(before.content) || "(not cached)" },
        { name: "After", value: quote(after.content) || "(empty)" },
        { name: "Author", value: after.author ? `<@${after.author.id}>` : "unknown", inline: true },
        { name: "Channel", value: `<#${after.channelId}>`, inline: true },
      ],
    });
  });

  client.on(Events.Error, (error) => console.error(`[bot] ${error.message}`));

  client.login(token).catch((error) => {
    if (String(error?.code) === "TokenInvalid" || String(error).includes("TOKEN_INVALID")) {
      console.error(
        "[config] Discord rejected DISCORD_TOKEN. Reset it in the Developer Portal under Bot, Reset Token, " +
          "update the environment variable and restart.",
      );
      process.exit(1);
    }

    if (String(error).includes("disallowed intents")) {
      console.error(
        "[config] Discord refused the login because the privileged intents are off. In the Developer Portal, " +
          "under Bot, Privileged Gateway Intents, turn on Server Members and Message Content, then restart.",
      );
      process.exit(1);
    }

    console.error(`[config] Could not log in to Discord: ${error.message}`);
    process.exit(1);
  });

  return client;
}

/**
 * The text channels a guild has, for the dashboard's dropdowns. Only channels
 * the bot can actually post in are offered, so nobody picks one and wonders
 * why nothing appears.
 *
 * @param {Client} client
 * @param {string} guildId
 * @returns {{id: string, name: string}[]}
 */
export function postableChannels(client, guildId) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return [];

  return guild.channels.cache
    .filter(
      (channel) =>
        (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement) &&
        channel.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.SendMessages),
    )
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map((channel) => ({ id: channel.id, name: channel.name }));
}

async function send(client, channelId, payload) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel?.isTextBased()) await channel.send(payload);
  } catch (error) {
    // A deleted channel or a missing permission must not take the bot down.
    console.error(`[bot] could not post in ${channelId}: ${error.message}`);
  }
}

async function log(client, channelId, { title, color, description, fields = [], footer }) {
  if (!channelId) return;

  const embed = new EmbedBuilder().setTitle(title).setColor(color).setTimestamp(new Date());
  if (description) embed.setDescription(description.slice(0, 4000));
  if (fields.length) embed.addFields(fields.map((f) => ({ ...f, value: String(f.value).slice(0, 1024) })));
  if (footer) embed.setFooter({ text: footer });

  await send(client, channelId, { embeds: [embed] });
}

// Quote somebody's text without letting it pretend to be part of the embed.
function quote(content) {
  const text = String(content ?? "").trim();
  if (!text) return "";
  return `>>> ${text.slice(0, 900)}`;
}
