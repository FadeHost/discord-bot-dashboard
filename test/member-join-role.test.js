import test from "node:test";
import assert from "node:assert/strict";
import { Collection } from "discord.js";

import { assignNewMemberRole } from "../src/bot.js";
import { JOIN_ROLE_ID } from "../src/join-role-access.js";

const GUILD_ID = "941800000000000401";
const MEMBER_ID = "941800000000000402";
const ROLE_ID = JOIN_ROLE_ID;

function makeMember({ roles = [], assignedRoleIds = [], fetchRoles, addError = null } = {}) {
  const added = [];
  const member = {
    id: MEMBER_ID,
    guild: {
      id: GUILD_ID,
      roles: {
        cache: new Collection(roles.map((role) => [role.id, role])),
        fetch: fetchRoles,
      },
    },
    roles: {
      cache: new Collection(assignedRoleIds.map((id) => [id, { id }])),
      add: async (role, reason) => {
        if (addError) throw addError;
        added.push({ role, reason });
      },
    },
  };
  return { member, added };
}

test("new members receive the configured join role by ID", async () => {
  const role = { id: ROLE_ID, name: "join role" };
  const { member, added } = makeMember({ roles: [role] });

  assert.equal(await assignNewMemberRole(member, async () => true), true);
  assert.deepEqual(added, [{
    role,
    reason: "Automatically assign the join role to new members",
  }]);
});

test("role assignment fetches roles if new is not in the cache", async () => {
  const role = { id: ROLE_ID, name: "join role" };
  let fetchCount = 0;
  const { member, added } = makeMember({
    fetchRoles: async () => {
      fetchCount += 1;
      return new Collection([[ROLE_ID, role]]);
    },
  });

  assert.equal(await assignNewMemberRole(member, async () => true), true);
  assert.equal(fetchCount, 1);
  assert.equal(added[0].role, role);
});

test("existing new roles are not assigned twice", async () => {
  const role = { id: ROLE_ID, name: "join role" };
  const { member, added } = makeMember({
    roles: [role],
    assignedRoleIds: [ROLE_ID],
  });

  assert.equal(await assignNewMemberRole(member, async () => true), true);
  assert.deepEqual(added, []);
});

test("missing roles or Discord permission errors do not throw", async () => {
  const missing = makeMember();
  const denied = makeMember({
    roles: [{ id: ROLE_ID, name: "join role" }],
    addError: Object.assign(new Error("missing permission"), { code: 50013 }),
  });
  const errors = [];
  const originalConsoleError = console.error;
  console.error = (...args) => errors.push(args.join(" "));

  try {
    assert.equal(await assignNewMemberRole(missing.member, async () => true), false);
    assert.equal(await assignNewMemberRole(denied.member, async () => true), false);
  } finally {
    console.error = originalConsoleError;
  }

  assert.match(errors[0], /join role was not found/);
  assert.match(errors[1], /Manage Roles permission and role hierarchy/);
});

test("a role named new cannot bypass the exact configured role ID", async () => {
  const wrongRole = { id: "941800000000000403", name: "new" };
  const { member, added } = makeMember({ roles: [wrongRole] });
  const errors = [];
  const originalConsoleError = console.error;
  console.error = (...args) => errors.push(args.join(" "));

  try {
    assert.equal(await assignNewMemberRole(member, async () => true), false);
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(added, []);
  assert.match(errors[0], /join role was not found/);
});

test("the join role is not assigned unless its visibility is configured", async () => {
  const role = { id: ROLE_ID, name: "join role" };
  const { member, added } = makeMember({ roles: [role] });
  const errors = [];
  const originalConsoleError = console.error;
  console.error = (...args) => errors.push(args.join(" "));

  try {
    assert.equal(await assignNewMemberRole(member, async () => false), false);
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(added, []);
  assert.match(errors[0], /could not be safely limited/);
});
