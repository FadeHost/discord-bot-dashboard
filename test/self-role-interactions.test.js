import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ChannelType, Collection, PermissionFlagsBits } from "discord.js";

import { SELF_ROLE_CATEGORIES, SELF_ROLE_CHANNEL_NAME } from "../src/self-role-catalog.js";
import {
  handleSelfRoleInteraction,
  isSelfRoleInteraction,
} from "../src/self-role-system.js";
import { SelfRoleStore } from "../src/self-role-store.js";

const GUILD_ID = "941800000000000001";
const MEMBER_ID = "941800000000000002";
const OTHER_ID = "941800000000000003";
const BOT_ID = "941800000000000004";
const PANEL_CHANNEL_ID = "941800000000000005";
const PANEL_MESSAGE_ID = "941800000000000006";
const STAFF_ROLE_ID = "941800000000000007";

function permissionBits(flags = []) {
  const bitfield = flags.reduce((combined, flag) => combined | BigInt(flag), 0n);
  return {
    bitfield,
    has: (flag) => (bitfield & BigInt(flag)) !== 0n,
  };
}

function makeFixture(t, { initialRoles = [] } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "self-role-interaction-test-"));
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
        name: `${category.label} ${option.label}`,
        permissions: { bitfield: 0n },
        managed: false,
        editable: true,
      };
      roleCache.set(id, role);
      store.setRoleId(GUILD_ID, key, id);
      roleIds[key] = id;
    }
  }

  const staffRole = {
    id: STAFF_ROLE_ID,
    name: "𝓢𝓽𝓪𝓯𝓯",
    permissions: { bitfield: 0n },
    managed: false,
    editable: true,
  };
  roleCache.set(STAFF_ROLE_ID, staffRole);
  store.setRoleId(GUILD_ID, "staff", STAFF_ROLE_ID);
  store.setChannel(GUILD_ID, PANEL_CHANNEL_ID, PANEL_MESSAGE_ID);

  const ticketChannels = new Map();
  const createdTicketOptions = [];
  const ticketMessages = [];
  const permissionEdits = [];
  let nextChannelId = 200;
  const guild = {
    id: GUILD_ID,
    ownerId: "941800000000000099",
    roles: {
      cache: roleCache,
      everyone: roleCache.get(GUILD_ID),
      create: async (options) => {
        const role = {
          id: "941800000000000088",
          name: options.name,
          color: options.color,
          permissions: { bitfield: 0n },
          managed: false,
          editable: true,
          edit: async function (changes) {
            Object.assign(this, changes);
            return this;
          },
        };
        roleCache.set(role.id, role);
        return role;
      },
    },
    members: {
      me: { permissions: { has: (flag) => flag === PermissionFlagsBits.ManageRoles } },
      fetch: async (id) => (id === MEMBER_ID ? member : staffMember),
    },
    channels: {
      fetch: async (id) => ticketChannels.get(id) ?? null,
      create: async (options) => {
        createdTicketOptions.push(options);
        const channel = {
          id: `941800000000000${String(nextChannelId++).padStart(3, "0")}`,
          type: ChannelType.GuildText,
          guildId: GUILD_ID,
          name: options.name,
          topic: options.topic,
          permissionOverwrites: {
            cache: new Collection(options.permissionOverwrites.map((overwrite) => [
              overwrite.id,
              {
                id: overwrite.id,
                allow: permissionBits(overwrite.allow),
                deny: permissionBits(overwrite.deny),
              },
            ])),
            edit: async (...args) => permissionEdits.push(args),
          },
          send: async (payload) => {
            ticketMessages.push(payload);
            return { id: `941800000000000${String(nextChannelId++).padStart(3, "0")}`, payload };
          },
          delete: async () => ticketChannels.delete(channel.id),
        };
        ticketChannels.set(channel.id, channel);
        return channel;
      },
    },
  };

  const makeMember = (id, keys = []) => {
    const cache = new Collection();
    for (const key of keys) {
      const roleId = roleIds[key];
      cache.set(roleId, roleCache.get(roleId));
    }
    const roles = {
      cache,
      add: async (values) => {
        for (const role of Array.isArray(values) ? values : [values]) cache.set(role.id, role);
      },
      remove: async (values) => {
        for (const role of Array.isArray(values) ? values : [values]) cache.delete(role.id);
      },
    };
    return { id, guild, roles };
  };
  const member = makeMember(MEMBER_ID, initialRoles);
  const staffMember = makeMember(OTHER_ID);
  staffMember.roles.cache.set(STAFF_ROLE_ID, staffRole);

  return {
    store,
    guild,
    member,
    staffMember,
    roleIds,
    ticketChannels,
    createdTicketOptions,
    ticketMessages,
    permissionEdits,
    client: { user: { id: BOT_ID } },
  };
}

function makeInteraction(fixture, {
  customId,
  kind = "button",
  userId = MEMBER_ID,
  member = fixture.member,
  channelId = PANEL_CHANNEL_ID,
  message = { id: PANEL_MESSAGE_ID, author: { id: BOT_ID }, components: [] },
  channel = null,
  values = [],
  permissions = { has: () => false },
} = {}) {
  const events = [];
  const interaction = {
    customId,
    guild: fixture.guild,
    guildId: GUILD_ID,
    channelId,
    channel,
    client: fixture.client,
    user: { id: userId },
    member,
    memberPermissions: permissions,
    message,
    values,
    deferred: false,
    replied: false,
    events,
    inGuild: () => true,
    isButton: () => kind === "button",
    isStringSelectMenu: () => kind === "select",
    isModalSubmit: () => kind === "modal",
    fields: { getTextInputValue: () => "#EFAAC9" },
    reply: async (payload) => {
      interaction.replied = true;
      events.push({ type: "reply", payload });
    },
    showModal: async (modal) => events.push({ type: "show-modal", modal }),
    deferReply: async (options) => {
      interaction.deferred = true;
      events.push({ type: "defer-reply", options });
    },
    deferUpdate: async () => {
      interaction.deferred = true;
      events.push({ type: "defer-update" });
    },
    editReply: async (payload) => events.push({ type: "edit-reply", payload }),
    followUp: async (payload) => events.push({ type: "follow-up", payload }),
  };
  return interaction;
}

test("category buttons state that role choices await approval and reject stale panels", async (t) => {
  const fixture = makeFixture(t);
  const interaction = makeInteraction(fixture, { customId: "self-role:open:gender" });

  assert.equal(isSelfRoleInteraction(interaction), true);
  await handleSelfRoleInteraction(interaction, fixture);

  assert.equal(interaction.events[0].payload.ephemeral, true);
  assert.match(interaction.events[0].payload.content, /waiting for your approval/i);
  assert.equal(fixture.member.roles.cache.size, 0);

  const wrongChannel = makeInteraction(fixture, {
    customId: "self-role:open:gender",
    channelId: "941800000000000098",
  });
  await handleSelfRoleInteraction(wrongChannel, fixture);
  assert.match(wrongChannel.events[0].payload.content, /no longer active/);
});

test("forged multi-select values cannot assign any unapproved role", async (t) => {
  const fixture = makeFixture(t);
  const interaction = makeInteraction(fixture, {
    customId: "self-role:select:sexuality",
    kind: "select",
    values: ["straight", "asexual"],
  });

  await handleSelfRoleInteraction(interaction, fixture);
  assert.equal(interaction.events[0].type, "defer-update");
  assert.match(interaction.events.at(-1).payload.content, /not part of the approved list/i);
  assert.equal(fixture.member.roles.cache.size, 0);
});

test("unapproved age options cannot create tickets, assign roles, or verify age", async (t) => {
  const fixture = makeFixture(t);
  const interaction = makeInteraction(fixture, {
    customId: "self-role:select:age",
    kind: "select",
    values: ["under-18", "18"],
  });

  await handleSelfRoleInteraction(interaction, fixture);
  assert.equal(fixture.createdTicketOptions.length, 0);
  assert.equal(fixture.member.roles.cache.size, 0);
  assert.equal(fixture.store.getOpenTicket(GUILD_ID, MEMBER_ID), null);
  assert.match(interaction.events.at(-1).payload.content, /approved option/i);
});

test("color category offers a custom color modal and a removal control", async (t) => {
  const fixture = makeFixture(t);
  const category = makeInteraction(fixture, { customId: "self-role:open:color" });
  await handleSelfRoleInteraction(category, fixture);
  const controls = category.events[0].payload.components[0].components;
  assert.deepEqual(controls.map((button) => button.data.custom_id), [
    "self-role:color:set",
    "self-role:color:remove",
  ]);

  const set = makeInteraction(fixture, {
    customId: "self-role:color:set",
    message: {
      author: { bot: true },
      components: [{ components: [{ customId: "self-role:color:set" }] }],
    },
  });
  await handleSelfRoleInteraction(set, fixture);
  assert.equal(set.events[0].type, "show-modal");
  assert.equal(set.events[0].modal.data.custom_id, "self-role:color:submit");
});

test("members can customize and remove only their own permissionless color role", async (t) => {
  const fixture = makeFixture(t);
  const setColor = makeInteraction(fixture, {
    customId: "self-role:color:submit",
    kind: "modal",
  });
  await handleSelfRoleInteraction(setColor, fixture);

  const colorRole = fixture.guild.roles.cache.get("941800000000000088");
  assert.equal(colorRole.color, 0xefaac9);
  assert.equal(colorRole.permissions.bitfield, 0n);
  assert.equal(fixture.member.roles.cache.has(colorRole.id), true);
  assert.equal(fixture.store.getGuild(GUILD_ID).colorRoleIds[MEMBER_ID], colorRole.id);
  assert.match(setColor.events.at(-1).payload, /#EFAAC9/);

  const remove = makeInteraction(fixture, {
    customId: "self-role:color:remove",
    message: {
      author: { bot: true },
      components: [{ components: [{ customId: "self-role:color:remove" }] }],
    },
  });
  await handleSelfRoleInteraction(remove, fixture);
  assert.equal(fixture.member.roles.cache.has(colorRole.id), false);
  assert.equal(fixture.store.getGuild(GUILD_ID).colorRoleIds[MEMBER_ID], colorRole.id);
  assert.match(remove.events.at(-1).payload, /color role was removed/);
});

test("invalid custom colors and missing role permissions do not assign a role", async (t) => {
  const fixture = makeFixture(t);
  const invalid = makeInteraction(fixture, {
    customId: "self-role:color:submit",
    kind: "modal",
  });
  invalid.fields.getTextInputValue = () => "pink";
  await handleSelfRoleInteraction(invalid, fixture);
  assert.match(invalid.events[0].payload.content, /six-digit hex color/);
  assert.equal(fixture.member.roles.cache.size, 0);

  fixture.guild.members.me.permissions.has = () => false;
  const denied = makeInteraction(fixture, {
    customId: "self-role:color:submit",
    kind: "modal",
  });
  await handleSelfRoleInteraction(denied, fixture);
  assert.match(denied.events.at(-1).payload, /Manage Roles and must rank above/);
  assert.equal(fixture.member.roles.cache.size, 0);

  fixture.guild.members.me.permissions.has = () => true;
  const highRole = await fixture.guild.roles.create({
    name: "existing color",
    color: 0x123456,
    permissions: [],
  });
  highRole.editable = false;
  fixture.store.setColorRoleId(GUILD_ID, MEMBER_ID, highRole.id);
  await fixture.member.roles.add(highRole);
  const hierarchyDenied = makeInteraction(fixture, {
    customId: "self-role:color:submit",
    kind: "modal",
  });
  await handleSelfRoleInteraction(hierarchyDenied, fixture);
  assert.match(hierarchyDenied.events.at(-1).payload, /cannot be safely managed/i);
  assert.equal(highRole.color, 0x123456);
  assert.equal(fixture.member.roles.cache.has(highRole.id), true);
});

test("unrelated private-ticket controls remain separate from the self-role panel", async (t) => {
  const fixture = makeFixture(t);
  const interaction = makeInteraction(fixture, { customId: "self-role:ticket-close" });
  await handleSelfRoleInteraction(interaction, fixture);
  assert.match(interaction.events[0].payload.content, /not an active Sugar AI review ticket/);
  assert.equal(SELF_ROLE_CHANNEL_NAME.includes("𝓼𝓮𝓵𝓯"), true);
});
