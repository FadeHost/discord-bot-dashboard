import { Events, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";

const COMMAND_NAME = "show-hide";
const SUPPORTED_ACTIONS = new Set(["show", "hide"]);

export function buildNsfwVisibilityCommand() {
  return new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setDescription("Show or hide NSFW channels you can already access")
    .addStringOption((option) =>
      option
        .setName("action")
        .setDescription("Show or hide age-restricted channels")
        .setRequired(true)
        .addChoices(
          { name: "Show NSFW channels", value: "show" },
          { name: "Hide NSFW channels", value: "hide" },
        ),
    )
    .toJSON();
}

export function attachNsfwVisibilitySystem(client, { store }) {
  if (!store) throw new Error("An NSFW visibility store is required.");

  client.on(Events.ChannelDelete, (channel) => {
    if (!channel.guildId) return;
    try {
      store.clearChannel(channel.guildId, channel.id);
    } catch (error) {
      console.error(`[nsfw-visibility] could not clear deleted-channel metadata: ${error.message}`);
    }
  });

  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand?.() || interaction.commandName !== COMMAND_NAME) return;
    void handleNsfwVisibilityInteraction(interaction, { store }).catch(async (error) => {
      console.error(`[nsfw-visibility] command failed in guild ${interaction.guildId ?? "unknown"}`);
      await respondEphemeral(interaction, "Sugar could not update NSFW channel visibility. No native age restrictions were changed.");
    });
  });
}

export async function handleNsfwVisibilityInteraction(interaction, { store }) {
  if (!interaction.inGuild?.() || !interaction.guild || !interaction.guildId) {
    return respondEphemeral(interaction, "Show/hide controls can only be used inside the server.");
  }

  const action = interaction.options.getString("action", true);
  if (!SUPPORTED_ACTIONS.has(action)) {
    return respondEphemeral(interaction, "Choose either Show NSFW channels or Hide NSFW channels.");
  }

  await interaction.deferReply({ ephemeral: true });
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const result = await applyNsfwVisibility(interaction.guild, member, store, action);
  return interaction.editReply(buildVisibilityResult(action, result));
}

export async function applyNsfwVisibility(guild, member, store, action) {
  if (!SUPPORTED_ACTIONS.has(action)) throw new Error("A valid NSFW visibility action is required.");

  const inventory = await guild.channels.fetch();
  if (!inventory?.values) throw new Error("The server channel list is unavailable; no visibility changes were made.");

  const channels = [...inventory.values()];
  const result = { changed: 0, skipped: 0, failed: 0 };

  if (action === "hide") {
    for (const channel of channels) {
      if (!isAgeRestrictedChannel(channel, guild.id)) continue;
      if (!memberCanView(channel, member)) {
        result.skipped += 1;
        continue;
      }

      const overwrite = channel.permissionOverwrites.cache.get(member.id);
      const previousViewChannel = explicitViewState(overwrite);
      // Never replace a direct member allow. A later "show" must not override
      // an administrator's newer permission changes.
      if (previousViewChannel === true || store.get(guild.id, channel.id, member.id)) {
        result.skipped += 1;
        continue;
      }
      if (!botCanManageChannel(channel, guild)) {
        result.failed += 1;
        continue;
      }

      try {
        store.save(guild.id, channel.id, member.id, {
          hadOverwrite: Boolean(overwrite),
          previousViewChannel,
        });
      } catch {
        result.skipped += 1;
        continue;
      }

      try {
        await channel.permissionOverwrites.edit(
          member.id,
          { ViewChannel: false },
          "Member hid an age-restricted channel using Sugar's visibility control",
        );
        result.changed += 1;
      } catch {
        store.delete(guild.id, channel.id, member.id);
        result.failed += 1;
      }
    }
    return result;
  }

  for (const record of store.listMember(guild.id, member.id)) {
    const channel = inventory.get(record.channelId);
    if (!isAgeRestrictedChannel(channel, guild.id)) {
      result.skipped += 1;
      continue;
    }
    if (record.previousViewChannel === true) {
      result.skipped += 1;
      continue;
    }
    if (!botCanManageChannel(channel, guild)) {
      result.failed += 1;
      continue;
    }

    try {
      await channel.permissionOverwrites.edit(
        member.id,
        { ViewChannel: record.previousViewChannel },
        "Member restored their previous NSFW channel visibility",
      );
      store.delete(guild.id, channel.id, member.id);
      result.changed += 1;
    } catch {
      result.failed += 1;
    }
  }

  return result;
}

export function buildVisibilityResult(action, { changed, skipped, failed }) {
  const count = Number.isInteger(changed) ? changed : 0;
  const skippedCount = Number.isInteger(skipped) ? skipped : 0;
  const failedCount = Number.isInteger(failed) ? failed : 0;
  const status = action === "hide" ? "hidden" : "restored";
  return [
    `${count} eligible NSFW channel${count === 1 ? "" : "s"} ${status}.`,
    "Discord's native age restrictions remain in force; this control never grants access.",
    skippedCount ? `${skippedCount} channel${skippedCount === 1 ? " was" : "s were"} skipped.` : "",
    failedCount ? `${failedCount} channel${failedCount === 1 ? " could" : "s could"} not be updated; check Manage Channels.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function isAgeRestrictedChannel(channel, guildId) {
  return Boolean(
    channel &&
      channel.guildId === guildId &&
      channel.nsfw === true &&
      channel.permissionOverwrites?.cache &&
      typeof channel.permissionOverwrites.edit === "function",
  );
}

function memberCanView(channel, member) {
  try {
    return Boolean(channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel));
  } catch {
    return false;
  }
}

function botCanManageChannel(channel, guild) {
  try {
    return Boolean(
      guild.members.me &&
        channel.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.ManageChannels),
    );
  } catch {
    return false;
  }
}

function explicitViewState(overwrite) {
  if (overwrite?.allow?.has?.(PermissionFlagsBits.ViewChannel)) return true;
  if (overwrite?.deny?.has?.(PermissionFlagsBits.ViewChannel)) return false;
  return null;
}

async function respondEphemeral(interaction, content) {
  const payload = { content, ephemeral: true, allowedMentions: { parse: [] } };
  if (interaction.deferred || interaction.replied) return interaction.followUp(payload);
  return interaction.reply(payload);
}
