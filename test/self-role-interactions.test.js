import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ChannelType, Collection, PermissionFlagsBits } from "discord.js";

import {
  HIDE_CHANNELS_EMOJI,
  SELF_ROLE_CATEGORIES,
  SELF_ROLE_CHANNEL_NAME,
} from "../src/self-role-catalog.js";
import {
  handleSelfRoleReaction,
  handleSelfRoleInteraction,
  isSelfRoleInteraction,
} from "../src/self-role-system.js";
import { SelfRoleStore } from "../src/self-role-store.js";
import { NsfwVisibilityStore } from "../src/nsfw-visibility-store.js";

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
  store.setReactionPanelMessage(GUILD_ID, "age", PANEL_CHANNEL_ID, PANEL_MESSAGE_ID);

  const ticketChannels = new Map();
  const createdTicketOptions = [];
  const ticketMessages = [];
  const permissionEdits = [];
  const underageChannels = new Collection();
  const dmPayloads = [];
  const accessFlags = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
  ];
  let nextChannelId = 200;
  const generalChannel = {
    id: "941800000000000090",
    guildId: GUILD_ID,
    name: "general",
    type: ChannelType.GuildText,
    nsfw: false,
    permissionOverwrites: {
      cache: new Collection(),
      edit: async (userId, patch) => {
        permissionEdits.push([generalChannel.id, userId, patch]);
        const overwrites = generalChannel.permissionOverwrites.cache;
        const current = overwrites.get(userId) ?? { allow: permissionBits(), deny: permissionBits() };
        const allow = new Set(accessFlags.filter((flag) => current.allow.has(flag)));
        const deny = new Set(accessFlags.filter((flag) => current.deny.has(flag)));
        for (const [name, value] of Object.entries(patch)) {
          const flag = PermissionFlagsBits[name];
          if (value === null) {
            allow.delete(flag);
            deny.delete(flag);
          } else if (value === true) {
            allow.add(flag);
            deny.delete(flag);
          } else if (value === false) {
            deny.add(flag);
            allow.delete(flag);
          }
        }
        if (allow.size || deny.size) {
          overwrites.set(userId, { allow: permissionBits([...allow]), deny: permissionBits([...deny]) });
        } else {
          overwrites.delete(userId);
        }
      },
    },
    permissionsFor: (target) => ({
      has: (flag) => {
        if (target.id === BOT_ID) return flag === PermissionFlagsBits.ManageChannels;
        const overwrite = generalChannel.permissionOverwrites.cache.get(MEMBER_ID);
        if (overwrite?.deny.has(flag)) return false;
        if (overwrite?.allow.has(flag)) return true;
        return accessFlags.includes(flag);
      },
    }),
  };
  underageChannels.set(generalChannel.id, generalChannel);
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
      me: {
        id: BOT_ID,
        permissions: {
          has: (flag) => [PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageChannels].includes(flag),
        },
      },
      fetch: async (id) => (id === MEMBER_ID ? member : staffMember),
    },
    channels: {
      fetch: async (id) =>
        id ? ticketChannels.get(id) ?? underageChannels.get(id) ?? null : underageChannels,
      create: async (options) => {
        if (options.name === "support") {
          const channel = {
            id: `941800000000000${String(nextChannelId++).padStart(3, "0")}`,
            guildId: GUILD_ID,
            name: options.name,
            type: ChannelType.GuildText,
            nsfw: false,
            permissionOverwrites: {
              cache: new Collection(),
              edit: async (userId, patch) => {
                permissionEdits.push([channel.id, userId, patch]);
                const overwrites = channel.permissionOverwrites.cache;
                const current = overwrites.get(userId) ?? { allow: permissionBits(), deny: permissionBits() };
                const allow = new Set(accessFlags.filter((flag) => current.allow.has(flag)));
                const deny = new Set(accessFlags.filter((flag) => current.deny.has(flag)));
                for (const [name, value] of Object.entries(patch)) {
                  const flag = PermissionFlagsBits[name];
                  if (value === null) {
                    allow.delete(flag);
                    deny.delete(flag);
                  } else if (value === true) {
                    allow.add(flag);
                    deny.delete(flag);
                  } else if (value === false) {
                    deny.add(flag);
                    allow.delete(flag);
                  }
                }
                if (allow.size || deny.size) {
                  overwrites.set(userId, { allow: permissionBits([...allow]), deny: permissionBits([...deny]) });
                } else {
                  overwrites.delete(userId);
                }
              },
            },
            permissionsFor: (target) => ({
              has: (flag) => {
                if (target.id === BOT_ID) return flag === PermissionFlagsBits.ManageChannels;
                const overwrite = channel.permissionOverwrites.cache.get(MEMBER_ID);
                if (overwrite?.deny.has(flag)) return false;
                if (overwrite?.allow.has(flag)) return true;
                return false;
              },
            }),
          };
          underageChannels.set(channel.id, channel);
          return channel;
        }
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
    return {
      id,
      guild,
      roles,
      permissions: { has: () => false },
      user: {
        send: async (payload) => {
          dmPayloads.push(payload);
        },
      },
    };
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
    underageChannels,
    dmPayloads,
    nsfwVisibility: new NsfwVisibilityStore(directory),
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

test("unapproved category buttons stay inactive and stale controls are rejected", async (t) => {
  const fixture = makeFixture(t);
  const interaction = makeInteraction(fixture, { customId: "self-role:open:gender" });

  assert.equal(isSelfRoleInteraction(interaction), true);
  await handleSelfRoleInteraction(interaction, fixture);

  assert.equal(interaction.events[0].payload.ephemeral, true);
  assert.match(interaction.events[0].payload.content, /not available/i);
  assert.equal(fixture.member.roles.cache.size, 0);

  const wrongChannel = makeInteraction(fixture, {
    customId: "self-role:open:gender",
    channelId: "941800000000000098",
  });
  await handleSelfRoleInteraction(wrongChannel, fixture);
  assert.match(wrongChannel.events[0].payload.content, /not available/i);
});

test("forged multi-select values cannot assign any unapproved role", async (t) => {
  const fixture = makeFixture(t);
  const interaction = makeInteraction(fixture, {
    customId: "self-role:select:sexuality",
    kind: "select",
    values: ["straight", "asexual"],
  });

  await handleSelfRoleInteraction(interaction, fixture);
  assert.equal(interaction.events[0].payload.ephemeral, true);
  assert.match(interaction.events[0].payload.content, /no longer active/i);
  assert.equal(fixture.member.roles.cache.size, 0);
});

test("a forged multi-age selection is rejected without changing roles or opening tickets", async (t) => {
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
  assert.equal(interaction.events[0].type, "defer-reply");
  assert.equal(interaction.events[0].options.ephemeral, true);
  assert.match(interaction.events.at(-1).payload.content, /exactly one approved age option/i);
});

test("age choices replace the prior role and 18- restrictions restore after changing age", async (t) => {
  const fixture = makeFixture(t);
  const underage = makeInteraction(fixture, {
    customId: "self-role:select:age",
    kind: "select",
    values: ["under-18"],
  });

  await handleSelfRoleInteraction(underage, fixture);
  assert.equal(fixture.member.roles.cache.has(fixture.roleIds["age:under-18"]), true);
  assert.equal(fixture.store.getAgeSelection(GUILD_ID, MEMBER_ID), "under-18");
  assert.equal(
    fixture.underageChannels.get("941800000000000090")
      .permissionsFor(fixture.member)
      .has(PermissionFlagsBits.ViewChannel),
    false,
  );
  const support = [...fixture.underageChannels.values()].find(({ name }) => name === "support");
  assert.equal(support.permissionsFor(fixture.member).has(PermissionFlagsBits.ViewChannel), true);
  assert.equal(fixture.dmPayloads.length, 1);
  assert.equal(fixture.dmPayloads[0].embeds[0].data.color, 0xf472b6);
  assert.match(fixture.dmPayloads[0].embeds[0].data.description, /open a support ticket/i);

  const adult = makeInteraction(fixture, {
    customId: "self-role:select:age",
    kind: "select",
    values: ["18"],
  });
  await handleSelfRoleInteraction(adult, fixture);
  assert.equal(fixture.member.roles.cache.has(fixture.roleIds["age:under-18"]), false);
  assert.equal(fixture.member.roles.cache.has(fixture.roleIds["age:18"]), true);
  assert.equal(fixture.store.getAgeSelection(GUILD_ID, MEMBER_ID), "18");
  assert.equal(
    fixture.underageChannels.get("941800000000000090")
      .permissionsFor(fixture.member)
      .has(PermissionFlagsBits.ViewChannel),
    true,
  );
  assert.equal(fixture.store.getUnderageAccess(GUILD_ID, MEMBER_ID), null);
  assert.equal(fixture.dmPayloads.length, 1);
});

test("Hide Channels reactions persist across an under-18 selection and restore on removal", async (t) => {
  const fixture = makeFixture(t);
  const channel = fixture.underageChannels.get("941800000000000090");
  const hidePanelMessageId = "941800000000000015";
  channel.nsfw = true;
  fixture.store.setReactionPanelMessage(
    GUILD_ID,
    "hide-channels",
    PANEL_CHANNEL_ID,
    hidePanelMessageId,
    { [HIDE_CHANNELS_EMOJI]: "hide-nsfw" },
  );

  await handleSelfRoleInteraction(
    makeInteraction(fixture, {
      customId: "self-role:select:age",
      kind: "select",
      values: ["under-18"],
    }),
    fixture,
  );

  const reaction = {
    emoji: { name: HIDE_CHANNELS_EMOJI },
    message: {
      id: hidePanelMessageId,
      guildId: GUILD_ID,
      guild: fixture.guild,
    },
  };
  const user = { id: MEMBER_ID };
  await handleSelfRoleReaction(
    reaction,
    user,
    { store: fixture.store, nsfwVisibility: fixture.nsfwVisibility },
    "add",
  );
  assert.equal(fixture.store.getHideChannelsSelection(GUILD_ID, MEMBER_ID), true);
  assert.equal(
    fixture.nsfwVisibility.get(GUILD_ID, channel.id, MEMBER_ID),
    null,
  );

  await handleSelfRoleInteraction(
    makeInteraction(fixture, {
      customId: "self-role:select:age",
      kind: "select",
      values: ["18"],
    }),
    fixture,
  );
  assert.equal(
    channel.permissionsFor(fixture.member).has(PermissionFlagsBits.ViewChannel),
    false,
  );
  assert.ok(fixture.nsfwVisibility.get(GUILD_ID, channel.id, MEMBER_ID));

  await handleSelfRoleReaction(
    reaction,
    user,
    { store: fixture.store, nsfwVisibility: fixture.nsfwVisibility },
    "remove",
  );
  assert.equal(fixture.store.getHideChannelsSelection(GUILD_ID, MEMBER_ID), false);
  assert.equal(
    channel.permissionsFor(fixture.member).has(PermissionFlagsBits.ViewChannel),
    true,
  );
  assert.equal(
    fixture.nsfwVisibility.get(GUILD_ID, channel.id, MEMBER_ID),
    null,
  );
});

test("color controls remain inactive until their options are approved", async (t) => {
  const fixture = makeFixture(t);
  const category = makeInteraction(fixture, { customId: "self-role:open:color" });
  await handleSelfRoleInteraction(category, fixture);
  assert.match(category.events[0].payload.content, /not available/i);

  const set = makeInteraction(fixture, {
    customId: "self-role:color:set",
    message: {
      author: { bot: true },
      components: [{ components: [{ customId: "self-role:color:set" }] }],
    },
  });
  await handleSelfRoleInteraction(set, fixture);
  assert.match(set.events[0].payload.content, /not available/i);

  const submit = makeInteraction(fixture, {
    customId: "self-role:color:submit",
    kind: "modal",
  });
  await handleSelfRoleInteraction(submit, fixture);
  assert.match(submit.events[0].payload.content, /inactive until they are approved/i);
  assert.equal(fixture.member.roles.cache.size, 0);
});

test("unrelated private-ticket controls remain separate from the self-role panel", async (t) => {
  const fixture = makeFixture(t);
  const interaction = makeInteraction(fixture, { customId: "self-role:ticket-close" });
  await handleSelfRoleInteraction(interaction, fixture);
  assert.match(interaction.events[0].payload.content, /not an active Sugar AI review ticket/);
  assert.equal(SELF_ROLE_CHANNEL_NAME.includes("𝓼𝓮𝓵𝓯"), true);
});
