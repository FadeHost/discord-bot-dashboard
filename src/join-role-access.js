import { ChannelType, PermissionFlagsBits } from "discord.js";

export const JOIN_ROLE_ID = "1568188492704522330";
export const JOIN_ROLE_CATEGORY_ID = "1567715604818038896";

const configuredGuilds = new Set();
const pendingGuilds = new Map();
const configurationVersions = new Map();

/**
 * Make the configured join role visible only in its onboarding category.
 * Other guilds keep their existing role behavior.
 */
export async function ensureJoinRoleVisibility(guild, suppliedRole = null) {
  if (!guild?.id) return false;

  let role = suppliedRole;
  if (!role) {
    role = guild.roles?.cache?.get?.(JOIN_ROLE_ID) ?? null;
    if (!role && typeof guild.roles?.fetch === "function") {
      try {
        const roles = await guild.roles.fetch();
        role = roles?.get?.(JOIN_ROLE_ID) ?? null;
      } catch (error) {
        console.error(`[join-role] could not fetch roles in guild ${guild.id} (${error?.code ?? "unknown error"})`);
        return false;
      }
    }
  }

  if (!role || role.id !== JOIN_ROLE_ID) return true;
  if (configuredGuilds.has(guild.id)) return true;
  if (pendingGuilds.has(guild.id)) return pendingGuilds.get(guild.id);

  const pending = configureCurrentChannelSet(guild, role)
    .catch((error) => {
      console.error(`[join-role] could not configure role visibility in guild ${guild.id} (${error?.code ?? "unknown error"})`);
      return false;
    })
    .finally(() => pendingGuilds.delete(guild.id));
  pendingGuilds.set(guild.id, pending);
  return pending;
}

export function invalidateJoinRoleVisibility(guildId) {
  configuredGuilds.delete(guildId);
  configurationVersions.set(guildId, (configurationVersions.get(guildId) ?? 0) + 1);
}

async function configureCurrentChannelSet(guild, role) {
  let version = configurationVersions.get(guild.id) ?? 0;
  while (true) {
    if (!await applyJoinRoleVisibility(guild, role)) return false;
    const currentVersion = configurationVersions.get(guild.id) ?? 0;
    if (currentVersion === version) {
      configuredGuilds.add(guild.id);
      return true;
    }
    version = currentVersion;
  }
}

async function applyJoinRoleVisibility(guild, role) {
  if (role.managed || role.permissions?.has?.(PermissionFlagsBits.Administrator)) {
    console.error(`[join-role] role ${JOIN_ROLE_ID} is managed or has Administrator in guild ${guild.id}`);
    return false;
  }

  let channels;
  try {
    channels = await guild.channels.fetch();
  } catch (error) {
    console.error(`[join-role] could not list channels in guild ${guild.id} (${error?.code ?? "unknown error"})`);
    return false;
  }

  if (!channels?.values) {
    console.error(`[join-role] channel list is unavailable in guild ${guild.id}`);
    return false;
  }

  const category = channels.get?.(JOIN_ROLE_CATEGORY_ID) ??
    [...channels.values()].find((channel) => channel.id === JOIN_ROLE_CATEGORY_ID);
  if (
    category?.type !== ChannelType.GuildCategory ||
    (category.guildId && category.guildId !== guild.id)
  ) {
    console.error(`[join-role] category ${JOIN_ROLE_CATEGORY_ID} was not found in guild ${guild.id}`);
    return false;
  }

  let botMember = guild.members?.me;
  if (!botMember && typeof guild.members?.fetchMe === "function") {
    try {
      botMember = await guild.members.fetchMe();
    } catch (error) {
      console.error(`[join-role] could not inspect bot permissions in guild ${guild.id} (${error?.code ?? "unknown error"})`);
      return false;
    }
  }
  if (!botMember) {
    console.error(`[join-role] bot membership is unavailable in guild ${guild.id}`);
    return false;
  }

  const changes = [];
  for (const channel of channels.values()) {
    if (channel.isThread?.()) continue;

    const parent = channel.parentId ? channels.get?.(channel.parentId) : null;
    if (parent?.type === ChannelType.GuildCategory && channel.permissionsLocked === true) {
      // Synced channels inherit their category's overwrite; editing them would unsync them.
      continue;
    }

    if (typeof channel.permissionOverwrites?.edit !== "function") {
      console.error(`[join-role] cannot safely configure channel ${channel.id} in guild ${guild.id}`);
      return false;
    }
    if (!channel.permissionsFor?.(botMember)?.has?.(PermissionFlagsBits.ManageChannels)) {
      console.error(`[join-role] bot needs Manage Channels to configure role visibility in guild ${guild.id}`);
      return false;
    }

    const allowed = channel.id === JOIN_ROLE_CATEGORY_ID ||
      channel.parentId === JOIN_ROLE_CATEGORY_ID ||
      channel.parent?.id === JOIN_ROLE_CATEGORY_ID;
    const previousOverwrite = channel.permissionOverwrites.cache?.get?.(role.id) ?? null;
    const previous = viewPermissionState(previousOverwrite);
    if (previous !== allowed) {
      changes.push({ channel, allowed, previous, hadOverwrite: Boolean(previousOverwrite) });
    }
  }

  const categoryIsIncluded = channels.get?.(JOIN_ROLE_CATEGORY_ID) ??
    [...channels.values()].find((channel) => channel.id === JOIN_ROLE_CATEGORY_ID);
  if (!categoryIsIncluded) return false;

  const applied = [];
  for (const change of changes) {
    try {
      await change.channel.permissionOverwrites.edit(
        role.id,
        { ViewChannel: change.allowed },
        "Limit the join role to its onboarding category",
      );
      applied.push(change);
    } catch (error) {
      console.error(
        `[join-role] could not configure channel ${change.channel.id} in guild ${guild.id} (${error?.code ?? "unknown error"})`,
      );
      await restoreChanges(role.id, guild, applied);
      return false;
    }
  }

  return true;
}

async function restoreChanges(roleId, guild, changes) {
  for (const change of [...changes].reverse()) {
    try {
      if (!change.hadOverwrite) {
        await change.channel.permissionOverwrites.delete(
          roleId,
          "Restore join-role visibility after an incomplete update",
        );
      } else {
        await change.channel.permissionOverwrites.edit(
          roleId,
          { ViewChannel: change.previous },
          "Restore join-role visibility after an incomplete update",
        );
      }
    } catch (error) {
      console.error(
        `[join-role] could not roll back channel ${change.channel.id} in guild ${guild.id} (${error?.code ?? "unknown error"})`,
      );
    }
  }
}

function viewPermissionState(overwrite) {
  if (overwrite?.allow?.has?.(PermissionFlagsBits.ViewChannel)) return true;
  if (overwrite?.deny?.has?.(PermissionFlagsBits.ViewChannel)) return false;
  return null;
}
