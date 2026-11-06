import fs from "node:fs";
import path from "node:path";

const MAX_USERS = 1_000;
const MAX_MESSAGES_PER_USER = 12;
const MAX_MESSAGE_LENGTH = 1_200;

/**
 * Small, bounded per-guild/per-user conversation store.
 * Keep this file on FadeHost's persistent DATA_DIR volume.
 */
export class MemoryStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, "memory.json");
    this.data = this.#read();
  }

  getHistory(guildId, userId) {
    const key = memoryKey(guildId, userId);
    return (this.data[key] ?? []).map((entry) => ({ ...entry }));
  }

  addExchange(guildId, userId, userText, assistantText) {
    const key = memoryKey(guildId, userId);
    const history = this.data[key] ?? [];
    history.push(
      { role: "user", content: cleanText(userText), timestamp: Date.now() },
      { role: "assistant", content: cleanText(assistantText), timestamp: Date.now() },
    );
    this.data[key] = history.slice(-MAX_MESSAGES_PER_USER);

    const keys = Object.keys(this.data);
    while (keys.length > MAX_USERS) {
      delete this.data[keys.shift()];
    }
    this.#write();
  }

  clear(guildId, userId) {
    delete this.data[memoryKey(guildId, userId)];
    this.#write();
  }

  #read() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return {};
      throw new Error("Unable to read memory.json; existing memories were left untouched.");
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("memory.json is invalid JSON; repair it or restore a backup before restarting.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("memory.json has an invalid structure; refusing to overwrite it.");
    }

    const entries = Object.entries(parsed);
    if (entries.length > MAX_USERS || entries.some(([key, value]) =>
      !/^[0-9]{5,25}:[0-9]{5,25}$/.test(key) ||
      !Array.isArray(value) ||
      value.length > MAX_MESSAGES_PER_USER ||
      value.some((item) =>
        !item || !["user", "assistant"].includes(item.role) ||
        typeof item.content !== "string" || item.content.length > MAX_MESSAGE_LENGTH ||
        !Number.isFinite(item.timestamp)
      )
    )) {
      throw new Error("memory.json has an invalid structure; refusing to overwrite it.");
    }
    return parsed;
  }

  #write() {
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
}

function memoryKey(guildId, userId) {
  const guild = String(guildId ?? "");
  const user = String(userId ?? "");
  if (!/^\d{5,25}$/.test(guild) || !/^\d{5,25}$/.test(user)) {
    throw new Error("Valid guild and user IDs are required for memory.");
  }
  return `${guild}:${user}`;
}

function cleanText(value) {
  return [...String(value ?? "").trim()].slice(0, MAX_MESSAGE_LENGTH).join("");
}
