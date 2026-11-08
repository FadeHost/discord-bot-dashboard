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

test("the role catalog contains only the five approved categories and no unapproved options", () => {
  assert.deepEqual(SELF_ROLE_CATEGORIES.map(({ key }) => key), [
    "age",
    "gender",
    "sexuality",
    "interests",
    "color",
  ]);
  assert.ok(SELF_ROLE_CATEGORIES.every((category) => category.options.length === 0));
  assert.match(SELF_ROLE_CATEGORIES.find(({ key }) => key === "age").description, /never verify age/i);
});

test("the pink self-role panel uses Royal Bold styling and clearly holds options pending approval", () => {
  const payload = buildSelfRolePickerPayload();
  const embed = payload.embeds[0].toJSON();
  assert.equal(embed.color, 0xf472b6);
  assert.match(embed.title, /🎀$/u);
  assert.equal(embed.fields.length, 5);
  assert.ok(embed.fields.every(({ name }) => name === toRoyalBold(name.normalize("NFKC"))));
  assert.equal(payload.components[0].components.length, 5);
  assert.ok(payload.components[0].components.every(({ data }) => data.label === toRoyalBold(data.label.normalize("NFKC"))));
  assert.match(embed.description, /waiting for approval/i);
  assert.match(embed.description, /never verify age/i);
  assert.match(embed.description, /grant age-restricted access/i);
  assert.match(embed.description, /custom hex value/i);
});

test("unapproved and forged role choices cannot add or remove any member roles", async (t) => {
  const { store, member, guild } = makeFixture(t);
  store.setRoleId(GUILD_ID, "age:18", "941800000000000777");
  guild.roles.cache.set("941800000000000777", {
    id: "941800000000000777",
    permissions: { bitfield: PermissionFlagsBits.ManageRoles },
    editable: true,
    managed: false,
  });

  for (const [category, option] of [
    ["age", "18"],
    ["gender", "female"],
    ["sexuality", "bisexual"],
    ["interests", "gaming"],
  ]) {
    await assert.rejects(
      applySelfRoleSelection(member, guild, store, category, [option]),
      /waiting for approval/,
    );
  }
  assert.equal(member.roles.cache.size, 0);
  assert.throws(() => buildSelfRoleSelectionRow("age", {}, member), /waiting for approval/);
  await assert.rejects(applySelfRoleSelection(member, guild, store, "custom", []), /not available/);
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
