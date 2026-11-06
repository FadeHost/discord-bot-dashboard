import fs from "node:fs";
import path from "node:path";

export const MAX_PRIVATE_CHAT_MEMBERS = 5;
export const MAX_PRIVATE_CHATS = 1_000;
const MAX_DISPLAY_NAME_LENGTH = 40;
const MAX_PROTECTED_SETUP_MESSAGES = 2;

/**
 * Persistent owner/member metadata for private-chat channels.
 * This file belongs on the same persistent DATA_DIR volume as other bot data.
 */
export class PrivateChatStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, "private-chats.json");
    this.data = this.#read();
  }

  get(channelId) {
    const id = snowflake(channelId, "channel");
    const chat = this.data.chats[id];
    return chat ? copyChat(chat) : null;
  }

  listGuild(guildId) {
    const id = snowflake(guildId, "guild");
    return Object.entries(this.data.chats)
      .filter(([, chat]) => chat.guildId === id)
      .map(([channelId, chat]) => ({ channelId, ...copyChat(chat) }));
  }

  create({ channelId, guildId, ownerId, memberIds = [], displayName }) {
    const channel = snowflake(channelId, "channel");
    const guild = snowflake(guildId, "guild");
    const owner = snowflake(ownerId, "owner");
    const members = userIds(memberIds);
    const name = cleanDisplayName(displayName);

    if (members.length > MAX_PRIVATE_CHAT_MEMBERS) {
      throw new Error(`A private chat can have at most ${MAX_PRIVATE_CHAT_MEMBERS} invited people.`);
    }
    if (members.includes(owner)) {
      throw new Error("The chat owner cannot also be listed as an invited person.");
    }
    if (this.data.chats[channel]) {
      throw new Error("That channel is already registered as a private chat.");
    }
    if (Object.keys(this.data.chats).length >= MAX_PRIVATE_CHATS) {
      throw new Error("The private-chat limit has been reached.");
    }

    const chat = {
      guildId: guild,
      ownerId: owner,
      memberIds: members,
      displayName: name,
      createdAt: new Date().toISOString(),
    };
    this.#commit({
      ...this.data,
      chats: { ...this.data.chats, [channel]: chat },
    });
    return copyChat(chat);
  }

  addMembers(channelId, memberIds) {
    const channel = snowflake(channelId, "channel");
    const chat = this.data.chats[channel];
    if (!chat) throw new Error("This channel is not registered as a private chat.");

    const members = userIds(memberIds);
    if (members.includes(chat.ownerId)) {
      throw new Error("The chat owner cannot be added as an invited person.");
    }
    if (members.some((id) => chat.memberIds.includes(id))) {
      throw new Error("One or more selected people are already in this private chat.");
    }
    if (chat.memberIds.length + members.length > MAX_PRIVATE_CHAT_MEMBERS) {
      throw new Error(`A private chat can have at most ${MAX_PRIVATE_CHAT_MEMBERS} invited people.`);
    }

    const updated = { ...chat, memberIds: [...chat.memberIds, ...members] };
    this.#replaceChat(channel, updated);
    return copyChat(updated);
  }

  removeMembers(channelId, memberIds) {
    const channel = snowflake(channelId, "channel");
    const chat = this.data.chats[channel];
    if (!chat) throw new Error("This channel is not registered as a private chat.");

    const members = userIds(memberIds);
    if (members.includes(chat.ownerId)) {
      throw new Error("The chat owner cannot be removed.");
    }
    if (members.some((id) => !chat.memberIds.includes(id))) {
      throw new Error("One or more selected people are not invited to this private chat.");
    }

    const removed = new Set(members);
    const updated = { ...chat, memberIds: chat.memberIds.filter((id) => !removed.has(id)) };
    this.#replaceChat(channel, updated);
    return copyChat(updated);
  }

  rename(channelId, displayName) {
    const channel = snowflake(channelId, "channel");
    const chat = this.data.chats[channel];
    if (!chat) throw new Error("This channel is not registered as a private chat.");

    const updated = { ...chat, displayName: cleanDisplayName(displayName) };
    this.#replaceChat(channel, updated);
    return copyChat(updated);
  }

  getProtectedMessageIds(channelId) {
    const channel = snowflake(channelId, "channel");
    const chat = this.data.chats[channel];
    if (!chat || !Array.isArray(chat.protectedMessageIds) || chat.protectedMessageIds.length === 0) return null;
    return [...chat.protectedMessageIds];
  }

  setProtectedMessageIds(channelId, messageIds) {
    const channel = snowflake(channelId, "channel");
    const chat = this.data.chats[channel];
    if (!chat) throw new Error("This channel is not registered as a private chat.");
    if (!Array.isArray(messageIds)) throw new Error("A list of protected setup message IDs is required.");

    const ids = messageIds.map((id) => snowflake(id, "message"));
    if (ids.length > MAX_PROTECTED_SETUP_MESSAGES) {
      throw new Error("A private chat can protect only its welcome and command-guide messages.");
    }
    if (new Set(ids).size !== ids.length) {
      throw new Error("A protected setup message was listed more than once.");
    }

    const updated = { ...chat, protectedMessageIds: ids };
    this.#replaceChat(channel, updated);
    return [...ids];
  }

  isClearHistoryPanelReady(channelId) {
    const channel = snowflake(channelId, "channel");
    return this.data.chats[channel]?.clearHistoryPanelReady === true;
  }

  markClearHistoryPanelReady(channelId) {
    const channel = snowflake(channelId, "channel");
    const chat = this.data.chats[channel];
    if (!chat) throw new Error("This channel is not registered as a private chat.");

    this.#replaceChat(channel, { ...chat, clearHistoryPanelReady: true });
  }

  delete(channelId) {
    const channel = snowflake(channelId, "channel");
    if (!this.data.chats[channel]) return false;

    const chats = { ...this.data.chats };
    delete chats[channel];
    this.#commit({ ...this.data, chats });
    return true;
  }

  getLobbyGuideMessageId(lobbyChannelId) {
    const id = snowflake(lobbyChannelId, "lobby channel");
    return this.data.lobbyGuideMessageIds[id] ?? null;
  }

  setLobbyGuideMessageId(lobbyChannelId, messageId) {
    const lobby = snowflake(lobbyChannelId, "lobby channel");
    const message = snowflake(messageId, "message");
    this.#commit({
      ...this.data,
      lobbyGuideMessageIds: { ...this.data.lobbyGuideMessageIds, [lobby]: message },
    });
  }

  #replaceChat(channelId, chat) {
    this.#commit({
      ...this.data,
      chats: { ...this.data.chats, [channelId]: chat },
    });
  }

  #commit(nextData) {
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(nextData, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
    this.data = nextData;
  }

  #read() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { version: 1, chats: {}, lobbyGuideMessageIds: {} };
      }
      throw new Error("Unable to read private-chats.json; existing private-chat data was left untouched.");
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("private-chats.json is invalid JSON; repair it or restore a backup before restarting.");
    }

    if (
      !isObject(parsed) ||
      parsed.version !== 1 ||
      !isObject(parsed.chats) ||
      !isObject(parsed.lobbyGuideMessageIds) ||
      Object.keys(parsed.chats).length > MAX_PRIVATE_CHATS ||
      Object.entries(parsed.chats).some(([channelId, chat]) => !isValidChat(channelId, chat)) ||
      Object.entries(parsed.lobbyGuideMessageIds).some(
        ([channelId, messageId]) => !isSnowflake(channelId) || !isSnowflake(messageId),
      )
    ) {
      throw new Error("private-chats.json has an invalid structure; refusing to overwrite it.");
    }

    return parsed;
  }
}

function isValidChat(channelId, chat) {
  return (
    isSnowflake(channelId) &&
    isObject(chat) &&
    isSnowflake(chat.guildId) &&
    isSnowflake(chat.ownerId) &&
    Array.isArray(chat.memberIds) &&
    chat.memberIds.length <= MAX_PRIVATE_CHAT_MEMBERS &&
    chat.memberIds.every(isSnowflake) &&
    new Set(chat.memberIds).size === chat.memberIds.length &&
    !chat.memberIds.includes(chat.ownerId) &&
    typeof chat.displayName === "string" &&
    chat.displayName.trim().length > 0 &&
    [...chat.displayName].length <= MAX_DISPLAY_NAME_LENGTH &&
    typeof chat.createdAt === "string" &&
    Number.isFinite(Date.parse(chat.createdAt)) &&
    (!Object.hasOwn(chat, "protectedMessageIds") ||
      (Array.isArray(chat.protectedMessageIds) &&
        chat.protectedMessageIds.length <= MAX_PROTECTED_SETUP_MESSAGES &&
        chat.protectedMessageIds.every(isSnowflake) &&
        new Set(chat.protectedMessageIds).size === chat.protectedMessageIds.length)) &&
    (!Object.hasOwn(chat, "clearHistoryPanelReady") || typeof chat.clearHistoryPanelReady === "boolean")
  );
}

function userIds(values) {
  if (!Array.isArray(values)) throw new Error("A list of Discord user IDs is required.");
  const ids = values.map((value) => snowflake(value, "user"));
  if (new Set(ids).size !== ids.length) throw new Error("The same person was selected more than once.");
  return ids;
}

function snowflake(value, label) {
  const id = String(value ?? "");
  if (!isSnowflake(id)) throw new Error(`A valid Discord ${label} ID is required.`);
  return id;
}

function isSnowflake(value) {
  return typeof value === "string" && /^\d{5,25}$/.test(value);
}

function cleanDisplayName(value) {
  const name = String(value ?? "").normalize("NFC").trim();
  if (!name || [...name].length > MAX_DISPLAY_NAME_LENGTH || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new Error(`Chat names must contain 1–${MAX_DISPLAY_NAME_LENGTH} visible characters.`);
  }
  return name;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function copyChat(chat) {
  return {
    ...chat,
    memberIds: [...chat.memberIds],
    ...(Array.isArray(chat.protectedMessageIds) ? { protectedMessageIds: [...chat.protectedMessageIds] } : {}),
    ...(typeof chat.clearHistoryPanelReady === "boolean"
      ? { clearHistoryPanelReady: chat.clearHistoryPanelReady }
      : {}),
  };
}
