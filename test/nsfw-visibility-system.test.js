import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Collection, PermissionFlagsBits } from "discord.js";

import { NsfwVisibilityStore } from "../src/nsfw-visibility-store.js";
import {
  applyNsfwVisibility,
  buildNsfwVisibilityCommand,
  handleNsfwVisibilityInteraction,
} from "../src/nsfw-visibility-system.js";

const GUILD_ID = "941800000000000001";
const MEMBER_ID = "941800000000000002";
const BOT_ID = "941800000000000003";

function permissionBits(values = []) {
  const bitfield = values.reduce((bits, value) => bits | BigInt(value), 0n);
  return {
    bitfield,
    has: (permission) => (bitfield & BigInt(permission)) !== 0n,
  };
}

function makeFixture(t, { canManage = true } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nsfw-visibility-test-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new NsfwVisibilityStore(dataDir);
  const member = { id: MEMBER_ID };
  const botMember = { id: BOT_ID };
  const editCalls = [];

  function channel(id, { nsfw = true, canView = true, initialOverwrite = null, manage = canManage } = {}) {
    const overwrites = new Collection();
    if (initialOverwrite) {
      overwrites.set(MEMBER_ID, {
        allow: permissionBits(initialOverwrite.allow ?? []),
        deny: permissionBits(initialOverwrite.deny ?? []),
      });
    }
    const value = {
      id,
      guildId: GUILD_ID,
      nsfw,
      permissionOverwrites: {
        cache: overwrites,
        edit: async (userId, patch, reason) => {
          editCalls.push({ channelId: id, userId, patch, reason });
          const current = overwrites.get(userId) ?? { allow: permissionBits(), deny: permissionBits() };
          const allow = new Set();
          const deny = new Set();
          for (const flag of [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]) {
            if (current.allow.has(flag)) allow.add(flag);
            if (current.deny.has(flag)) deny.add(flag);
          }
          if (patch.ViewChannel === null) {
            allow.delete(PermissionFlagsBits.ViewChannel);
            deny.delete(PermissionFlagsBits.ViewChannel);
          } else if (patch.ViewChannel === true) {
            allow.add(PermissionFlagsBits.ViewChannel);
            deny.delete(PermissionFlagsBits.ViewChannel);
          } else if (patch.ViewChannel === false) {
            deny.add(PermissionFlagsBits.ViewChannel);
            allow.delete(PermissionFlagsBits.ViewChannel);
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
          if (target.id === BOT_ID) return manage && flag === PermissionFlagsBits.ManageChannels;
          const overwrite = overwrites.get(MEMBER_ID);
          if (overwrite?.deny.has(flag)) return false;
          if (overwrite?.allow.has(flag)) return true;
          return flag === PermissionFlagsBits.ViewChannel && canView;
        },
      }),
    };
    return value;
  }

  const nsfw = channel("941800000000000010");
  const regular = channel("941800000000000011", { nsfw: false });
  const channels = new Collection([[nsfw.id, nsfw], [regular.id, regular]]);
  const guild = {
    id: GUILD_ID,
    channels: { fetch: async () => channels },
    members: { me: botMember, fetch: async () => member },
  };
  return { dataDir, store, member, botMember, guild, channels, nsfw, regular, editCalls, channel };
}

test("show-hide command offers only show or hide and keeps Discord's age restriction", () => {
  const command = buildNsfwVisibilityCommand();
  assert.equal(command.name, "show-hide");
  assert.deepEqual(command.options[0].choices.map(({ value }) => value), ["show", "hide"]);
  assert.match(command.description, /already access/);
});

test("hide and show restore only the member's previous View Channel state", async (t) => {
  const fixture = makeFixture(t);
  const hidden = await applyNsfwVisibility(fixture.guild, fixture.member, fixture.store, "hide");

  assert.deepEqual(hidden, { changed: 1, skipped: 0, failed: 0 });
  assert.equal(fixture.store.get(GUILD_ID, fixture.nsfw.id, MEMBER_ID).previousViewChannel, null);
  assert.equal(fixture.nsfw.permissionsFor(fixture.member).has(PermissionFlagsBits.ViewChannel), false);
  assert.equal(fixture.regular.permissionOverwrites.cache.size, 0);
  assert.equal(fixture.nsfw.nsfw, true);
  assert.deepEqual(fixture.editCalls[0].patch, { ViewChannel: false });

  const shown = await applyNsfwVisibility(fixture.guild, fixture.member, fixture.store, "show");
  assert.deepEqual(shown, { changed: 1, skipped: 0, failed: 0 });
  assert.equal(fixture.store.get(GUILD_ID, fixture.nsfw.id, MEMBER_ID), null);
  assert.equal(fixture.nsfw.permissionsFor(fixture.member).has(PermissionFlagsBits.ViewChannel), true);
  assert.equal(fixture.nsfw.nsfw, true);
  assert.deepEqual(fixture.editCalls[1].patch, { ViewChannel: null });
});

test("hiding preserves other explicit member permissions", async (t) => {
  const fixture = makeFixture(t, {
    canManage: true,
  });
  const channel = fixture.channel("941800000000000012", {
    initialOverwrite: { allow: [PermissionFlagsBits.SendMessages] },
  });
  fixture.channels.set(channel.id, channel);

  await applyNsfwVisibility(fixture.guild, fixture.member, fixture.store, "hide");
  const afterHide = channel.permissionOverwrites.cache.get(MEMBER_ID);
  assert.equal(afterHide.allow.has(PermissionFlagsBits.SendMessages), true);
  assert.equal(afterHide.deny.has(PermissionFlagsBits.ViewChannel), true);

  await applyNsfwVisibility(fixture.guild, fixture.member, fixture.store, "show");
  const afterShow = channel.permissionOverwrites.cache.get(MEMBER_ID);
  assert.equal(afterShow.allow.has(PermissionFlagsBits.SendMessages), true);
  assert.equal(afterShow.deny.has(PermissionFlagsBits.ViewChannel), false);
});

test("hide skips channels the member cannot access and never changes native NSFW flags", async (t) => {
  const fixture = makeFixture(t);
  const inaccessible = fixture.channel("941800000000000013", { canView: false });
  fixture.channels.set(inaccessible.id, inaccessible);

  const result = await applyNsfwVisibility(fixture.guild, fixture.member, fixture.store, "hide");
  assert.deepEqual(result, { changed: 1, skipped: 1, failed: 0 });
  assert.equal(inaccessible.permissionOverwrites.cache.size, 0);
  assert.equal(inaccessible.nsfw, true);
});

test("an explicit member allow is not replaced by a hide override", async (t) => {
  const fixture = makeFixture(t);
  const explicitlyAllowed = fixture.channel("941800000000000014", {
    initialOverwrite: { allow: [PermissionFlagsBits.ViewChannel] },
  });
  fixture.channels.set(explicitlyAllowed.id, explicitlyAllowed);

  const result = await applyNsfwVisibility(fixture.guild, fixture.member, fixture.store, "hide");
  assert.equal(result.changed, 1);
  assert.equal(result.skipped, 1);
  assert.equal(explicitlyAllowed.permissionOverwrites.cache.get(MEMBER_ID).allow.has(PermissionFlagsBits.ViewChannel), true);
  assert.equal(fixture.store.get(GUILD_ID, explicitlyAllowed.id, MEMBER_ID), null);
});

test("show never restores an old explicit allow or bypasses current channel settings", async (t) => {
  const fixture = makeFixture(t);
  fixture.store.save(GUILD_ID, fixture.nsfw.id, MEMBER_ID, {
    hadOverwrite: true,
    previousViewChannel: true,
  });

  const result = await applyNsfwVisibility(fixture.guild, fixture.member, fixture.store, "show");
  assert.equal(result.changed, 0);
  assert.equal(result.skipped, 1);
  assert.equal(fixture.editCalls.length, 0);
  assert.equal(fixture.nsfw.nsfw, true);
});

test("channels without Manage Channels permission are not modified", async (t) => {
  const fixture = makeFixture(t, { canManage: false });
  const result = await applyNsfwVisibility(fixture.guild, fixture.member, fixture.store, "hide");
  assert.equal(result.failed, 1);
  assert.equal(fixture.editCalls.length, 0);
  assert.equal(fixture.store.listMember(GUILD_ID, MEMBER_ID).length, 0);
});

test("command action is validated and the response is private", async (t) => {
  const fixture = makeFixture(t);
  const events = [];
  const interaction = {
    guild: fixture.guild,
    guildId: GUILD_ID,
    user: fixture.member,
    options: { getString: () => "show" },
    inGuild: () => true,
    deferReply: async (options) => events.push({ type: "defer", options }),
    editReply: async (payload) => events.push({ type: "edit", payload }),
  };

  await handleNsfwVisibilityInteraction(interaction, { store: fixture.store });
  assert.equal(events[0].options.ephemeral, true);
  assert.match(events[1].payload, /native age restrictions remain in force/);
});

test("store state survives restart and deleting a channel clears only its records", (t) => {
  const fixture = makeFixture(t);
  fixture.store.save(GUILD_ID, fixture.nsfw.id, MEMBER_ID, {
    hadOverwrite: false,
    previousViewChannel: null,
  });

  const restarted = new NsfwVisibilityStore(fixture.dataDir);
  assert.deepEqual(restarted.listMember(GUILD_ID, MEMBER_ID).map(({ channelId }) => channelId), [fixture.nsfw.id]);
  assert.equal(restarted.clearChannel(GUILD_ID, fixture.nsfw.id), 1);
  assert.equal(new NsfwVisibilityStore(fixture.dataDir).listMember(GUILD_ID, MEMBER_ID).length, 0);
});

test("invalid action is rejected before touching channel state", async (t) => {
  const fixture = makeFixture(t);
  await assert.rejects(applyNsfwVisibility(fixture.guild, fixture.member, fixture.store, "verify"), /valid NSFW visibility action/);
  assert.equal(fixture.editCalls.length, 0);
});
