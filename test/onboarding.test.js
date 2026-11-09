import test from "node:test";
import assert from "node:assert/strict";
import { ChannelType, Collection } from "discord.js";

import {
  buildOnboardingWelcomePayload,
  buildOnboardingGuidePayload,
  completeOnboardingVerification,
  createOnboardingService,
  ensureOnboardingChannels,
  handleOnboardingReaction,
  ONBOARDING_CHANNEL_ID,
  ONBOARDING_FOOTER,
  ONBOARDING_GUIDE_FOOTER,
  PINK_CHECK_EMOJI,
  PINK_CHECK_EMOJI_ID,
} from "../src/onboarding.js";
import { JOIN_ROLE_ID } from "../src/join-role-access.js";

const GUILD_ID = "941800000000000410";
const MEMBER_ID = "941800000000000411";
const NEW_ROLE_ID = JOIN_ROLE_ID;
const MEMBER_ROLE_ID = "941800000000000413";
const BOT_ID = "941800000000000414";
const STYLED_CHANNEL_NAMES = {
  rules: "📄 | ୨୧ • 𝓻𝓾𝓵𝓮𝓼",
  help: "❓ | ୨୧ • 𝓱𝓮𝓵𝓹",
  start: "👋 | ୨୧ • 𝓼𝓽𝓪𝓻𝓽",
  guide: "📖 | ୨୧ • 𝓰𝓾𝓲𝓭𝓮",
  news: "📢 | ୨୧ • 𝓪𝓷𝓷𝓸𝓾𝓷𝓬𝓮𝓶𝓮𝓷𝓽𝓼",
};

function makeGuild({ channels = [], roles = [], memberRoleIds = [NEW_ROLE_ID], addError = null, removeError = null } = {}) {
  const createdChannels = [];
  const channelCache = new Collection(channels.map((channel) => [channel.id, channel]));
  let nextChannelId = 500;
  const guild = {
    id: GUILD_ID,
    name: "Sugar Server",
    channels: {
      cache: channelCache,
      fetch: async () => channelCache,
      create: async (options) => {
        const channel = {
          id: String(nextChannelId++),
          name: options.name,
          type: options.type,
        };
        createdChannels.push({ options, channel });
        channelCache.set(channel.id, channel);
        return channel;
      },
    },
    roles: {
      cache: new Collection(roles.map((role) => [role.id, role])),
      fetch: async () => new Collection(roles.map((role) => [role.id, role])),
    },
    emojis: {
      cache: new Collection([[PINK_CHECK_EMOJI_ID, { id: PINK_CHECK_EMOJI_ID, name: "pinkcheck" }]]),
      fetch: async (id) => ({ id, name: "pinkcheck" }),
    },
    members: {
      fetch: async () => member,
    },
  };

  const memberRoleCache = new Collection(memberRoleIds.map((id) => [id, { id }]));
  const calls = [];
  const member = {
    id: MEMBER_ID,
    guild,
    roles: {
      cache: memberRoleCache,
      add: async (role, reason) => {
        calls.push({ action: "add", role, reason });
        if (addError) throw addError;
        memberRoleCache.set(role.id, role);
      },
      remove: async (role, reason) => {
        calls.push({ action: "remove", role, reason });
        if (removeError) throw removeError;
        memberRoleCache.delete(role.id);
      },
    },
  };

  return { guild, member, createdChannels, calls };
}

function onboardingRoles() {
  return [
    { id: NEW_ROLE_ID, name: "new" },
    { id: MEMBER_ROLE_ID, name: "member" },
  ];
}

test("onboarding setup creates missing channels and uses an announcement channel for news", async () => {
  const { guild, createdChannels } = makeGuild();

  const channels = await ensureOnboardingChannels(guild);

  assert.deepEqual([...channels.keys()], ["rules", "help", "start", "guide", "news"]);
  assert.equal(createdChannels.length, 5);
  assert.deepEqual(
    createdChannels.map(({ options }) => options.name),
    Object.values(STYLED_CHANNEL_NAMES),
  );
  assert.equal(
    createdChannels.find(({ options }) => options.name === STYLED_CHANNEL_NAMES.news).options.type,
    ChannelType.GuildAnnouncement,
  );
});

test("news falls back to a text channel when Discord rejects announcement-channel creation", async () => {
  const { guild } = makeGuild();
  const createChannel = guild.channels.create;
  const attempts = [];
  guild.channels.create = async (options) => {
    attempts.push(options);
    if (options.name === STYLED_CHANNEL_NAMES.news && options.type === ChannelType.GuildAnnouncement) {
      throw Object.assign(new Error("announcement channels unavailable"), { code: 50035 });
    }
    return createChannel(options);
  };
  const originalConsoleWarn = console.warn;
  console.warn = () => {};

  let channels;
  try {
    channels = await ensureOnboardingChannels(guild);
  } finally {
    console.warn = originalConsoleWarn;
  }

  assert.deepEqual(
    attempts.filter((options) => options.name === STYLED_CHANNEL_NAMES.news).map((options) => options.type),
    [ChannelType.GuildAnnouncement, ChannelType.GuildText],
  );
  assert.equal(channels.get("news").type, ChannelType.GuildText);
});

test("existing decorated text channels are matched and reused without changes", async () => {
  const existing = Object.values(STYLED_CHANNEL_NAMES).map((name, index) => ({
    id: String(600 + index),
    name,
    type: ChannelType.GuildText,
  }));
  const { guild, createdChannels } = makeGuild({ channels: existing });

  const channels = await ensureOnboardingChannels(guild);

  assert.equal(createdChannels.length, 0);
  assert.equal(channels.get("news"), existing[4]);
});

test("a single legacy plain onboarding channel is renamed in place without changing permissions", async () => {
  const permissionOverwrites = { cache: new Collection(), edit: async () => assert.fail("permissions must not change") };
  const legacyRules = {
    id: "640",
    name: "rules",
    type: ChannelType.GuildText,
    permissionOverwrites,
    setName: async function (name) {
      this.name = name;
      return this;
    },
  };
  const { guild, createdChannels } = makeGuild({ channels: [legacyRules] });

  const channels = await ensureOnboardingChannels(guild);

  assert.equal(legacyRules.name, STYLED_CHANNEL_NAMES.rules);
  assert.equal(channels.get("rules").id, legacyRules.id);
  assert.equal(channels.get("rules").permissionOverwrites, permissionOverwrites);
  assert.equal(createdChannels.some(({ options }) => options.name === STYLED_CHANNEL_NAMES.rules), false);
});

test("a decorated match wins over a plain duplicate without renaming or deleting either channel", async () => {
  let plainRenameCalls = 0;
  const permissionOverwrites = { cache: new Collection() };
  const decoratedRules = {
    id: "641",
    name: STYLED_CHANNEL_NAMES.rules,
    type: ChannelType.GuildText,
    permissionOverwrites,
  };
  const plainRules = {
    id: "642",
    name: "rules",
    type: ChannelType.GuildText,
    setName: async () => {
      plainRenameCalls += 1;
    },
  };
  const { guild, createdChannels } = makeGuild({ channels: [plainRules, decoratedRules] });
  const originalConsoleWarn = console.warn;
  console.warn = () => {};

  let channels;
  try {
    channels = await ensureOnboardingChannels(guild);
  } finally {
    console.warn = originalConsoleWarn;
  }

  assert.equal(channels.get("rules"), decoratedRules);
  assert.equal(plainRenameCalls, 0);
  assert.equal(createdChannels.some(({ options }) => options.name === STYLED_CHANNEL_NAMES.rules), false);
  assert.equal(permissionOverwrites.cache.size, 0);
});

test("channel-list failure does not create channels from an incomplete cache", async () => {
  const { guild, createdChannels } = makeGuild();
  guild.channels.fetch = async () => {
    throw Object.assign(new Error("channel list unavailable"), { code: 500 });
  };
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;
  console.error = () => {};
  console.warn = () => {};

  let channels;
  try {
    channels = await ensureOnboardingChannels(guild);
  } finally {
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
  }

  assert.equal(channels.size, 0);
  assert.equal(createdChannels.length, 0);
});

test("a same-name non-text channel is preserved instead of creating a duplicate", async () => {
  const voiceRules = { id: "650", name: "rules", type: ChannelType.GuildVoice };
  const { guild, createdChannels } = makeGuild({ channels: [voiceRules] });
  const originalConsoleWarn = console.warn;
  console.warn = () => {};

  let channels;
  try {
    channels = await ensureOnboardingChannels(guild);
  } finally {
    console.warn = originalConsoleWarn;
  }

  assert.equal(channels.has("rules"), false);
  assert.equal(createdChannels.some(({ options }) => options.name === "rules"), false);
});

test("welcome embed uses the private-chat style and mentions each onboarding channel", () => {
  const channels = new Map(["rules", "help", "start", "guide", "news"].map((name, index) => [
    name,
    { id: String(700 + index) },
  ]));

  const payload = buildOnboardingWelcomePayload({
    guildName: "Sugar Server",
    memberId: MEMBER_ID,
    channels,
  });
  const embed = payload.embeds[0].toJSON();

  assert.equal(embed.color, 0xf472b6);
  assert.match(embed.title, /🎀$/u);
  assert.match(embed.description, new RegExp(PINK_CHECK_EMOJI));
  assert.match(embed.description, /remove the `new` role and add the `member` role/);
  assert.deepEqual(payload.allowedMentions, { parse: [], users: [MEMBER_ID] });
  for (const channel of channels.values()) assert.ok(embed.fields.some((field) => field.value.includes(`<#${channel.id}>`)));
  assert.equal(embed.footer.text, ONBOARDING_FOOTER);
});

test("the start guide explains onboarding and uses the matching pink embed style", () => {
  const channels = new Map(["rules", "help", "start", "guide", "news"].map((name, index) => [
    name,
    { id: String(800 + index) },
  ]));

  const payload = buildOnboardingGuidePayload({ channels });
  const embed = payload.embeds[0].toJSON();
  const content = `${embed.description}\n${embed.fields.map(({ name, value }) => `${name}\n${value}`).join("\n")}`;

  assert.equal(embed.color, 0xf472b6);
  assert.match(embed.title, /🎀$/u);
  assert.match(content, /<#800>/);
  assert.match(content, new RegExp(`<#${ONBOARDING_CHANNEL_ID}>`));
  assert.match(content, new RegExp(PINK_CHECK_EMOJI));
  assert.match(content, /remove your `new` role and add the `member` role/);
  assert.match(content, /<#801>.*no ticket system/s);
  assert.match(content, /<#803>.*how the server works/s);
  assert.match(content, /<#804>.*announcements and updates/s);
  assert.equal(embed.footer.text, ONBOARDING_GUIDE_FOOTER);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
});

test("verification adds member before removing new", async () => {
  const { guild, calls, member } = makeGuild({ roles: onboardingRoles() });
  guild.members.fetch = async () => member;

  assert.equal(await completeOnboardingVerification(guild, MEMBER_ID), true);
  assert.deepEqual(calls.map(({ action }) => action), ["add", "remove"]);
  assert.equal(member.roles.cache.has(MEMBER_ROLE_ID), true);
  assert.equal(member.roles.cache.has(NEW_ROLE_ID), false);
});

test("verification finds the join role by its configured ID, not its display name", async () => {
  const customJoinRole = { id: JOIN_ROLE_ID, name: "Onboarding access" };
  const { guild, calls, member } = makeGuild({
    roles: [customJoinRole, { id: MEMBER_ROLE_ID, name: "member" }],
  });
  guild.members.fetch = async () => member;

  assert.equal(await completeOnboardingVerification(guild, MEMBER_ID), true);
  assert.deepEqual(calls.map(({ action, role }) => [action, role.id]), [
    ["add", MEMBER_ROLE_ID],
    ["remove", JOIN_ROLE_ID],
  ]);
});

test("verification does not remove new if adding member fails", async () => {
  const { guild, calls, member } = makeGuild({
    roles: onboardingRoles(),
    addError: Object.assign(new Error("missing permission"), { code: 50013 }),
  });
  guild.members.fetch = async () => member;
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    assert.equal(await completeOnboardingVerification(guild, MEMBER_ID), false);
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(calls.map(({ action }) => action), ["add"]);
  assert.equal(member.roles.cache.has(NEW_ROLE_ID), true);
});

test("verification ignores members who do not have the new role", async () => {
  const { guild, calls, member } = makeGuild({
    roles: onboardingRoles(),
    memberRoleIds: [],
  });
  guild.members.fetch = async () => member;

  assert.equal(await completeOnboardingVerification(guild, MEMBER_ID), false);
  assert.deepEqual(calls, []);
});

test("only the pink check reaction on Sugar's onboarding embed changes roles", async () => {
  const { guild, member, calls } = makeGuild({ roles: onboardingRoles() });
  guild.members.fetch = async () => member;
  const client = { user: { id: BOT_ID } };
  const message = {
    author: { id: BOT_ID },
    channelId: ONBOARDING_CHANNEL_ID,
    content: `Welcome <@${MEMBER_ID}>!`,
    guild,
    embeds: [{ footer: { text: ONBOARDING_FOOTER } }],
  };
  const reaction = {
    emoji: { id: PINK_CHECK_EMOJI_ID },
    message,
  };

  assert.equal(await handleOnboardingReaction(client, reaction, { id: MEMBER_ID, bot: false }), true);
  assert.deepEqual(calls.map(({ action }) => action), ["add", "remove"]);
  assert.equal(await handleOnboardingReaction(client, { ...reaction, emoji: { id: "other" } }, { id: MEMBER_ID }), false);
  assert.equal(await handleOnboardingReaction(client, reaction, { id: MEMBER_ID, bot: true }), false);
  assert.equal(await handleOnboardingReaction(client, reaction, { id: "941800000000000415" }), false);
});

test("the onboarding service provisions the target guild and reacts to each new welcome", async () => {
  const { guild, member, createdChannels } = makeGuild({ roles: onboardingRoles() });
  const posted = [];
  const targetChannel = {
    guild,
    guildId: GUILD_ID,
    isTextBased: () => true,
    send: async (payload) => {
      const message = {
        payload,
        react: async (emoji) => posted.push({ emojiId: emoji.id, emojiName: emoji.name }),
      };
      posted.push({ payload });
      return message;
    },
  };
  const fetchedChannelIds = [];
  const client = {
    channels: {
      fetch: async (channelId) => {
        fetchedChannelIds.push(channelId);
        return targetChannel;
      },
    },
  };
  const onboarding = createOnboardingService(client);

  assert.equal(await onboarding.provision(), true);
  assert.equal(await onboarding.sendWelcome(member), true);
  assert.deepEqual(fetchedChannelIds, [ONBOARDING_CHANNEL_ID]);
  assert.equal(createdChannels.length, 5);
  assert.equal(posted[0].payload.embeds[0].data.color, 0xf472b6);
  assert.deepEqual(posted[1], { emojiId: PINK_CHECK_EMOJI_ID, emojiName: "pinkcheck" });
});

test("startup creates one start guide and reuses it on later setup runs", async () => {
  const startChannel = {
    id: "941800000000000420",
    name: "start",
    type: ChannelType.GuildText,
    guildId: GUILD_ID,
    isTextBased: () => true,
    setName: async function (name) {
      this.name = name;
      return this;
    },
  };
  const { guild } = makeGuild({ channels: [startChannel] });
  startChannel.guild = guild;

  const history = new Collection();
  const edits = [];
  const guideStore = {
    messageId: null,
    getMessageId() {
      return this.messageId;
    },
    setMessageId(channelId, messageId) {
      assert.equal(channelId, startChannel.id);
      this.messageId = messageId;
    },
  };
  let sends = 0;

  startChannel.messages = {
    fetch: async (query) => {
      if (typeof query === "string") {
        const message = history.get(query);
        if (!message) throw Object.assign(new Error("unknown message"), { code: 10008 });
        return message;
      }
      return history;
    },
  };
  startChannel.send = async (payload) => {
    sends += 1;
    const message = {
      id: "941800000000000421",
      author: { id: BOT_ID },
      embeds: payload.embeds.map((embed) => embed.toJSON()),
      edit: async (updatedPayload) => {
        edits.push(updatedPayload);
        message.embeds = updatedPayload.embeds.map((embed) => embed.toJSON());
        return message;
      },
    };
    history.set(message.id, message);
    return message;
  };

  const welcomeChannel = {
    guild,
    guildId: GUILD_ID,
    isTextBased: () => true,
  };
  const client = {
    user: { id: BOT_ID },
    channels: { fetch: async () => welcomeChannel },
  };
  const onboarding = createOnboardingService(client, { guideStore });

  assert.equal(await onboarding.provision(), true);
  assert.equal(sends, 1);
  assert.equal(guideStore.messageId, "941800000000000421");
  assert.equal(await onboarding.provision(), true);
  assert.equal(sends, 1);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].embeds[0].data.footer.text, ONBOARDING_GUIDE_FOOTER);
});

test("an existing bot guide is reused without changing unrelated start messages", async () => {
  const startChannel = {
    id: "941800000000000430",
    name: "start",
    type: ChannelType.GuildText,
    guildId: GUILD_ID,
    isTextBased: () => true,
    setName: async function (name) {
      this.name = name;
      return this;
    },
  };
  const { guild } = makeGuild({ channels: [startChannel] });
  startChannel.guild = guild;

  let sends = 0;
  let edits = 0;
  const existingGuide = {
    id: "941800000000000431",
    author: { id: BOT_ID },
    embeds: [{ footer: { text: ONBOARDING_GUIDE_FOOTER } }],
    edit: async () => {
      edits += 1;
      return existingGuide;
    },
  };
  const unrelatedMessage = {
    id: "941800000000000432",
    author: { id: "941800000000000433" },
    embeds: [],
    edit: async () => assert.fail("unrelated messages must not be edited"),
  };
  const history = new Collection([
    [existingGuide.id, existingGuide],
    [unrelatedMessage.id, unrelatedMessage],
  ]);
  startChannel.messages = { fetch: async () => history };
  startChannel.send = async () => {
    sends += 1;
  };

  const welcomeChannel = {
    guild,
    guildId: GUILD_ID,
    isTextBased: () => true,
  };
  const onboarding = createOnboardingService(
    { user: { id: BOT_ID }, channels: { fetch: async () => welcomeChannel } },
    { guideStore: { getMessageId: () => null, setMessageId: () => {} } },
  );

  assert.equal(await onboarding.provision(), true);
  assert.equal(startChannel.name, STYLED_CHANNEL_NAMES.start);
  assert.equal(edits, 1);
  assert.equal(sends, 0);
  assert.equal(unrelatedMessage.embeds.length, 0);
});

test("the onboarding service does not post in a different guild", async () => {
  const { guild, member } = makeGuild();
  let sends = 0;
  const targetChannel = {
    guild,
    guildId: GUILD_ID,
    isTextBased: () => true,
    send: async () => {
      sends += 1;
    },
  };
  const client = { channels: { fetch: async () => targetChannel } };
  const onboarding = createOnboardingService(client);
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    assert.equal(await onboarding.sendWelcome({ ...member, guild: { id: "941800000000000499" } }), false);
    assert.equal(sends, 0);
  } finally {
    console.error = originalConsoleError;
  }
});
