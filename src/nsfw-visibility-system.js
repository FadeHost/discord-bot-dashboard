import {
  ActionRowBuilder,
  Events,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from "discord.js";

const CONTROL_ID = "nsfw-visibility:action";
const SUPPORTED_ACTIONS = new Set(["show", "hide"]);

export function buildNsfwVisibilityControlRow() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(CONTROL_ID)
      .setPlaceholder("Age-restricted channels")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel("Show NSFW channels")
          .setDescription("Restore only your saved access")
          .setValue("show"),
        new StringSelectMenuOptionBuilder()
          .setLabel("Hide NSFW channels")
          .setDescription("Hide channels you can already access")
          .setValue("hide"),
      ),
  );
}

export function attachNsfwVisibilitySystem(client, { store, selfRoles }) {
  if (!store) throw new Error("An NSFW visibility store is required.");
  if (!selfRoles) throw new Error("A self-role store is required for the panel control.");

  client.on(Events.ChannelDelete, (channel) => {
    if (!channel.guildId) return;
    try {
      store.clearChannel(channel.guildId, channel.id);
    } catch (error) {
      console.error(`[nsfw-visibility] could not clear deleted-channel metadata: ${error.message}`);
    }
  });

  client.on(Events.InteractionCreate, (interaction) => {
    if (!isNsfwVisibilityControl(interaction)) return;
    void handleNsfwVisibilityInteraction(interaction, { store, selfRoles, client }).catch(async () => {
      console.error(`[nsfw-visibility] control failed in guild ${interaction.guildId ?? "unknown"}`);
      await respondEphemeral(interaction, "Sugar could not update NSFW channel visibility. No native age restrictions were changed.");
    });
  });
}

export function isNsfwVisibilityControl(interaction) {
  return Boolean(interaction.isStringSelectMenu?.() && interaction.customId === CONTROL_ID);
}

export async function handleNsfwVisibilityInteraction(interaction, { store, selfRoles, client }) {
  if (!interaction.inGuild?.() || !interaction.guild || !interaction.guildId) {
    return respondEphemeral(interaction, "Show/hide controls can only be used inside the server.");
  }

  if (!isActivePanelControl(interaction, selfRoles, client)) {
    return respondEphemeral(interaction, "This self-role panel control is no longer active.");
  }

  const action = Array.isArray(interaction.values) && interaction.values.length === 1 ? interaction.values[0] : null;
  if (!SUPPORTED_ACTIONS.has(action)) {
    return respondEphemeral(interaction, "Choose one valid show or hide action.");
  }

  await interaction.deferReply({ ephemeral: true });
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const result = await applyNsfwVisibility(interaction.guild, member, store, action);
  return interaction.editReply(buildVisibilityResult(action, result));
}

function isActivePanelControl(interaction, selfRoles, client) {
  if (!selfRoles?.getGuild || !client?.user?.id) return false;
  const panel = selfRoles.getGuild(interaction.guildId);
  return Boolean(
    panel.channelId === interaction.channelId &&
      panel.messageId === interaction.message?.id &&
      interaction.message?.author?.id === client.user.id,
  );
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
