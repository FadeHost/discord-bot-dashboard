// Signing in with Discord, and deciding who is allowed into the dashboard.

import crypto from "node:crypto";

export const DISCORD_API = process.env.DISCORD_API || "https://discord.com/api/v10";

// The two permission bits that mean "this person runs the server".
const ADMINISTRATOR = 1n << 3n;
const MANAGE_GUILD = 1n << 5n;

/**
 * Where Discord sends people back to. It is built from the app's public
 * address, so it is right on FadeHost without anybody typing it twice. Paste
 * this exact string into the Developer Portal under OAuth2, Redirects.
 *
 * @param {string|undefined} appUrl
 * @returns {string|null}
 */
export function redirectUri(appUrl) {
  const base = String(appUrl ?? "").trim().replace(/\/+$/, "");
  if (!base.startsWith("http://") && !base.startsWith("https://")) return null;
  return `${base}/auth/callback`;
}

/**
 * The authorize URL to send somebody to.
 *
 * @param {{clientId: string, redirectUri: string, state: string}} options
 */
export function authorizeUrl({ clientId, redirectUri: uri, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: uri,
    response_type: "code",
    scope: "identify guilds",
    state,
    prompt: "none",
  });

  return `https://discord.com/oauth2/authorize?${params}`;
}

/** The invite link for the bot, with the permissions it needs. */
export function inviteUrl(clientId) {
  const params = new URLSearchParams({
    client_id: clientId,
    // View channels, send messages, embed links, read history.
    permissions: "84992",
    scope: "bot",
  });

  return `https://discord.com/oauth2/authorize?${params}`;
}

/** A short-lived signed value, so a callback has to come from a login we started. */
export function makeState(secret, now = Date.now()) {
  const stamp = String(now);
  return `${stamp}.${sign(secret, stamp)}`;
}

/** @param {number} [maxAgeMs] ten minutes by default */
export function checkState(secret, state, now = Date.now(), maxAgeMs = 10 * 60 * 1000) {
  if (typeof state !== "string" || !state.includes(".")) return false;

  const [stamp, signature] = state.split(".", 2);
  if (!/^\d+$/.test(stamp) || now - Number(stamp) > maxAgeMs || Number(stamp) > now + 60_000) return false;

  return timingSafeEqual(sign(secret, stamp), signature);
}

export function sign(secret, value) {
  return crypto.createHmac("sha256", String(secret)).update(String(value)).digest("base64url");
}

export function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Swap the code Discord sent back for an access token.
 *
 * @returns {Promise<string>} the access token
 */
export async function exchangeCode({ clientId, clientSecret, code, redirectUri: uri }) {
  const response = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: uri,
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    // A wrong redirect URL is the usual cause, and Discord's own words say so.
    throw new Error(`Discord refused the login (${response.status}). ${detail.slice(0, 200)}`);
  }

  const body = await response.json();
  return body.access_token;
}

/** Who just signed in. */
export async function fetchUser(accessToken) {
  const user = await callDiscord("/users/@me", accessToken);
  return { id: user.id, username: user.global_name || user.username, avatar: user.avatar };
}

/** The servers they are in, as Discord reports them. */
export async function fetchGuilds(accessToken) {
  const guilds = await callDiscord("/users/@me/guilds", accessToken);
  return Array.isArray(guilds) ? guilds : [];
}

async function callDiscord(path, accessToken) {
  const response = await fetch(`${DISCORD_API}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) throw new Error(`Discord answered ${response.status} for ${path}.`);
  return response.json();
}

/**
 * Does this person run that server? Owner, Administrator or Manage Server.
 *
 * @param {{owner?: boolean, permissions?: string|number}} guild
 */
export function isGuildAdmin(guild) {
  if (guild?.owner === true) return true;

  let permissions;
  try {
    permissions = BigInt(guild?.permissions ?? 0);
  } catch {
    return false;
  }

  return (permissions & ADMINISTRATOR) === ADMINISTRATOR || (permissions & MANAGE_GUILD) === MANAGE_GUILD;
}

/**
 * The guilds to show somebody: the ones they run AND the bot is in. A server
 * the bot has not been invited to has nothing to configure.
 *
 * @param {object[]} guilds from fetchGuilds
 * @param {Set<string>|string[]} botGuildIds
 */
export function manageableGuilds(guilds, botGuildIds) {
  const present = botGuildIds instanceof Set ? botGuildIds : new Set(botGuildIds);

  return guilds
    .filter((guild) => isGuildAdmin(guild) && present.has(guild.id))
    .map((guild) => ({ id: guild.id, name: guild.name, icon: guild.icon }));
}
