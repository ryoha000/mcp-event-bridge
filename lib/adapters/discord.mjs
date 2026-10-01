import { digest, eventIdFor, fault, exact, validateEnvelope } from '../events/envelope.mjs';

export const GUILD_ID = process.env.DISCORD_GUILD_ID ?? '100000000000000400';
export const BOT_ID = process.env.DISCORD_BOT_ID ?? '100000000000001900';
export const DISCORD_EVENT = 'discord.mention.created';
export const DISCORD_INTENTS = 513;
const snowflake = value => typeof value === 'string' && /^[0-9]{17,20}$/.test(value);
export function readDiscordChannels(env) {
  const channels=JSON.parse(env.DISCORD_CHANNEL_IDS??'[]');
  if(!Array.isArray(channels)||!channels.length||channels.length>100||channels.some(c=>!snowflake(c))||new Set(channels).size!==channels.length)throw fault('DISCORD_ALLOWLIST_REQUIRED');
  return channels;
}
export function readDiscordChannelPolicy(env){
 const channelScope=env.DISCORD_CHANNEL_SCOPE??'allowlist';if(!['allowlist','guild-visible'].includes(channelScope))throw fault('DISCORD_CHANNEL_POLICY_REQUIRED');
 return {channelScope,channelIds:channelScope==='guild-visible'?[]:readDiscordChannels(env)};
}
export function createDiscordAdapter({ guildId = GUILD_ID, botId = BOT_ID, channelIds = [], sendMessage,inlineMentions=false,channelScope='allowlist' } = {}) {
  if (!snowflake(guildId) || !snowflake(botId)) throw fault();
  if(!['allowlist','guild-visible'].includes(channelScope)||!Array.isArray(channelIds)||channelIds.some(c=>!snowflake(c))||new Set(channelIds).size!==channelIds.length)throw fault();
  const allowed=new Set(channelIds);
  const validate = input => {
    const e = validateEnvelope(input);
    exact(e.data, ['content']);
    if (e.source !== 'discord' || e.name !== DISCORD_EVENT || e.origin.tenantId !== guildId ||
        !Object.values(e.origin).every(snowflake) || (channelScope==='allowlist'&&!allowed.has(e.origin.channelId)) || typeof e.data.content !== 'string' || e.data.content.length > 4000) throw fault();
    return e;
  };
  return Object.freeze({
    source: 'discord', eventName: DISCORD_EVENT, tenantId: guildId, validate,
    ...(inlineMentions?{
      payloadSchema:{type:'object',properties:{version:{type:'integer',const:1},event_id:{type:'string',pattern:'^evt_[a-f0-9]{64}$'},source:{type:'string',const:'discord'},guild_id:{type:'string',const:guildId},channel_id:{type:'string',pattern:'^[0-9]{17,20}$'},message_id:{type:'string',pattern:'^[0-9]{17,20}$'},actor_id:{type:'string',pattern:'^[0-9]{17,20}$'},timestamp:{type:'string',format:'date-time',maxLength:32},content:{type:'string',maxLength:4000},context_policy:{type:'string',const:'origin_event_only'}},required:['version','event_id','source','guild_id','channel_id','message_id','actor_id','timestamp','content','context_policy'],additionalProperties:false},
      callbackData(input){const e=validate(input),payload={version:1,event_id:e.eventId,source:e.source,guild_id:e.origin.tenantId,channel_id:e.origin.channelId,message_id:e.origin.messageId,actor_id:e.origin.actorId,timestamp:e.timestamp,content:e.data.content,context_policy:e.contextPolicy};if(Buffer.byteLength(JSON.stringify(payload))>16384)throw fault('EVENT_CAPACITY');return payload;}
    }:{}),
    normalize(packet) {
      if (packet?.op !== 0 || packet.t !== 'MESSAGE_CREATE') return null;
      const m = packet.d;
      if (!m || m.guild_id !== guildId || !snowflake(m.id) || !snowflake(m.channel_id) || (channelScope==='allowlist'&&!allowed.has(m.channel_id)) || !snowflake(m.author?.id) ||
          m.author.id === botId || m.author.bot || m.author.system || m.webhook_id ||
          ![0,19].includes(m.type) || !Array.isArray(m.mentions) || !m.mentions.some(u => u?.id === botId) ||
          typeof m.content !== 'string' || m.content.length > 4000 || typeof m.timestamp !== 'string' || !Number.isFinite(Date.parse(m.timestamp))) return null;
      return validate({ version:1, eventId:eventIdFor('discord',guildId,m.id,DISCORD_EVENT), name:DISCORD_EVENT,
        timestamp:new Date(m.timestamp).toISOString(), source:'discord',
        origin:{tenantId:guildId,channelId:m.channel_id,messageId:m.id,actorId:m.author.id},
        data:{content:m.content},contextPolicy:'origin_event_only' });
    },
    async reply(event, content) {
      const e = validate(event);
      if (typeof sendMessage !== 'function' || typeof content !== 'string' || !content.trim() || content.length > 2000) throw fault();
      // 送信先は永続化されたメンションのみから決まり、モデルの引数は使わない。
      return sendMessage(e.origin.channelId, { content, allowed_mentions:{parse:[],replied_user:false},
        message_reference:{message_id:e.origin.messageId,channel_id:e.origin.channelId,guild_id:guildId,fail_if_not_exists:true},
        nonce:digest(['discord-reply',e.eventId]).slice(0,25),enforce_nonce:true },{eventId:e.eventId});
    },
  });
}
