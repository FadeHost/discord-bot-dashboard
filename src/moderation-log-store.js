import fs from "node:fs";
import path from "node:path";

const VERSION = 1;
const MAX_ENTRIES = 1_000;
const MAX_MESSAGE_IDS_PER_ENTRY = 100;
const SNOWFLAKE = /^\d{5,25}$/;
const ENTRY_ID = /^[0-9a-f-]{36}$/i;
const STATUSES = new Set(["started", "completed", "partial"]);

/**
 * Private, bounded moderation audit records stored on the same persistent
 * DATA_DIR volume as the rest of the bot's data. Message content is never kept.
 */
export class ModerationLogStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, "moderation-logs.json");
    this.data = this.#read();
    this.privateMessageIds = new Set(this.data.entries.flatMap((entry) => entry.messageIds));
  }

  begin(input) {
    const entry = normalizeEntry(input);
    if (entry.status !== "started") throw new Error("A new moderation entry must start in the started state.");
    if (this.data.entries.some((item) => item.id === entry.id)) {
      throw new Error("That moderation operation is already recorded.");
    }

    this.#commit({
      version: VERSION,
      entries: [...this.data.entries, entry].slice(-MAX_ENTRIES),
    });
    return copyEntry(entry);
  }

  finish(id, result) {
    const index = this.data.entries.findIndex((entry) => entry.id === id);
    if (index < 0) throw new Error("The moderation operation was not found in the private log.");
    if (!result || !["completed", "partial"].includes(result.status)) {
      throw new Error("A completed or partial moderation result is required.");
    }

    const previous = this.data.entries[index];
    const entry = normalizeEntry({
      ...previous,
      ...result,
      id: previous.id,
      guildId: previous.guildId,
      channelId: previous.channelId,
      actorId: previous.actorId,
      targetId: previous.targetId,
      action: previous.action,
      requestedCount: previous.requestedCount,
      selectedCount: previous.selectedCount,
      createdAt: previous.createdAt,
      completedAt: result.completedAt ?? new Date().toISOString(),
    });
    const entries = [...this.data.entries];
    entries[index] = entry;
    this.#commit({ version: VERSION, entries });
    return copyEntry(entry);
  }

  isPrivateModerationDelete(messageId) {
    return this.privateMessageIds.has(String(messageId ?? ""));
  }

  list() {
    return this.data.entries.map(copyEntry);
  }

  #commit(nextData) {
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(nextData, null, 2), { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, this.file);
    this.data = nextData;
    this.privateMessageIds = new Set(nextData.entries.flatMap((entry) => entry.messageIds));
  }

  #read() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return { version: VERSION, entries: [] };
      throw new Error("Unable to read moderation-logs.json; existing moderation records were left untouched.");
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("moderation-logs.json is invalid JSON; repair it or restore a backup before restarting.");
    }

    if (
      !isObject(parsed) ||
      parsed.version !== VERSION ||
      !Array.isArray(parsed.entries) ||
      parsed.entries.length > MAX_ENTRIES ||
      parsed.entries.some((entry) => !isValidEntry(entry))
    ) {
      throw new Error("moderation-logs.json has an invalid structure; refusing to overwrite it.");
    }
    return parsed;
  }
}

function normalizeEntry(input = {}) {
  const entry = {
    id: String(input.id ?? ""),
    action: input.action,
    guildId: String(input.guildId ?? ""),
    channelId: String(input.channelId ?? ""),
    actorId: String(input.actorId ?? ""),
    targetId: input.targetId === null ? null : String(input.targetId ?? ""),
    requestedCount: input.requestedCount,
    selectedCount: input.selectedCount,
    messageIds: input.messageIds,
    status: input.status,
    deletedCount: input.deletedCount ?? 0,
    skippedCount: input.skippedCount ?? 0,
    failedCount: input.failedCount ?? 0,
    createdAt: input.createdAt ?? new Date().toISOString(),
    ...(input.completedAt ? { completedAt: input.completedAt } : {}),
  };
  if (!isValidEntry(entry)) throw new Error("The moderation record has an invalid structure.");
  return entry;
}

function isValidEntry(entry) {
  return (
    isObject(entry) &&
    ENTRY_ID.test(entry.id) &&
    entry.action === "mod-delete" &&
    SNOWFLAKE.test(entry.guildId) &&
    SNOWFLAKE.test(entry.channelId) &&
    SNOWFLAKE.test(entry.actorId) &&
    (entry.targetId === null || SNOWFLAKE.test(entry.targetId)) &&
    isCount(entry.requestedCount) &&
    isCount(entry.selectedCount) &&
    entry.selectedCount <= entry.requestedCount &&
    Array.isArray(entry.messageIds) &&
    entry.messageIds.length <= MAX_MESSAGE_IDS_PER_ENTRY &&
    entry.messageIds.every((id) => typeof id === "string" && SNOWFLAKE.test(id)) &&
    new Set(entry.messageIds).size === entry.messageIds.length &&
    STATUSES.has(entry.status) &&
    isCount(entry.deletedCount) &&
    isCount(entry.skippedCount) &&
    isCount(entry.failedCount) &&
    typeof entry.createdAt === "string" &&
    Number.isFinite(Date.parse(entry.createdAt)) &&
    (!Object.hasOwn(entry, "completedAt") ||
      (typeof entry.completedAt === "string" && Number.isFinite(Date.parse(entry.completedAt))))
  );
}

function isCount(value) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_MESSAGE_IDS_PER_ENTRY;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function copyEntry(entry) {
  return { ...entry, messageIds: [...entry.messageIds] };
}
