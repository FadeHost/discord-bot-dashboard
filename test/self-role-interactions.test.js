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
    roles: { cache: roleCache, everyone: roleCache.get(GUILD_ID) },
    members: { fetch: async (id) => (id === MEMBER_ID ? member : staffMember) },
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
    reply: async (payload) => {
      interaction.replied = true;
      events.push({ type: "reply", payload });
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

test("category buttons open a personalized ephemeral menu from the active panel only", async (t) => {
  const fixture = makeFixture(t, { initialRoles: ["gender:female"] });
  const interaction = makeInteraction(fixture, { customId: "self-role:open:gender" });

  assert.equal(isSelfRoleInteraction(interaction), true);
  await handleSelfRoleInteraction(interaction, fixture);

  const reply = interaction.events[0].payload;
  assert.equal(reply.ephemeral, true);
  const menu = reply.components[0].components[0].toJSON();
  assert.equal(menu.custom_id, "self-role:select:gender");
  assert.equal(
    menu.options.find(({ value }) => value === "female").default,
    true,
  );

  const wrongChannel = makeInteraction(fixture, {
    customId: "self-role:open:gender",
    channelId: "941800000000000098",
  });
  await handleSelfRoleInteraction(wrongChannel, fixture);
  assert.match(wrongChannel.events[0].payload.content, /no longer active/);
});

test("multi-select interaction updates only the member's approved roles", async (t) => {
  const fixture = makeFixture(t);
  const interaction = makeInteraction(fixture, {
    customId: "self-role:select:sexuality",
    kind: "select",
    values: ["straight", "asexual"],
  });

  await handleSelfRoleInteraction(interaction, fixture);
  assert.equal(fixture.member.roles.cache.has(fixture.roleIds["sexuality:straight"]), true);
  assert.equal(fixture.member.roles.cache.has(fixture.roleIds["sexuality:asexual"]), true);
  assert.equal(fixture.member.roles.cache.has(fixture.roleIds["gender:female"]), false);
  assert.equal(interaction.events[0].type, "defer-update");
  assert.match(interaction.events.at(-1).payload.content, /2 approved roles selected/);

  const clear = makeInteraction(fixture, {
    customId: "self-role:select:sexuality",
    kind: "select",
    values: [],
  });
  await handleSelfRoleInteraction(clear, fixture);
  assert.equal(fixture.member.roles.cache.has(fixture.roleIds["sexuality:straight"]), false);
  assert.equal(fixture.member.roles.cache.has(fixture.roleIds["sexuality:asexual"]), false);
  assert.match(clear.events.at(-1).payload.content, /selection cleared/);
});

test("Under 18 creates one private ticket and remains a self-declared, mutually exclusive age choice", async (t) => {
  const fixture = makeFixture(t, { initialRoles: ["age:18"] });
  const first = makeInteraction(fixture, {
    customId: "self-role:select:age",
    kind: "select",
    values: ["under-18"],
  });
  await handleSelfRoleInteraction(first, fixture);

  assert.equal(fixture.createdTicketOptions.length, 1);
  assert.equal(fixture.createdTicketOptions[0].name.includes("୨୧"), true);
  assert.deepEqual(
    fixture.createdTicketOptions[0].permissionOverwrites.map(({ id }) => id),
    [GUILD_ID, MEMBER_ID, STAFF_ROLE_ID, BOT_ID],
  );
  assert.equal(fixture.member.roles.cache.has(fixture.roleIds["age:18"]), false);
  assert.equal(fixture.member.roles.cache.has(fixture.roleIds["age:under-18"]), true);
  const open = fixture.store.getOpenTicket(GUILD_ID, MEMBER_ID);
  assert.ok(open);
  const channel = fixture.ticketChannels.get(open.channelId);
  assert.equal(channel.topic, `sugar-ai:self-role-review:${GUILD_ID}:${MEMBER_ID}`);
  assert.match(fixture.ticketMessages[0].embeds[0].data.description, /not age verification/i);
  assert.deepEqual(fixture.ticketMessages[0].allowedMentions.roles, [STAFF_ROLE_ID]);
  assert.match(fixture.ticketMessages[0].content, new RegExp(`<@&${STAFF_ROLE_ID}>`));
  assert.match(first.events.at(-1).payload.content, /no automatic jail/i);

  const second = makeInteraction(fixture, {
    customId: "self-role:select:age",
    kind: "select",
    values: ["under-18"],
  });
  await handleSelfRoleInteraction(second, fixture);
  assert.equal(fixture.createdTicketOptions.length, 1);
  assert.match(second.events.at(-1).payload.content, /existing private review ticket/);
});

test("only staff or administrators can close a review ticket; the member retains read access", async (t) => {
  const fixture = makeFixture(t);
  const selection = makeInteraction(fixture, {
    customId: "self-role:select:age",
    kind: "select",
    values: ["under-18"],
  });
  await handleSelfRoleInteraction(selection, fixture);
  const open = fixture.store.getOpenTicket(GUILD_ID, MEMBER_ID);
  const ticketChannel = fixture.ticketChannels.get(open.channelId);

  const memberClose = makeInteraction(fixture, {
    customId: "self-role:ticket-close",
    userId: MEMBER_ID,
    member: fixture.member,
    channelId: open.channelId,
    channel: ticketChannel,
  });
  await handleSelfRoleInteraction(memberClose, fixture);
  assert.match(memberClose.events[0].payload.content, /Only the configured staff role/);
  assert.equal(fixture.permissionEdits.length, 0);
  assert.equal(fixture.store.getTicket(GUILD_ID, open.channelId).status, "open");

  const staffClose = makeInteraction(fixture, {
    customId: "self-role:ticket-close",
    userId: OTHER_ID,
    member: fixture.staffMember,
    channelId: open.channelId,
    channel: ticketChannel,
  });
  await handleSelfRoleInteraction(staffClose, fixture);
  assert.deepEqual(fixture.permissionEdits[0].slice(0, 2), [MEMBER_ID, { SendMessages: false }]);
  assert.equal(fixture.store.getTicket(GUILD_ID, open.channelId).status, "closed");
  assert.deepEqual(staffClose.events.at(-1).payload.components, []);
  assert.match(staffClose.events.at(-1).payload.content, /can still read the ticket/);
});

test("tickets with changed visibility permissions are neither reused nor closed", async (t) => {
  const fixture = makeFixture(t);
  const selection = makeInteraction(fixture, {
    customId: "self-role:select:age",
    kind: "select",
    values: ["under-18"],
  });
  await handleSelfRoleInteraction(selection, fixture);
  const open = fixture.store.getOpenTicket(GUILD_ID, MEMBER_ID);
  const ticketChannel = fixture.ticketChannels.get(open.channelId);
  ticketChannel.permissionOverwrites.cache.set("941800000000000098", {
    id: "941800000000000098",
    allow: permissionBits([PermissionFlagsBits.ViewChannel]),
    deny: permissionBits(),
  });

  const retry = makeInteraction(fixture, {
    customId: "self-role:select:age",
    kind: "select",
    values: ["under-18"],
  });
  await handleSelfRoleInteraction(retry, fixture);
  assert.equal(fixture.createdTicketOptions.length, 1);
  assert.match(retry.events.at(-1).payload.content, /could not be verified/);

  const close = makeInteraction(fixture, {
    customId: "self-role:ticket-close",
    userId: OTHER_ID,
    member: fixture.staffMember,
    channelId: open.channelId,
    channel: ticketChannel,
  });
  await handleSelfRoleInteraction(close, fixture);
  assert.match(close.events[0].payload.content, /private permissions changed/);
  assert.equal(fixture.permissionEdits.length, 0);
  assert.equal(fixture.store.getTicket(GUILD_ID, open.channelId).status, "open");
});

test("invalid Under 18 selections do not open tickets or change roles", async (t) => {
  const fixture = makeFixture(t);
  const interaction = makeInteraction(fixture, {
    customId: "self-role:select:age",
    kind: "select",
    values: ["under-18", "18"],
  });

  await handleSelfRoleInteraction(interaction, fixture);
  assert.equal(fixture.createdTicketOptions.length, 0);
  assert.equal(fixture.member.roles.cache.size, 0);
  assert.match(interaction.events.at(-1).payload.content, /only one approved option/);
});

test("unrelated channel permission flags are not added by ticket closure", async (t) => {
  const fixture = makeFixture(t);
  const selection = makeInteraction(fixture, {
    customId: "self-role:select:age",
    kind: "select",
    values: ["under-18"],
  });
  await handleSelfRoleInteraction(selection, fixture);
  const open = fixture.store.getOpenTicket(GUILD_ID, MEMBER_ID);
  const ticketChannel = fixture.ticketChannels.get(open.channelId);
  const admin = makeInteraction(fixture, {
    customId: "self-role:ticket-close",
    userId: OTHER_ID,
    member: fixture.staffMember,
    channelId: open.channelId,
    channel: ticketChannel,
    permissions: { has: (flag) => flag === PermissionFlagsBits.Administrator },
  });

  await handleSelfRoleInteraction(admin, fixture);
  assert.equal(fixture.store.getTicket(GUILD_ID, open.channelId).status, "closed");
  assert.equal(SELF_ROLE_CHANNEL_NAME.includes("𝓼𝓮𝓵𝓯"), true);
});
