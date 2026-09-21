import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  authorizeUrl,
  checkState,
  isGuildAdmin,
  makeState,
  manageableGuilds,
  redirectUri,
  timingSafeEqual,
} from "../src/oauth.js";
import { Sessions, readCookie } from "../src/session.js";
import { DEFAULT_WELCOME, SettingsStore, cleanSettings, renderWelcome, resolveDataDir } from "../src/settings.js";
import { escapeHtml, guildPage, loginPage } from "../src/views.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-test-"));
}

// ---- the redirect URL ----------------------------------------------------

test("the redirect URL is built from the app's public address", () => {
  assert.equal(redirectUri("https://mybot.fadehost.app"), "https://mybot.fadehost.app/auth/callback");
  assert.equal(redirectUri("https://mybot.fadehost.app/"), "https://mybot.fadehost.app/auth/callback");
  assert.equal(redirectUri("http://localhost:8080"), "http://localhost:8080/auth/callback");
});

test("without a web address there is no redirect URL, and the dashboard says so", () => {
  assert.equal(redirectUri(undefined), null);
  assert.equal(redirectUri(""), null);
  assert.equal(redirectUri("mybot.fadehost.app"), null);

  assert.match(loginPage({ botName: "Warden", ready: false }), /needs a web address/);
});

test("the authorize URL asks for the two scopes we use and nothing more", () => {
  const url = new URL(authorizeUrl({ clientId: "123", redirectUri: "https://x/auth/callback", state: "s" }));
  assert.equal(url.searchParams.get("scope"), "identify guilds");
  assert.equal(url.searchParams.get("client_id"), "123");
  assert.equal(url.searchParams.get("redirect_uri"), "https://x/auth/callback");
  assert.equal(url.searchParams.get("response_type"), "code");
});

// ---- who gets in ---------------------------------------------------------

test("owners, administrators and managers count as admins", () => {
  assert.equal(isGuildAdmin({ owner: true, permissions: "0" }), true);
  assert.equal(isGuildAdmin({ permissions: String(1n << 3n) }), true);
  assert.equal(isGuildAdmin({ permissions: String(1n << 5n) }), true);
});

test("an ordinary member does not", () => {
  // Send Messages and Read History only.
  assert.equal(isGuildAdmin({ permissions: String((1n << 11n) | (1n << 16n)) }), false);
  assert.equal(isGuildAdmin({ permissions: "0" }), false);
  assert.equal(isGuildAdmin({}), false);
  assert.equal(isGuildAdmin({ permissions: "not a number" }), false);
});

test("only servers the bot is in are offered", () => {
  const guilds = [
    { id: "1", name: "Has bot", owner: true, permissions: "0" },
    { id: "2", name: "No bot", owner: true, permissions: "0" },
    { id: "3", name: "Not an admin", permissions: "0" },
  ];

  assert.deepEqual(
    manageableGuilds(guilds, new Set(["1", "3"])).map((g) => g.id),
    ["1"],
  );
});

// ---- the state parameter -------------------------------------------------

test("a state we minted passes and a made-up one does not", () => {
  const state = makeState("secret");
  assert.equal(checkState("secret", state), true);
  assert.equal(checkState("secret", "123.nonsense"), false);
  assert.equal(checkState("other secret", state), false);
  assert.equal(checkState("secret", ""), false);
});

test("a state older than ten minutes is refused", () => {
  const state = makeState("secret", Date.now() - 11 * 60 * 1000);
  assert.equal(checkState("secret", state), false);
});

// ---- sessions ------------------------------------------------------------

test("a session cookie round trips", () => {
  const sessions = new Sessions("secret");
  const cookie = sessions.create({ user: { id: "1", username: "bernis" }, guilds: [] });

  assert.equal(sessions.read(cookie).user.username, "bernis");
});

test("a cookie with a broken signature is worthless", () => {
  const sessions = new Sessions("secret");
  const cookie = sessions.create({ user: { id: "1" }, guilds: [] });

  assert.equal(sessions.read(cookie.replace(/.$/, "x")), null);
  assert.equal(sessions.read("madeup.signature"), null);
  assert.equal(sessions.read(undefined), null);
});

test("a cookie signed by a different secret is worthless", () => {
  const cookie = new Sessions("secret").create({ user: { id: "1" }, guilds: [] });
  assert.equal(new Sessions("another").read(cookie), null);
});

test("signing out invalidates the cookie", () => {
  const sessions = new Sessions("secret");
  const cookie = sessions.create({ user: { id: "1" }, guilds: [] });

  sessions.destroy(cookie);
  assert.equal(sessions.read(cookie), null);
});

test("the csrf token is tied to one session", () => {
  const sessions = new Sessions("secret");
  const a = sessions.create({ user: { id: "1" }, guilds: [] });
  const b = sessions.create({ user: { id: "2" }, guilds: [] });

  assert.notEqual(sessions.csrf(a), sessions.csrf(b));
  assert.equal(timingSafeEqual(sessions.csrf(a), sessions.csrf(a)), true);
});

test("readCookie picks one cookie out of the header", () => {
  assert.equal(readCookie("a=1; dash_sid=xyz", "dash_sid"), "xyz");
  assert.equal(readCookie(undefined, "dash_sid"), undefined);
});

// ---- settings ------------------------------------------------------------

test("settings survive a new store over the same directory, like a redeploy", () => {
  const dir = tempDir();
  new SettingsStore(dir).set("941800000000000001", {
    welcomeChannelId: "941800000000000002",
    welcomeMessage: "Hi {user}",
    logChannelId: "941800000000000003",
  });

  const after = new SettingsStore(dir);
  assert.deepEqual(after.get("941800000000000001"), {
    welcomeChannelId: "941800000000000002",
    welcomeMessage: "Hi {user}",
    logChannelId: "941800000000000003",
  });
});

test("a guild nobody configured gets the defaults", () => {
  const settings = new SettingsStore(tempDir());
  assert.deepEqual(settings.get("999"), {
    welcomeChannelId: null,
    welcomeMessage: DEFAULT_WELCOME,
    logChannelId: null,
  });
});

test("a channel id that is not a snowflake means off", () => {
  const clean = cleanSettings({ welcomeChannelId: "../../etc", logChannelId: "<script>", welcomeMessage: "Hi" });
  assert.equal(clean.welcomeChannelId, null);
  assert.equal(clean.logChannelId, null);
});

test("an empty welcome message falls back to the default", () => {
  assert.equal(cleanSettings({ welcomeMessage: "   " }).welcomeMessage, DEFAULT_WELCOME);
});

test("a huge welcome message is cut down", () => {
  assert.equal(cleanSettings({ welcomeMessage: "x".repeat(5000) }).welcomeMessage.length, 1500);
});

test("nothing outside the three known fields is stored", () => {
  const settings = new SettingsStore(tempDir());
  const saved = settings.set("941800000000000001", {
    welcomeChannelId: "941800000000000002",
    token: "leak me",
  });

  assert.deepEqual(Object.keys(saved).sort(), ["logChannelId", "welcomeChannelId", "welcomeMessage"]);
});

test("resolveDataDir uses the directory it is given", () => {
  const dir = tempDir();
  assert.equal(resolveDataDir(dir), dir);
});

// ---- the welcome message -------------------------------------------------

test("every placeholder is filled in", () => {
  const text = renderWelcome("{user} ({username}) joined {server}, member {count}", {
    mention: "<@1>",
    username: "bernis",
    guildName: "Emberfell",
    memberCount: 42,
  });

  assert.equal(text, "<@1> (bernis) joined Emberfell, member 42");
});

test("a welcome message can never be longer than Discord allows", () => {
  const text = renderWelcome("{user} ".repeat(1000), {
    mention: "<@1>",
    username: "b",
    guildName: "g",
    memberCount: 1,
  });

  assert.ok(text.length <= 2000);
});

// ---- rendering -----------------------------------------------------------

test("a server name cannot inject markup into the settings page", () => {
  const html = guildPage({
    guild: { id: "1", name: "<script>alert(1)</script>" },
    settings: { welcomeChannelId: null, welcomeMessage: DEFAULT_WELCOME, logChannelId: null },
    channels: [{ id: "2", name: "general" }],
    csrf: "token",
  });

  assert.equal(html.includes("<script>alert(1)"), false);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /#general/);
});

test("the selected channel is the one that comes back selected", () => {
  const html = guildPage({
    guild: { id: "1", name: "Emberfell" },
    settings: { welcomeChannelId: "2", welcomeMessage: "Hi", logChannelId: null },
    channels: [
      { id: "2", name: "general" },
      { id: "3", name: "logs" },
    ],
    csrf: "token",
  });

  assert.match(html, /<option value="2" selected>#general<\/option>/);
  assert.match(html, /<option value="3">#logs<\/option>/);
});

test("escapeHtml covers the characters that matter", () => {
  assert.equal(escapeHtml(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
});
