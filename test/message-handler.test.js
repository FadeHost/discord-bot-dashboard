import test from "node:test";
import assert from "node:assert/strict";

import { createMessageResponder } from "../src/message-handler.js";
import { cleanAddressedMessage, isAddressedToSugar } from "../src/message-trigger.js";

const BOT_ID = "123456789012345678";

function message({ content, id = "message-1", bot = false, guild = true, webhookId } = {}) {
  const replies = [];
  return {
    id,
    content,
    guild: guild ? { id: "guild-1" } : null,
    author: { bot },
    webhookId,
    replies,
    async reply(payload) {
      replies.push(payload);
    },
  };
}

test("explicit bot mentions and direct name addresses trigger locally", () => {
  for (const content of [
    `<@${BOT_ID}> what is the weather?`,
    `<@!${BOT_ID}> tell me a joke`,
    "Sugar, can you help me?",
    "Hey Sugar, what’s a good name for a cat?",
    "Sugar can you explain this?",
    "Sugar, I need some help.",
    "Sugar, can I ask you something?",
    "Can you help me, Sugar?",
    "Thanks, Sugar!",
    "Thanks Sugar",
    "Hey Sugar",
  ]) {
    assert.equal(isAddressedToSugar(content, BOT_ID), true, content);
  }
});

test("ordinary uses of sugar do not trigger the AI", () => {
  for (const content of [
    "I put sugar in my coffee.",
    "Sugar daddy stories are everywhere.",
    "I bought sugar cookies and candy.",
    "Sugar is in the drinks by the fridge.",
    "The recipe needs sugar, flour, and butter.",
    "Can you tell me where the sugar is?",
    "I like the word sugar.",
    "I need sugar.",
    "Hey Sugar, the coffee is ready.",
    "Sugar, the cake is in the kitchen.",
    "Sugar, I need sugar in my coffee.",
  ]) {
    assert.equal(isAddressedToSugar(content, BOT_ID), false, content);
  }
});

test("only the addressed text is cleaned and prompt length is bounded", () => {
  assert.equal(cleanAddressedMessage(`<@${BOT_ID}> tell me a joke`, BOT_ID), "tell me a joke");
  assert.equal(cleanAddressedMessage("Hey Sugar, tell me a joke", BOT_ID), "tell me a joke");
  assert.equal(cleanAddressedMessage("Can you help me, Sugar?", BOT_ID), "Can you help me");
  assert.equal(cleanAddressedMessage("Sugar, " + "x".repeat(2_000), BOT_ID).length, 1_200);
});

test("unaddressed messages never reach the provider", async () => {
  let calls = 0;
  const respond = createMessageResponder({
    generateReply: async () => {
      calls += 1;
      return "reply";
    },
    getBotUserId: () => BOT_ID,
  });

  const incoming = message({ content: "Sugar is in my coffee." });
  await respond(incoming);

  assert.equal(calls, 0);
  assert.equal(incoming.replies.length, 0);
});

test("bot, webhook, and DM messages are ignored", async () => {
  let calls = 0;
  const respond = createMessageResponder({
    generateReply: async () => {
      calls += 1;
      return "reply";
    },
    getBotUserId: () => BOT_ID,
  });

  await respond(message({ content: `<@${BOT_ID}> hello`, bot: true }));
  await respond(message({ content: `<@${BOT_ID}> hello`, webhookId: "webhook-1" }));
  await respond(message({ content: `<@${BOT_ID}> hello`, guild: false }));

  assert.equal(calls, 0);
});

test("duplicate message events produce only one provider call and reply", async () => {
  let calls = 0;
  const respond = createMessageResponder({
    generateReply: async () => {
      calls += 1;
      return "Hello!";
    },
    getBotUserId: () => BOT_ID,
  });

  const incoming = message({ content: `<@${BOT_ID}> hello` });
  await Promise.all([respond(incoming), respond(incoming)]);

  assert.equal(calls, 1);
  assert.equal(incoming.replies.length, 1);
  assert.deepEqual(incoming.replies[0].allowedMentions, { parse: [], repliedUser: false });
});


test("a direct reply to Sugar triggers a response and passes member context", async () => {
  let calls = 0;
  let receivedProfile;
  const respond = createMessageResponder({
    generateReply: async (_prompt, _history, profile) => {
      calls += 1;
      receivedProfile = profile;
      return "I’m here!";
    },
    getBotUserId: () => BOT_ID,
  });
  const incoming = message({ content: "and what do you think?", id: "reply-1" });
  incoming.reference = {
    messageId: "sugar-message",
    message: { author: { id: BOT_ID } },
  };
  incoming.member = {
    displayName: "Kitti",
    joinedAt: new Date("2025-01-01T00:00:00.000Z"),
    roles: { cache: [{ name: "Member" }] },
  };
  incoming.author = {
    id: "user-1",
    bot: false,
    username: "kitti",
    globalName: "Kitti",
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
  };

  await respond(incoming);

  assert.equal(calls, 1);
  assert.equal(incoming.replies[0].content, "I’m here!");
  assert.equal(receivedProfile.username, "kitti");
  assert.deepEqual(receivedProfile.roles, ["Member"]);
});

test("a reply to another member does not trigger Sugar", async () => {
  let calls = 0;
  const respond = createMessageResponder({
    generateReply: async () => { calls += 1; return "reply"; },
    getBotUserId: () => BOT_ID,
  });
  const incoming = message({ content: "same here", id: "reply-other" });
  incoming.reference = {
    messageId: "other-message",
    message: { author: { id: "another-user" } },
  };

  await respond(incoming);

  assert.equal(calls, 0);
  assert.equal(incoming.replies.length, 0);
});

test("concurrent provider work is capped", async () => {
  let calls = 0;
  let release;
  const waitForReply = new Promise((resolve) => {
    release = resolve;
  });
  const respond = createMessageResponder({
    generateReply: async () => {
      calls += 1;
      await waitForReply;
      return "Hello!";
    },
    getBotUserId: () => BOT_ID,
  });

  const first = message({ id: "one", content: `<@${BOT_ID}> one` });
  const second = message({ id: "two", content: `<@${BOT_ID}> two` });
  const third = message({ id: "three", content: `<@${BOT_ID}> three` });
  const pending = [respond(first), respond(second)];
  await new Promise((resolve) => setImmediate(resolve));
  await respond(third);
  release();
  await Promise.all(pending);

  assert.equal(calls, 2);
  assert.match(third.replies[0].content, /try me again/i);
});

test("provider failures produce a friendly fallback without exposing error text", async () => {
  const respond = createMessageResponder({
    generateReply: async () => {
      throw new Error("secret-key or provider response");
    },
    getBotUserId: () => BOT_ID,
  });
  const incoming = message({ content: `<@${BOT_ID}> hello` });
  const originalError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args.join(" "));

  try {
    await respond(incoming);
  } finally {
    console.error = originalError;
  }

  assert.equal(incoming.replies.length, 1);
  assert.match(incoming.replies[0].content, /can’t reach my AI/i);
  assert.doesNotMatch(logs.join(" "), /secret-key|provider response/);
});

test("generated replies are bounded to Discord-safe length", async () => {
  const respond = createMessageResponder({
    generateReply: async () => "x".repeat(3_000),
    getBotUserId: () => BOT_ID,
  });
  const incoming = message({ content: `<@${BOT_ID}> hello` });

  await respond(incoming);

  assert.equal(incoming.replies[0].content.length, 1_800);
});
