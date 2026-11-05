# Discord bot with a dashboard

[![Deploy to FadeHost](https://fadehost.com/deploy-button.svg)](https://laplace.fadehost.com/register?intent=app&repo=https://github.com/FadeHost/discord-bot-dashboard)

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
| `DEEPSEEK_API_KEY` | no | Optional. Enables AI replies when set. |
| `APP_URL` | no | The public address. FadeHost sets it when the web address is on. Set it yourself when running elsewhere. |
| `PORT` | no | The port to listen on. FadeHost sets this for you. |
| `DATA_DIR` | no | An existing, writable persistent directory for settings. Production defaults to `/data`. |
| `NODE_ENV` | no | Set to `development` for local data-directory fallback; other modes require persistent storage. |

Without `APP_URL` the bot still runs; the dashboard just says it has nowhere
for Discord to send people back to.

### Keeping secrets out of the project

The app reads variables from its process environment; it does not load `.env`
files. Set production secrets in the host's secret or environment-variable
manager. `.env.example` contains names and empty values only. Local `.env*`
files and `.envrc` are ignored by Git, and backup archives exclude them.
Never place secret values in GitHub, project documents, or backup archives.

## Run it somewhere else

```bash
npm ci
npm start
```

Before starting, provide the required environment variables through your
operating system or host's secure environment-variable manager. Generate a
long random `SESSION_SECRET`; do not put secret values in shell history or
project files. Add `http://localhost:8080/auth/callback` to the redirects in
the Developer Portal while testing. For local development, run
`NODE_ENV=development npm start`; production requires an existing `DATA_DIR`
or a mounted `/data` directory. Node 20 or newer.

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

## Backup and recovery

The app currently has no database. Its durable application data is the
`settings.json` file in `DATA_DIR`. Point `DATA_DIR` at a persistent disk or
mounted directory on the host. Outside `NODE_ENV=development`, the app only
uses an existing `DATA_DIR` or `/data` and stops if that storage is unavailable;
it never switches to `./data`. Local development may fall back to `./data`.
A writable path is not necessarily persistent, so confirm the chosen disk
survives host restarts and redeploys.

GitHub `main` stores the source history. To make a portable snapshot of the
project files and current data, run this from the project directory:

```bash
bash scripts/backup.sh
```

The archive is written to `~/sugar-backups` by default. To choose another
location outside the project, pass it as the first argument:

```bash
bash scripts/backup.sh /path/to/private-backups
```

The backup includes source, configuration templates, project documents, and
the selected data directory. It excludes Git internals, installed packages,
temporary caches, and secret-bearing environment files. Store the archive
somewhere separate from the host that runs the bot.

To inspect and recover a snapshot, extract it into a new, empty directory:

```bash
bash scripts/restore.sh /path/to/sugar-ai-YYYYMMDDTHHMMSSZ.tar.gz
```

An optional second argument selects the restore directory. The script refuses
to overwrite an existing directory or extract into the live project. Review
`BACKUP-INFO.txt` and the restored `data/` before using them. For a new host,
check out the GitHub `main` branch, install with `npm ci`, set the required
secrets in that host's secret manager, and point `DATA_DIR` at a persistent
directory. Restore data only into an empty data directory; preserve any
existing host data before attempting a recovery. Do not copy secrets from an
archive: they are intentionally not included.

## Tests

```bash
npm test
```

The dashboard tests start the real web server with a stand-in for the bot, so
the routes, the cookies and the permission checks are covered without a
Discord token.

Built and maintained by [FadeHost](https://fadehost.com). MIT licensed.
