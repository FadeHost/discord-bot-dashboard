import fs from "node:fs";
import path from "node:path";

import { isSelfRoleKey } from "./self-role-catalog.js";

const STORE_VERSION = 1;
const MAX_GUILDS = 500;
const MAX_TICKETS_PER_GUILD = 10_000;
const SNOWFLAKE = /^\d{5,25}$/u;

function emptyGuild() {
  return { channelId: null, messageId: null, staffRoleId: null, roleIds: {}, colorRoleIds: {}, tickets: {} };
}

/**
 * Durable metadata for the self-role panel and private review channels.
 * Kept separately so this feature never rewrites settings.json or private-chats.json.
 */
export class SelfRoleStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, "self-roles.json");
    this.data = this.#read();
  }

  getGuild(guildId) {
    const id = snowflake(guildId, "guild");
    return copyGuild(this.data.guilds[id] ?? emptyGuild());
  }

  setChannel(guildId, channelId, messageId = null) {
    const id = snowflake(guildId, "guild");
    const channel = channelId === null ? null : snowflake(channelId, "channel");
    const message = messageId === null ? null : snowflake(messageId, "message");
    if (!channel && message) throw new Error("A panel message cannot be saved without its channel.");

    this.#replaceGuild(id, {
      ...this.#guild(id),
      channelId: channel,
      messageId: message,
    });
  }

  clearChannel(guildId, channelId) {
    const id = snowflake(guildId, "guild");
    const channel = snowflake(channelId, "channel");
    const current = this.#guild(id);
    if (current.channelId !== channel) return false;

    this.#replaceGuild(id, { ...current, channelId: null, messageId: null });
    return true;
  }

  setRoleId(guildId, roleKey, roleId) {
    const id = snowflake(guildId, "guild");
    if (roleKey !== "staff" && !isSelfRoleKey(roleKey)) {
      throw new Error("That role is not part of the approved self-role list.");
    }
    const parsed = roleId === null ? null : snowflake(roleId, "role");
    const current = this.#guild(id);
    const roleIds = { ...current.roleIds };
    let staffRoleId = current.staffRoleId;

    if (roleKey === "staff") {
      staffRoleId = parsed;
    } else if (parsed) {
      roleIds[roleKey] = parsed;
    } else {
      delete roleIds[roleKey];
    }

    const allIds = [
      ...Object.values(roleIds),
      ...Object.values(current.colorRoleIds),
      ...(staffRoleId ? [staffRoleId] : []),
    ];
    if (new Set(allIds).size !== allIds.length) {
      throw new Error("A Discord role cannot be used for more than one self-role option.");
    }

    this.#replaceGuild(id, { ...current, roleIds, staffRoleId });
  }

  setColorRoleId(guildId, memberId, roleId) {
    const id = snowflake(guildId, "guild");
    const member = snowflake(memberId, "member");
    const parsed = roleId === null ? null : snowflake(roleId, "role");
    const current = this.#guild(id);
    const colorRoleIds = { ...current.colorRoleIds };
    if (parsed) {
      colorRoleIds[member] = parsed;
    } else {
      delete colorRoleIds[member];
    }

    const allIds = [
      ...Object.values(current.roleIds),
      ...Object.values(colorRoleIds),
      ...(current.staffRoleId ? [current.staffRoleId] : []),
    ];
    if (new Set(allIds).size !== allIds.length) {
      throw new Error("A Discord role cannot be used for more than one self-role option.");
    }

    this.#replaceGuild(id, { ...current, colorRoleIds });
  }

  getTicket(guildId, channelId) {
    const id = snowflake(guildId, "guild");
    const channel = snowflake(channelId, "channel");
    const ticket = this.#guild(id).tickets[channel];
    return ticket ? { ...ticket } : null;
  }

  getOpenTicket(guildId, memberId) {
    const id = snowflake(guildId, "guild");
    const member = snowflake(memberId, "member");
    const entry = Object.entries(this.#guild(id).tickets).find(
      ([, ticket]) => ticket.memberId === member && ticket.status === "open",
    );
    return entry ? { channelId: entry[0], ...entry[1] } : null;
  }

  setTicket(guildId, { channelId, memberId }) {
    const id = snowflake(guildId, "guild");
    const channel = snowflake(channelId, "channel");
    const member = snowflake(memberId, "member");
    const current = this.#guild(id);
    const existing = current.tickets[channel];
    if (existing) throw new Error("That review channel is already registered.");
    if (this.getOpenTicket(id, member)) throw new Error("This member already has an open review ticket.");
    if (Object.keys(current.tickets).length >= MAX_TICKETS_PER_GUILD) {
      throw new Error("The review-ticket history limit has been reached.");
    }

    const ticket = { memberId: member, status: "open", createdAt: new Date().toISOString() };
    this.#replaceGuild(id, {
      ...current,
      tickets: { ...current.tickets, [channel]: ticket },
    });
    return { channelId: channel, ...ticket };
  }

  closeTicket(guildId, channelId, closedBy) {
    const id = snowflake(guildId, "guild");
    const channel = snowflake(channelId, "channel");
    const actor = snowflake(closedBy, "staff member");
    const current = this.#guild(id);
    const ticket = current.tickets[channel];
    if (!ticket) throw new Error("This channel is not a registered review ticket.");
    if (ticket.status !== "open") return { channelId: channel, ...ticket };

    const updated = {
      ...ticket,
      status: "closed",
      closedAt: new Date().toISOString(),
      closedBy: actor,
    };
    this.#replaceGuild(id, {
      ...current,
      tickets: { ...current.tickets, [channel]: updated },
    });
    return { channelId: channel, ...updated };
  }

  removeTicket(guildId, channelId) {
    const id = snowflake(guildId, "guild");
    const channel = snowflake(channelId, "channel");
    const current = this.#guild(id);
    if (!current.tickets[channel]) return false;
    const tickets = { ...current.tickets };
    delete tickets[channel];
    this.#replaceGuild(id, { ...current, tickets });
    return true;
  }

  #guild(guildId) {
    return copyGuild(this.data.guilds[guildId] ?? emptyGuild());
  }

  #replaceGuild(guildId, guild) {
    const next = { ...this.data, guilds: { ...this.data.guilds, [guildId]: guild } };
    validateData(next);
    this.#commit(next);
  }

  #commit(next) {
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
    this.data = next;
  }

  #read() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return { version: STORE_VERSION, guilds: {} };
      throw new Error("Unable to read self-roles.json; existing bot data was left untouched.");
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("self-roles.json is invalid JSON; repair it or restore a backup before restarting.");
    }

    try {
      validateData(parsed);
    } catch {
      throw new Error("self-roles.json has an invalid structure; refusing to overwrite it.");
    }
    return parsed;
  }
}

function validateData(data) {
  if (
    !isObject(data) ||
    data.version !== STORE_VERSION ||
    !isObject(data.guilds) ||
    Object.keys(data.guilds).length > MAX_GUILDS ||
    Object.entries(data.guilds).some(([guildId, guild]) => !isSnowflake(guildId) || !isValidGuild(guild))
  ) {
    throw new Error("Invalid self-role data.");
  }
}

function isValidGuild(guild) {
  if (
    !isObject(guild) ||
    !nullableSnowflake(guild.channelId) ||
    !nullableSnowflake(guild.messageId) ||
    !nullableSnowflake(guild.staffRoleId) ||
    !isObject(guild.roleIds) ||
    (guild.colorRoleIds !== undefined && !isObject(guild.colorRoleIds)) ||
    !isObject(guild.tickets) ||
    Object.keys(guild.roleIds).length > 100 ||
    Object.keys(guild.colorRoleIds ?? {}).length > 100_000 ||
    Object.keys(guild.tickets).length > MAX_TICKETS_PER_GUILD ||
    (!guild.channelId && guild.messageId) ||
    Object.entries(guild.roleIds).some(([key, roleId]) => !isSelfRoleKey(key) || !isSnowflake(roleId)) ||
    Object.entries(guild.colorRoleIds ?? {}).some(
      ([memberId, roleId]) => !isSnowflake(memberId) || !isSnowflake(roleId),
    ) ||
    new Set([
      ...Object.values(guild.roleIds),
      ...Object.values(guild.colorRoleIds ?? {}),
      ...(guild.staffRoleId ? [guild.staffRoleId] : []),
    ]).size !== Object.keys(guild.roleIds).length +
      Object.keys(guild.colorRoleIds ?? {}).length +
      (guild.staffRoleId ? 1 : 0) ||
    Object.entries(guild.tickets).some(([channelId, ticket]) => !isValidTicket(channelId, ticket))
  ) {
    return false;
  }

  const openMembers = Object.values(guild.tickets)
    .filter((ticket) => ticket.status === "open")
    .map((ticket) => ticket.memberId);
  return new Set(openMembers).size === openMembers.length;
}

function isValidTicket(channelId, ticket) {
  return (
    isSnowflake(channelId) &&
    isObject(ticket) &&
    isSnowflake(ticket.memberId) &&
    (ticket.status === "open" || ticket.status === "closed") &&
    typeof ticket.createdAt === "string" &&
    Number.isFinite(Date.parse(ticket.createdAt)) &&
    (ticket.status === "open"
      ? !Object.hasOwn(ticket, "closedAt") && !Object.hasOwn(ticket, "closedBy")
      : typeof ticket.closedAt === "string" &&
        Number.isFinite(Date.parse(ticket.closedAt)) &&
        isSnowflake(ticket.closedBy))
  );
}

function nullableSnowflake(value) {
  return value === null || isSnowflake(value);
}

function snowflake(value, label) {
  const id = String(value ?? "");
  if (!isSnowflake(id)) throw new Error(`A valid Discord ${label} ID is required.`);
  return id;
}

function isSnowflake(value) {
  return typeof value === "string" && SNOWFLAKE.test(value);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function copyGuild(guild) {
  return {
    ...guild,
    roleIds: { ...guild.roleIds },
    colorRoleIds: { ...(guild.colorRoleIds ?? {}) },
    tickets: Object.fromEntries(
      Object.entries(guild.tickets).map(([channelId, ticket]) => [channelId, { ...ticket }]),
    ),
  };
}
