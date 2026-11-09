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
import {
  DEFAULT_WELCOME,
  SettingsStore,
  cleanSettings,
  parseRoleIds,
  renderWelcome,
  resolveDataDir,
} from "../src/settings.js";
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
  new SettingsStore(dir, { allowMissing: true }).set("941800000000000001", {
    welcomeChannelId: "941800000000000002",
    welcomeMessage: "Hi {user}",
    logChannelId: "941800000000000003",
    vipRoleIds: ["941800000000000004"],
    moderatorRoleIds: ["941800000000000005"],
  });

  const after = new SettingsStore(dir);
  assert.deepEqual(after.get("941800000000000001"), {
    welcomeChannelId: "941800000000000002",
    welcomeMessage: "Hi {user}",
    logChannelId: "941800000000000003",
    vipRoleIds: ["941800000000000004"],
    moderatorRoleIds: ["941800000000000005"],
  });
});

test("a guild nobody configured gets the defaults", () => {
  const settings = new SettingsStore(tempDir(), { allowMissing: true });
  assert.deepEqual(settings.get("999"), {
    welcomeChannelId: null,
    welcomeMessage: DEFAULT_WELCOME,
    logChannelId: null,
    vipRoleIds: [],
    moderatorRoleIds: [],
  });
});

test("a channel id that is not a snowflake means off", () => {
  const clean = cleanSettings({ welcomeChannelId: "../../etc", logChannelId: "<script>", welcomeMessage: "Hi" });
  assert.equal(clean.welcomeChannelId, null);
  assert.equal(clean.logChannelId, null);
});

test("role IDs accept comma-separated snowflakes, remove duplicates, and reject invalid input", () => {
  assert.deepEqual(parseRoleIds("941800000000000010, 941800000000000011\n941800000000000010"), {
    ids: ["941800000000000010", "941800000000000011"],
    invalid: [],
  });
  assert.deepEqual(parseRoleIds("moderator, 941800000000000012"), {
    ids: ["941800000000000012"],
    invalid: ["moderator"],
  });
  assert.deepEqual(parseRoleIds(""), { ids: [], invalid: [] });
});

test("the dashboard renders VIP and moderator role-ID settings", () => {
  const html = guildPage({
    guild: { id: "941800000000000001", name: "Test server" },
    settings: cleanSettings({
      vipRoleIds: ["941800000000000010"],
      moderatorRoleIds: ["941800000000000011"],
    }),
    channels: [],
    csrf: "csrf-token",
  });

  assert.match(html, /name="vipRoleIds"/);
  assert.match(html, /name="moderatorRoleIds"/);
  assert.match(html, /941800000000000010/);
  assert.match(html, /941800000000000011/);
});

test("an empty welcome message falls back to the default", () => {
  assert.equal(cleanSettings({ welcomeMessage: "   " }).welcomeMessage, DEFAULT_WELCOME);
});

test("a huge welcome message is cut down", () => {
  assert.equal(cleanSettings({ welcomeMessage: "x".repeat(5000) }).welcomeMessage.length, 1500);
});

test("nothing outside the three known fields is stored", () => {
  const settings = new SettingsStore(tempDir(), { allowMissing: true });
  const saved = settings.set("941800000000000001", {
    welcomeChannelId: "941800000000000002",
    token: "leak me",
  });

  assert.deepEqual(Object.keys(saved).sort(), [
    "logChannelId",
    "moderatorRoleIds",
    "vipRoleIds",
    "welcomeChannelId",
    "welcomeMessage",
  ]);
});

test("corrupt settings stop loading without changing the file", () => {
  const dir = tempDir();
  const file = path.join(dir, "settings.json");
  const contents = '{"941800000000000001":';
  fs.writeFileSync(file, contents);

  assert.throws(() => new SettingsStore(dir), /settings\.json is invalid JSON/);
  assert.equal(fs.readFileSync(file, "utf8"), contents);
});

test("missing settings stop production startup without creating a file", () => {
  const dir = tempDir();
  const file = path.join(dir, "settings.json");

  assert.throws(() => new SettingsStore(dir), /settings\.json is missing/);
  assert.equal(fs.existsSync(file), false);
});

test("development may initialize empty settings when the file is missing", () => {
  const dir = tempDir();
  const settings = new SettingsStore(dir, { allowMissing: true });

  assert.deepEqual(settings.get("941800000000000001"), {
    welcomeChannelId: null,
    welcomeMessage: DEFAULT_WELCOME,
    logChannelId: null,
    vipRoleIds: [],
    moderatorRoleIds: [],
  });
  assert.equal(fs.existsSync(path.join(dir, "settings.json")), false);
});

test("settings with an invalid structure stop loading without being rewritten", () => {
  const dir = tempDir();
  const file = path.join(dir, "settings.json");
  const contents = JSON.stringify({ "941800000000000001": ["not", "settings"] });
  fs.writeFileSync(file, contents);

  assert.throws(() => new SettingsStore(dir), /settings\.json has an invalid structure/);
  assert.equal(fs.readFileSync(file, "utf8"), contents);
});

test("an unreadable settings path stops loading instead of using empty settings", () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, "settings.json"));

  assert.throws(() => new SettingsStore(dir), /Unable to read settings\.json/);
  assert.equal(fs.statSync(path.join(dir, "settings.json")).isDirectory(), true);
});

test("resolveDataDir uses the directory it is given", () => {
  const dir = tempDir();
  assert.equal(resolveDataDir(dir), dir);
});

test("production storage failure does not create or fall back from DATA_DIR", () => {
  const previousCwd = process.cwd();
  const previousNodeEnv = process.env.NODE_ENV;
  const previousDataDir = process.env.DATA_DIR;
  const root = tempDir();
  const fallback = path.join(root, "data");
  const missingStorage = path.join(root, "persistent-data");
  fs.mkdirSync(fallback);

  try {
    process.chdir(root);
    process.env.NODE_ENV = "production";
    process.env.DATA_DIR = missingStorage;

    assert.throws(() => resolveDataDir(), /Persistent storage is unavailable/);
    assert.equal(fs.existsSync(missingStorage), false);
    assert.equal(fs.statSync(fallback).isDirectory(), true);
  } finally {
    process.chdir(previousCwd);
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
  }
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
