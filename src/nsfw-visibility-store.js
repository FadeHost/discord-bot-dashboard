import fs from "node:fs";
import path from "node:path";

const VERSION = 1;

/**
 * Stores only the member's prior View Channel state for channels hidden by
 * the NSFW visibility control. It never stores role permissions or channel
 * NSFW flags.
 */
export class NsfwVisibilityStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, "nsfw-visibility.json");
    this.data = this.#read();
  }

  get(guildId, channelId, memberId) {
    const guild = snowflake(guildId, "guild");
    const channel = snowflake(channelId, "channel");
    const member = snowflake(memberId, "member");
    const record = this.data.hidden[guild]?.[channel]?.[member];
    return record ? { ...record } : null;
  }

  listMember(guildId, memberId) {
    const guild = snowflake(guildId, "guild");
    const member = snowflake(memberId, "member");
    const records = this.data.hidden[guild] ?? {};

    return Object.entries(records)
      .filter(([, members]) => Object.hasOwn(members, member))
      .map(([channelId, members]) => ({ channelId, ...members[member] }));
  }

  save(guildId, channelId, memberId, record) {
    const guild = snowflake(guildId, "guild");
    const channel = snowflake(channelId, "channel");
    const member = snowflake(memberId, "member");
    const clean = cleanRecord(record);
    if (this.data.hidden[guild]?.[channel]?.[member]) {
      throw new Error("This NSFW channel already has a saved visibility override for this member.");
    }

    const next = {
      version: VERSION,
      hidden: {
        ...this.data.hidden,
        [guild]: {
          ...(this.data.hidden[guild] ?? {}),
          [channel]: {
            ...(this.data.hidden[guild]?.[channel] ?? {}),
            [member]: clean,
          },
        },
      },
    };
    this.#write(next);
    return { ...clean };
  }

  delete(guildId, channelId, memberId) {
    const guild = snowflake(guildId, "guild");
    const channel = snowflake(channelId, "channel");
    const member = snowflake(memberId, "member");
    const current = this.data.hidden[guild]?.[channel]?.[member];
    if (!current) return false;

    const hidden = { ...this.data.hidden };
    const guildRecords = { ...hidden[guild] };
    const channelRecords = { ...guildRecords[channel] };
    delete channelRecords[member];
    if (Object.keys(channelRecords).length) {
      guildRecords[channel] = channelRecords;
    } else {
      delete guildRecords[channel];
    }
    if (Object.keys(guildRecords).length) {
      hidden[guild] = guildRecords;
    } else {
      delete hidden[guild];
    }

    this.#write({ version: VERSION, hidden });
    return true;
  }

  clearChannel(guildId, channelId) {
    const guild = snowflake(guildId, "guild");
    const channel = snowflake(channelId, "channel");
    if (!this.data.hidden[guild]?.[channel]) return 0;

    const count = Object.keys(this.data.hidden[guild][channel]).length;
    const hidden = { ...this.data.hidden, [guild]: { ...this.data.hidden[guild] } };
    delete hidden[guild][channel];
    if (!Object.keys(hidden[guild]).length) delete hidden[guild];
    this.#write({ version: VERSION, hidden });
    return count;
  }

  #read() {
    let contents;
    try {
      contents = fs.readFileSync(this.file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return { version: VERSION, hidden: {} };
      throw new Error("Unable to read nsfw-visibility.json; existing channel visibility data was left untouched.");
    }

    let parsed;
    try {
      parsed = JSON.parse(contents);
    } catch {
      throw new Error("nsfw-visibility.json is invalid JSON; repair it or restore a backup before restarting.");
    }

    if (
      !isObject(parsed) ||
      parsed.version !== VERSION ||
      !isObject(parsed.hidden) ||
      Object.entries(parsed.hidden).some(
        ([guildId, channels]) =>
          !isSnowflake(guildId) ||
          !isObject(channels) ||
          Object.entries(channels).some(
            ([channelId, members]) =>
              !isSnowflake(channelId) ||
              !isObject(members) ||
              Object.entries(members).some(
                ([memberId, record]) => !isSnowflake(memberId) || !isValidRecord(record),
              ),
          ),
      )
    ) {
      throw new Error("nsfw-visibility.json has an invalid structure; refusing to overwrite it.");
    }

    return parsed;
  }

  #write(next) {
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
    this.data = next;
  }
}

function cleanRecord(record) {
  if (
    !isObject(record) ||
    typeof record.hadOverwrite !== "boolean" ||
    (record.previousViewChannel !== null && typeof record.previousViewChannel !== "boolean") ||
    (!record.hadOverwrite && record.previousViewChannel !== null) ||
    (record.hiddenAt !== undefined && (typeof record.hiddenAt !== "string" || !Number.isFinite(Date.parse(record.hiddenAt))))
  ) {
    throw new Error("A valid previous member channel permission state is required.");
  }
  return {
    hadOverwrite: record.hadOverwrite,
    previousViewChannel: record.previousViewChannel,
    hiddenAt: record.hiddenAt ?? new Date().toISOString(),
  };
}

function isValidRecord(record) {
  return (
    isObject(record) &&
    typeof record.hadOverwrite === "boolean" &&
    (record.previousViewChannel === null || typeof record.previousViewChannel === "boolean") &&
    (record.hadOverwrite || record.previousViewChannel === null) &&
    typeof record.hiddenAt === "string" &&
    Number.isFinite(Date.parse(record.hiddenAt))
  );
}

function snowflake(value, label) {
  const id = String(value ?? "");
  if (!isSnowflake(id)) throw new Error(`A valid Discord ${label} ID is required.`);
  return id;
}

function isSnowflake(value) {
  return typeof value === "string" && /^\d{5,25}$/u.test(value);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
