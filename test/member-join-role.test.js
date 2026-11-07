import test from "node:test";
import assert from "node:assert/strict";
import { Collection } from "discord.js";

import { assignNewMemberRole } from "../src/bot.js";

const GUILD_ID = "941800000000000401";
const MEMBER_ID = "941800000000000402";
const ROLE_ID = "941800000000000403";

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

test("new members receive the exact role named new", async () => {
  const role = { id: ROLE_ID, name: "new" };
  const { member, added } = makeMember({ roles: [role] });

  assert.equal(await assignNewMemberRole(member), true);
  assert.deepEqual(added, [{
    role,
    reason: "Automatically assign the new role to new members",
  }]);
});

test("role assignment fetches roles if new is not in the cache", async () => {
  const role = { id: ROLE_ID, name: "new" };
  let fetchCount = 0;
  const { member, added } = makeMember({
    fetchRoles: async () => {
      fetchCount += 1;
      return new Collection([[ROLE_ID, role]]);
    },
  });

  assert.equal(await assignNewMemberRole(member), true);
  assert.equal(fetchCount, 1);
  assert.equal(added[0].role, role);
});

test("existing new roles are not assigned twice", async () => {
  const role = { id: ROLE_ID, name: "new" };
  const { member, added } = makeMember({
    roles: [role],
    assignedRoleIds: [ROLE_ID],
  });

  assert.equal(await assignNewMemberRole(member), true);
  assert.deepEqual(added, []);
});

test("missing roles or Discord permission errors do not throw", async () => {
  const missing = makeMember();
  const denied = makeMember({
    roles: [{ id: ROLE_ID, name: "new" }],
    addError: Object.assign(new Error("missing permission"), { code: 50013 }),
  });
  const errors = [];
  const originalConsoleError = console.error;
  console.error = (...args) => errors.push(args.join(" "));

  try {
    assert.equal(await assignNewMemberRole(missing.member), false);
    assert.equal(await assignNewMemberRole(denied.member), false);
  } finally {
    console.error = originalConsoleError;
  }

  assert.match(errors[0], /role "new" was not found/);
  assert.match(errors[1], /Manage Roles permission and role hierarchy/);
});
