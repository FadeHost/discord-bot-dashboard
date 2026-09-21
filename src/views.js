// The dashboard's pages.

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const STYLE = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 40px 20px 64px;
  background: #0b0b0f; color: #e7e7ea;
  font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
.wrap { max-width: 640px; margin: 0 auto; }
h1 { font-size: 26px; font-weight: 600; margin: 0 0 6px; letter-spacing: -0.01em; }
h2 { font-size: 16px; font-weight: 600; margin: 0 0 14px; }
.sub { color: #8b8b95; font-size: 14px; margin: 0 0 28px; }
.card { background: #131318; border: 1px solid #23232c; border-radius: 14px; padding: 20px; }
.card + .card { margin-top: 14px; }
a.card { display: flex; align-items: center; gap: 13px; text-decoration: none; color: inherit; padding: 15px 18px; }
a.card:hover { border-color: #0ea5e955; background: #16161d; }
.avatar {
  width: 40px; height: 40px; border-radius: 12px; flex: none;
  background: #23232c; display: grid; place-items: center;
  font-weight: 600; font-size: 15px; color: #a1a1ab; overflow: hidden;
}
.avatar img { width: 100%; height: 100%; display: block; }
.grow { min-width: 0; flex: 1; }
.guild-name { font-weight: 600; overflow-wrap: anywhere; }
.guild-meta { color: #8b8b95; font-size: 13px; }
.chev { color: #5c5c66; flex: none; }
label { display: block; font-size: 14px; font-weight: 500; margin: 0 0 6px; }
.hint { color: #8b8b95; font-weight: 400; font-size: 13px; }
select, textarea, input {
  width: 100%; background: #0f0f14; color: #e7e7ea;
  border: 1px solid #2c2c36; border-radius: 9px;
  padding: 10px 12px; font: inherit; font-size: 15px;
}
select:focus, textarea:focus { outline: 2px solid #0ea5e9; outline-offset: -1px; border-color: transparent; }
textarea { min-height: 92px; resize: vertical; }
.field + .field { margin-top: 18px; }
button, .btn {
  display: inline-block; background: #0ea5e9; color: #04131c; border: 0;
  border-radius: 9px; padding: 11px 18px; text-decoration: none;
  font: inherit; font-weight: 600; cursor: pointer;
}
button:hover, .btn:hover { background: #38bdf8; }
button.ghost, .btn.ghost { background: #23232c; color: #e7e7ea; }
button.ghost:hover, .btn.ghost:hover { background: #2f2f3a; }
.actions { margin-top: 22px; display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.banner { border-radius: 11px; padding: 13px 15px; font-size: 14px; margin: 0 0 20px; }
.banner.ok { background: #4ade801a; border: 1px solid #4ade8040; color: #86efac; }
.banner.bad { background: #f871711a; border: 1px solid #f8717140; color: #fca5a5; }
.topbar { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 8px; }
.back { color: #8b8b95; font-size: 14px; text-decoration: none; }
.back:hover { color: #c9c9d1; }
code { font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; background: #1d1d24; padding: 2px 6px; border-radius: 6px; overflow-wrap: anywhere; }
.tokens { color: #8b8b95; font-size: 13px; margin: 8px 0 0; }
.empty { color: #8b8b95; text-align: center; padding: 22px 0; }
footer { margin-top: 32px; text-align: center; color: #6b6b75; font-size: 13px; }
footer a { color: #8b8b95; }
@media (max-width: 480px) { body { padding: 28px 14px 48px; } }
`;

function layout({ title, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body><div class="wrap">${body}
<footer>Hosted on <a href="https://fadehost.com" rel="noreferrer">FadeHost</a></footer>
</div></body>
</html>`;
}

/** The signed-out page. */
export function loginPage({ botName, error = null, ready = true, redirectUri = null }) {
  const body = ready
    ? `<div class="card">
  <h2>Sign in to change the settings</h2>
  <p class="sub" style="margin:0 0 18px">You will only see the servers you run and the bot is in.</p>
  <a class="btn" href="/login">Sign in with Discord</a>
</div>`
    : `<div class="card">
  <h2>The dashboard needs a web address</h2>
  <p class="sub" style="margin:0">Turn on the web address for this app in the FadeHost panel and restart it.
  The bot half is already running: it just has nowhere to put the dashboard yet.</p>
</div>`;

  return layout({
    title: botName ? `${botName} dashboard` : "Bot dashboard",
    body: `<h1>${escapeHtml(botName || "Bot")} dashboard</h1>
<p class="sub">Welcome messages and a channel log, set up here instead of with slash commands.</p>
${error ? `<div class="banner bad">${escapeHtml(error)}</div>` : ""}
${body}
${redirectUri ? `<p class="tokens">Redirect URL for the Developer Portal: <code>${escapeHtml(redirectUri)}</code></p>` : ""}`,
  });
}

/** The list of servers somebody can configure. */
export function guildListPage({ user, guilds, csrf, inviteUrl }) {
  const body = guilds.length
    ? guilds.map(guildRow).join("")
    : `<div class="card"><div class="empty">
  <p style="margin:0 0 14px">None of the servers you run have this bot in them yet.</p>
  <a class="btn" href="${escapeHtml(inviteUrl)}" rel="noreferrer">Invite the bot</a>
</div></div>`;

  return layout({
    title: "Your servers",
    body: `<div class="topbar">
  <div><h1>Your servers</h1><p class="sub" style="margin:0">Signed in as ${escapeHtml(user.username)}</p></div>
  <form method="post" action="/logout">
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <button class="ghost" type="submit">Sign out</button>
  </form>
</div>
<div style="margin-top:22px">${body}</div>`,
  });
}

function guildRow(guild) {
  const icon = guild.icon
    ? `<img src="https://cdn.discordapp.com/icons/${encodeURIComponent(guild.id)}/${encodeURIComponent(guild.icon)}.png?size=80" alt="">`
    : escapeHtml(guild.name.slice(0, 2).toUpperCase());

  return `<a class="card" href="/g/${encodeURIComponent(guild.id)}">
  <span class="avatar">${icon}</span>
  <span class="grow"><span class="guild-name">${escapeHtml(guild.name)}</span></span>
  <span class="chev">&rsaquo;</span>
</a>`;
}

/** One server's settings. */
export function guildPage({ guild, settings, channels, csrf, saved = false, warning = null }) {
  const options = (selected) =>
    [`<option value="">Off</option>`]
      .concat(
        channels.map(
          (channel) =>
            `<option value="${escapeHtml(channel.id)}"${channel.id === selected ? " selected" : ""}>#${escapeHtml(channel.name)}</option>`,
        ),
      )
      .join("");

  return layout({
    title: guild.name,
    body: `<a class="back" href="/">&lsaquo; All servers</a>
<h1 style="margin-top:10px">${escapeHtml(guild.name)}</h1>
<p class="sub">Changes take effect straight away.</p>
${saved ? `<div class="banner ok">Saved.</div>` : ""}
${warning ? `<div class="banner bad">${escapeHtml(warning)}</div>` : ""}
<form method="post" action="/g/${escapeHtml(guild.id)}">
  <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
  <div class="card">
    <h2>Welcome</h2>
    <div class="field">
      <label for="welcomeChannelId">Channel <span class="hint">where new members are greeted</span></label>
      <select id="welcomeChannelId" name="welcomeChannelId">${options(settings.welcomeChannelId)}</select>
    </div>
    <div class="field">
      <label for="welcomeMessage">Message</label>
      <textarea id="welcomeMessage" name="welcomeMessage" maxlength="1500">${escapeHtml(settings.welcomeMessage)}</textarea>
      <p class="tokens"><code>{user}</code> mentions them · <code>{username}</code> their name ·
        <code>{server}</code> this server · <code>{count}</code> how many members there are now</p>
    </div>
  </div>
  <div class="card">
    <h2>Log</h2>
    <div class="field">
      <label for="logChannelId">Channel <span class="hint">joins, leaves, edited and deleted messages</span></label>
      <select id="logChannelId" name="logChannelId">${options(settings.logChannelId)}</select>
    </div>
  </div>
  <div class="actions"><button type="submit">Save</button></div>
</form>`,
  });
}

/** Something went wrong and there is nothing to show. */
export function errorPage({ title, message }) {
  return layout({
    title,
    body: `<h1>${escapeHtml(title)}</h1>
<div class="banner bad">${escapeHtml(message)}</div>
<a class="btn ghost" href="/">Back</a>`,
  });
}
