import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Collection, Events, PermissionFlagsBits } from "discord.js";

import { toRoyalBold } from "../src/embed-format.js";
import {
  SELF_ROLE_CATEGORIES,
  SELF_ROLE_STAFF_NAME,
} from "../src/self-role-catalog.js";
import {
  applySelfRoleSelection,
  attachSelfRoleSystem,
  buildReviewTicketPayload,
  buildReviewTicketPermissionOverwrites,
  buildSelfRoleSelectionRow,
} from "../src/self-role-system.js";
import { buildSelfRolePickerPayload } from "../src/self-role-provisioning.js";
import { SelfRoleStore } from "../src/self-role-store.js";
import { ONBOARDING_CHANNEL_ID } from "../src/onboarding.js";

const GUILD_ID = "941800000000000001";
const MEMBER_ID = "941800000000000002";
const STAFF_ROLE_ID = "941800000000000003";
const BOT_ID = "941800000000000004";

function makeFixture(t, { selectedRoleKeys = [] } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "self-role-system-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new SelfRoleStore(directory);
  const roleCache = new Collection();
  roleCache.set(GUILD_ID, { id: GUILD_ID, name: "@everyone", permissions: { bitfield: 0n } });
  const roleIds = {};
  let nextRoleId = 100;

  for (const category of SELF_ROLE_CATEGORIES) {
    for (const option of category.options) {
      const key = `${category.key}:${option.key}`;
      const id = `941800000000000${String(nextRoleId++).padStart(3, "0")}`;
      const role = {
        id,
        name: `${toRoyalBold(category.label)} · ${toRoyalBold(option.label)}`,
        permissions: { bitfield: 0n },
        managed: false,
        editable: true,
        color: option.color ?? 0,
      };
      roleCache.set(id, role);
      store.setRoleId(GUILD_ID, key, id);
      roleIds[key] = id;
    }
  }

  const staffRole = {
    id: STAFF_ROLE_ID,
    name: SELF_ROLE_STAFF_NAME,
    permissions: { bitfield: 0n },
    managed: false,
    editable: true,
  };
  roleCache.set(STAFF_ROLE_ID, staffRole);
  store.setRoleId(GUILD_ID, "staff", STAFF_ROLE_ID);

  const memberRoleCache = new Collection();
  for (const key of selectedRoleKeys) {
    const roleId = roleIds[key];
    memberRoleCache.set(roleId, roleCache.get(roleId));
  }
  const member = {
    id: MEMBER_ID,
    guild: null,
    roles: {
      cache: memberRoleCache,
      add: async (roles) => {
        for (const role of Array.isArray(roles) ? roles : [roles]) memberRoleCache.set(role.id, role);
      },
      remove: async (roles) => {
        for (const role of Array.isArray(roles) ? roles : [roles]) memberRoleCache.delete(role.id);
      },
    },
  };
  const guild = {
    id: GUILD_ID,
    ownerId: "941800000000000099",
    roles: { cache: roleCache, everyone: roleCache.get(GUILD_ID) },
    members: { fetch: async () => member },
  };
  member.guild = guild;
  return { directory, store, roleCache, roleIds, member, guild, staffRole };
}

test("the approved role catalog has exactly five categories and the approved choices", () => {
  assert.deepEqual(
    SELF_ROLE_CATEGORIES.map(({ key, selection, options }) => [key, selection, options.length]),
    [
      ["age", "single", 24],
      ["gender", "single", 7],
      ["sexuality", "multiple", 8],
      ["interests", "multiple", 20],
      ["color", "single", 23],
    ],
  );
  assert.deepEqual(
    SELF_ROLE_CATEGORIES.find(({ key }) => key === "interests").options.map(({ label }) => label),
    [
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
    ],
  );
  assert.deepEqual(
    SELF_ROLE_CATEGORIES.find(({ key }) => key === "color").options.map(({ label, hex }) => [label, hex]),
    [
      ["Pink", "#E91E63"],
      ["Light Pink", "#F4A7C4"],
      ["Fuchsia", "#D946EF"],
      ["Red", "#EF4444"],
      ["Light Red", "#FCA5A5"],
      ["Orange", "#F97316"],
      ["Light Orange", "#FDBA74"],
      ["Yellow", "#EAB308"],
      ["Light Yellow", "#FEF08A"],
      ["Green", "#16A34A"],
      ["Light Green", "#86EFAC"],
      ["Teal", "#14B8A6"],
      ["Cyan", "#06B6D4"],
      ["Blue", "#2563EB"],
      ["Light Blue", "#7DD3FC"],
      ["Purple", "#7E22CE"],
      ["Lilac", "#C8A2C8"],
      ["Navy", "#1E3A8A"],
      ["Brown", "#8B5E3C"],
      ["Black", "#111827"],
      ["Grey", "#6B7280"],
      ["Light Grey", "#D1D5DB"],
      ["White", "#F9FAFB"],
    ],
  );
  const ages = SELF_ROLE_CATEGORIES.find(({ key }) => key === "age").options.map(({ label }) => label);
  assert.deepEqual(ages, ["Under 18", ...Array.from({ length: 23 }, (_, index) => String(index + 18))]);
});

test("the picker and role menu use Royal Bold labels and stay within Discord's menu limit", () => {
  const payload = buildSelfRolePickerPayload();
  const embed = payload.embeds[0].toJSON();
  assert.equal(embed.color, 0xf472b6);
  assert.match(embed.title, /🎀$/u);
  assert.equal(embed.fields.length, 5);
  assert.ok(embed.fields.every(({ name }) => name === toRoyalBold(name.normalize("NFKC"))));
  assert.equal(payload.components[0].components.length, 5);
  assert.ok(payload.components[0].components.every(({ data }) => data.label === toRoyalBold(data.label.normalize("NFKC"))));
  assert.match(embed.description, /never age verification/i);
  assert.match(embed.description, /does not automatically jail/i);

  const age = SELF_ROLE_CATEGORIES.find(({ key }) => key === "age");
  const roleIds = Object.fromEntries(age.options.map((option) => [`age:${option.key}`, option.key]));
  const member = { roles: { cache: new Map([["18", {}], ["19", {}]]) } };
  const ageMenu = buildSelfRoleSelectionRow("age", roleIds, member).toJSON().components[0];
  assert.equal(ageMenu.options.length, 25);
  assert.equal(ageMenu.max_values, 1);
  assert.equal(ageMenu.options.filter(({ default: isDefault }) => isDefault).length, 1);
  assert.ok(ageMenu.options.every(({ label }) => label === toRoyalBold(label.normalize("NFKC"))));

  const interestsMenu = buildSelfRoleSelectionRow("interests", {}, { roles: { cache: new Map() } })
    .toJSON().components[0];
  assert.equal(interestsMenu.options.length, 20);
  assert.equal(interestsMenu.min_values, 0);
  assert.equal(interestsMenu.max_values, 20);
});

test("member selections enforce category exclusivity and allow removing roles", async (t) => {
  const { store, roleIds, member, guild } = makeFixture(t);

  await applySelfRoleSelection(member, guild, store, "gender", ["female"]);
  assert.equal(member.roles.cache.has(roleIds["gender:female"]), true);

  await applySelfRoleSelection(member, guild, store, "gender", ["male"]);
  assert.equal(member.roles.cache.has(roleIds["gender:female"]), false);
  assert.equal(member.roles.cache.has(roleIds["gender:male"]), true);

  await applySelfRoleSelection(member, guild, store, "interests", ["anime", "manga"]);
  assert.equal(member.roles.cache.has(roleIds["interests:anime"]), true);
  assert.equal(member.roles.cache.has(roleIds["interests:manga"]), true);

  await applySelfRoleSelection(member, guild, store, "interests", ["manga"]);
  assert.equal(member.roles.cache.has(roleIds["interests:anime"]), false);
  assert.equal(member.roles.cache.has(roleIds["interests:manga"]), true);

  await applySelfRoleSelection(member, guild, store, "interests", []);
  assert.equal(member.roles.cache.has(roleIds["interests:manga"]), false);
});

test("age and color menus clear selections, and forged or conflicting values are rejected", async (t) => {
  const { store, roleIds, member, guild } = makeFixture(t);

  await applySelfRoleSelection(member, guild, store, "age", ["18"]);
  assert.equal(member.roles.cache.has(roleIds["age:18"]), true);
  await applySelfRoleSelection(member, guild, store, "age", ["clear"]);
  assert.equal(member.roles.cache.has(roleIds["age:18"]), false);

  await applySelfRoleSelection(member, guild, store, "color", ["lilac"]);
  assert.equal(member.roles.cache.has(roleIds["color:lilac"]), true);
  await applySelfRoleSelection(member, guild, store, "color", ["clear"]);
  assert.equal(member.roles.cache.has(roleIds["color:lilac"]), false);

  await assert.rejects(applySelfRoleSelection(member, guild, store, "age", ["18", "19"]), /only one/);
  await assert.rejects(applySelfRoleSelection(member, guild, store, "interests", ["anime", "unapproved"]), /not part/);
  await assert.rejects(applySelfRoleSelection(member, guild, store, "custom", []), /not available/);
});

test("self-assignment refuses roles with permissions instead of granting them", async (t) => {
  const { store, roleIds, member, guild } = makeFixture(t);
  guild.roles.cache.get(roleIds["gender:female"]).permissions.bitfield = PermissionFlagsBits.ManageRoles;

  await assert.rejects(
    applySelfRoleSelection(member, guild, store, "gender", ["female"]),
    /cannot be safely managed/,
  );
  assert.equal(member.roles.cache.size, 0);
});

test("review tickets are private and grant no server-wide privileges to the member or staff role", () => {
  const overwrites = buildReviewTicketPermissionOverwrites({
    everyoneId: GUILD_ID,
    memberId: MEMBER_ID,
    staffRoleId: STAFF_ROLE_ID,
    botId: BOT_ID,
  });
  assert.deepEqual(overwrites.map(({ id }) => id), [GUILD_ID, MEMBER_ID, STAFF_ROLE_ID, BOT_ID]);
  assert.ok(overwrites[0].deny.includes(PermissionFlagsBits.ViewChannel));
  for (const overwrite of overwrites.slice(1, 3)) {
    assert.ok(overwrite.allow.includes(PermissionFlagsBits.ViewChannel));
    assert.ok(!overwrite.allow.includes(PermissionFlagsBits.ManageRoles));
    assert.ok(!overwrite.allow.includes(PermissionFlagsBits.Administrator));
    assert.ok(!overwrite.allow.includes(PermissionFlagsBits.ManageChannels));
  }
  assert.ok(overwrites[3].allow.includes(PermissionFlagsBits.ManageChannels));
  assert.throws(
    () => buildReviewTicketPermissionOverwrites({ everyoneId: "nope", memberId: MEMBER_ID, staffRoleId: STAFF_ROLE_ID, botId: BOT_ID }),
    /valid everyoneId/,
  );
});

test("review-ticket embed clearly states self-declaration and offers a close control", () => {
  const payload = buildReviewTicketPayload(MEMBER_ID, STAFF_ROLE_ID);
  const embed = payload.embeds[0].toJSON();
  assert.equal(embed.color, 0xf472b6);
  assert.match(embed.title, /🎀$/u);
  assert.match(embed.description, /self-declaration, not age verification/i);
  assert.match(embed.description, /No automatic jail or punishment/i);
  assert.equal(payload.components[0].components[0].data.custom_id, "self-role:ticket-close");
  assert.deepEqual(payload.allowedMentions, { parse: [], users: [MEMBER_ID], roles: [STAFF_ROLE_ID] });
  assert.match(payload.content, new RegExp(`<@&${STAFF_ROLE_ID}>`));
});

test("startup provisions only the server identified by the onboarding welcome channel", async (t) => {
  const store = new SelfRoleStore(fs.mkdtempSync(path.join(os.tmpdir(), "self-role-target-test-")));
  t.after(() => fs.rmSync(path.dirname(store.file), { recursive: true, force: true }));
  const targetChannels = new Collection();
  const created = [];
  let otherFetches = 0;
  const targetGuild = {
    id: GUILD_ID,
    channels: {
      fetch: async () => targetChannels,
      create: async (options) => {
        created.push(options);
        const channel = { id: "941800000000000010", ...options };
        targetChannels.set(channel.id, channel);
        return channel;
      },
    },
    roles: {
      fetch: async () => {
        throw new Error("stop after target-channel check");
      },
    },
  };
  const otherGuild = {
    id: "941800000000000011",
    channels: {
      fetch: async () => {
        otherFetches += 1;
        return new Collection();
      },
    },
  };
  const listeners = new Map();
  const client = {
    user: { id: BOT_ID },
    guilds: { cache: new Collection([[GUILD_ID, targetGuild], [otherGuild.id, otherGuild]]) },
    channels: {
      fetch: async (channelId) => {
        assert.equal(channelId, ONBOARDING_CHANNEL_ID);
        return { guildId: GUILD_ID, guild: targetGuild };
      },
    },
    once: (event, handler) => listeners.set(event, handler),
    on: (event, handler) => listeners.set(event, handler),
  };

  attachSelfRoleSystem(client, { store });
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await listeners.get(Events.ClientReady)();
  } finally {
    console.error = originalConsoleError;
  }
  listeners.get(Events.GuildCreate)(otherGuild);

  assert.equal(created.length, 1);
  assert.equal(otherFetches, 0);
});
