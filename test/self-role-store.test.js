import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SelfRoleStore } from "../src/self-role-store.js";

const GUILD_ID = "941800000000000001";
const CHANNEL_ID = "941800000000000002";
const MEMBER_ID = "941800000000000003";
const STAFF_ROLE_ID = "941800000000000004";
const AGE_ROLE_ID = "941800000000000005";

function dataDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "self-role-store-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("self-role channel, roles, and review tickets survive a new store instance", (t) => {
  const directory = dataDirectory(t);
  const store = new SelfRoleStore(directory);
  store.setChannel(GUILD_ID, CHANNEL_ID, "941800000000000006");
  store.setRoleId(GUILD_ID, "age:18", AGE_ROLE_ID);
  store.setRoleId(GUILD_ID, "staff", STAFF_ROLE_ID);
  store.setTicket(GUILD_ID, { channelId: "941800000000000007", memberId: MEMBER_ID });

  const restarted = new SelfRoleStore(directory);
  assert.deepEqual(restarted.getGuild(GUILD_ID), {
    channelId: CHANNEL_ID,
    messageId: "941800000000000006",
    staffRoleId: STAFF_ROLE_ID,
    roleIds: { "age:18": AGE_ROLE_ID },
    tickets: {
      "941800000000000007": {
        memberId: MEMBER_ID,
        status: "open",
        createdAt: restarted.getTicket(GUILD_ID, "941800000000000007").createdAt,
      },
    },
  });
  assert.equal(restarted.getOpenTicket(GUILD_ID, MEMBER_ID).channelId, "941800000000000007");

  const closed = restarted.closeTicket(GUILD_ID, "941800000000000007", STAFF_ROLE_ID);
  assert.equal(closed.status, "closed");
  assert.equal(new SelfRoleStore(directory).getOpenTicket(GUILD_ID, MEMBER_ID), null);
  assert.equal(new SelfRoleStore(directory).getTicket(GUILD_ID, "941800000000000007").closedBy, STAFF_ROLE_ID);
});

test("self-role store returns copies and refuses duplicate open tickets", (t) => {
  const store = new SelfRoleStore(dataDirectory(t));
  store.setRoleId(GUILD_ID, "age:18", AGE_ROLE_ID);
  const copy = store.getGuild(GUILD_ID);
  copy.roleIds["age:18"] = "941800000000000099";
  assert.equal(store.getGuild(GUILD_ID).roleIds["age:18"], AGE_ROLE_ID);

  store.setTicket(GUILD_ID, { channelId: CHANNEL_ID, memberId: MEMBER_ID });
  assert.throws(
    () => store.setTicket(GUILD_ID, { channelId: "941800000000000008", memberId: MEMBER_ID }),
    /already has an open review ticket/,
  );
});

test("role IDs cannot be reused across self-role options or accepted for unapproved keys", (t) => {
  const store = new SelfRoleStore(dataDirectory(t));
  store.setRoleId(GUILD_ID, "age:18", AGE_ROLE_ID);
  assert.throws(() => store.setRoleId(GUILD_ID, "gender:female", AGE_ROLE_ID), /more than one self-role option/);
  assert.throws(() => store.setRoleId(GUILD_ID, "custom:role", "941800000000000009"), /not part of the approved/);
});

test("deleted channels clear only matching panel or ticket metadata", (t) => {
  const store = new SelfRoleStore(dataDirectory(t));
  store.setChannel(GUILD_ID, CHANNEL_ID, "941800000000000006");
  store.setTicket(GUILD_ID, { channelId: "941800000000000007", memberId: MEMBER_ID });

  assert.equal(store.clearChannel(GUILD_ID, "941800000000000099"), false);
  assert.equal(store.clearChannel(GUILD_ID, CHANNEL_ID), true);
  assert.equal(store.getGuild(GUILD_ID).messageId, null);
  assert.equal(store.removeTicket(GUILD_ID, "941800000000000007"), true);
  assert.equal(store.getTicket(GUILD_ID, "941800000000000007"), null);
});

test("corrupt self-role data is refused without overwriting it", (t) => {
  const directory = dataDirectory(t);
  const file = path.join(directory, "self-roles.json");
  const original = "{ this is not json";
  fs.writeFileSync(file, original);

  assert.throws(() => new SelfRoleStore(directory), /invalid JSON/);
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("invalid self-role structures are refused without rewriting existing data", (t) => {
  const directory = dataDirectory(t);
  const file = path.join(directory, "self-roles.json");
  const original = JSON.stringify({
    version: 1,
    guilds: {
      [GUILD_ID]: {
        channelId: null,
        messageId: CHANNEL_ID,
        staffRoleId: null,
        roleIds: {},
        tickets: {},
      },
    },
  });
  fs.writeFileSync(file, original);

  assert.throws(() => new SelfRoleStore(directory), /invalid structure/);
  assert.equal(fs.readFileSync(file, "utf8"), original);
});
