import {BOT_ID,GUILD_ID,DISCORD_INTENTS} from './discord.mjs';
const phases=new Set(['bot_verified','guild_verified','allowlist_verified','guild_visibility_verified','gateway_ready','gateway_resumed','gateway_failed']);
const codes=new Set(['DISCORD_HTTP_REFUSED','DISCORD_RESPONSE_REFUSED','BOT_MISMATCH','GUILD_MISMATCH','CHANNEL_MISMATCH','CONFIG_REFUSED']);
export function discordDiagnostic(phase,details={},sink=console.info){
 const row={kind:'discord_diagnostic',phase:phases.has(phase)?phase:'unknown'};
 for(const key of ['botMatches','guildMatches','repliesEnabled'])if(typeof details[key]==='boolean')row[key]=details[key];
 for(const key of ['channelCount','intentMask','status','gatewayCode'])if(Number.isInteger(details[key])&&details[key]>=0&&details[key]<=10000)row[key]=details[key];
 if(codes.has(details.code))row.code=details.code;
 try{sink(JSON.stringify(row));}catch{}return row;
}
const fail=(code,status)=>{throw Object.assign(Error('Discord integration validation refused'),{code,status});};
// ランタイムメモリ上の固定されたbot/ギルド/チャンネルのメタデータのみ読む。
// 履歴、メッセージ、名前、権限変更、認証情報、本文は診断に入れない。
export async function validateDiscordIntegration({token,channelIds,channelScope='allowlist',fetchImpl=fetch,diagnosticSink=console.info}){
 if(typeof token!=='string'||!token||/\s/.test(token)||DISCORD_INTENTS!==513||!['allowlist','guild-visible'].includes(channelScope)||!Array.isArray(channelIds)||(channelScope==='allowlist'&&!channelIds.length)||channelIds.length>100||channelIds.some(id=>!/^\d{17,20}$/.test(id))||new Set(channelIds).size!==channelIds.length)fail('CONFIG_REFUSED');
 async function get(path){
  const r=await fetchImpl('https://discord.com/api/v10'+path,{method:'GET',redirect:'error',signal:AbortSignal.timeout(8000),headers:{authorization:'Bot '+token}});
  if(!r.ok){await r.body?.cancel?.().catch(()=>{});fail('DISCORD_HTTP_REFUSED',r.status);}
  let size=0;const chunks=[];for await(const c of r.body??[]){size+=c.length;if(size>262144)fail('DISCORD_RESPONSE_REFUSED');chunks.push(Buffer.from(c));}
  try{return JSON.parse(Buffer.concat(chunks).toString());}catch{fail('DISCORD_RESPONSE_REFUSED');}
 }
 const user=await get('/users/@me');if(user.id!==BOT_ID||user.bot!==true)fail('BOT_MISMATCH');
 discordDiagnostic('bot_verified',{botMatches:true,intentMask:DISCORD_INTENTS},diagnosticSink);
 const guild=await get('/guilds/'+GUILD_ID);if(guild.id!==GUILD_ID)fail('GUILD_MISMATCH');
 discordDiagnostic('guild_verified',{guildMatches:true},diagnosticSink);
 if(channelScope==='allowlist')for(const id of channelIds){const channel=await get('/channels/'+id);if(channel.id!==id||channel.guild_id!==GUILD_ID)fail('CHANNEL_MISMATCH');}
 discordDiagnostic(channelScope==='allowlist'?'allowlist_verified':'guild_visibility_verified',{...(channelScope==='allowlist'?{channelCount:channelIds.length}:{}),intentMask:DISCORD_INTENTS},diagnosticSink);
 return {botMatches:true,guildMatches:true,channelCount:channelScope==='allowlist'?channelIds.length:null,...(channelScope==='guild-visible'?{channelScope}:{}),intentMask:DISCORD_INTENTS};
}
