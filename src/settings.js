// Per-guild settings, kept as one JSON file on the persistent volume.

import fs from "node:fs";
import path from "node:path";

export const DEFAULT_WELCOME = "Welcome to {server}, {user}! You are member number {count}.";

/**
 * Resolve persistent storage without hiding a production mount/config error.
 * Local fallback and directory creation are limited to development.
 *
 * @param {string} [preferred]
 */
export function resolveDataDir(preferred = process.env.DATA_DIR) {
  const development = process.env.NODE_ENV === "development";
  const configured = typeof preferred === "string" ? preferred.trim() : "";
  const candidates = configured ? [configured] : development ? ["/data", path.resolve("data")] : ["/data"];
  const failures = [];

  for (const dir of candidates) {
    try {
      if (development) {
        fs.mkdirSync(dir, { recursive: true });
      }
      if (!fs.statSync(dir).isDirectory()) {
        const error = new Error("Data path is not a directory");
        error.code = "ENOTDIR";
        throw error;
      }
      fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
      return dir;
    } catch (error) {
      failures.push(typeof error?.code === "string" ? error.code : "unavailable");
    }
  }

  const causes = [...new Set(failures)].join(", ");
  if (!development) {
    throw new Error(
      `Persistent storage is unavailable${causes ? ` (${causes})` : ""}. Mount /data or set DATA_DIR to an existing, writable persistent directory. Startup stopped without changing stored settings.`,
    );
  }

  throw new Error(
    `No writable data directory is available${causes ? ` (${causes})` : ""}. Set DATA_DIR to a writable directory.`,
  );
}

/** Everything one guild can be configured with. */
export function blankSettings() {
  return {
    welcomeChannelId: null,
    welcomeMessage: DEFAULT_WELCOME,
    logChannelId: null,
    vipRoleIds: [],
    moderatorRoleIds: [],
  };
}

/**
 * Keep only the fields we know, and only in shapes we accept. The dashboard
 * posts a form, and a form can say anything.
 *
 * @param {Record<string, unknown>} input
 * @returns {{welcomeChannelId: string|null, welcomeMessage: string, logChannelId: string|null, vipRoleIds: string[], moderatorRoleIds: string[]}}
 */
export function cleanSettings(input = {}) {
  return {
    welcomeChannelId: channelId(input.welcomeChannelId),
    welcomeMessage: String(input.welcomeMessage ?? DEFAULT_WELCOME).slice(0, 1500).trim() || DEFAULT_WELCOME,
    logChannelId: channelId(input.logChannelId),
    vipRoleIds: parseRoleIds(input.vipRoleIds).ids,
    moderatorRoleIds: parseRoleIds(input.moderatorRoleIds).ids,
  };
}

/** Parse role IDs entered as a comma-, space-, or newline-separated list. */
export function parseRoleIds(value) {
  const tokens = (Array.isArray(value) ? value : [value])
    .flatMap((entry) => String(entry ?? "").split(/[,\s]+/u))
    .map((entry) => entry.trim())
    .filter(Boolean);
  const ids = [];
  const invalid = [];

  for (const token of tokens) {
    if (!/^\d{5,25}$/u.test(token)) {
      invalid.push(token);
    } else if (!ids.includes(token)) {
      if (ids.length >= 20) {
        invalid.push(token);
      } else {
        ids.push(token);
      }
    }
  }

  return { ids, invalid };
}

// Discord snowflakes are digits. Anything else means "off".
function channelId(value) {
  const text = String(value ?? "").trim();
  return /^\d{5,25}$/.test(text) ? text : null;
}

export class SettingsStore {
  /**
   * @param {string} dataDir
   * @param {{allowMissing?: boolean}} [options]
   */
  constructor(dataDir, { allowMissing = false } = {}) {
    this.file = path.join(dataDir, "settings.json");
    this.data = this.#read(allowMissing);
  }

  /** @param {string} guildId */
  get(guildId) {
    const settings = { ...blankSettings(), ...(this.data[guildId] ?? {}) };
    return {
      ...settings,
      vipRoleIds: [...settings.vipRoleIds],
      moderatorRoleIds: [...settings.moderatorRoleIds],
    };
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

  #read(allowMissing) {
    let contents;
    try {
      contents = fs.readFileSync(this.file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        try {
          // A dangling symlink exists but cannot be read; do not treat it as a new install.
          fs.lstatSync(this.file);
        } catch (statError) {
          if (statError?.code === "ENOENT") {
            if (allowMissing) {
              return {};
            }
            throw new Error(
              "settings.json is missing. Startup stopped instead of initializing empty settings. Restore it or create an empty file only for a confirmed new installation.",
            );
          }
          throw settingsReadError(statError);
        }
      }
      throw settingsReadError(error);
    }

    let parsed;
    try {
      parsed = JSON.parse(contents);
    } catch {
      throw new Error(
        "settings.json is invalid JSON. Startup stopped without changing it; repair the file or restore a backup before restarting.",
      );
    }

    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.values(parsed).some((settings) => !isStoredSettings(settings))
    ) {
      throw new Error(
        "settings.json has an invalid structure. Startup stopped without changing it; repair the file or restore a backup before restarting.",
      );
    }

    return parsed;
  }

  #write() {
    // Write beside the file and rename, so a crash halfway through never
    // leaves everyone's settings truncated.
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.data, null, 2));
    fs.renameSync(temporary, this.file);
  }
}

function isStoredSettings(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return false;
  }

  return (
    (settings.welcomeChannelId === undefined ||
      settings.welcomeChannelId === null ||
      typeof settings.welcomeChannelId === "string") &&
    (settings.logChannelId === undefined ||
      settings.logChannelId === null ||
      typeof settings.logChannelId === "string") &&
    (settings.welcomeMessage === undefined || typeof settings.welcomeMessage === "string") &&
    isStoredRoleIds(settings.vipRoleIds) &&
    isStoredRoleIds(settings.moderatorRoleIds)
  );
}

function isStoredRoleIds(value) {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= 20 &&
      value.every((id) => typeof id === "string" && /^\d{5,25}$/u.test(id)) &&
      new Set(value).size === value.length)
  );
}

function settingsReadError(error) {
  const code = typeof error?.code === "string" ? ` (${error.code})` : "";
  return new Error(
    `Unable to read settings.json${code}. Startup stopped to protect existing settings; check storage permissions or restore a backup.`,
  );
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
