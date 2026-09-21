// The dashboard, exercised over real HTTP with a stand-in for the bot.
//
// discord.js is only asked for two things here: which guilds the bot is in,
// and which channels it can post in. Both are easy to stand in for, which
// means the routes, the cookies and the permission checks can be tested
// without a Discord token.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SettingsStore } from "../src/settings.js";
import { createWeb } from "../src/web.js";

const GUILD = "941800000000000001";
const OTHER_GUILD = "941800000000000009";
const CHANNEL = "941800000000000002";

// createWeb calls postableChannels(client, guildId), which reads the guild's
// channel cache. A Map of the shape discord.js gives back is enough.
function stubClient() {
  const channels = new Map([
    [CHANNEL, { id: CHANNEL, name: "general", type: 0, rawPosition: 0, permissionsFor: () => ({ has: () => true }) }],
  ]);
  channels.filter = function (fn) {
    return new Map([...this].filter(([, v]) => fn(v)));
  };
  channels.sort = function (fn) {
    return [...this.values()].sort(fn);
  };

  return {
    user: { username: "Warden" },
    guilds: { cache: new Map([[GUILD, { id: GUILD, name: "Emberfell", channels: { cache: channels }, members: { me: {} } }]]) },
  };
}

async function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-web-"));
  const settings = new SettingsStore(dir);

  const { app } = createWeb({
    client: stubClient(),
    settings,
    config: {
      clientId: "123456",
      clientSecret: "shh",
      sessionSecret: "a-long-enough-session-secret",
      appUrl: "http://127.0.0.1:0",
    },
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, settings, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("a visitor who is not signed in is offered the Discord login", async () => {
  const { base, close } = await start();

  const response = await fetch(base);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /Sign in with Discord/);
  assert.match(html, /Warden dashboard/);

  await close();
});

test("the login redirects to Discord with our redirect URL", async () => {
  const { base, close } = await start();

  const response = await fetch(`${base}/login`, { redirect: "manual" });
  const location = new URL(response.headers.get("location"));

  assert.equal(response.status, 302);
  assert.equal(location.host, "discord.com");
  assert.match(location.searchParams.get("redirect_uri"), /\/auth\/callback$/);
  assert.ok(location.searchParams.get("state"));

  await close();
});

test("a callback without a state we signed is refused", async () => {
  const { base, close } = await start();

  const response = await fetch(`${base}/auth/callback?code=abc&state=forged`);

  assert.equal(response.status, 400);
  assert.match(await response.text(), /did not come from here/);

  await close();
});

test("a settings page cannot be opened without signing in", async () => {
  const { base, close } = await start();

  const response = await fetch(`${base}/g/${GUILD}`, { redirect: "manual" });

  assert.equal(response.status, 302);
  assert.equal(new URL(response.headers.get("location"), base).pathname, "/");

  await close();
});

test("saving without signing in does nothing", async () => {
  const { base, settings, close } = await start();

  await fetch(`${base}/g/${GUILD}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ welcomeChannelId: CHANNEL, welcomeMessage: "pwned" }),
    redirect: "manual",
  });

  assert.equal(settings.get(GUILD).welcomeChannelId, null);
  assert.equal(settings.get(OTHER_GUILD).welcomeChannelId, null);

  await close();
});

test("health says whether the bot is up and the dashboard has an address", async () => {
  const { base, close } = await start();

  const body = await (await fetch(`${base}/health`)).json();

  assert.equal(body.ok, true);
  assert.equal(body.bot, "Warden");
  assert.equal(body.guilds, 1);
  assert.equal(body.dashboard, true);

  await close();
});
