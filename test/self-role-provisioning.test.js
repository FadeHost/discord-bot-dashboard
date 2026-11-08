import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ChannelType, Collection, PermissionFlagsBits } from "discord.js";

import { toRoyalBold } from "../src/embed-format.js";
import {
  SELF_ROLE_CHANNEL_NAME,
  SELF_ROLE_EMBED_FOOTER,
} from "../src/self-role-catalog.js";
import {
  ensureSelfRoleChannel,
  ensureSelfRolePanel,
  ensureSelfRoles,
} from "../src/self-role-provisioning.js";
import { SelfRoleStore } from "../src/self-role-store.js";

const GUILD_ID = "941800000000000001";
const BOT_ID = "941800000000000002";
const CHANNEL_ID = "941800000000000003";
const MESSAGE_ID = "941800000000000004";

function directory(t) {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), "self-role-provisioning-test-"));
  t.after(() => fs.rmSync(result, { recursive: true, force: true }));
  return result;
}

function role(id, name, permissions = 0n, color = 0) {
  return {
    id,
    name,
    permissions: { bitfield: permissions },
    color,
    managed: false,
    editable: true,
    edit: async function (options) {
      Object.assign(this, options);
      return this;
    },
  };
}

function guildWithRoleManager(initialRoles = []) {
  const roleCache = new Collection(initialRoles.map((item) => [item.id, item]));
  const createCalls = [];
  let nextId = 500;
  const guild = {
    id: GUILD_ID,
    roles: {
      cache: roleCache,
      fetch: async () => roleCache,
      create: async (options) => {
        createCalls.push(options);
        const created = role(
          `941800000000000${String(nextId++).padStart(3, "0")}`,
          options.name,
          0n,
          options.color ?? 0,
        );
        created.createOptions = options;
        roleCache.set(created.id, created);
        return created;
      },
    },
  };
  return { guild, roleCache, createCalls };
}

test("missing self-role channel is created once with the Kittisugar style", async () => {
  const created = [];
  const channelCache = new Collection();
  const guild = {
    id: GUILD_ID,
    channels: {
      cache: channelCache,
      fetch: async () => channelCache,
      create: async (options) => {
        created.push(options);
        const channel = { id: CHANNEL_ID, ...options };
        channelCache.set(channel.id, channel);
        return channel;
      },
    },
  };

  const first = await ensureSelfRoleChannel(guild);
  const second = await ensureSelfRoleChannel(guild);
  assert.equal(first, second);
  assert.equal(created.length, 1);
  assert.equal(created[0].name, SELF_ROLE_CHANNEL_NAME);
  assert.equal(created[0].type, ChannelType.GuildText);
  assert.match(created[0].name, /୨୧/u);
  assert.match(created[0].name, new RegExp(toRoyalBold("self-roles")));
});

test("a single existing self-role alias is restyled in place without touching permissions", async () => {
  const permissionOverwrites = { marker: true };
  const existing = {
    id: CHANNEL_ID,
    name: "self roles",
    type: ChannelType.GuildText,
    permissionOverwrites,
    setName: async function (name) {
      this.name = name;
      return this;
    },
  };
  const channelCache = new Collection([[existing.id, existing]]);
  let createCalls = 0;
  const guild = {
    id: GUILD_ID,
    channels: {
      cache: channelCache,
      fetch: async () => channelCache,
      create: async () => {
        createCalls += 1;
      },
    },
  };

  const found = await ensureSelfRoleChannel(guild);
  assert.equal(found, existing);
  assert.equal(existing.name, SELF_ROLE_CHANNEL_NAME);
  assert.equal(existing.permissionOverwrites, permissionOverwrites);
  assert.equal(createCalls, 0);
});

test("duplicate matching channels are reused without renaming or deleting either", async () => {
  let renameCalls = 0;
  const styled = { id: CHANNEL_ID, name: SELF_ROLE_CHANNEL_NAME, type: ChannelType.GuildText };
  const plain = {
    id: "941800000000000005",
    name: "self-roles",
    type: ChannelType.GuildText,
    setName: async () => {
      renameCalls += 1;
    },
  };
  const channelCache = new Collection([[plain.id, plain], [styled.id, styled]]);
  const guild = {
    id: GUILD_ID,
    channels: { cache: channelCache, fetch: async () => channelCache, create: async () => assert.fail("no duplicate") },
  };
  const originalConsoleWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await ensureSelfRoleChannel(guild), styled);
  } finally {
    console.warn = originalConsoleWarn;
  }
  assert.equal(renameCalls, 0);
  assert.equal(channelCache.size, 2);
});

test("an unavailable channel inventory fails closed instead of creating a duplicate", async () => {
  let createCalls = 0;
  const guild = {
    id: GUILD_ID,
    channels: {
      cache: new Collection(),
      fetch: async () => {
        throw Object.assign(new Error("unavailable"), { code: 500 });
      },
      create: async () => {
        createCalls += 1;
      },
    },
  };
  const originalConsoleWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await ensureSelfRoleChannel(guild), null);
  } finally {
    console.warn = originalConsoleWarn;
  }
  assert.equal(createCalls, 0);
});

test("provisioning creates no unapproved self-role or staff roles", async (t) => {
  const dataDir = directory(t);
  const store = new SelfRoleStore(dataDir);
  const everyone = role(GUILD_ID, "@everyone");
  const { guild, roleCache, createCalls } = guildWithRoleManager([everyone]);

  const roleIds = await ensureSelfRoles(guild, store);
  assert.deepEqual(roleIds, {});
  assert.equal(createCalls.length, 0);
  assert.equal(roleCache.size, 1);
  assert.equal(store.getGuild(GUILD_ID).staffRoleId, null);

  const restarted = new SelfRoleStore(dataDir);
  assert.deepEqual(await ensureSelfRoles(guild, restarted), {});
  assert.equal(createCalls.length, 0);
});

test("existing role names are left untouched while role choices await approval", async (t) => {
  const store = new SelfRoleStore(directory(t));
  const privileged = role(
    "941800000000000006",
    toRoyalBold("Age · 18"),
    PermissionFlagsBits.ManageRoles,
  );
  const { guild, createCalls } = guildWithRoleManager([role(GUILD_ID, "@everyone"), privileged]);

  assert.deepEqual(await ensureSelfRoles(guild, store), {});
  assert.equal(createCalls.length, 0);
  assert.equal(privileged.name, toRoyalBold("Age · 18"));
  assert.equal(privileged.permissions.bitfield, PermissionFlagsBits.ManageRoles);
});

test("the self-role panel is edited on restart instead of duplicated", async (t) => {
  const store = new SelfRoleStore(directory(t));
  const history = new Collection();
  let sends = 0;
  let edits = 0;
  const channel = {
    id: CHANNEL_ID,
    guildId: GUILD_ID,
    messages: {
      fetch: async (query) => {
        if (typeof query === "string") {
          const found = history.get(query);
          if (!found) throw Object.assign(new Error("unknown message"), { code: 10008 });
          return found;
        }
        return history;
      },
    },
    send: async (payload) => {
      sends += 1;
      const message = {
        id: MESSAGE_ID,
        author: { id: BOT_ID },
        embeds: payload.embeds.map((embed) => embed.toJSON()),
        edit: async (nextPayload) => {
          edits += 1;
          message.embeds = nextPayload.embeds.map((embed) => embed.toJSON());
          return message;
        },
      };
      history.set(message.id, message);
      return message;
    },
  };
  const client = { user: { id: BOT_ID } };

  await ensureSelfRolePanel(channel, client, store, {});
  await ensureSelfRolePanel(channel, client, store, {});
  assert.equal(sends, 1);
  assert.equal(edits, 1);
  assert.equal(store.getGuild(GUILD_ID).channelId, CHANNEL_ID);
  assert.equal(store.getGuild(GUILD_ID).messageId, MESSAGE_ID);
  assert.equal(history.get(MESSAGE_ID).embeds[0].footer.text, SELF_ROLE_EMBED_FOOTER);
});
