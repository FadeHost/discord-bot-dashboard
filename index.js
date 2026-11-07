// A Discord welcome and log bot with a web dashboard.
//
// One process runs both halves: the bot on the gateway, and a small web
// server on PORT that the FadeHost web address puts on the internet.

import { createBot } from "./src/bot.js";
import { createDeepSeekClient } from "./src/deepseek.js";
import { resolveDeploymentVersion } from "./src/deployment-version.js";
import { SettingsStore, resolveDataDir } from "./src/settings.js";
import { MemoryStore } from "./src/memory.js";
import { PrivateChatStore } from "./src/private-chat-store.js";
import { ModerationLogStore } from "./src/moderation-log-store.js";
import { createWeb } from "./src/web.js";

const STARTED_AT = new Date().toISOString();
const VERSION = resolveDeploymentVersion();
const PORT = Number(process.env.PORT || 8080);
const DISCORD_TOKEN = (process.env.DISCORD_TOKEN || "").trim();
const DEEPSEEK_API_KEY = (process.env.DEEPSEEK_API_KEY || "").trim();
const DISCORD_CLIENT_ID = (process.env.DISCORD_CLIENT_ID || "").trim();
const DISCORD_CLIENT_SECRET = (process.env.DISCORD_CLIENT_SECRET || "").trim();
const SESSION_SECRET = (process.env.SESSION_SECRET || "").trim();
const APP_URL = (process.env.APP_URL || "").trim() || undefined;

function fatal(message, category = "config") {
  console.error(`[${category}] ${message}`);
  process.exit(1);
}

if (!DISCORD_TOKEN) {
  fatal(
    "DISCORD_TOKEN is not set. Create an application at discord.com/developers, open Bot, Reset Token, " +
      "and add the token as an environment variable.",
  );
}
if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
  fatal(
    "DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET are both needed for the dashboard login. " +
      "They are on the OAuth2 page of the same application as the bot token.",
  );
}
if (SESSION_SECRET.length < 16) {
  fatal("SESSION_SECRET is missing or too short. Use at least 16 random characters: it signs the login cookie.");
}

let dataDir;
let settings;
let memory;
let privateChats;
let moderationLogs;
try {
  dataDir = resolveDataDir();
  settings = new SettingsStore(dataDir, { allowMissing: process.env.NODE_ENV === "development" });
  memory = new MemoryStore(dataDir);
  privateChats = new PrivateChatStore(dataDir);
  moderationLogs = new ModerationLogStore(dataDir);
} catch (error) {
  fatal(error instanceof Error ? error.message : "Storage initialization failed.", "storage");
}
console.log(`[dashboard] settings in ${dataDir}/settings.json`);

const generateReply = DEEPSEEK_API_KEY ? createDeepSeekClient({ apiKey: DEEPSEEK_API_KEY }) : undefined;
if (!generateReply) {
  console.warn("[ai] DEEPSEEK_API_KEY is not set; AI replies are disabled.");
}

const client = createBot({
  token: DISCORD_TOKEN,
  applicationId: DISCORD_CLIENT_ID,
  settings,
  generateReply,
  memory,
  privateChats,
  moderationLogs,
});

const { app, redirectUri } = createWeb({
  client,
  settings,
  config: {
    clientId: DISCORD_CLIENT_ID,
    clientSecret: DISCORD_CLIENT_SECRET,
    sessionSecret: SESSION_SECRET,
    appUrl: APP_URL,
  },
  version: VERSION,
  startedAt: STARTED_AT,
});

// 0.0.0.0, because the web address reaches this container from outside it.
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[dashboard] listening on ${PORT}`);

  if (redirectUri) {
    console.log(`[dashboard] open ${APP_URL}`);
    console.log(`[dashboard] paste this under OAuth2, Redirects: ${redirectUri}`);
  } else {
    console.log(
      "[dashboard] no APP_URL, so the login is off. Turn on the web address for this app in the FadeHost panel " +
        "and restart it. The bot half works either way.",
    );
  }
});
