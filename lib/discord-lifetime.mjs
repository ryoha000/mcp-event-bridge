// Opt-in policy applies only to separate Discord-role grants. Probe and mixed
// probe/Discord grants keep their existing one-hour absolute lifetime.
export const DISCORD_GRANT_SECONDS = 90 * 86400;
export const DISCORD_REFRESH_SECONDS = 86400;
export function discordRole(scopes) {
  const values = String(scopes ?? '').split(' ').filter(s=>!['openid','offline_access',''].includes(s));
  return values.length > 0 && (values.every(s=>['discord:read','discord:reply'].includes(s)) || values.every(s=>['discord:ingest','discord:receive-replies'].includes(s)));
}
export function discordLifetime(config) {
  return {
    Grant: (_ctx, grant) => config.discordUnattendedEnabled && discordRole(grant.resources?.[config.resource]) ? DISCORD_GRANT_SECONDS : 3600,
    RefreshToken: (_ctx, token) => config.discordUnattendedEnabled && discordRole(token.scope)
      ? Math.max(1, Math.min(DISCORD_REFRESH_SECONDS, (token.iiat ?? Math.floor(Date.now()/1000)) + DISCORD_GRANT_SECONDS - Math.floor(Date.now()/1000))) : 3600,
  };
}
