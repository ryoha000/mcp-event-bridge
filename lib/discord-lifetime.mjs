// オプトインのポリシーはDiscordロールのみの許可に適用する。
// プローブおよびプローブ/Discord混在の許可は、従来の1時間の絶対寿命を維持する。
export const DISCORD_GRANT_SECONDS = 90 * 86400;
export const DISCORD_REFRESH_SECONDS = 86400;
const roles=scopes=>String(scopes ?? '').split(' ').filter(s=>!['openid','offline_access',''].includes(s));
export function discordRole(scopes) {
  const values = roles(scopes);
  return values.length > 0 && values.every(s=>['discord:read','discord:reply'].includes(s));
}
export function sourceEventRole(scopes) {
  const values = roles(scopes);
  return values.length > 0 && values.every(s=>['discord:read','discord:reply','x:read'].includes(s));
}
export function discordLifetime(config) {
  const role=config.consumerOnly===true?sourceEventRole:discordRole;
  return {
    Grant: (_ctx, grant) => config.discordUnattendedEnabled && role(grant.resources?.[config.resource]) ? DISCORD_GRANT_SECONDS : 3600,
    RefreshToken: (_ctx, token) => config.discordUnattendedEnabled && role(token.scope)
      ? Math.max(1, Math.min(DISCORD_REFRESH_SECONDS, (token.iiat ?? Math.floor(Date.now()/1000)) + DISCORD_GRANT_SECONDS - Math.floor(Date.now()/1000))) : 3600,
  };
}
