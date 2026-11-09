import { toRoyalBold } from "./embed-format.js";

export const PRIVATE_CHAT_LOBBY_CHANNEL_ID = "1568179043356901376";

const MAX_CHANNEL_LABEL_LENGTH = 32;

/** Convert a display name into a channel-safe slug while preserving Unicode letters. */
export function normalizePrivateChatLabel(value) {
  const input = String(value ?? "").normalize("NFKC").trim();
  if (!input || [...input].length > 40) {
    throw new Error("Chat names must contain 1–40 characters.");
  }

  const slug = input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+$/g, "");
  const boundedSlug = [...slug]
    .slice(0, MAX_CHANNEL_LABEL_LENGTH)
    .join("")
    .replace(/-+$/g, "");

  if (!boundedSlug) throw new Error("Use at least one letter or number in the chat name.");
  return boundedSlug;
}

export function formatPrivateChatChannelName(displayName) {
  return `👤｜୨୧•${toRoyalBold(normalizePrivateChatLabel(displayName))}`;
}

/** Ignore decorative marks and compatibility-font lettering such as math script. */
export function normalizeCategoryName(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[୨୧]/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}
