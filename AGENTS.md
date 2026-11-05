# AGENTS.md — Sugar

This is the repository's durable project guidance. Read it before making any code, test, documentation, or configuration changes. If a request conflicts with this file, stop and clarify rather than silently choosing a direction.

## Purpose

Sugar is the single Discord bot for the Kittisugar community. Keep the product focused on community operations through Discord. Do not create a second bot or a parallel website product.

## System architecture and boundaries

- GitHub is the canonical home for source code, history, and collaboration.
- FadeHost is the production runtime for the bot. The bot must be able to run continuously on FadeHost without Replit being available.
- Discord is the community platform and the bot's intended user-facing interface.
- DeepSeek is the intended AI provider. The current repository does not yet contain a DeepSeek integration; do not describe AI features as live until they are implemented and verified.
- Replit is for development only. Do not make production uptime, bot operation, AI calls, persistent state, scheduled work, or required callbacks depend on a Replit project or deployment.

Keep the production bot self-contained on FadeHost. GitHub stores its code; it is not the runtime. Replit may be used to edit, inspect, and test code, but Sugar must stay online when Replit is closed, unavailable, or unused.

## Product boundary and dashboard transition

The intended product is a Discord bot, not a website or web dashboard. New user-facing features should be implemented through Discord commands, interactions, or bot events—not new web pages or dashboard features.

Current-state exception: this repository still contains a web dashboard, Discord OAuth login, web sessions, and HTTP routes. Preserve this existing functionality for now. Do not remove, disable, or rewrite the dashboard as part of unrelated work or this context-file change. Any future removal or migration of that existing functionality must be a separate, explicitly approved task. Until that task is approved and completed, describe the dashboard as existing legacy functionality rather than claiming the repository is already bot-only.

## Discord application and secret handling

Keep using the existing Discord bot application and its existing bot token. Do not create a replacement application, change the application identity, invalidate or rotate the token, or change its configuration without explicit approval.

Never put secrets, tokens, API keys, passwords, OAuth client secrets, session secrets, or credential-bearing URLs in source code, tests, logs, documentation, commit messages, GitHub issues, or pull requests. Never print or paste secret values into chat. Read credentials only from the hosting platform's secret or environment-variable facility; share variable names, not values. Keep the existing Discord token in FadeHost's secret configuration. Keep any future DeepSeek API key in FadeHost's secret configuration as well. Example environment files may document variable names but must contain only empty or clearly fake placeholders.

## Hosting and resource limits

Treat the stated FadeHost free-tier limits as hard operating constraints: Node.js 20 or newer and 256 MB RAM. Keep startup and steady-state memory use small. Prefer the existing Node.js runtime and dependencies; justify any new dependency against its memory, maintenance, and security cost. Bound API response sizes, message lengths, caches, and concurrent work. Avoid memory-heavy frameworks, unnecessary background workers, and work that can grow without limit.

Do not move production hosting to Replit. Do not change deployment settings, environment-variable configuration, process commands, public URLs, storage mounts, runtime versions, or hosting plans without asking for and receiving approval. Do not deploy unless the user explicitly authorizes that deployment.

## Coding conventions and modularity

- Follow the existing Node.js ES-module style and package configuration. Use the repository's established two-space indentation, double-quoted strings, and semicolons.
- Keep modules focused on one responsibility, use clear named exports, and preserve the existing separation between bot events, Discord OAuth/access checks, web routes/views, sessions, and settings storage.
- Prefer small, readable functions and the existing Node.js and discord.js/Express stack. Avoid adding dependencies or introducing a frontend framework without a concrete need and approval when the change affects product scope.
- Validate and normalize all settings and external input at module boundaries. Check permissions on the server side; do not trust form fields, command arguments, or cached authorization alone.
- Use async/await and handle Discord or provider failures without taking down unrelated bot functionality. Add bounded timeouts and safe fallbacks for future external AI calls. Do not send secrets or unnecessary community data to DeepSeek.
- Add comments for non-obvious security, persistence, or Discord permission behavior. Keep examples and logs free of personal data and credentials.

## Current repository structure

- .env.example — environment-variable names and example configuration; never place real values here.
- .gitignore — files excluded from Git.
- LICENSE — project license.
- README.md — current setup and feature documentation.
- index.js — validates startup configuration and starts the settings store, Discord bot, and HTTP server in one Node process.
- package.json and package-lock.json — runtime requirements, scripts, and locked dependencies.
- src/bot.js — Discord client, member and message event handlers, welcome messages, log embeds, and postable-channel selection.
- src/oauth.js — Discord OAuth URLs and callback helpers, signed state, token exchange, and guild authorization filtering.
- src/session.js — in-memory login sessions, signed cookies, CSRF tokens, and cookie helpers.
- src/settings.js — defaults, settings validation, welcome-template rendering, data-directory selection, and JSON persistence.
- src/views.js — server-rendered HTML for the current login, server-list, settings, and error pages.
- src/web.js — Express routes for login, OAuth callback, server settings, logout, and health status.
- test/dashboard.test.js — unit tests for OAuth helpers, authorization, sessions, settings, templates, and HTML rendering.
- test/web.test.js — HTTP route tests using a stub Discord client rather than production credentials.

Keep new functionality in the module that owns that responsibility. Avoid turning index.js into a feature module or combining unrelated concerns.

## Existing functionality and current gaps

The current bot greets new members in a configured channel and logs member joins, departures, edited messages, and deleted messages. Welcome templates support user, username, server, and member-count placeholders. Per-server welcome and log channel settings are managed through the existing web dashboard and stored in a JSON file. The dashboard uses Discord OAuth and limits access to servers the signed-in user can manage where the bot is present. A health endpoint reports bot and dashboard status.

The bot uses Discord's Server Members and Message Content privileged intents; the corresponding intents must remain enabled in the existing Discord application for the documented events to work. The current code has no DeepSeek client or AI feature. Any AI implementation must be treated as new functionality, isolated in an appropriate module, configured with a FadeHost secret, and covered by tests before being called live.

## Testing expectations

Use the repository's built-in Node.js test runner. Run npm test after code changes and add focused tests for new behavior, validation, error paths, and security boundaries. Use stubs or mocks for Discord and AI provider interactions; tests must not require production tokens, send real community messages, or depend on the live community. Keep HTTP route tests isolated from external services. Do not claim tests passed unless they were actually run and passed.

For documentation-only changes, verify the diff and ensure no unrelated file changed. For code changes, inspect the final diff and test results before proposing deployment.

## Persistent data requirements

The existing settings store writes per-server configuration to settings.json under the selected data directory. On FadeHost, use its persistent data volume (currently expected at /data); do not rely on an ephemeral deployment filesystem for data that must survive restarts or redeploys. Preserve the existing settings unless a separately approved migration is necessary.

Write durable data atomically, validate it when loading, and keep formats backward-compatible where practical. For any schema change, document migration and recovery behavior and avoid destructive rewrites. Keep credentials, OAuth tokens, and session cookies out of persistent application data. The current login sessions are intentionally in memory and expire; do not treat them as durable configuration.

## Change control

Before editing, inspect this AGENTS.md and the relevant source, tests, and current Git diff. Keep changes scoped to the request and list every changed file. Ask for explicit approval before deleting existing functionality, removing or migrating the current dashboard, changing deployment or hosting configuration, changing the existing Discord application or token, or performing a deployment. Do not infer approval for any of those actions from a request to make an unrelated code or documentation change.

Webhook deployment test.
