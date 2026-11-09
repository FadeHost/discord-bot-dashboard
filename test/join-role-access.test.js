import assert from "node:assert/strict";
import test from "node:test";
import { ChannelType, Collection, PermissionFlagsBits } from "discord.js";

import {
  ensureJoinRoleVisibility,
  invalidateJoinRoleVisibility,
  JOIN_ROLE_CATEGORY_ID,
  JOIN_ROLE_ID,
} from "../src/join-role-access.js";

const BOT_ID = "941800000000000450";

function permissionBits(flags = []) {
  const bits = flags.reduce((value, flag) => value | BigInt(flag), 0n);
  return { has: (flag) => (bits & BigInt(flag)) !== 0n };
}

function makeFixture({
  guildId,
  categoryId = JOIN_ROLE_CATEGORY_ID,
  categoryType = ChannelType.GuildCategory,
  blockedChannelId = null,
  botCanManage = true,
  categoryExists = true,
} = {}) {
  const channels = new Collection();
  const edits = [];

  function makeChannel(id, {
    type = ChannelType.GuildText,
    parentId = null,
    permissionsLocked = false,
    initialAllow = [],
    initialDeny = [],
    canManage = botCanManage,
  } = {}) {
    const overwrites = new Collection();
    if (initialAllow.length || initialDeny.length) {
      overwrites.set(JOIN_ROLE_ID, {
        allow: permissionBits(initialAllow),
        deny: permissionBits(initialDeny),
      });
    }
    const channel = {
      id,
      guildId,
      type,
      parentId,
      permissionsLocked,
      permissionOverwrites: {
        cache: overwrites,
        edit: async (roleId, patch) => {
          edits.push({ channelId: id, roleId, patch });
          if (id === blockedChannelId && Object.hasOwn(patch, "ViewChannel")) {
            throw Object.assign(new Error("permission update denied"), { code: "50013" });
          }

          const current = overwrites.get(roleId) ?? {
            allow: permissionBits(),
            deny: permissionBits(),
          };
          const allow = new Set(
            Object.values(PermissionFlagsBits).filter((flag) => current.allow.has(flag)),
          );
          const deny = new Set(
            Object.values(PermissionFlagsBits).filter((flag) => current.deny.has(flag)),
          );
          for (const [name, value] of Object.entries(patch)) {
            const flag = PermissionFlagsBits[name];
            if (value === null) {
              allow.delete(flag);
              deny.delete(flag);
            } else if (value === true) {
              allow.add(flag);
              deny.delete(flag);
            } else {
              deny.add(flag);
              allow.delete(flag);
            }
          }
          if (allow.size || deny.size) {
            overwrites.set(roleId, {
              allow: permissionBits([...allow]),
              deny: permissionBits([...deny]),
            });
          } else {
            overwrites.delete(roleId);
          }
        },
        delete: async (roleId) => {
          overwrites.delete(roleId);
        },
      },
      permissionsFor: (member) => ({
        has: (flag) => member.id === BOT_ID && canManage && flag === PermissionFlagsBits.ManageChannels,
      }),
    };
    channels.set(id, channel);
    return channel;
  }

  const category = categoryExists
    ? makeChannel(categoryId, { type: categoryType })
    : null;
  const inCategory = makeChannel("941800000000000451", {
    parentId: JOIN_ROLE_CATEGORY_ID,
    initialAllow: [PermissionFlagsBits.SendMessages],
  });
  const syncedInCategory = makeChannel("941800000000000452", {
    parentId: JOIN_ROLE_CATEGORY_ID,
    permissionsLocked: true,
  });
  const otherCategory = makeChannel("941800000000000453", {
    type: ChannelType.GuildCategory,
    initialAllow: [PermissionFlagsBits.SendMessages],
  });
  const outside = makeChannel("941800000000000454", {
    parentId: otherCategory.id,
    initialAllow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
  });
  const syncedOutside = makeChannel("941800000000000455", {
    parentId: otherCategory.id,
    permissionsLocked: true,
  });
  const uncategorized = makeChannel("941800000000000456");
  const role = {
    id: JOIN_ROLE_ID,
    managed: false,
    permissions: { has: () => false },
  };
  const guild = {
    id: guildId,
    roles: { cache: new Collection([[role.id, role]]) },
    members: { me: { id: BOT_ID } },
    channels: { fetch: async () => channels },
  };

  return {
    guild,
    channels,
    makeChannel,
    role,
    category,
    inCategory,
    syncedInCategory,
    otherCategory,
    outside,
    syncedOutside,
    uncategorized,
    edits,
  };
}

function viewState(channel) {
  const overwrite = channel.permissionOverwrites.cache.get(JOIN_ROLE_ID);
  if (overwrite?.allow.has(PermissionFlagsBits.ViewChannel)) return true;
  if (overwrite?.deny.has(PermissionFlagsBits.ViewChannel)) return false;
  return null;
}

test("join role can see only its category and unsynced child channels", async () => {
  const fixture = makeFixture({ guildId: "941800000000000460" });

  assert.equal(await ensureJoinRoleVisibility(fixture.guild, fixture.role), true);
  assert.equal(viewState(fixture.category), true);
  assert.equal(viewState(fixture.inCategory), true);
  assert.equal(viewState(fixture.syncedInCategory), null);
  assert.equal(viewState(fixture.otherCategory), false);
  assert.equal(viewState(fixture.outside), false);
  assert.equal(viewState(fixture.syncedOutside), null);
  assert.equal(viewState(fixture.uncategorized), false);
  assert.equal(
    fixture.outside.permissionOverwrites.cache.get(JOIN_ROLE_ID).allow.has(PermissionFlagsBits.SendMessages),
    true,
    "unrelated role permissions remain intact",
  );

  const editCount = fixture.edits.length;
  assert.equal(await ensureJoinRoleVisibility(fixture.guild, fixture.role), true);
  assert.equal(fixture.edits.length, editCount, "repeated setup is idempotent");
});

test("join-role access fails closed when the target category is missing", async () => {
  const fixture = makeFixture({
    guildId: "941800000000000461",
    categoryExists: false,
  });
  const errors = [];
  const originalConsoleError = console.error;
  console.error = (...args) => errors.push(args.join(" "));

  try {
    assert.equal(await ensureJoinRoleVisibility(fixture.guild, fixture.role), false);
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(fixture.edits.length, 0);
  assert.match(errors[0], /category .* was not found/);
});

test("join-role access does not make changes without Manage Channels", async () => {
  const fixture = makeFixture({
    guildId: "941800000000000462",
    botCanManage: false,
  });
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    assert.equal(await ensureJoinRoleVisibility(fixture.guild, fixture.role), false);
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(fixture.edits.length, 0);
});

test("failed channel updates roll back earlier join-role permission changes", async () => {
  const fixture = makeFixture({
    guildId: "941800000000000463",
    blockedChannelId: "941800000000000454",
  });
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    assert.equal(await ensureJoinRoleVisibility(fixture.guild, fixture.role), false);
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(viewState(fixture.category), null);
  assert.equal(viewState(fixture.inCategory), null);
  assert.equal(viewState(fixture.otherCategory), null);
  assert.equal(
    fixture.otherCategory.permissionOverwrites.cache.get(JOIN_ROLE_ID).allow.has(PermissionFlagsBits.SendMessages),
    true,
  );
  assert.equal(viewState(fixture.outside), true);
  assert.equal(
    fixture.outside.permissionOverwrites.cache.get(JOIN_ROLE_ID).allow.has(PermissionFlagsBits.SendMessages),
    true,
  );
});

test("channels created during setup are included before the role policy is cached", async () => {
  const fixture = makeFixture({ guildId: "941800000000000465" });
  let releaseFirstFetch;
  let firstFetchStarted;
  let fetchCount = 0;
  const firstFetchStartedPromise = new Promise((resolve) => {
    firstFetchStarted = resolve;
  });
  const staleChannelList = new Collection(fixture.channels);
  fixture.guild.channels.fetch = async () => {
    fetchCount += 1;
    if (fetchCount === 1) {
      firstFetchStarted();
      return new Promise((resolve) => {
        releaseFirstFetch = () => resolve(staleChannelList);
      });
    }
    return fixture.channels;
  };

  const pending = ensureJoinRoleVisibility(fixture.guild, fixture.role);
  await firstFetchStartedPromise;
  const lateChannel = fixture.makeChannel("941800000000000466");
  invalidateJoinRoleVisibility(fixture.guild.id);
  releaseFirstFetch();

  assert.equal(await pending, true);
  assert.equal(fetchCount, 2);
  assert.equal(viewState(lateChannel), false);
});

test("administrator join roles are rejected instead of relying on ineffective channel denies", async () => {
  const fixture = makeFixture({ guildId: "941800000000000464" });
  fixture.role.permissions.has = (flag) => flag === PermissionFlagsBits.Administrator;
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    assert.equal(await ensureJoinRoleVisibility(fixture.guild, fixture.role), false);
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(fixture.edits.length, 0);
});
