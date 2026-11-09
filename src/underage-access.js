import { ChannelType, EmbedBuilder, PermissionFlagsBits } from "discord.js";

import { formatEmbedTitle, toRoyalBold } from "./embed-format.js";
import { SELF_ROLE_PINK } from "./self-role-catalog.js";

export const SUPPORT_CHANNEL_NAME = "support";

const SUPPORT_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
];
const THREAD_CHANNEL_TYPES = new Set([
  ChannelType.AnnouncementThread,
  ChannelType.PrivateThread,
  ChannelType.PublicThread,
]);
const underageQueues = new Map();
const supportChannelQueues = new Map();

export async function ensureSupportChannel(guild) {
  return runQueued(supportChannelQueues, guild.id, async () => {
    let inventory;
    try {
      inventory = await guild.channels.fetch();
    } catch (error) {
      throw new Error(`Could not inspect channels before finding #support (${error?.code ?? "unknown error"}).`);
    }
    if (!inventory?.values) throw new Error("The channel list is unavailable; Sugar did not create #support.");

    const matches = [...inventory.values()].filter(
      (channel) => String(channel.name ?? "").normalize("NFKC").toLowerCase() === SUPPORT_CHANNEL_NAME,
    );
    if (matches.length > 1) {
      throw new Error("More than one #support channel exists; Sugar did not create another.");
    }
    if (matches.length === 1) {
      const [channel] = matches;
      if (channel.type !== ChannelType.GuildText) {
        throw new Error("The existing #support channel is not a text channel; Sugar did not create another.");
      }
      if (channel.nsfw === true) {
        throw new Error("The existing #support channel is age-restricted; native Discord restrictions were not bypassed.");
      }
      return channel;
    }

    if (!botCanManageChannels(guild)) {
      throw new Error("Sugar needs Manage Channels to create the missing #support channel.");
    }
    try {
      return await guild.channels.create({
        name: SUPPORT_CHANNEL_NAME,
        type: ChannelType.GuildText,
        reason: "Create the requested support channel for self-declared under-18 members",
      });
    } catch (error) {
      throw new Error(`Could not create #support (${error?.code ?? "unknown error"}).`);
    }
  });
}

export async function applyUnderageAccess(guild, member, supportChannel, store) {
  return runQueued(underageQueues, `${guild.id}:${member.id}`, async () => {
    if (member.permissions?.has?.(PermissionFlagsBits.Administrator)) {
      return { changed: 0, skipped: 0, failed: 1, administrator: true };
    }
    if (
      !supportChannel ||
      supportChannel.guildId !== guild.id ||
      supportChannel.nsfw === true
    ) {
      throw new Error("A non-age-restricted #support text channel in this server is required.");
    }

    let inventory;
    try {
      inventory = await guild.channels.fetch();
    } catch (error) {
      throw new Error(`Could not inspect channels before applying under-18 access (${error?.code ?? "unknown error"}).`);
    }
    if (!inventory?.values) throw new Error("The channel list is unavailable; no under-18 access changes were made.");
    if (!inventory.has?.(supportChannel.id)) {
      throw new Error("#support is not in the current channel list; no under-18 access changes were made.");
    }

    const result = {
      changed: 0,
      skipped: 0,
      failed: 0,
      administrator: false,
      supportAvailable: false,
    };

    await grantSupportAccess(guild, supportChannel, member, store, result);
    if (!result.supportAvailable) return result;

    const current = store.getUnderageAccess(guild.id, member.id);

    for (const channel of inventory.values()) {
      if (channel.id === supportChannel.id) continue;
      if (!channel.permissionOverwrites?.edit || !channel.permissionOverwrites?.cache) {
        if (THREAD_CHANNEL_TYPES.has(channel.type)) {
          result.skipped += 1;
        } else {
          result.failed += 1;
        }
        continue;
      }

      const prior = current?.channels?.[channel.id];
      const previousViewChannel = explicitPermission(channel, "ViewChannel", member.id);
      if (previousViewChannel === false && !prior) {
        result.skipped += 1;
        continue;
      }
      if (!botCanManageChannel(channel, guild)) {
        result.failed += 1;
        continue;
      }

      const addedRecord = !prior;
      if (addedRecord) {
        try {
          store.saveUnderageChannelState(
            guild.id,
            member.id,
            supportChannel.id,
            channel.id,
            {
              hadOverwrite: Boolean(channel.permissionOverwrites.cache.get(member.id)),
              permissions: { ViewChannel: previousViewChannel },
            },
          );
        } catch {
          result.failed += 1;
          continue;
        }
      }

      try {
        await channel.permissionOverwrites.edit(
          member.id,
          { ViewChannel: false },
          "Apply the member's self-declared under-18 channel restriction",
        );
        if (previousViewChannel !== false) result.changed += 1;
      } catch {
        if (addedRecord) store.removeUnderageChannelState(guild.id, member.id, channel.id);
        result.failed += 1;
      }
    }

    return result;
  });
}

export async function restoreUnderageAccess(guild, member, store) {
  return runQueued(underageQueues, `${guild.id}:${member.id}`, async () => {
    const access = store.getUnderageAccess(guild.id, member.id);
    if (!access) return { changed: 0, failed: 0 };

    let inventory;
    try {
      inventory = await guild.channels.fetch();
    } catch (error) {
      throw new Error(`Could not inspect channels before restoring access (${error?.code ?? "unknown error"}).`);
    }
    if (!inventory?.get) throw new Error("The channel list is unavailable; saved permissions were not changed.");

    const result = { changed: 0, failed: 0 };
    for (const [channelId, record] of Object.entries(access.channels)) {
      const channel = inventory.get(channelId);
      if (!channel) {
        store.removeUnderageChannelState(guild.id, member.id, channelId);
        continue;
      }
      if (!channel.permissionOverwrites?.edit) {
        result.failed += 1;
        continue;
      }
      if (!botCanManageChannel(channel, guild)) {
        result.failed += 1;
        continue;
      }

      const permissions = Object.fromEntries(
        Object.entries(record.permissions).map(([key, value]) => [key, value]),
      );
      try {
        await channel.permissionOverwrites.edit(
          member.id,
          permissions,
          "Restore the channel visibility recorded before the member selected an age role",
        );
        store.removeUnderageChannelState(guild.id, member.id, channelId);
        result.changed += 1;
      } catch {
        result.failed += 1;
      }
    }

    const remaining = store.getUnderageAccess(guild.id, member.id);
    if (remaining && Object.keys(remaining.channels).length === 0) {
      store.clearUnderageAccess(guild.id, member.id);
    }
    return result;
  });
}

export function buildUnderageNoticeEmbed(
  supportChannel,
  { permissionFailures = 0, supportAvailable = true } = {},
) {
  const description = [
    "You selected 18- (under 18). This is self-declared, not age verification.",
    supportAvailable
      ? permissionFailures
        ? "Sugar restricted channels where it had permission. Some channel updates need administrator attention. Open a support ticket in #support if you need help."
        : "Sugar limits your channel visibility to #support. Open a support ticket there if you need help."
      : "Sugar could not confirm that you can use #support, so it did not restrict your other channels. Contact a server administrator for help.",
    "Discord's native age restrictions remain in force; Sugar never grants access to age-restricted channels.",
    permissionFailures
      ? `${permissionFailures} channel permission update(s) need an administrator's attention.`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return new EmbedBuilder()
    .setColor(SELF_ROLE_PINK)
    .setTitle(formatEmbedTitle("Under-18 access information"))
    .setDescription(description)
    .addFields({ name: toRoyalBold("Support"), value: `<#${supportChannel.id}>` })
    .setFooter({ text: toRoyalBold("Age is self-declared · Discord restrictions are unchanged") });
}

async function grantSupportAccess(guild, channel, member, store, result) {
  if (channel.nsfw === true) {
    throw new Error("The #support channel is age-restricted; native Discord restrictions were not bypassed.");
  }
  let directAllowCount = 0;
  const previous = Object.fromEntries(
    SUPPORT_PERMISSIONS.map((permission) => {
      const name = permissionName(permission);
      const state = explicitPermission(channel, name, member.id);
      if (state === true) directAllowCount += 1;
      return [name, state];
    }),
  );
  if (directAllowCount === SUPPORT_PERMISSIONS.length) {
    if (memberCanUseSupport(channel, member)) {
      result.skipped += 1;
      result.supportAvailable = true;
      return;
    }
  }
  if (!botCanManageChannel(channel, guild)) {
    result.failed += 1;
    return;
  }

  const addedRecord = !store.getUnderageAccess(guild.id, member.id)?.channels?.[channel.id];
  if (addedRecord) {
    try {
      store.saveUnderageChannelState(
        guild.id,
        member.id,
        channel.id,
        channel.id,
        {
          hadOverwrite: Boolean(channel.permissionOverwrites.cache.get(member.id)),
          permissions: previous,
        },
      );
    } catch {
      result.failed += 1;
      return;
    }
  }

  if (directAllowCount !== SUPPORT_PERMISSIONS.length) {
    try {
      await channel.permissionOverwrites.edit(
        member.id,
        Object.fromEntries(SUPPORT_PERMISSIONS.map((permission) => [permissionName(permission), true])),
        "Allow the member to reach the support channel for an under-18 self-declaration",
      );
      result.changed += 1;
    } catch {
      if (addedRecord) store.removeUnderageChannelState(guild.id, member.id, channel.id);
      result.failed += 1;
      return;
    }
  }

  if (!memberCanUseSupport(channel, member)) {
    result.failed += 1;
    return;
  }
  result.supportAvailable = true;
}

function memberCanUseSupport(channel, member) {
  try {
    return SUPPORT_PERMISSIONS.every((permission) =>
      Boolean(channel.permissionsFor(member)?.has(permission)),
    );
  } catch {
    return false;
  }
}

function explicitPermission(channel, name, memberId) {
  const memberOverwrite = channel.permissionOverwrites?.cache?.get(memberId);
  const flag = PermissionFlagsBits[name];
  if (memberOverwrite?.allow?.has?.(flag)) return true;
  if (memberOverwrite?.deny?.has?.(flag)) return false;
  return null;
}

function permissionName(permission) {
  return Object.entries(PermissionFlagsBits).find(([, value]) => value === permission)?.[0] ?? "";
}

function botCanManageChannels(guild) {
  try {
    return Boolean(guild.members?.me?.permissions?.has?.(PermissionFlagsBits.ManageChannels));
  } catch {
    return false;
  }
}

function botCanManageChannel(channel, guild) {
  try {
    return Boolean(
      guild.members?.me &&
        channel.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.ManageChannels),
    );
  } catch {
    return false;
  }
}

function runQueued(queues, key, operation) {
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  queues.set(key, current);
  return current.finally(() => {
    if (queues.get(key) === current) queues.delete(key);
  });
}
