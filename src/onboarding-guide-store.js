import fs from "node:fs";
import path from "node:path";

export class OnboardingGuideStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, "onboarding-guide.json");
    this.data = this.#read();
  }

  getMessageId(channelId) {
    const channel = snowflake(channelId, "channel");
    return this.data.messageIds[channel] ?? null;
  }

  setMessageId(channelId, messageId) {
    const channel = snowflake(channelId, "channel");
    const message = snowflake(messageId, "message");
    this.#commit({
      ...this.data,
      messageIds: { ...this.data.messageIds, [channel]: message },
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
      if (error?.code === "ENOENT") return { version: 1, messageIds: {} };
      throw new Error("Unable to read onboarding-guide.json; existing guide data was left untouched.");
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("onboarding-guide.json is invalid JSON; repair it or restore a backup before restarting.");
    }

    if (
      !isObject(parsed) ||
      parsed.version !== 1 ||
      !isObject(parsed.messageIds) ||
      Object.entries(parsed.messageIds).some(
        ([channelId, messageId]) => !isSnowflake(channelId) || !isSnowflake(messageId),
      )
    ) {
      throw new Error("onboarding-guide.json has an invalid structure; refusing to overwrite it.");
    }

    return parsed;
  }
}

function snowflake(value, label) {
  const id = String(value ?? "");
  if (!isSnowflake(id)) throw new Error(`A valid Discord ${label} ID is required.`);
  return id;
}

function isSnowflake(value) {
  return typeof value === "string" && /^\d{5,25}$/.test(value);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
