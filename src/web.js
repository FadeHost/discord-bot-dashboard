// The dashboard half: sign in with Discord, change a server's settings.

import express from "express";

import { postableChannels } from "./bot.js";
import {
  authorizeUrl,
  checkState,
  exchangeCode,
  fetchGuilds,
  fetchUser,
  inviteUrl,
  makeState,
  manageableGuilds,
  redirectUri as buildRedirectUri,
  timingSafeEqual,
} from "./oauth.js";
import { COOKIE, Sessions, clearCookie, readCookie, setCookie } from "./session.js";
import { errorPage, guildListPage, guildPage, loginPage } from "./views.js";

/**
 * Build the express app.
 *
 * @param {object} options
 * @param {import("discord.js").Client} options.client
 * @param {import("./settings.js").SettingsStore} options.settings
 * @param {{clientId: string, clientSecret: string, sessionSecret: string, appUrl: string|undefined}} options.config
 */
export function createWeb({ client, settings, config }) {
  const sessions = new Sessions(config.sessionSecret);
  const redirectUri = buildRedirectUri(config.appUrl);
  const secureCookies = Boolean(config.appUrl?.startsWith("https://"));

  const app = express();
  app.disable("x-powered-by");
  // The FadeHost web address terminates TLS in front of this app.
  app.set("trust proxy", true);
  app.use(express.urlencoded({ extended: false, limit: "32kb" }));

  const botName = () => client.user?.username ?? null;

  /** The session behind this request, or null. */
  function sessionOf(req) {
    const cookie = readCookie(req.headers.cookie, COOKIE);
    const session = sessions.read(cookie);
    return session ? { session, cookie, csrf: sessions.csrf(cookie) } : null;
  }

  // ---- signing in --------------------------------------------------------

  app.get("/", (req, res) => {
    const current = sessionOf(req);

    if (!current) {
      res.type("html").send(
        loginPage({
          botName: botName(),
          ready: Boolean(redirectUri),
          redirectUri,
          error: typeof req.query.error === "string" ? req.query.error : null,
        }),
      );
      return;
    }

    res.type("html").send(
      guildListPage({
        user: current.session.user,
        guilds: current.session.guilds,
        csrf: current.csrf,
        inviteUrl: inviteUrl(config.clientId),
      }),
    );
  });

  app.get("/login", (_req, res) => {
    if (!redirectUri) {
      res.redirect("/?error=" + encodeURIComponent("This app has no web address yet, so Discord has nowhere to send you back to."));
      return;
    }

    res.redirect(
      authorizeUrl({
        clientId: config.clientId,
        redirectUri,
        state: makeState(config.sessionSecret),
      }),
    );
  });

  app.get("/auth/callback", async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";

    if (!code || !checkState(config.sessionSecret, state)) {
      res.status(400).type("html").send(
        errorPage({
          title: "That login did not come from here",
          message: "Start again from the dashboard. If it keeps happening, the link was probably stale.",
        }),
      );
      return;
    }

    try {
      const accessToken = await exchangeCode({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        code,
        redirectUri,
      });

      const [user, guilds] = await Promise.all([fetchUser(accessToken), fetchGuilds(accessToken)]);

      // Only servers this person runs AND the bot is in. The access token is
      // not kept: everything we need is decided right here.
      const allowed = manageableGuilds(guilds, new Set(client.guilds.cache.keys()));

      const cookie = sessions.create({ user, guilds: allowed });
      setCookie(res, cookie, secureCookies);

      console.log(`[web] ${user.username} signed in (${allowed.length} server(s))`);
      res.redirect("/");
    } catch (error) {
      console.error(`[web] login failed: ${error.message}`);
      res.status(502).type("html").send(
        errorPage({
          title: "Discord would not finish the login",
          message:
            `${error.message} Check that ${redirectUri} is listed under OAuth2, Redirects in the ` +
            "Developer Portal, and that the client id and secret are the ones for this application.",
        }),
      );
    }
  });

  app.post("/logout", (req, res) => {
    const current = sessionOf(req);

    if (current && timingSafeEqual(String(req.body?.csrf ?? ""), current.csrf)) {
      sessions.destroy(current.cookie);
    }

    clearCookie(res);
    res.redirect("/");
  });

  // ---- one server's settings ---------------------------------------------

  /** Resolve the guild in the URL, or answer for us. */
  function guildFor(req, res) {
    const current = sessionOf(req);

    if (!current) {
      res.redirect("/");
      return null;
    }

    const guild = current.session.guilds.find((g) => g.id === req.params.guildId);

    if (!guild) {
      // Not "not found": somebody may be poking at another server's id.
      res.status(403).type("html").send(
        errorPage({
          title: "Not your server",
          message: "You can only change servers you run that this bot is in.",
        }),
      );
      return null;
    }

    return { ...current, guild };
  }

  app.get("/g/:guildId", (req, res) => {
    const found = guildFor(req, res);
    if (!found) return;

    const channels = postableChannels(client, found.guild.id);

    res.type("html").send(
      guildPage({
        guild: found.guild,
        settings: settings.get(found.guild.id),
        channels,
        csrf: found.csrf,
        saved: req.query.saved === "1",
        warning: channels.length
          ? null
          : "The bot cannot post in any channel here. Give it View Channel and Send Messages, then reload.",
      }),
    );
  });

  app.post("/g/:guildId", (req, res) => {
    const found = guildFor(req, res);
    if (!found) return;

    if (!timingSafeEqual(String(req.body?.csrf ?? ""), found.csrf)) {
      res.status(403).send("Bad token.");
      return;
    }

    // A dropdown can be made to say anything, so only channels this guild
    // actually has are accepted.
    const allowed = new Set(postableChannels(client, found.guild.id).map((c) => c.id));
    const pick = (value) => (allowed.has(String(value)) ? String(value) : null);

    const saved = settings.set(found.guild.id, {
      welcomeChannelId: pick(req.body?.welcomeChannelId),
      welcomeMessage: req.body?.welcomeMessage,
      logChannelId: pick(req.body?.logChannelId),
    });

    console.log(
      `[web] ${found.session.user.username} saved ${found.guild.name}: ` +
        `welcome ${saved.welcomeChannelId ?? "off"}, log ${saved.logChannelId ?? "off"}`,
    );

    res.redirect(`/g/${encodeURIComponent(found.guild.id)}?saved=1`);
  });

  app.get("/health", (_req, res) => {
    res.json({
      ok: Boolean(client.user),
      bot: botName(),
      guilds: client.guilds.cache.size,
      dashboard: Boolean(redirectUri),
    });
  });

  return { app, redirectUri };
}
