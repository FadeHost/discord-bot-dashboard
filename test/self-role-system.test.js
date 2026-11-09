import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Collection, Events, PermissionFlagsBits } from "discord.js";

import { toRoyalBold } from "../src/embed-format.js";
import {
  HIDE_CHANNELS_EMOJI,
  SELF_ROLE_CATEGORIES,
  SELF_ROLE_CHANNEL_NAME,
  SELF_ROLE_PANEL_KEYS,
  SELF_ROLE_STAFF_NAME,
  getSelfRolePanelFooter,
} from "../src/self-role-catalog.js";
import {
  applySelfRoleSelection,
  attachSelfRoleSystem,
  buildReviewTicketPayload,
  buildReviewTicketPermissionOverwrites,
  buildSelfRoleSelectionRow,
  provisionGuild,
  resolveTargetGuild,
} from "../src/self-role-system.js";
import { buildSelfRolePanelPayloads } from "../src/self-role-provisioning.js";
import { SelfRoleStore } from "../src/self-role-store.js";
import { NsfwVisibilityStore } from "../src/nsfw-visibility-store.js";

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

test("only the approved age choices are active", () => {
  assert.deepEqual(SELF_ROLE_CATEGORIES.map(({ key }) => key), [
    "age",
    "gender",
    "sexuality",
    "interests",
    "color",
  ]);
  const age = SELF_ROLE_CATEGORIES.find(({ key }) => key === "age");
  assert.deepEqual(age.options.map(({ key }) => key), ["under-18", ...Array.from({ length: 23 }, (_, index) => String(index + 18))]);
  assert.ok(age.options.every(({ emoji }) => emoji === undefined));
  assert.ok(SELF_ROLE_CATEGORIES.filter(({ key }) => key !== "age").every((category) => category.options.length === 0));
  assert.match(SELF_ROLE_CATEGORIES.find(({ key }) => key === "age").description, /never verify age/i);
});

test("seven pink panels appear in order with a 24-option Age selector and inactive categories", () => {
  const panels = buildSelfRolePanelPayloads();
  assert.deepEqual(panels.map(({ key }) => key), SELF_ROLE_PANEL_KEYS);
  assert.ok(panels.every(({ payload }) => payload.embeds[0].data.color === 0xf472b6));
  assert.ok(panels.every(({ payload }) => payload.embeds[0].data.title.endsWith("🎀")));

  const age = panels.find(({ key }) => key === "age").payload;
  const menu = age.components[0].components[0].toJSON();
  assert.equal(menu.custom_id, "self-role:select:age");
  assert.equal(menu.options.length, 24);
  assert.deepEqual(menu.options.map(({ value }) => value), [
    "under-18",
    ...Array.from({ length: 23 }, (_, index) => String(index + 18)),
  ]);
  assert.ok(menu.options.every(({ emoji }) => emoji === undefined));
  assert.equal(age.embeds[0].data.description, "Please select your age.");
  const intro = panels.find(({ key }) => key === "intro").payload.embeds[0].data.description;
  assert.match(intro, /self-declared Age role.*not age verification/i);
  assert.match(intro, /Discord's native age restrictions always remain in force/i);

  for (const key of ["gender", "sexuality", "interests", "color"]) {
    const panel = panels.find((item) => item.key === key);
    assert.equal(panel.payload.components.length, 0);
    assert.deepEqual(panel.reactions, {});
    assert.match(panel.payload.embeds[0].data.description, /inactive|waiting for your approval/i);
  }
  const hide = panels.find(({ key }) => key === "hide-channels");
  assert.deepEqual(hide.reactions, { [HIDE_CHANNELS_EMOJI]: "hide-nsfw" });
  assert.equal(hide.payload.components.length, 0);
  assert.match(hide.payload.embeds[0].data.description, /never grants access or changes Discord's native age restrictions/i);
});

test("unapproved categories and forged multi-age selections cannot change roles", async (t) => {
  const { store, member, guild } = makeFixture(t);

  for (const [category, option] of [
    ["gender", "female"],
    ["sexuality", "bisexual"],
    ["interests", "gaming"],
    ["color", "pink"],
  ]) {
    await assert.rejects(
      applySelfRoleSelection(member, guild, store, category, [option]),
      /waiting for approval/,
    );
  }
  assert.equal(member.roles.cache.size, 0);
  assert.equal(buildSelfRoleSelectionRow("age", store.getGuild(GUILD_ID).roleIds, member).components[0].options.length, 24);
  await assert.rejects(
    applySelfRoleSelection(member, guild, store, "age", ["18", "19"]),
    /exactly one approved age option/,
  );
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

function makeProvisioningGuild(guildId, { existingChannel = false, inventoryError = false } = {}) {
  const channelCache = new Collection();
  const history = new Collection();
  const createdChannels = [];
  const channelId = guildId === GUILD_ID ? "941800000000000010" : "941800000000000020";
  const messageId = guildId === GUILD_ID ? "941800000000000030" : "941800000000000040";
  const roleCache = new Collection([
    [guildId, { id: guildId, name: "@everyone", permissions: { bitfield: 0n } }],
  ]);
  let nextRoleId = 200;
  let nextMessageId = BigInt(messageId);
  let sends = 0;
  let edits = 0;
  let fetches = 0;

  function makeChannel(options) {
    const channel = {
      id: channelId,
      name: options.name,
      type: options.type,
      guildId,
      messages: {
        fetch: async (query) => {
          if (typeof query === "string") {
            const message = history.get(query);
            if (!message) throw Object.assign(new Error("unknown message"), { code: 10008 });
            return message;
          }
          return history;
        },
      },
      send: async (payload) => {
        sends += 1;
        const message = {
          id: String(nextMessageId++),
          author: { id: BOT_ID, bot: true },
          embeds: payload.embeds.map((embed) => embed.toJSON()),
          components: payload.components.map((row) => row.toJSON()),
          reactions: [],
          edit: async (nextPayload) => {
            edits += 1;
            message.embeds = nextPayload.embeds.map((embed) => embed.toJSON());
            message.components = nextPayload.components.map((row) => row.toJSON());
            return message;
          },
          react: async (emoji) => {
            if (!message.reactions.includes(emoji)) message.reactions.push(emoji);
            return message;
          },
        };
        history.set(message.id, message);
        return message;
      },
    };
    return channel;
  }

  if (existingChannel) {
    const channel = makeChannel({ name: SELF_ROLE_CHANNEL_NAME, type: 0 });
    channelCache.set(channel.id, channel);
  }

  const guild = {
    id: guildId,
    roles: {
      cache: roleCache,
      fetch: async () => roleCache,
      create: async (options) => {
        const role = {
          id: `941800000000000${String(nextRoleId++).padStart(3, "0")}`,
          name: options.name,
          permissions: { bitfield: 0n },
          managed: false,
          editable: true,
          color: options.color ?? 0,
          edit: async function (changes) {
            Object.assign(this, changes);
            return this;
          },
        };
        roleCache.set(role.id, role);
        return role;
      },
    },
    members: { me: { permissions: { has: () => true } } },
    channels: {
      fetch: async () => {
        fetches += 1;
        if (inventoryError) throw Object.assign(new Error("unavailable"), { code: 500 });
        return channelCache;
      },
      create: async (options) => {
        createdChannels.push(options);
        const channel = makeChannel(options);
        channelCache.set(channel.id, channel);
        return channel;
      },
    },
  };

  return {
    guild,
    channelCache,
    createdChannels,
    get sends() { return sends; },
    get edits() { return edits; },
    get fetches() { return fetches; },
    get panel() { return history.get(messageId) ?? null; },
  };
}

test("startup provisions the sole connected server without fetching the onboarding channel", async (t) => {
  const { directory, store } = makeFixture(t);
  const target = makeProvisioningGuild(GUILD_ID);
  const listeners = new Map();
  const client = {
    user: { id: BOT_ID },
    guilds: { cache: new Collection([[GUILD_ID, target.guild]]) },
    once: (event, handler) => listeners.set(event, handler),
    on: (event, handler) => listeners.set(event, handler),
  };
  attachSelfRoleSystem(client, { store, nsfwVisibility: new NsfwVisibilityStore(directory) });
  await listeners.get(Events.ClientReady)();
  await provisionGuild(target.guild, client, store);

  assert.equal(target.createdChannels.length, 1);
  assert.equal(target.createdChannels[0].name, SELF_ROLE_CHANNEL_NAME);
  assert.equal(target.sends, 7);
  assert.equal(target.edits, 7);
  assert.equal(target.panel.embeds[0].footer.text, getSelfRolePanelFooter("intro"));
  assert.equal(store.getPanelMessageId(GUILD_ID, "intro"), target.panel.id);
  assert.equal(store.getGuild(GUILD_ID).panelMessageIds["hide-channels"] !== undefined, true);
  assert.equal(store.getGuild(GUILD_ID).channelId, target.channelCache.first().id);
});

test("target selection fails closed when multiple guilds have no unique self-role channel", async () => {
  const first = makeProvisioningGuild(GUILD_ID);
  const second = makeProvisioningGuild("941800000000000011");
  const client = { guilds: { cache: new Collection([[GUILD_ID, first.guild], [second.guild.id, second.guild]]) } };

  assert.equal(await resolveTargetGuild(client), null);
  assert.equal(first.createdChannels.length, 0);
  assert.equal(second.createdChannels.length, 0);
  assert.equal(first.fetches, 1);
  assert.equal(second.fetches, 1);
});

test("target selection uses the only guild with an existing self-role channel", async () => {
  const other = makeProvisioningGuild(GUILD_ID);
  const target = makeProvisioningGuild("941800000000000011", { existingChannel: true });
  const client = { guilds: { cache: new Collection([[GUILD_ID, other.guild], [target.guild.id, target.guild]]) } };

  assert.equal(await resolveTargetGuild(client), target.guild);
  assert.equal(other.createdChannels.length, 0);
  assert.equal(target.createdChannels.length, 0);
});

test("target selection fails closed when any guild channel inventory cannot be checked", async () => {
  const first = makeProvisioningGuild(GUILD_ID);
  const second = makeProvisioningGuild("941800000000000011", { existingChannel: true, inventoryError: true });
  const client = { guilds: { cache: new Collection([[GUILD_ID, first.guild], [second.guild.id, second.guild]]) } };

  assert.equal(await resolveTargetGuild(client), null);
  assert.equal(first.createdChannels.length, 0);
  assert.equal(second.createdChannels.length, 0);
});
