import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ChannelType, Collection, PermissionFlagsBits } from "discord.js";

import {
  applyUnderageAccess,
  ensureSupportChannel,
  restoreUnderageAccess,
} from "../src/underage-access.js";
import { SelfRoleStore } from "../src/self-role-store.js";

const GUILD_ID = "941800000000000001";
const MEMBER_ID = "941800000000000002";
const BOT_ID = "941800000000000003";
const CATEGORY_ID = "941800000000000010";
const GENERAL_ID = "941800000000000011";
const NSFW_ID = "941800000000000012";
const SUPPORT_ID = "941800000000000013";

function permissionBits(flags = []) {
  const bits = flags.reduce((value, flag) => value | BigInt(flag), 0n);
  return { has: (flag) => (bits & BigInt(flag)) !== 0n };
}

function makeFixture(
  t,
  {
    existingSupport = true,
    duplicateSupport = false,
    supportNsfw = false,
    supportCanManage = true,
    generalCanManage = true,
  } = {},
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "underage-access-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new SelfRoleStore(directory);
  const channels = new Collection();
  let nextChannelId = 100;
  let createCalls = 0;

  function makeChannel(id, name, {
    type = ChannelType.GuildText,
    nsfw = false,
    parentId = null,
    memberPermissions = [],
    initialAllow = [],
    initialDeny = [],
    canManage = true,
  } = {}) {
    const overwrites = new Collection();
    if (initialAllow.length || initialDeny.length) {
      overwrites.set(MEMBER_ID, {
        allow: permissionBits(initialAllow),
        deny: permissionBits(initialDeny),
      });
    }

    const channel = {
      id,
      guildId: GUILD_ID,
      name,
      type,
      nsfw,
      parentId,
      permissionOverwrites: {
        cache: overwrites,
        edit: async (userId, patch) => {
          const current = overwrites.get(userId) ?? {
            allow: permissionBits(),
            deny: permissionBits(),
          };
          const allow = new Set(
            Object.values(PermissionFlagsBits).filter((flag) => current.allow.has(flag)),
          );
          const deny = new Set(
            Object.values(PermissionFlagsBits).filter((flag) => current.deny.has(flag)),
          );
          for (const [nameKey, value] of Object.entries(patch)) {
            const flag = PermissionFlagsBits[nameKey];
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
            overwrites.set(userId, {
              allow: permissionBits([...allow]),
              deny: permissionBits([...deny]),
            });
          } else {
            overwrites.delete(userId);
          }
        },
      },
      permissionsFor: (target) => ({
        has: (flag) => {
          if (target.id === BOT_ID) return canManage && flag === PermissionFlagsBits.ManageChannels;
          const overwrite = overwrites.get(MEMBER_ID);
          if (overwrite?.deny.has(flag)) return false;
          if (overwrite?.allow.has(flag)) return true;
          return memberPermissions.includes(flag);
        },
      }),
    };
    return channel;
  }

  const category = makeChannel(CATEGORY_ID, "rooms", {
    type: ChannelType.GuildCategory,
    memberPermissions: [PermissionFlagsBits.ViewChannel],
  });
  const general = makeChannel(GENERAL_ID, "general", {
    canManage: generalCanManage,
    initialAllow: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
    ],
    memberPermissions: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
    ],
  });
  const nsfw = makeChannel(NSFW_ID, "adult", {
    nsfw: true,
    memberPermissions: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
    ],
  });
  channels.set(category.id, category);
  channels.set(general.id, general);
  channels.set(nsfw.id, nsfw);

  if (existingSupport) {
    channels.set(SUPPORT_ID, makeChannel(SUPPORT_ID, "support", {
      parentId: CATEGORY_ID,
      nsfw: supportNsfw,
      canManage: supportCanManage,
      initialDeny: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    }));
    if (duplicateSupport) {
      const duplicateId = "941800000000000014";
      channels.set(duplicateId, makeChannel(duplicateId, "support"));
    }
  }

  const botMember = {
    id: BOT_ID,
    permissions: { has: (flag) => flag === PermissionFlagsBits.ManageChannels },
  };
  const member = { id: MEMBER_ID, permissions: { has: () => false } };
  const guild = {
    id: GUILD_ID,
    members: { me: botMember },
    channels: {
      fetch: async () => channels,
      create: async (options) => {
        createCalls += 1;
        const id = `941800000000000${String(nextChannelId++).padStart(3, "0")}`;
        const channel = makeChannel(id, options.name, { type: options.type });
        channels.set(channel.id, channel);
        return channel;
      },
    },
  };
  return {
    store,
    guild,
    member,
    channels,
    category,
    general,
    nsfw,
    get createCalls() { return createCalls; },
  };
}

test("under-18 access hides every channel except support and restores the saved permissions", async (t) => {
  const fixture = makeFixture(t);
  const support = await ensureSupportChannel(fixture.guild);

  const restricted = await applyUnderageAccess(
    fixture.guild,
    fixture.member,
    support,
    fixture.store,
  );
  assert.equal(restricted.failed, 0);
  assert.equal(restricted.supportAvailable, true);
  assert.equal(fixture.category.permissionsFor(fixture.member).has(PermissionFlagsBits.ViewChannel), false);
  assert.equal(fixture.general.permissionsFor(fixture.member).has(PermissionFlagsBits.ViewChannel), false);
  assert.equal(
    fixture.general.permissionOverwrites.cache.get(MEMBER_ID).allow.has(PermissionFlagsBits.SendMessages),
    true,
  );
  assert.equal(fixture.nsfw.permissionsFor(fixture.member).has(PermissionFlagsBits.ViewChannel), false);
  assert.equal(support.permissionsFor(fixture.member).has(PermissionFlagsBits.ViewChannel), true);
  assert.equal(support.permissionsFor(fixture.member).has(PermissionFlagsBits.SendMessages), true);
  assert.equal(support.nsfw, false);

  const saved = fixture.store.getUnderageAccess(GUILD_ID, MEMBER_ID);
  assert.ok(saved.channels[CATEGORY_ID]);
  assert.ok(saved.channels[GENERAL_ID]);
  assert.ok(saved.channels[NSFW_ID]);
  assert.deepEqual(saved.channels[GENERAL_ID].permissions, { ViewChannel: true });
  assert.deepEqual(saved.channels[SUPPORT_ID].permissions, {
    ViewChannel: false,
    SendMessages: false,
    ReadMessageHistory: false,
  });

  const repeated = await applyUnderageAccess(
    fixture.guild,
    fixture.member,
    support,
    fixture.store,
  );
  assert.equal(repeated.failed, 0);
  assert.equal(repeated.supportAvailable, true);

  const restored = await restoreUnderageAccess(fixture.guild, fixture.member, fixture.store);
  assert.equal(restored.failed, 0);
  assert.equal(fixture.store.getUnderageAccess(GUILD_ID, MEMBER_ID), null);
  assert.equal(fixture.category.permissionsFor(fixture.member).has(PermissionFlagsBits.ViewChannel), true);
  assert.equal(fixture.general.permissionsFor(fixture.member).has(PermissionFlagsBits.ViewChannel), true);
  assert.equal(
    fixture.general.permissionOverwrites.cache.get(MEMBER_ID).allow.has(PermissionFlagsBits.ViewChannel),
    true,
  );
  assert.equal(fixture.nsfw.nsfw, true);
  assert.equal(support.permissionsFor(fixture.member).has(PermissionFlagsBits.ViewChannel), false);
});

test("restriction waits until #support access is confirmed", async (t) => {
  const fixture = makeFixture(t, { supportCanManage: false });
  const support = await ensureSupportChannel(fixture.guild);

  const result = await applyUnderageAccess(
    fixture.guild,
    fixture.member,
    support,
    fixture.store,
  );

  assert.equal(result.supportAvailable, false);
  assert.equal(result.failed, 1);
  assert.equal(fixture.general.permissionsFor(fixture.member).has(PermissionFlagsBits.ViewChannel), true);
  assert.equal(fixture.store.getUnderageAccess(GUILD_ID, MEMBER_ID), null);
});

test("permission failures are counted while a confirmed support path remains available", async (t) => {
  const fixture = makeFixture(t, { generalCanManage: false });
  const support = await ensureSupportChannel(fixture.guild);

  const result = await applyUnderageAccess(
    fixture.guild,
    fixture.member,
    support,
    fixture.store,
  );

  assert.equal(result.supportAvailable, true);
  assert.equal(result.failed, 1);
  assert.equal(fixture.general.permissionsFor(fixture.member).has(PermissionFlagsBits.ViewChannel), true);
  assert.equal(support.permissionsFor(fixture.member).has(PermissionFlagsBits.ViewChannel), true);
});

test("support creation is idempotent and existing duplicates are not expanded", async (t) => {
  const missing = makeFixture(t, { existingSupport: false });
  const [first, second] = await Promise.all([
    ensureSupportChannel(missing.guild),
    ensureSupportChannel(missing.guild),
  ]);
  assert.equal(first.id, second.id);
  assert.equal(missing.createCalls, 1);
  assert.equal(first.name, "support");

  const duplicate = makeFixture(t, { duplicateSupport: true });
  await assert.rejects(ensureSupportChannel(duplicate.guild), /More than one #support channel/);
  assert.equal(duplicate.createCalls, 0);
});

test("an age-restricted support channel and unmanageable channels fail closed", async (t) => {
  const fixture = makeFixture(t, { supportNsfw: true });
  await assert.rejects(ensureSupportChannel(fixture.guild), /native Discord restrictions were not bypassed/);
  const adult = fixture.nsfw;
  adult.permissionsFor = () => permissionBits([]);
  const result = await applyUnderageAccess(
    fixture.guild,
    fixture.member,
    { ...fixture.channels.get(SUPPORT_ID), nsfw: true },
    fixture.store,
  ).catch((error) => error);
  assert.ok(result instanceof Error);
  assert.equal(adult.permissionOverwrites.cache.size, 0);
});
