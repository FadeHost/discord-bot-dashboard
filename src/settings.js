// Per-guild settings, kept as one JSON file on the persistent volume.

import fs from "node:fs";
import path from "node:path";

export const DEFAULT_WELCOME = "Welcome to {server}, {user}! You are member number {count}.";

/**
 * A directory that survives a redeploy. On FadeHost that is /data; anywhere
 * else, ./data next to the app.
 *
 * @param {string} [preferred]
 */
export function resolveDataDir(preferred = process.env.DATA_DIR) {
  const candidates = [preferred, "/data", path.resolve("data")].filter(Boolean);

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {
      // Try the next one.
    }
  }

  throw new Error(`No writable data directory. Tried: ${candidates.join(", ")}`);
}

/** Everything one guild can be configured with. */
export function blankSettings() {
  return {
    welcomeChannelId: null,
    welcomeMessage: DEFAULT_WELCOME,
    logChannelId: null,
  };
}

/**
 * Keep only the fields we know, and only in shapes we accept. The dashboard
 * posts a form, and a form can say anything.
 *
 * @param {Record<string, unknown>} input
 * @returns {{welcomeChannelId: string|null, welcomeMessage: string, logChannelId: string|null}}
 */
export function cleanSettings(input = {}) {
  return {
    welcomeChannelId: channelId(input.welcomeChannelId),
    welcomeMessage: String(input.welcomeMessage ?? DEFAULT_WELCOME).slice(0, 1500).trim() || DEFAULT_WELCOME,
    logChannelId: channelId(input.logChannelId),
  };
}

// Discord snowflakes are digits. Anything else means "off".
function channelId(value) {
  const text = String(value ?? "").trim();
  return /^\d{5,25}$/.test(text) ? text : null;
}

export class SettingsStore {
  /** @param {string} dataDir */
  constructor(dataDir) {
    this.file = path.join(dataDir, "settings.json");
    this.data = this.#read();
  }

  /** @param {string} guildId */
  get(guildId) {
    return { ...blankSettings(), ...(this.data[guildId] ?? {}) };
  }

  /**
   * @param {string} guildId
   * @param {object} settings
   */
  set(guildId, settings) {
    this.data[guildId] = cleanSettings(settings);
    this.#write();
    return this.data[guildId];
  }

  /** @returns {string[]} the guilds that have been configured */
  guildIds() {
    return Object.keys(this.data);
  }

  #read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  #write() {
    // Write beside the file and rename, so a crash halfway through never
    // leaves everyone's settings truncated.
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.data, null, 2));
    fs.renameSync(temporary, this.file);
  }
}

/**
 * Fill the placeholders in a welcome message.
 *
 * @param {string} template
 * @param {{mention: string, username: string, guildName: string, memberCount: number}} member
 */
export function renderWelcome(template, member) {
  return String(template ?? "")
    .replaceAll("{user}", member.mention)
    .replaceAll("{username}", member.username)
    .replaceAll("{server}", member.guildName)
    .replaceAll("{count}", String(member.memberCount))
    .slice(0, 2000);
}
