import test from "node:test";
import assert from "node:assert/strict";
import { Collection } from "discord.js";

import { sendProfileWelcome } from "../src/bot.js";
import { createProfileWelcome, PROFILE_WELCOME_CHANNEL_ID } from "../src/profile-welcome.js";

const MEMBER_ID = "941800000000000301";
const GUILD_ID = "941800000000000302";

function makeMember() {
  return {
    id: MEMBER_ID,
    displayName: "Kitti",
    user: {
      username: "kitti",
      globalName: "Kitti",
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    },
    joinedAt: new Date("2025-01-01T00:00:00.000Z"),
    roles: {
      cache: new Collection([
        ["role-1", { name: "@everyone" }],
        ["role-2", { name: "Community member" }],
      ]),
    },
  };
}

test("profile welcomes use Sugar's bounded member context and only ping the new member", async () => {
  const member = makeMember();
  let captured;
  const payload = await createProfileWelcome(member, async (prompt, history, profile) => {
    captured = { prompt, history, profile };
    return "Welcome, Kitti! We’re glad you found your way here.";
  });

  assert.equal(PROFILE_WELCOME_CHANNEL_ID, "1567093021298794658");
  assert.match(captured.prompt, /public welcome/i);
  assert.deepEqual(captured.history, []);
  assert.deepEqual(captured.profile, {
    username: "kitti",
    displayName: "Kitti",
    roles: ["Community member"],
    accountCreated: "2024-01-01T00:00:00.000Z",
    memberSince: "2025-01-01T00:00:00.000Z",
  });
  assert.equal(payload.content, `<@${MEMBER_ID}> Welcome, Kitti! We’re glad you found your way here.`);
  assert.deepEqual(payload.allowedMentions, { parse: [], users: [MEMBER_ID] });
});

test("profile welcomes use a safe fallback if AI is unavailable or fails", async () => {
  const member = makeMember();
  const unavailable = await createProfileWelcome(member);
  assert.match(unavailable.content, /Sugar is glad you’re here/);

  const failed = await createProfileWelcome(member, async () => {
    throw new Error("provider details are not sent to the welcome channel");
  });
  assert.match(failed.content, /Sugar is glad you’re here/);
  assert.doesNotMatch(failed.content, /provider details/);
});

test("profile welcome output is bounded", async () => {
  const payload = await createProfileWelcome(makeMember(), async () => "x".repeat(500));
  assert.equal([...payload.content.slice(`<@${MEMBER_ID}> `.length)].length, 350);
});

test("profile welcomes only go to the configured channel in the joining member's server", async () => {
  const member = { ...makeMember(), guild: { id: GUILD_ID } };
  const sent = [];
  const client = {
    channels: {
      fetch: async (channelId) => {
        assert.equal(channelId, PROFILE_WELCOME_CHANNEL_ID);
        return {
          guildId: GUILD_ID,
          isTextBased: () => true,
          send: async (payload) => sent.push(payload),
        };
      },
    },
  };
  let generationCount = 0;
  const generateReply = async () => {
    generationCount += 1;
    return "A personalized hello.";
  };

  assert.equal(await sendProfileWelcome(client, member, generateReply), true);
  assert.equal(generationCount, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /A personalized hello/);

  const otherGuildClient = {
    channels: {
      fetch: async () => ({
        guildId: "941800000000000399",
        isTextBased: () => true,
        send: async () => assert.fail("should not post to another server"),
      }),
    },
  };
  assert.equal(await sendProfileWelcome(otherGuildClient, member, generateReply), false);
  assert.equal(generationCount, 1);
});
