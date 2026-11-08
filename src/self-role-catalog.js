import { toRoyalBold } from "./embed-format.js";

const COLORS = [
  ["pink", "Pink", "#E91E63"],
  ["light-pink", "Light Pink", "#F4A7C4"],
  ["fuchsia", "Fuchsia", "#D946EF"],
  ["red", "Red", "#EF4444"],
  ["light-red", "Light Red", "#FCA5A5"],
  ["orange", "Orange", "#F97316"],
  ["light-orange", "Light Orange", "#FDBA74"],
  ["yellow", "Yellow", "#EAB308"],
  ["light-yellow", "Light Yellow", "#FEF08A"],
  ["green", "Green", "#16A34A"],
  ["light-green", "Light Green", "#86EFAC"],
  ["teal", "Teal", "#14B8A6"],
  ["cyan", "Cyan", "#06B6D4"],
  ["blue", "Blue", "#2563EB"],
  ["light-blue", "Light Blue", "#7DD3FC"],
  ["purple", "Purple", "#7E22CE"],
  ["lilac", "Lilac", "#C8A2C8"],
  ["navy", "Navy", "#1E3A8A"],
  ["brown", "Brown", "#8B5E3C"],
  ["black", "Black", "#111827"],
  ["grey", "Grey", "#6B7280"],
  ["light-grey", "Light Grey", "#D1D5DB"],
  ["white", "White", "#F9FAFB"],
];

const ageOptions = [
  { key: "under-18", label: "Under 18", description: "Self-declared; not age verification." },
  ...Array.from({ length: 23 }, (_, index) => {
    const age = index + 18;
    return { key: String(age), label: String(age) };
  }),
];

function options(keys) {
  return keys.map((label) => ({
    key: label.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, ""),
    label,
  }));
}

export const SELF_ROLE_CATEGORIES = Object.freeze([
  {
    key: "age",
    label: "Age",
    selection: "single",
    description: "Choose one self-declared age. It is not age verification.",
    options: ageOptions,
  },
  {
    key: "gender",
    label: "Gender",
    selection: "single",
    description: "Choose one, or clear your selection.",
    options: options(["Female", "Male", "Nonbinary", "Genderfluid", "Agender", "Questioning", "Another identity"]),
  },
  {
    key: "sexuality",
    label: "Sexuality",
    selection: "multiple",
    description: "Choose any that fit, or clear all selections.",
    options: options([
      "Straight",
      "Gay/Lesbian",
      "Bisexual",
      "Pansexual",
      "Asexual",
      "Queer",
      "Questioning",
      "Another identity",
    ]),
  },
  {
    key: "interests",
    label: "Interests",
    selection: "multiple",
    description: "Choose any interests, or clear all selections.",
    options: options([
      "Anime",
      "Manga",
      "Gaming",
      "Music",
      "Movies",
      "TV Shows",
      "Books",
      "Writing",
      "Art",
      "Photography",
      "Cosplay",
      "Sports",
      "Fitness",
      "Technology",
      "Programming",
      "Fashion",
      "Makeup",
      "Cooking",
      "Pets",
      "Travel",
    ]),
  },
  {
    key: "color",
    label: "Color",
    selection: "single",
    description: "Choose one preset role color, or clear it.",
    options: COLORS.map(([key, label, hex]) => ({
      key,
      label,
      hex,
      color: Number.parseInt(hex.slice(1), 16),
    })),
  },
]);

export const SELF_ROLE_KEYS = Object.freeze(
  SELF_ROLE_CATEGORIES.flatMap((category) =>
    category.options.map((option) => `${category.key}:${option.key}`),
  ),
);

const roleKeySet = new Set(SELF_ROLE_KEYS);

export const SELF_ROLE_STAFF_KEY = "staff";
export const SELF_ROLE_STAFF_NAME = toRoyalBold("Staff");
export const SELF_ROLE_CHANNEL_NAME = `🎀 | ୨୧ • ${toRoyalBold("self-roles")}`;
export const SELF_ROLE_EMBED_FOOTER = toRoyalBold("Sugar AI self roles · member controls");
export const SELF_ROLE_TICKET_MARKER = "sugar-ai:self-role-review";
export const SELF_ROLE_PREFIX = "self-role:";
export const SELF_ROLE_CLEAR_VALUE = "clear";
export const SELF_ROLE_PINK = 0xf472b6;

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
  return roleKeySet.has(value);
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
