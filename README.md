# MCP Event Bridge

A durable MCP Events bridge with a synthetic probe and a Discord mention adapter. The current continuous Discord host uses one Linux process, SQLite, systemd and an HTTPS reverse proxy. A request-based, scale-to-zero service does not keep a Discord Gateway connection alive.

`Discord Gateway → source adapter → versioned event envelope → durable outbox → signed MCP Events callback`

The consumer can use `discord_read_event`, `discord_reply_to_event` and `discord_status` through `/mcp/discord`. OAuth scopes separate read and reply access. Replies derive their destination from the stored originating mention; callers cannot choose another channel. Direct human mentions are accepted only in the configured guild. DMs, bot messages, message history and attachments are excluded. Mention text is untrusted input, and an automated responder should use only that event's context.

SQLite persists events, delivery attempts, subscriptions, OAuth grants, reply receipts and Gateway checkpoints. Event IDs and reply receipts deduplicate retries. An ambiguous Discord send is retained as `unknown` instead of automatically sending again. The Discord adapter also issues a bounded, independent 👀 reaction. Inline callback payloads carry the immutable mention envelope to avoid an extra read request. Other sources can implement the same normalize/validate/reply adapter contract in `lib/adapters/` and use the shared `lib/events/` components.

## Development

Requires Node.js 22.13 or later; use Node.js 22 LTS for the existing runtime.

```sh
npm ci --ignore-scripts
npm run check
npm test
```

Tests use fake Discord inputs and temporary storage. They do not need Discord or Google credentials. The separate synthetic probe remains in `server.mjs`, `production.mjs` and `lib/probe.mjs`; its cloud-backed production mode uses a private GCS bucket.

## Run the continuous Discord host

The provided service files are examples for an independently configured Linux VM. They do not provision infrastructure or permissions.

1. Install the source and production dependencies at `/opt/discord-mcp`, with Node available at `/usr/local/bin/node`. Create an unprivileged `discord-mcp` user. Keep `/var/lib/discord-mcp` private to that user and retain it across restarts.
2. Use `deployment/gce/runtime.env.example` as the basis for a root-readable `/etc/discord-mcp/runtime.env`. Set your own `GCE_DISCORD_ORIGIN`, `DISCORD_GUILD_ID`, `DISCORD_BOT_ID`, Google Web client ID, Google-authoritative owner email and exact connector redirect URI. Register the HTTPS origin with the Google Web client. `guild-visible` follows the bot's existing visibility; `allowlist` additionally requires `DISCORD_CHANNEL_IDS` as a JSON array.
3. Supply a Discord bot token and a separate OAuth signing/cookie JSON document through systemd credentials. The document needs `cookieKeys` (an array of random strings of at least 32 bytes) and `jwks.keys` (an array of private RSA JWK objects with at least 2048-bit keys). Store real values outside the checkout. The optional `discord-mcp-secrets.service` loads pinned Secret Manager versions using VM identity; configure the `MCP_*` settings and grant that identity access only to those two secrets. No service-account key file is used.
4. Install the two example units from `deployment/gce/` into systemd. For another credential provider, replace the secret-loader unit while preserving the two `/run/discord-mcp-secrets/` credential files. Provide nginx with a valid certificate, render the `@@HOST@@` placeholders, and install the proxy snippet and timing-log format. Expose only the routes in the HTTPS example. MCP and OAuth must use HTTPS.
5. Start the prepared host with `sudo systemctl daemon-reload` and `sudo systemctl enable --now discord-mcp.service`. The unit runs the equivalent of `npm start` under a process lock, binds Node to `127.0.0.1:8080`, and supplies the credential directory. Check `/healthz`, then connect the consumer to `https://<your-host>/mcp/discord` and subscribe to `discord.mention.created` for your guild.

The bot needs access to the chosen guild/channels, Gateway guild and guild-message intents (mask 513), and channel permissions to view, send replies and add reactions. The implementation does not change Discord roles or channel permissions. Set `GCE_DISCORD_REPLIES_ENABLE=true` only when automatic replies are wanted. Keep OAuth grants, databases, credentials and logs out of source control.

This repository contains generic examples and fake fixtures, without deployment history or live operational configuration.
