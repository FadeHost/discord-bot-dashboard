# Discord bot with a dashboard

[![Deploy on FadeHost](https://img.shields.io/badge/deploy%20on-FadeHost-0ea5e9?style=flat-square)](https://laplace.fadehost.com/bots?new=1)

A welcome and log bot you set up on a web page instead of with slash commands.
It is also the example to copy when you want your own bot to have a dashboard:
the login, the permission check and the settings file are all here in about
four hundred lines.

- Greets new members in a channel you choose, with their name, your server's
  name and the member count
- Logs joins, leaves, edited messages and deleted messages to another channel
- Everything is configured on the app's own web address
- Signing in is Discord's own login, and only people who run the server get in
- Settings are kept on the persistent volume, so a redeploy keeps them

## Deploy on FadeHost

1. Create an application at
   [discord.com/developers](https://discord.com/developers/applications).
   Under **Bot**, press Reset Token and copy it. Under **Bot, Privileged
   Gateway Intents**, turn on **Server Members** and **Message Content**.
2. Under **OAuth2**, copy the **Client ID** and the **Client Secret**.
3. In the [FadeHost panel](https://laplace.fadehost.com/bots), choose **Host an
   app**, then the **Bot with a dashboard** template, and paste the three
   values. Turn on the web address.
4. Open your address once. The console prints the redirect URL to paste back
   into the Developer Portal under **OAuth2, Redirects**. It is your address
   with `/auth/callback` on the end.
5. Invite the bot to your server, sign in on the dashboard, pick your channels.

Step 4 is the only fiddly one, and Discord insists on it: it will not send
anybody back to an address you have not listed.

## Environment variables

| Variable | Required | What it is |
|---|---|---|
| `DISCORD_TOKEN` | yes | The bot token, from **Bot, Reset Token**. |
| `DISCORD_CLIENT_ID` | yes | From the **OAuth2** page of the same application. |
| `DISCORD_CLIENT_SECRET` | yes | From the **OAuth2** page. Treat it like a password. |
| `SESSION_SECRET` | yes | Any long random string. It signs the login cookie. |
| `APP_URL` | no | The public address. FadeHost sets it when the web address is on. Set it yourself when running elsewhere. |
| `PORT` | no | The port to listen on. FadeHost sets this for you. |

Without `APP_URL` the bot still runs; the dashboard just says it has nowhere
for Discord to send people back to.

## Run it somewhere else

```bash
npm install
DISCORD_TOKEN=... DISCORD_CLIENT_ID=... DISCORD_CLIENT_SECRET=... \
SESSION_SECRET=$(openssl rand -hex 32) APP_URL=http://localhost:8080 npm start
```

Add `http://localhost:8080/auth/callback` to the redirects in the Developer
Portal while you are testing. Node 20 or newer.

## The welcome message

| Placeholder | Becomes |
|---|---|
| `{user}` | a mention, so they get a ping |
| `{username}` | their name, without the mention |
| `{server}` | your server's name |
| `{count}` | how many members there are now |

## Who can change things

The login asks Discord for two things: who you are, and which servers you are
in. A server appears on your dashboard only when you are its owner, an
administrator or have Manage Server, **and** the bot is in it. Every save is
checked again against that list, so a hand-written request cannot reach a
server that is not yours, and the channel you pick has to be one the bot can
really post in.

Logins live in memory, so restarting the app signs everybody out. That is two
clicks to fix and means there is nothing on disk worth stealing.

## What it stores

```
/data/settings.json   one entry per server: the two channels and the message
```

## Tests

```bash
npm test
```

The dashboard tests start the real web server with a stand-in for the bot, so
the routes, the cookies and the permission checks are covered without a
Discord token.

Built and maintained by [FadeHost](https://fadehost.com). MIT licensed.
