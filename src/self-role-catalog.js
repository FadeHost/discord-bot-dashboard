import { toRoyalBold } from "./embed-format.js";

export const SELF_ROLE_CATEGORIES = Object.freeze([
  {
    key: "age",
    label: "Age",
    selection: "single",
    description: "Age roles are self-declared only and never verify age.",
    options: [
      { key: "under-18", label: "18-", emoji: "🔞" },
      { key: "18", label: "18", emoji: "🎂" },
      { key: "19", label: "19", emoji: "🎈" },
      { key: "20", label: "20", emoji: "🎉" },
      { key: "21", label: "21", emoji: "🍾" },
      { key: "22", label: "22", emoji: "🌹" },
      { key: "23", label: "23", emoji: "🌷" },
      { key: "24", label: "24", emoji: "🌻" },
      { key: "25", label: "25", emoji: "🌼" },
      { key: "26", label: "26", emoji: "🌸" },
      { key: "27", label: "27", emoji: "🌺" },
      { key: "28", label: "28", emoji: "🪻" },
      { key: "29", label: "29", emoji: "🍀" },
      { key: "30", label: "30", emoji: "🌿" },
      { key: "31", label: "31", emoji: "🍃" },
      { key: "32", label: "32", emoji: "🦋" },
      { key: "33", label: "33", emoji: "🐝" },
      { key: "34", label: "34", emoji: "🐞" },
      { key: "35", label: "35", emoji: "🐬" },
      { key: "36", label: "36", emoji: "🐠" },
      { key: "37", label: "37", emoji: "🐙" },
      { key: "38", label: "38", emoji: "🦄" },
      { key: "39", label: "39", emoji: "🐱" },
      { key: "40", label: "40", emoji: "👑" },
    ],
  },
  {
    key: "gender",
    label: "Gender",
    selection: "single",
    description: "Gender options are waiting for your approval.",
    options: [],
  },
  {
    key: "sexuality",
    label: "Sexuality",
    selection: "multiple",
    description: "Sexuality options are waiting for your approval.",
    options: [],
  },
  {
    key: "interests",
    label: "Interests",
    selection: "multiple",
    description: "Interest options are waiting for your approval.",
    options: [],
  },
  {
    key: "color",
    label: "Color",
    selection: "single",
    description: "Color role options are waiting for your approval.",
    options: [],
  },
]);

export const SELF_ROLE_PANEL_KEYS = Object.freeze([
  "intro",
  "age",
  "gender",
  "sexuality",
  "interests",
  "color",
  "hide-channels",
]);

export const SELF_ROLE_KEYS = Object.freeze(
  SELF_ROLE_CATEGORIES.flatMap((category) =>
    category.options.map((option) => `${category.key}:${option.key}`),
  ),
);

const roleKeySet = new Set(SELF_ROLE_KEYS);
const categoryKeySet = new Set(SELF_ROLE_CATEGORIES.map((category) => category.key));

export const SELF_ROLE_STAFF_KEY = "staff";
export const SELF_ROLE_STAFF_NAME = toRoyalBold("Staff");
export const SELF_ROLE_CHANNEL_NAME = `🎀 | ୨୧ • ${toRoyalBold("self-roles")}`;
export const SELF_ROLE_EMBED_FOOTER = toRoyalBold("Sugar AI self roles · member controls");
export const SELF_ROLE_TICKET_MARKER = "sugar-ai:self-role-review";
export const SELF_ROLE_PREFIX = "self-role:";
export const SELF_ROLE_CLEAR_VALUE = "clear";
export const SELF_ROLE_PINK = 0xf472b6;
export const HIDE_CHANNELS_EMOJI = "🔞";

export function getSelfRolePanelFooter(panelKey) {
  if (!SELF_ROLE_PANEL_KEYS.includes(panelKey)) return null;
  return toRoyalBold(`${SELF_ROLE_EMBED_FOOTER} · ${panelKey}`);
}

export function getSelfRoleCategory(key) {
  return SELF_ROLE_CATEGORIES.find((category) => category.key === key) ?? null;
}

export function getSelfRoleOption(category, optionKey) {
  return category?.options.find((option) => option.key === optionKey) ?? null;
}

export function getSelfRoleDefinition(roleKey) {
  if (!roleKeySet.has(roleKey)) return null;
  const [categoryKey, optionKey] = roleKey.split(":");
  const category = getSelfRoleCategory(categoryKey);
  const option = getSelfRoleOption(category, optionKey);
  return category && option
    ? {
        key: roleKey,
        category,
        option,
        name: toRoyalBold(`${category.label} · ${option.label}`),
        color: option.color,
      }
    : null;
}

export function isSelfRoleKey(value) {
  if (roleKeySet.has(value)) return true;
  const match = String(value ?? "").match(/^([a-z-]+):([a-z0-9-]+)$/u);
  // Keep previously persisted role IDs readable, but assignment still checks
  // only the currently approved category.options list.
  return Boolean(match && categoryKeySet.has(match[1]));
}

/** NFKC makes Mathematical Script role names compare to their Latin names. */
export function normalizeSelfRoleName(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

export function selfRoleHexColor(option) {
  return option?.hex ?? null;
}
